import type { ModelRequest, ModelResponse } from "../src/model";

type Step = ModelResponse | ((req: ModelRequest) => ModelResponse);

/**
 * A scripted fake model: returns the given responses in order and records
 * every request, so loop behavior can be asserted without any API key.
 */
export function scriptedModel(steps: Step[]) {
  const requests: ModelRequest[] = [];
  let i = 0;
  const callModel = async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(structuredClone({ ...req, signal: undefined }));
    const step = steps[i++];
    if (!step) throw new Error(`scriptedModel: no response scripted for call ${i}`);
    return typeof step === "function" ? step(req) : step;
  };
  return { callModel, requests, get calls() { return i; } };
}

export const text = (content: string): ModelResponse => ({ content, function_calls: [] });

export const code = (source: string, extra: Partial<ModelResponse> = {}): ModelResponse => ({
  content: extra.content ?? null,
  function_calls: [{ id: `c${Math.random().toString(36).slice(2, 7)}`, name: "execute_code", arguments: { code: source } }],
  ...extra,
});

export const useSkills = (...skills: string[]): ModelResponse => ({
  content: null,
  function_calls: [{ id: `s${Math.random().toString(36).slice(2, 7)}`, name: "use_skills", arguments: { skills } }],
});

/** The last tool-result text the model was shown before this request. */
export function lastToolResult(req: ModelRequest): string {
  const tools = req.messages.filter((m) => m.role === "tool");
  const last = tools[tools.length - 1];
  return last?.toolResults?.map((r) => r.content).join("\n") ?? "";
}
