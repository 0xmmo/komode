/**
 * The model seam. The Agent speaks a small message/response shape that is
 * structurally identical to 190proof's GenericPayload / ParsedResponseMessage,
 * so the default implementation is a direct `callWithRetries` call. Wrap or
 * replace it with `callModel` to add usage tracking, routing, caching, or a
 * different client entirely.
 */

import type { JsonSchema } from "./schema-to-ts";

export interface ModelFile {
  mimeType: string;
  url?: string;
  /** Base64 content */
  data?: string;
}

export interface ModelFunctionCall {
  /** Provider tool-call id, echoed back on the matching tool result */
  id?: string;
  name: string;
  arguments: Record<string, any>;
  /** Opaque per-call signature some providers require echoed back verbatim */
  thoughtSignature?: string;
}

export interface ModelToolResult {
  toolCallId: string;
  name?: string;
  content: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  files?: ModelFile[];
  functionCalls?: ModelFunctionCall[];
  toolResults?: ModelToolResult[];
  /** Reasoning echoed back on assistant turns (some reasoning models require it) */
  reasoning?: string;
  reasoningDetails?: unknown;
}

export interface ModelFunction {
  name: string;
  description?: string;
  parameters: JsonSchema;
}

export interface ModelRequest {
  /** 190proof model string, e.g. "anthropic:claude-sonnet-5" or "openai:gpt-5" */
  model: string;
  fallbackModel?: string;
  messages: ModelMessage[];
  functions?: ModelFunction[];
  function_call?: "none" | "auto";
  temperature?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
}

export interface ModelResponse {
  content: string | null;
  function_call?: ModelFunctionCall | null;
  function_calls?: ModelFunctionCall[];
  reasoning?: string;
  reasoningDetails?: unknown;
  /** The completion was cut short (e.g. a stream deadline) */
  truncated?: boolean;
  usage?: ModelUsage | null;
}

export type CallModel = (request: ModelRequest) => Promise<ModelResponse>;

/** Default model call: 190proof's callWithRetries (an optional peer dependency). */
export const callWith190proof: CallModel = async (request) => {
  let lib: any;
  try {
    lib = await import("190proof");
  } catch {
    throw new Error(
      'komode\'s Agent calls models through the "190proof" package. Install it (npm i 190proof), or pass your own `callModel` to the Agent.',
    );
  }
  const callWithRetries = lib.callWithRetries ?? lib.default?.callWithRetries;
  try {
    return await callWithRetries("komode", request);
  } catch (error) {
    throw toModelCallError(error);
  }
};

/** A model call failed. Carries the provider's status and message, never the request. */
export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelCallError";
  }
}

/**
 * HTTP client errors (axios in particular) carry the full request config,
 * API-key headers included, and get logged verbatim by most apps. Rebuild a
 * clean error from the parts worth keeping and drop the original — no `cause`.
 */
export function toModelCallError(error: unknown): Error {
  const e = error as any;
  if (e?.name === "AbortError" || e?.code === "ERR_CANCELED") return new ModelCallError("Model call aborted");
  const status: number | undefined = e?.response?.status ?? e?.status ?? e?.statusCode;
  const body = e?.response?.data;
  const providerMessage =
    body?.error?.message ?? body?.message ?? (typeof body === "string" ? body.slice(0, 500) : undefined);
  const message = providerMessage ?? e?.message ?? String(error);
  return new ModelCallError(`Model call failed${status ? ` (${status})` : ""}: ${message}`, status);
}
