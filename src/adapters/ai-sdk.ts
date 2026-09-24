/**
 * Code mode for the Vercel AI SDK: one `execute_code` tool that exposes your
 * tools (and MCP servers) to the model as a typed TypeScript API.
 *
 *   const executeCode = codeModeTool({ tools: [getWeather] });
 *   await generateText({ model, tools: { execute_code: executeCode }, prompt });
 */

import { jsonSchema, tool } from "ai";
import { createCodeModeTool, type CodeModeTool, type CodeModeToolOptions } from "../code-mode";

export type { CodeModeToolOptions } from "../code-mode";

export function codeModeTool<TState = any>(opts: CodeModeToolOptions<TState> = {}) {
  const codeMode = createCodeModeTool(opts);
  const aiTool = tool({
    description: codeMode.description,
    inputSchema: jsonSchema<{ code: string }>(codeMode.parameters as any),
    execute: async (input: { code: string }, options: { abortSignal?: AbortSignal }) =>
      codeMode.execute(input, { signal: options?.abortSignal }),
  });
  return Object.assign(aiTool, { codeMode }) as typeof aiTool & { codeMode: CodeModeTool };
}
