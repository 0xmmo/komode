/**
 * Framework-neutral code-mode tool: one `execute_code` function whose
 * description carries the typed API of every tool you hand it. Drop it into
 * any agent framework that accepts a JSON-schema tool; the adapters in
 * "komode/ai-sdk" and "komode/openai-agents" wrap exactly this.
 */

import { CodeRunner, FETCH_DECLARATION, type CodeRunnerOptions } from "./runner";
import { buildToolsApi, type JsonSchema } from "./schema-to-ts";
import { resolveTool, type FileAttachment, type Tool } from "./tool";

export interface CodeModeToolOptions<TState = any> extends CodeRunnerOptions<TState> {
  /** Tool name shown to the model. Default "execute_code". */
  name?: string;
  /** MCP connections (from `connectMcp`) whose tools become globals too */
  mcp?: { tools: Tool<TState>[] }[];
}

export interface CodeModeTool {
  name: string;
  /** Usage guidance plus the generated TypeScript declarations */
  description: string;
  /** JSON Schema for `{ code: string }` */
  parameters: JsonSchema;
  /**
   * Run model-written code. Resolves with the text the model should read back
   * (completed calls, logs, return value or error). Never throws for model
   * mistakes; those come back as `<error>` text so the model can fix them.
   */
  execute(input: { code: string }, opts?: { signal?: AbortSignal }): Promise<string>;
  /** Files tools produced so far (they are not otherwise visible to your framework) */
  readonly files: FileAttachment[];
  /** Release the sandbox VM. Globals and `state` persist until then. */
  dispose(): void;
}

export const CODE_MODE_GUIDE = `
Run TypeScript in a sandbox (QuickJS, ES2020 standard library).
- The functions declared below are async globals: call them with await. Each takes a single object argument. They throw on failure.
- Chain several calls in one run and use Promise.all for independent ones, instead of running one call just to look at its result.
- Write statements at the top level with await and end with \`return\`; the return value and console output come back to you. Don't wrap logic in \`async function main(){...}\`.
- A global \`state\` object persists across runs: stash large results there (state.rows = data) and return only a compact digest.
- import/require are not available.
`.trim();

export function createCodeModeTool<TState = any>(opts: CodeModeToolOptions<TState> = {}): CodeModeTool {
  const tools = [...(opts.tools ?? []), ...(opts.mcp ?? []).flatMap((m) => m.tools)];
  const runner = new CodeRunner<TState>({ ...opts, tools });
  const declarations = [buildToolsApi(tools.map((t) => resolveTool(t).schema)), runner.fetchEnabled ? FETCH_DECLARATION : null]
    .filter(Boolean)
    .join("\n\n");
  const files: FileAttachment[] = [];
  // Frameworks may run tool calls in parallel; scripts share one VM, so run
  // them one at a time rather than let them tear each other's session down.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    name: opts.name ?? "execute_code",
    description: `${CODE_MODE_GUIDE}\n\nAvailable functions:\n${declarations || "// (none: standard library only)"}`,
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "TypeScript source." },
      },
      required: ["code"],
      additionalProperties: false,
    },
    files,
    async execute(input, callOpts = {}) {
      const run = queue.then(() => runner.run(String(input?.code ?? ""), { signal: callOpts.signal }));
      queue = run.catch(() => {});
      const outcome = await run;
      files.push(...outcome.files);
      if (outcome.endTurn) {
        return outcome.endTurn.reply ?? "Done. The task is complete; no further reply is needed.";
      }
      const imageNote = outcome.images.length
        ? [`<note>${outcome.images.length} image(s) were returned by tools; this integration passes text only.</note>`]
        : [];
      return CodeRunner.format(outcome, imageNote);
    },
    dispose: () => runner.dispose(),
  };
}
