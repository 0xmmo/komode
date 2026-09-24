import type { Logger } from "../util";

export interface SandboxBinding {
  /** Global function name exposed to guest code, e.g. "webSearch" */
  name: string;
  /**
   * Resolves with the value handed back to guest code (a string, or any
   * JSON-serializable value marshaled into a native guest value); throws to
   * reject the guest promise. `signal` aborts when the VM is disposed
   * (wall-clock timeout / abandoned run): forward it into the binding's I/O.
   */
  fn: (input: unknown, signal: AbortSignal) => Promise<unknown>;
}

export interface SandboxResult {
  ok: boolean;
  /** Captured console.log/warn/error output for this run, in order */
  logs: string[];
  /** JSON-safe dump of the script's return value (undefined if none) */
  returnValue?: unknown;
  /** Error message (with guest stack when available) on failure */
  error?: string;
  /**
   * The VM was destroyed mid-run (timeout, un-awaited work): the session
   * cannot be reused and the caller must create a fresh one (`state` is lost).
   */
  sessionBroken?: boolean;
  /**
   * The script was rejected before any code executed (module-syntax guard,
   * transpile failure): no binding ran and no guest state changed.
   */
  rejectedBeforeExecution?: boolean;
}

export interface SandboxOptions {
  /** Wall-clock limit per run, host binding calls included. Default 120s. */
  timeoutMs?: number;
  /** Guest heap limit. Default 64 MB. */
  memoryLimitBytes?: number;
  /** Cap on captured log output per run. Default 20,000 chars. */
  maxLogChars?: number;
  /**
   * Cooperative abort, polled by the interrupt handler: when it returns true
   * the guest is stopped the same way a CPU timeout stops it.
   */
  isAborted?: () => boolean;
  /**
   * Session-level only: JSON-serializable values seeded onto the guest
   * `state` object at creation, so guest code can read data that never
   * transits the model.
   */
  initialState?: Record<string, unknown>;
  /**
   * Session-level only: plain-JS (ES2020) source evaluated once at creation,
   * before any run. Not transpiled and not scanned by the module-syntax guard.
   */
  prelude?: string;
  logger?: Logger;
}

/**
 * A persistent guest VM. Globals and the `state` object survive across runs,
 * so a later script can reuse what an earlier one stashed.
 */
export interface SandboxSession {
  /**
   * Run a TypeScript script. Bindings are (re)registered before evaluation,
   * so the set may grow between runs.
   */
  run(tsCode: string, bindings: SandboxBinding[], opts?: SandboxOptions): Promise<SandboxResult>;
  dispose(): void;
}

/**
 * Where model-written code executes. komode ships the in-process QuickJS
 * executor; the interface exists so a remote one (a microVM, a Worker) can
 * drop in without touching the agent loop.
 */
export interface Executor {
  createSession(opts?: SandboxOptions): Promise<SandboxSession>;
}
