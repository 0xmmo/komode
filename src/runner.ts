/**
 * CodeRunner: one execute_code call, end to end. Wires tools into sandbox
 * bindings (arg validation, fan-out cap, call trace, files/images/endTurn
 * capture), runs the script in a persistent session, and formats the outcome
 * the way the model reads it back. Shared by the Agent and the framework
 * adapters so both behave identically.
 */

import { FETCH_TIMEOUT_MS, MAX_FETCHES_PER_RUN, MAX_RESPONSE_BYTES, NO_FETCH_PRELUDE, FETCH_PRELUDE, WEB_PRELUDE, sandboxFetch } from "./sandbox/fetch";
import { quickJSExecutor } from "./sandbox/quickjs";
import type { Executor, SandboxBinding, SandboxResult, SandboxSession } from "./sandbox/types";
import {
  isToolResult,
  resolveTool,
  type FileAttachment,
  type ModelImage,
  type ResolvedTool,
  type Tool,
} from "./tool";
import { AbortedError, anySignal, indent, safeStringify, silentLogger, truncateMiddle, type Logger } from "./util";

export interface RunnerLimits {
  /** Tool calls allowed within one execute_code run (fan-out guard). Default 25. */
  maxToolCallsPerRun?: number;
  /** Return value chars shown to the model before middle-truncation. Default 50,000. */
  maxReturnChars?: number;
  /** Console output chars captured per run. Default 8,000. */
  maxLogChars?: number;
}

export interface SandboxConfig {
  /** Wall-clock limit per run, tool calls included. Default 120s. */
  timeoutMs?: number;
  /** Guest heap limit. Default 64 MB. */
  memoryLimitBytes?: number;
  /**
   * Give guest code a web-standard fetch (GET/HEAD, public URLs only, SSRF
   * guarded, 2 MB / 10 s / 16 per run). Default true.
   */
  fetch?: boolean;
  /** Where code runs. Default: in-process QuickJS. */
  executor?: Executor;
}

/** Observable events, for logging and progress UIs. */
export type RunnerEvent =
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; error?: string; ms: number }
  | { type: "fetch"; host: string; status?: number; error?: string };

export interface CodeRunOutcome {
  /** Raw sandbox result */
  result: SandboxResult;
  /** Formatted sections the model reads back (completed_calls, logs, return_value or error) */
  parts: string[];
  /** Tool-call trace lines, `name(args) -> ok|error` */
  calls: string[];
  files: FileAttachment[];
  images: { tool: string; image: ModelImage }[];
  /** Set when a tool ended the run (toolResult({ endTurn })) */
  endTurn: { reply: string | null } | null;
  /** False when nothing executed (empty code, transpile or module-syntax rejection) */
  ran: boolean;
}

const DEFAULTS = {
  maxToolCallsPerRun: 25,
  maxReturnChars: 50_000,
  maxLogChars: 8_000,
};

export interface CodeRunnerOptions<TState> {
  tools?: Tool<TState>[];
  state?: TState;
  sandbox?: SandboxConfig;
  limits?: RunnerLimits;
  /** Values seeded onto the guest `state` object (never shown to the model) */
  initialState?: Record<string, unknown>;
  logger?: Logger;
  onEvent?: (event: RunnerEvent) => void;
}

/**
 * Per-run bookkeeping. Bindings read it at CALL time rather than closing over
 * it: guest code can stash a function reference (state.fn = someTool) and call
 * it in a later run, and that call must count against — and be traced in —
 * the run it actually happens in.
 */
interface ActiveRun {
  outcome: CodeRunOutcome;
  signal?: AbortSignal;
  callCount: number;
  fetchCount: number;
}

export class CodeRunner<TState = any> {
  private session: SandboxSession | null = null;
  private active: ActiveRun | null = null;
  private readonly tools = new Map<string, { resolved: ResolvedTool<TState>; source: Tool<TState> }>();
  private readonly limits: Required<RunnerLimits>;
  private readonly log: Logger;

  constructor(private readonly opts: CodeRunnerOptions<TState> = {}) {
    this.limits = { ...DEFAULTS, ...opts.limits };
    this.log = opts.logger ?? silentLogger;
    this.addTools(opts.tools ?? []);
  }

  /** Make more tools callable from the next run on (e.g. a skill just loaded). */
  addTools(tools: Tool<TState>[]): void {
    for (const tool of tools) {
      const resolved = resolveTool(tool);
      const existing = this.tools.get(resolved.schema.name);
      if (existing && existing.source !== tool) {
        throw new Error(
          `Two different tools are named "${resolved.schema.name}". Rename one (MCP connections take a \`prefix\`).`,
        );
      }
      this.tools.set(resolved.schema.name, { resolved, source: tool });
    }
  }

  get toolNames(): string[] {
    return [...this.tools.keys()];
  }

  get fetchEnabled(): boolean {
    return this.opts.sandbox?.fetch !== false;
  }

  async run(code: string, opts: { signal?: AbortSignal } = {}): Promise<CodeRunOutcome> {
    const outcome: CodeRunOutcome = {
      result: { ok: false, logs: [] },
      parts: [],
      calls: [],
      files: [],
      images: [],
      endTurn: null,
      ran: false,
    };
    if (!code?.trim()) {
      outcome.result.error = "No code provided.";
      outcome.parts.push(`<error>No code provided.</error>`);
      return outcome;
    }

    if (this.active) {
      throw new Error("CodeRunner.run() is already running; runs on one runner must not overlap");
    }
    this.active = { outcome, signal: opts.signal, callCount: 0, fetchCount: 0 };
    try {
      return await this.runActive(code, outcome);
    } finally {
      this.active = null;
    }
  }

  private async runActive(code: string, outcome: CodeRunOutcome): Promise<CodeRunOutcome> {
    const bindings = this.buildBindings();
    let result: SandboxResult;
    try {
      if (!this.session) {
        const executor = this.opts.sandbox?.executor ?? quickJSExecutor;
        this.session = await executor.createSession({
          timeoutMs: this.opts.sandbox?.timeoutMs,
          memoryLimitBytes: this.opts.sandbox?.memoryLimitBytes,
          maxLogChars: this.limits.maxLogChars,
          // Read the CURRENT run's signal: the session outlives the run that created it
          isAborted: () => this.active?.signal?.aborted === true,
          initialState: this.opts.initialState,
          prelude: (this.fetchEnabled ? FETCH_PRELUDE : NO_FETCH_PRELUDE) + WEB_PRELUDE,
          logger: this.log,
        });
      }
      result = await this.session.run(code, bindings, {
        timeoutMs: this.opts.sandbox?.timeoutMs,
        maxLogChars: this.limits.maxLogChars,
      });
    } catch (error: any) {
      this.log.error("Sandbox failure", error?.message || String(error));
      const message = `Sandbox unavailable (${truncateMiddle(String(error?.message || error), 200)}). Answer from what you have, or without code.`;
      outcome.result = { ok: false, logs: [], error: message };
      outcome.parts.push(`<error>${message}</error>`);
      outcome.ran = true;
      return outcome;
    }
    if (result.sessionBroken) {
      // The VM was destroyed mid-run; the next run gets a fresh one
      this.session?.dispose();
      this.session = null;
    }
    outcome.result = result;
    // Pre-execution rejections (module syntax, transpile) ran nothing
    outcome.ran = !result.rejectedBeforeExecution;
    if (outcome.endTurn) return outcome;

    // Always show which calls completed: a failed run must still tell the
    // model which side effects happened, or it re-runs them (duplicate sends).
    if (outcome.calls.length > 0) {
      outcome.parts.push(`<completed_calls>\n${indent(outcome.calls.join("\n"), 2)}\n</completed_calls>`);
    }
    if (result.logs.length > 0) {
      outcome.parts.push(`<logs>\n${indent(result.logs.join("\n"), 2)}\n</logs>`);
    }
    if (result.ok) {
      const raw =
        result.returnValue === undefined
          ? "undefined (did the code end with a return statement?)"
          : typeof result.returnValue === "string"
            ? result.returnValue
            : safeStringify(result.returnValue);
      const max = this.limits.maxReturnChars;
      const value =
        raw.length > max
          ? truncateMiddle(raw, max) +
            `\n[truncated: ${raw.length} chars total — the elided middle is unrecoverable; return less and stash raw data in state]`
          : raw;
      outcome.parts.push(`<return_value>\n${indent(value, 2)}\n</return_value>`);
    } else {
      outcome.parts.push(`<error>\n${indent(result.error || "Unknown error", 2)}\n</error>`);
    }
    return outcome;
  }

  /** Render an outcome as the tool-result text the model reads. */
  static format(outcome: CodeRunOutcome, extraParts: string[] = [], attrs = ""): string {
    const parts = [...outcome.parts, ...extraParts];
    return `<execute_code${attrs}>\n${indent(parts.join("\n"), 2)}\n</execute_code>`;
  }

  dispose(): void {
    try {
      this.session?.dispose();
    } catch (err: any) {
      this.log.warn("sandbox dispose failed", err?.message || String(err));
    }
    this.session = null;
  }

  /** The run a binding call belongs to; throws when called outside any run. */
  private currentRun(name: string): ActiveRun {
    const run = this.active;
    if (!run) throw new Error(`${name}() can only be called while execute_code is running.`);
    if (run.signal?.aborted) throw new AbortedError();
    if (run.outcome.endTurn) throw new Error(`${name}() was called after a tool ended the run.`);
    return run;
  }

  private buildBindings(): SandboxBinding[] {
    const max = this.limits.maxToolCallsPerRun;
    const bindings: SandboxBinding[] = [...this.tools.entries()].map(([name, { resolved: tool }]) => ({
      name,
      fn: async (input: unknown, hostSignal: AbortSignal) => {
        const run = this.currentRun(name);
        const { outcome } = run;
        if (++run.callCount > max) {
          throw new Error(
            `Too many function calls in one execute_code run (limit ${max}). Narrow the work to fewer calls.`,
          );
        }
        // Reject non-object args instead of silently running with {}
        if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
          throw new Error(`${name}(input) takes a single object argument, e.g. ${name}({ ... }).`);
        }
        const args = (input ?? {}) as Record<string, unknown>;
        if (args.type === "pending" && Object.keys(args).length === 1) {
          throw new Error(`${name}() received an unresolved Promise as its argument — did you forget an await?`);
        }
        this.opts.onEvent?.({ type: "tool_call", name, args });
        const digest = truncateMiddle(safeStringify(args), 200);
        const startedAt = Date.now();
        try {
          const value = await tool.run(args, {
            state: this.opts.state as TState,
            signal: anySignal([hostSignal, run.signal]) ?? hostSignal,
            logger: this.log,
          });
          outcome.calls.push(`${name}(${digest}) -> ok`);
          this.opts.onEvent?.({ type: "tool_result", name, ok: true, ms: Date.now() - startedAt });
          // A void tool: tell the model it worked rather than hand it undefined
          if (value === undefined) return "Done.";
          if (!isToolResult(value)) return value;
          if (value.files?.length) outcome.files.push(...value.files);
          if (value.images?.length) {
            outcome.images.push(...value.images.map((image) => ({ tool: name, image })));
          }
          if (value.endTurn) outcome.endTurn = value.endTurn;
          if (value.value == null) {
            const fileNames = value.files?.map((f) => f.fileName).join(", ");
            return fileNames
              ? `File(s) produced: ${fileNames}. They will be attached to your final reply automatically — do not include URLs for them.`
              : "Done.";
          }
          return value.value;
        } catch (error: any) {
          const message = String(error?.message || error);
          outcome.calls.push(`${name}(${digest}) -> error: ${truncateMiddle(message, 200)}`);
          this.opts.onEvent?.({ type: "tool_result", name, ok: false, error: message, ms: Date.now() - startedAt });
          throw error;
        }
      },
    }));

    if (this.fetchEnabled) {
      // Host side of the guest fetch() shim. Own budget, separate from the
      // tool-call cap, so fetches never produce misleading cap errors.
      bindings.push({
        name: "__fetch",
        fn: async (input: unknown, hostSignal: AbortSignal) => {
          const run = this.currentRun("fetch");
          if (++run.fetchCount > MAX_FETCHES_PER_RUN) {
            throw new Error(
              `Too many fetch() calls in one execute_code run (limit ${MAX_FETCHES_PER_RUN}). Batch the work or fetch less.`,
            );
          }
          const host = (() => {
            try {
              return new URL(String((input as any)?.url ?? input ?? "")).hostname;
            } catch {
              return "?";
            }
          })();
          try {
            const res = await sandboxFetch(input, anySignal([hostSignal, run.signal]), this.log);
            run.outcome.calls.push(`fetch(${host}) -> ${res.status}, ${Buffer.byteLength(res.body)} bytes`);
            this.opts.onEvent?.({ type: "fetch", host, status: res.status });
            return res;
          } catch (error: any) {
            const message = String(error?.message || error);
            run.outcome.calls.push(`fetch(${host}) -> error: ${truncateMiddle(message, 200)}`);
            this.opts.onEvent?.({ type: "fetch", host, error: message });
            throw error;
          }
        },
      });
    }
    return bindings;
  }
}

/** Hand-written fetch declaration (the web signature schema-to-ts can't express). */
export const FETCH_DECLARATION = `/**
 * Web-standard fetch over the public internet. GET and HEAD only — no request
 * bodies, no writes. Public http(s) URLs only (internal hosts are blocked).
 * Response body is charset-decoded text, max ${MAX_RESPONSE_BYTES / 1024 / 1024} MB; ${FETCH_TIMEOUT_MS / 1000}s timeout; up to ${MAX_FETCHES_PER_RUN}
 * fetches per execute_code run. Non-2xx responses RESOLVE (check res.ok /
 * res.status); network errors and blocked URLs throw.
 */
declare function fetch(url: string, init?: { method?: "GET" | "HEAD"; headers?: Record<string, string> }): Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
}>;`;
