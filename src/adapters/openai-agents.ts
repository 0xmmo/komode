/**
 * Code mode for the OpenAI Agents SDK (TypeScript): one `execute_code`
 * function tool that exposes your tools (and MCP servers) to the model as a
 * typed TypeScript API.
 *
 *   const agent = new Agent({ name: "helper", tools: [codeModeTool({ tools: [getWeather] })] });
 */

import { tool } from "@openai/agents";
import { createCodeModeTool, type CodeModeTool, type CodeModeToolOptions } from "../code-mode";

export type { CodeModeToolOptions } from "../code-mode";

export function codeModeTool<TState = any>(opts: CodeModeToolOptions<TState> = {}) {
  const codeMode = createCodeModeTool(opts);
  const agentsTool = tool({
    name: codeMode.name,
    description: codeMode.description,
    parameters: {
      type: "object",
      properties: { code: { type: "string", description: "TypeScript source." } },
      required: ["code"],
      additionalProperties: false,
    },
    strict: true,
    execute: async (input: any, _context?: unknown, details?: { signal?: AbortSignal }) =>
      codeMode.execute({ code: String(input?.code ?? "") }, { signal: details?.signal }),
  });
  return Object.assign(agentsTool, { codeMode }) as typeof agentsTool & { codeMode: CodeModeTool };
}
