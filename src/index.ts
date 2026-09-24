/**
 * komode — a code-mode agent runtime for TypeScript.
 *
 * Instead of chaining JSON tool calls, the model writes TypeScript against
 * your tools, which appear as typed async functions inside an in-process
 * QuickJS sandbox. Skills keep large toolsets cheap: the model loads only the
 * ones a request needs.
 *
 * Entry points:
 *   komode                  Agent, defineTool/defineSkill/defineContext, createCodeModeTool
 *   komode/sandbox          the sandbox alone (no LLM)
 *   komode/ai-sdk           execute_code tool for the Vercel AI SDK
 *   komode/openai-agents    execute_code tool for the OpenAI Agents SDK
 *   komode/mcp              MCP servers as tools or skills
 */

export {
  Agent,
  selectLoopModel,
  type AgentEvent,
  type AgentLimits,
  type AgentMessage,
  type AgentOptions,
  type AgentStep,
  type RunOptions,
  type RunResult,
} from "./agent";
export {
  BaseTool,
  defineTool,
  isToolResult,
  toolResult,
  type FileAttachment,
  type ModelImage,
  type Tool,
  type ToolClass,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./tool";
export { defineSkill, type Skill } from "./skill";
export { BaseContext, defineContext, type Context, type ContextClass, type ContextDefinition } from "./context";
export { createCodeModeTool, CODE_MODE_GUIDE, type CodeModeTool, type CodeModeToolOptions } from "./code-mode";
export { CodeRunner, type CodeRunOutcome, type RunnerEvent, type RunnerLimits, type SandboxConfig } from "./runner";
export { buildToolsApi, functionSchemaToTs, type FunctionSchema, type JsonSchema } from "./schema-to-ts";
export {
  callWith190proof,
  ModelCallError,
  toModelCallError,
  type CallModel,
  type ModelFile,
  type ModelFunction,
  type ModelFunctionCall,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolResult,
  type ModelUsage,
} from "./model";
export { AbortedError, type Logger } from "./util";
export type { Executor, SandboxResult, SandboxSession } from "./sandbox/types";
