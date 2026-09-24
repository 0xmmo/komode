/**
 * Tools: the functions model-written code can call. A tool is a JSON-schema'd
 * function; inside execute_code it appears as a typed async global
 * (`await getWeather({ city: "Cairo" })`). Results resolve, errors throw.
 *
 * Define one with `defineTool({...})`, or subclass `BaseTool` when the tool
 * needs its own state or helpers. Both forms are accepted everywhere.
 */

import type { FunctionSchema, JsonSchema } from "./schema-to-ts";
import type { Logger } from "./util";

/** A file a tool produced; collected across the run and returned with the reply. */
export interface FileAttachment {
  fileName: string;
  mimeType: string;
  /** Where the file lives, if hosted */
  url?: string;
  /** Base64 content, if inline */
  data?: string;
}

/**
 * An image for the model itself to look at (not for the end user). Shown to
 * the model right after the current execute_code returns.
 */
export interface ModelImage {
  mimeType: string;
  /** Base64 content */
  data: string;
  /** Optional source URL, quoted to the model alongside the pixels */
  url?: string;
}

/** Per-call context handed to every tool. */
export interface ToolContext<TState = unknown> {
  /** Caller-defined state passed to `agent.run(..., { state })` */
  state: TState;
  /** Aborts when the run is cancelled or the sandbox VM is torn down */
  signal: AbortSignal;
  logger: Logger;
}

const TOOL_RESULT = Symbol.for("komode.toolResult");

/** A rich tool return: a value plus side outputs. Build it with `toolResult()`. */
export interface ToolResult {
  /** Value handed back to the model's code (any JSON-serializable value) */
  value?: unknown;
  /** Files attached to the final reply */
  files?: FileAttachment[];
  /** Images shown to the model after this execute_code returns */
  images?: ModelImage[];
  /**
   * End the agent run now. `reply` becomes the final text (null: end with no
   * reply). Later calls in the same script are blocked.
   */
  endTurn?: { reply: string | null };
}

/**
 * Wrap a tool's return when it carries files, images or an endTurn signal.
 * A plain return value is fine otherwise.
 */
export function toolResult(result: ToolResult): ToolResult {
  return Object.assign(Object.create(null), result, { [TOOL_RESULT]: true });
}

export function isToolResult(value: unknown): value is ToolResult {
  return typeof value === "object" && value !== null && (value as any)[TOOL_RESULT] === true;
}

/** A tool defined as a plain object. */
export interface ToolDefinition<TState = any, TArgs = any> {
  /** Global function name in the sandbox; must be a valid JS identifier */
  name: string;
  /** What it does, when to use it, what it returns. Shown to the model as JSDoc. */
  description: string;
  /** JSON Schema for the single object argument */
  parameters?: JsonSchema;
  /** JSON Schema for the resolved value; without it the model sees `Promise<string>` */
  returns?: JsonSchema;
  run(args: TArgs, ctx: ToolContext<TState>): unknown | Promise<unknown>;
}

/** Define a tool as a plain object. */
export function defineTool<TArgs = any, TState = any>(
  def: ToolDefinition<TState, TArgs>,
): ToolDefinition<TState, TArgs> {
  assertIdentifier(def.name, "Tool name");
  return def;
}

/**
 * Class form of a tool: declare `static schema` and implement `execute`.
 * A fresh instance is constructed per call, with `this.ctx` set.
 */
export abstract class BaseTool<TState = any, TArgs = any> {
  static schema: FunctionSchema;

  constructor(protected readonly ctx: ToolContext<TState>) {}

  protected get state(): TState {
    return this.ctx.state;
  }

  abstract execute(args: TArgs): unknown | Promise<unknown>;
}

export interface ToolClass<TState = any> {
  schema: FunctionSchema;
  new (ctx: ToolContext<TState>): BaseTool<TState>;
}

/** Either tool form. */
export type Tool<TState = any> = ToolDefinition<TState> | ToolClass<TState>;

/** Normalized tool shape used internally by the runner. */
export interface ResolvedTool<TState = any> {
  schema: FunctionSchema;
  run(args: Record<string, unknown>, ctx: ToolContext<TState>): Promise<unknown>;
}

export function resolveTool<TState>(tool: Tool<TState>): ResolvedTool<TState> {
  if (typeof tool === "function") {
    const ToolClass = tool;
    if (!ToolClass.schema?.name) {
      throw new Error(`Tool class ${ToolClass.name} is missing a static schema with a name`);
    }
    assertIdentifier(ToolClass.schema.name, "Tool name");
    return {
      schema: ToolClass.schema,
      run: async (args, ctx) => new ToolClass(ctx).execute(args),
    };
  }
  assertIdentifier(tool.name, "Tool name");
  return {
    schema: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      returns: tool.returns,
    },
    run: async (args, ctx) => tool.run(args, ctx),
  };
}

/** Keywords, and sandbox/standard globals a tool must not shadow. */
export const RESERVED_NAMES = new Set([
  // keywords and reserved words
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in",
  "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "yield", "let", "static", "implements", "interface",
  "package", "private", "protected", "public", "await", "async", "arguments", "eval", "undefined",
  "NaN", "Infinity",
  // globals the sandbox and model code rely on
  "state", "console", "fetch", "require", "Buffer", "btoa", "atob", "TextEncoder", "TextDecoder",
  "globalThis", "JSON", "Math", "Object", "Array", "String", "Number", "Boolean", "Promise", "Date",
  "RegExp", "Map", "Set", "Error", "Symbol",
]);

export function assertIdentifier(name: string, label: string): void {
  if (!/^[A-Za-z_$][\w$]*$/.test(name ?? "")) {
    throw new Error(`${label} "${name}" must be a valid JavaScript identifier`);
  }
  if (RESERVED_NAMES.has(name) || name.startsWith("__")) {
    throw new Error(`${label} "${name}" is reserved in the sandbox; pick another name`);
  }
}
