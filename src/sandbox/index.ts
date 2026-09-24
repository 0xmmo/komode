/**
 * komode/sandbox — the execution layer on its own, with no LLM dependency.
 *
 *   const sb = await createSandbox({ bindings: { add: async ({ a, b }) => a + b } });
 *   const { ok, returnValue } = await sb.run("return await add({ a: 1, b: 2 })");
 *   sb.dispose();
 */

import { FETCH_PRELUDE, MAX_FETCHES_PER_RUN, NO_FETCH_PRELUDE, WEB_PRELUDE, sandboxFetch } from "./fetch";
import { quickJSExecutor } from "./quickjs";
import type { Executor, SandboxBinding, SandboxOptions, SandboxResult } from "./types";

export type BindingFn = (input: any, signal: AbortSignal) => unknown | Promise<unknown>;

export interface CreateSandboxOptions extends Omit<SandboxOptions, "prelude"> {
  /** Host functions exposed as async globals, by name */
  bindings?: Record<string, BindingFn> | SandboxBinding[];
  /** Web-standard fetch for guest code (GET/HEAD, public URLs only, SSRF guarded). Default false here. */
  fetch?: boolean;
  /** Extra plain-JS source evaluated once at creation, after the built-in prelude */
  prelude?: string;
  executor?: Executor;
}

export interface Sandbox {
  /** Run TypeScript. Globals and `state` persist across runs until dispose(). */
  run(code: string, opts?: { timeoutMs?: number; bindings?: Record<string, BindingFn> }): Promise<SandboxResult>;
  dispose(): void;
}

export async function createSandbox(opts: CreateSandboxOptions = {}): Promise<Sandbox> {
  const { bindings, fetch = false, prelude, executor = quickJSExecutor, ...sessionOpts } = opts;
  const baseBindings = toBindings(bindings);
  const session = await executor.createSession({
    ...sessionOpts,
    prelude: (fetch ? FETCH_PRELUDE : NO_FETCH_PRELUDE) + WEB_PRELUDE + (prelude ?? ""),
  });

  return {
    async run(code, runOpts = {}) {
      const all = [...baseBindings, ...toBindings(runOpts.bindings)];
      if (fetch) {
        let count = 0;
        all.push({
          name: "__fetch",
          fn: async (input, signal) => {
            if (++count > MAX_FETCHES_PER_RUN) {
              throw new Error(`Too many fetch() calls in one run (limit ${MAX_FETCHES_PER_RUN}).`);
            }
            return sandboxFetch(input, signal, sessionOpts.logger);
          },
        });
      }
      return session.run(code, all, { timeoutMs: runOpts.timeoutMs ?? sessionOpts.timeoutMs, maxLogChars: sessionOpts.maxLogChars });
    },
    dispose: () => session.dispose(),
  };
}

function toBindings(bindings?: Record<string, BindingFn> | SandboxBinding[]): SandboxBinding[] {
  if (!bindings) return [];
  if (Array.isArray(bindings)) return bindings;
  return Object.entries(bindings).map(([name, fn]) => ({ name, fn: async (input, signal) => fn(input, signal) }));
}

export { createSandboxSession, runCodeInSandbox, quickJSExecutor, hasTopLevelModuleSyntax, transpileForSandbox } from "./quickjs";
export { sandboxFetch, decodeBody, MAX_FETCHES_PER_RUN, MAX_RESPONSE_BYTES, FETCH_TIMEOUT_MS } from "./fetch";
export {
  assertPublicUrl,
  BlockedUrlError,
  guardedHttp,
  hostBlockReason,
  isBlockedUrlError,
  isPrivateIp,
  safeGet,
  urlGuardConfig,
} from "./safe-url";
export type { Executor, SandboxBinding, SandboxOptions, SandboxResult, SandboxSession } from "./types";
