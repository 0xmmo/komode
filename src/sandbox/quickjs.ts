/**
 * QuickJS WASM sandbox for running model-written TypeScript against
 * host-provided bindings (code-mode execution).
 *
 * Bindings are exposed to the guest as global async functions. Each binding
 * call creates a guest promise that the host settles when the real function
 * finishes, so guest code can use await and Promise.all freely.
 *
 * A SandboxSession persists VM state across runs (CodeAct-style): a global
 * `state` object lets scripts stash raw data (state.results = ...) so later
 * scripts can use it without the data ever entering the model's context —
 * only what a script returns or logs does.
 */

import * as ts from "typescript";
import releaseSyncVariant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  QuickJSContext,
  QuickJSHandle,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { silentLogger, truncateMiddle } from "../util";
import type {
  Executor,
  SandboxBinding,
  SandboxOptions,
  SandboxResult,
  SandboxSession,
} from "./types";

let quickJSModule: Promise<QuickJSWASMModule> | null = null;
function getQuickJS(): Promise<QuickJSWASMModule> {
  if (!quickJSModule) {
    quickJSModule = newQuickJSWASMModuleFromVariant(releaseSyncVariant).catch((error) => {
      // A transient load failure must not poison every later run
      quickJSModule = null;
      throw error;
    });
  }
  return quickJSModule;
}

/**
 * An Emscripten abort (e.g. QuickJS's JS_FreeRuntime leak assertion firing on
 * teardown after a guest OOM mid-continuation) permanently poisons the WASM
 * module instance — every later call on any runtime from it throws. Drop the
 * cached module so the next session loads a fresh instance instead of every
 * sandbox run in this process failing until restart. Returns whether the
 * error was such an abort.
 */
function resetQuickJSModuleIfAborted(error: unknown): boolean {
  const isAbort =
    error instanceof WebAssembly.RuntimeError ||
    String((error as any)?.message ?? error).includes("Aborted(");
  if (isAbort) quickJSModule = null;
  return isAbort;
}

// Wall-clock per run, host calls included. Generous so slow tools (LLM
// sub-calls, scrapers) surface as errors the model can react to rather than
// the caller's own deadline killing the whole turn first.
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LOG_CHARS = 20_000;
/** Guest CPU budget per synchronous slice (interrupt handler deadline) */
const CPU_SLICE_MS = 5_000;

/**
 * True when the script itself uses top-level module syntax (import/export
 * declarations, `export` modifiers, `export =`). Checked on the AST rather
 * than the raw text: generated file content inside string/template literals
 * legitimately contains lines starting with `import`/`export` (Python, JS,
 * shell), and the raw-text regex this replaces rejected those scripts —
 * models then burned execute_code budget on retries and obfuscated the
 * keyword via String.fromCharCode to get past it (prod, 2026-07-02).
 */
export function hasTopLevelModuleSyntax(tsCode: string): boolean {
  const sourceFile = ts.createSourceFile(
    "agent-code.ts",
    tsCode,
    ts.ScriptTarget.ES2020,
  );
  return sourceFile.statements.some(
    (stmt) =>
      ts.isImportDeclaration(stmt) ||
      ts.isImportEqualsDeclaration(stmt) ||
      ts.isExportDeclaration(stmt) ||
      ts.isExportAssignment(stmt) ||
      (ts.canHaveModifiers(stmt) &&
        (ts.getModifiers(stmt) ?? []).some(
          (mod) => mod.kind === ts.SyntaxKind.ExportKeyword,
        )),
  );
}

/** Strip TypeScript types; the guest runs plain ES2020. */
export function transpileForSandbox(tsCode: string): string {
  return ts.transpileModule(tsCode, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.None,
    },
  }).outputText;
}

function stringifyDumped(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function createSandboxSession(
  sessionOpts: SandboxOptions = {},
): Promise<SandboxSession> {
  const memoryLimitBytes =
    sessionOpts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES;
  const log = sessionOpts.logger ?? silentLogger;

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimitBytes);
  runtime.setMaxStackSize(1024 * 1024);

  // Two timeout layers, shared across runs via mutable deadlines: the
  // interrupt handler stops guest CPU loops; the wall-clock deadline (raced
  // per run) covers time spent awaiting host tool calls, during which the
  // interpreter isn't running.
  let wallDeadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let cpuDeadline = Date.now() + CPU_SLICE_MS;
  let timedOut = false;
  let disposed = false;
  // Aborted when the VM is disposed (wall-clock timeout / abandoned run) so any
  // in-flight host tool I/O is actually cancelled, not just ignored on return.
  const hostAbort = new AbortController();
  const isAborted = sessionOpts.isAborted;
  runtime.setInterruptHandler(() => {
    if (timedOut || disposed || Date.now() > wallDeadline) return true;
    if (isAborted?.()) return true;
    return Date.now() > cpuDeadline;
  });

  const ctx = runtime.newContext();
  /** Deferreds not yet settled; disposed explicitly if the session is abandoned */
  const pendingDeferreds = new Set<{ dispose: () => void }>();
  const onSettle = () => {
    cpuDeadline = Date.now() + CPU_SLICE_MS;
    return disposed;
  };

  // Per-run log sink; the console handles close over this holder
  let currentLogs: string[] = [];
  let logChars = 0;
  let maxLogChars = sessionOpts.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;
  const pushLog = (line: string) => {
    if (logChars >= maxLogChars) return;
    const remaining = maxLogChars - logChars;
    const entry =
      line.length > remaining ? truncateMiddle(line, remaining) : line;
    currentLogs.push(entry);
    logChars += entry.length;
  };

  setupConsole(ctx, pushLog);
  // Persistent scratch space across runs: scripts stash raw data here
  // (state.results = ...) instead of returning it to the model
  ctx.unwrapResult(ctx.evalCode("globalThis.state = {};")).dispose();

  // Pristine JSON.parse captured before any guest code runs. Tool-return
  // marshaling (hostValueToHandle) calls THIS handle rather than resolving
  // `JSON.parse` from guest scope at call time, so a script that reassigns
  // globalThis.JSON.parse can't corrupt or downgrade later tool results.
  const jsonParse = ctx.unwrapResult(ctx.evalCode("JSON.parse"));

  // Own filename so model-code stack traces keep their exact line numbers.
  // A broken prelude throws here (our bug, not the model's) and surfaces
  // through the caller's "Sandbox unavailable" handling.
  if (sessionOpts.prelude) {
    ctx
      .unwrapResult(ctx.evalCode(sessionOpts.prelude, "sandbox-prelude.js"))
      .dispose();
  }

  if (sessionOpts.initialState) {
    const stateHandle = ctx.unwrapResult(ctx.evalCode("globalThis.state"));
    for (const [key, value] of Object.entries(sessionOpts.initialState)) {
      const valueHandle = hostValueToHandle(ctx, jsonParse, value);
      ctx.setProp(stateHandle, key, valueHandle);
      valueHandle.dispose();
    }
    stateHandle.dispose();
  }

  async function run(
    tsCode: string,
    bindings: SandboxBinding[],
    opts: SandboxOptions = {},
  ): Promise<SandboxResult> {
    if (disposed) {
      return { ok: false, logs: [], error: "Sandbox session is disposed" };
    }

    const timeoutMs = opts.timeoutMs ?? sessionOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    maxLogChars =
      opts.maxLogChars ?? sessionOpts.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;
    currentLogs = [];
    logChars = 0;
    const logs = currentLogs;
    timedOut = false;
    wallDeadline = Date.now() + timeoutMs;
    cpuDeadline = Date.now() + CPU_SLICE_MS;

    // ModuleKind.None still emits CommonJS for module syntax, and the guest
    // has no `exports`/`require` — fail with an actionable message instead of
    // a baffling ReferenceError.
    if (hasTopLevelModuleSyntax(tsCode)) {
      return {
        ok: false,
        logs,
        error:
          "import/export are not available in the sandbox. All available functions are already globals — call them directly.",
        rejectedBeforeExecution: true,
      };
    }

    let js: string;
    try {
      js = transpileForSandbox(tsCode);
    } catch (error: any) {
      return {
        ok: false,
        logs,
        error: `TypeScript transpile error: ${error?.message || String(error)}`,
        rejectedBeforeExecution: true,
      };
    }

    try {
      // (Re)register bindings — overwriting an existing global is fine, and
      // per-script closures get refreshed per run
      for (const binding of bindings) {
        setupBinding(
          ctx,
          jsonParse,
          binding,
          pendingDeferreds,
          onSettle,
          hostAbort.signal,
        );
      }

      const wrapped = `(async () => {\n${js}\n})()`;
      const evalResult = ctx.evalCode(wrapped, "agent-code.js");
      if (evalResult.error) {
        const err = ctx.dump(evalResult.error);
        evalResult.error.dispose();
        return { ok: false, logs, error: formatGuestError(err, bindings) };
      }

      const promiseHandle = evalResult.value;
      const settled = ctx.resolvePromise(promiseHandle);
      promiseHandle.dispose();
      // On failure the result carries a live error handle — dispose it, or it
      // keeps a guest object alive and trips JS_FreeRuntime's leak assertion.
      ctx.runtime.executePendingJobs().dispose();

      const timeout = new Promise<"timeout">((resolve) => {
        const timer = setTimeout(
          () => resolve("timeout"),
          Math.max(0, wallDeadline - Date.now()),
        );
        // Don't keep the process alive for the timer alone
        if (typeof timer === "object" && "unref" in timer) timer.unref();
      });

      const outcome = await Promise.race([settled, timeout]);
      if (outcome === "timeout") {
        timedOut = true;
        // Destroy the VM so the abandoned script can never resume when its
        // pending host call settles (it would otherwise run as a zombie inside
        // the next script: stale side effects, logs, messages sent twice).
        dispose();
        return {
          ok: false,
          logs,
          sessionBroken: true,
          error:
            `Execution timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            `The sandbox was reset: variables and \`state\` are gone, and the script's remaining statements will never run ` +
            `(side effects of calls that were already in flight may still complete — do not blindly re-run them).`,
        };
      }

      if (outcome.error) {
        const err = ctx.dump(outcome.error);
        outcome.error.dispose();
        // The script threw while a host call it started is still in flight
        // (e.g. an un-awaited `sendEmail(...)` before a throw): that call
        // would resume/leak into the next run. Reset the VM so it can't zombie
        // (same as the un-awaited-success guard below); the guest's own error
        // stays the surfaced signal. An awaited tool failure does NOT trip this
        // — its deferred is deleted before the rejection reaches the wrapper.
        if (pendingDeferreds.size > 0) {
          dispose();
          return {
            ok: false,
            logs,
            sessionBroken: true,
            error: formatGuestError(err, bindings),
          };
        }
        return { ok: false, logs, error: formatGuestError(err, bindings) };
      }

      // The wrapper resolved while a host (tool) call it started is still
      // pending: the script kicked off async work without awaiting it — almost
      // always `async function main(){...}` followed by a bare `main();` (which
      // is fire-and-forget) instead of `return main()`, or a missing `await` on
      // a tool call. Left running, that work would resume the guest AFTER this
      // run returns and leak its side effects (files produced, messages sent)
      // into a later run. Reject loudly
      // and reset the VM (as with a wall-clock timeout) so the model re-runs it
      // with everything awaited.
      if (pendingDeferreds.size > 0) {
        outcome.value.dispose();
        dispose();
        return {
          ok: false,
          logs,
          sessionBroken: true,
          error:
            "Your code returned while a function call it started was still running — async work was not awaited. " +
            "This usually means you wrote `async function main(){...}` then called `main();` instead of `return main()`, " +
            "or you missed an `await` on a call. Put your statements at the top level with `await` and end with a `return` " +
            "(don't wrap logic in a main() function), then re-run.",
        };
      }

      const returnValue = ctx.dump(outcome.value);
      outcome.value.dispose();
      return { ok: true, logs, returnValue };
    } catch (error: any) {
      if (resetQuickJSModuleIfAborted(error)) {
        log.warn(
          "sandbox-wasm-aborted mid-run, module cache reset",
          error?.message || String(error),
        );
      }
      return {
        ok: false,
        logs,
        error: `Sandbox error: ${error?.message || String(error)}`,
      };
    }
  }

  function dispose() {
    if (disposed) return;
    // Synchronous teardown: later binding callbacks observe `disposed` and
    // skip the VM (resolve-after-dispose is a documented no-op).
    disposed = true;
    try {
      // Cancel in-flight host tool I/O (fetch/axios/LLM sub-calls) rather than
      // letting it run to completion after the VM is gone.
      hostAbort.abort();
      for (const deferred of pendingDeferreds) deferred.dispose();
      pendingDeferreds.clear();
      jsonParse.dispose();
      ctx.dispose();
      runtime.dispose();
    } catch (error: any) {
      // Teardown failure must never surface as a response error — in
      // production it replaced already-computed replies with a generic
      // failure. Known trigger: a guest OOM inside an
      // await-continuation leaks GC objects engine-side, so JS_FreeRuntime's
      // list_empty(&rt->gc_obj_list) assertion aborts the WASM module.
      const poisoned = resetQuickJSModuleIfAborted(error);
      log.warn(
        `sandbox-dispose-failed${poisoned ? " (wasm module aborted, cache reset)" : ""}`,
        error?.message || String(error),
      );
    }
  }

  return { run, dispose };
}

/** The default executor: an in-process QuickJS WASM VM per session. */
export const quickJSExecutor: Executor = {
  createSession: (opts) => createSandboxSession(opts),
};

/** One-shot convenience: create a session, run once, dispose. */
export async function runCodeInSandbox(
  tsCode: string,
  bindings: SandboxBinding[],
  opts: SandboxOptions = {},
): Promise<SandboxResult> {
  const session = await createSandboxSession(opts);
  try {
    return await session.run(tsCode, bindings, opts);
  } finally {
    session.dispose();
  }
}

function setupConsole(ctx: QuickJSContext, pushLog: (line: string) => void) {
  const consoleHandle = ctx.newObject();
  for (const level of ["log", "warn", "error"] as const) {
    const fnHandle = ctx.newFunction(level, (...argHandles) => {
      const parts = argHandles.map((h) => stringifyDumped(ctx.dump(h)));
      const prefix = level === "log" ? "" : `[${level}] `;
      pushLog(prefix + parts.join(" "));
    });
    ctx.setProp(consoleHandle, level, fnHandle);
    fnHandle.dispose();
  }
  ctx.setProp(ctx.global, "console", consoleHandle);
  consoleHandle.dispose();
}

/**
 * Marshal a host value (a tool's return) into a guest handle. Strings map
 * directly, null/undefined map to themselves, and everything else round-trips
 * through JSON so the guest receives a native object/array/number/boolean.
 *
 * `jsonParse` is a pristine JSON.parse handle captured at session init — we
 * call it rather than the guest's `JSON.parse` so a script that reassigned
 * that global can't corrupt or silently downgrade tool results.
 */
function hostValueToHandle(
  ctx: QuickJSContext,
  jsonParse: QuickJSHandle,
  value: unknown,
): QuickJSHandle {
  if (typeof value === "string") return ctx.newString(value);
  if (value === undefined) return ctx.undefined;
  if (value === null) return ctx.null;

  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } catch {
    json = undefined; // circular or otherwise unserializable
  }
  if (json === undefined) return ctx.newString(String(value));

  // Parse the JSON into a native guest value via the pristine parser handle.
  const jsonHandle = ctx.newString(json);
  const parsed = ctx.callFunction(jsonParse, ctx.undefined, jsonHandle);
  jsonHandle.dispose();
  if (parsed.error) {
    parsed.error.dispose();
    return ctx.newString(json); // fall back to the raw JSON string
  }
  return parsed.value;
}

function setupBinding(
  ctx: QuickJSContext,
  jsonParse: QuickJSHandle,
  binding: SandboxBinding,
  pendingDeferreds: Set<{ dispose: () => void }>,
  onSettle: () => boolean,
  signal: AbortSignal,
) {
  const fnHandle = ctx.newFunction(binding.name, (inputHandle?: QuickJSHandle) => {
    const input = inputHandle ? ctx.dump(inputHandle) : undefined;
    const deferred = ctx.newPromise();
    pendingDeferreds.add(deferred);

    void binding
      .fn(input, signal)
      .then(
        (result) => {
          if (onSettle()) return;
          const resultHandle = hostValueToHandle(ctx, jsonParse, result);
          try {
            deferred.resolve(resultHandle);
          } finally {
            // resolve() throws when the call into the VM fails (allocation at
            // the memory limit, interrupt) — the handle must die regardless.
            resultHandle.dispose();
          }
        },
        (error: any) => {
          if (onSettle()) return;
          const errorHandle = ctx.newError(
            String(error?.message || error || "Unknown error"),
          );
          try {
            deferred.reject(errorHandle);
          } finally {
            errorHandle.dispose();
          }
        },
      )
      .then(() => {
        pendingDeferreds.delete(deferred);
        // On failure the result carries a live error handle (interrupted /
        // OOM'd job) — dispose it or it outlives the session and trips
        // JS_FreeRuntime's leak assertion.
        if (!onSettle()) ctx.runtime.executePendingJobs().dispose();
      })
      .catch((error: any) => {
        // Settling into the VM failed (e.g. allocation at the memory limit).
        // Dispose the deferred (safe when partially settled) so its handles
        // don't leak; the run then ends via its wall-clock timeout instead of
        // an unhandled rejection.
        resetQuickJSModuleIfAborted(error);
        pendingDeferreds.delete(deferred);
        try {
          deferred.dispose();
        } catch {
          // teardown-of-teardown: nothing left to do
        }
      });

    return deferred.handle;
  });
  ctx.setProp(ctx.global, binding.name, fnHandle);
  fnHandle.dispose();
}

function formatGuestError(
  dumped: unknown,
  bindings: SandboxBinding[]
): string {
  if (dumped && typeof dumped === "object") {
    const err = dumped as { name?: string; message?: string; stack?: string };
    const head = [err.name, err.message].filter(Boolean).join(": ");
    if (head) {
      let out = err.stack ? `${head}\n${err.stack}` : head;
      // An unbound function name gets a bare ReferenceError, after which
      // models tend to brute-force more guesses instead of using a real
      // function — list what's actually callable so one retry lands. A real
      // function that simply isn't loaded yet reads as "doesn't exist", so
      // name both possibilities.
      if (
        err.name === "ReferenceError" &&
        /is not defined/.test(err.message ?? "")
      ) {
        const names = bindings
          .map((b) => b.name)
          .filter((n) => !n.startsWith("__"));
        if (names.length > 0) {
          out += `\nAvailable functions: ${names.join(", ")}`;
        }
        out +=
          "\nIt may not exist, or it may be gated behind a skill you have not loaded.";
      }
      return out;
    }
  }
  return stringifyDumped(dumped);
}
