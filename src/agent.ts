/**
 * The code-mode agent loop.
 *
 * The model sees exactly two functions:
 * - use_skills: injects skills' instructions/contexts and unlocks their tools
 * - execute_code: runs model-written TypeScript in a sandbox, with loaded
 *   skills' tools (and the agent's global tools) available as typed globals
 *
 * A run ends when the model replies with plain text, a tool ends it
 * (toolResult({ endTurn })), or the iteration cap is reached — in which case
 * one wrap-up call asks for the best answer from what was gathered.
 *
 * Extracted from the production agent behind Olly (olly.bot); the budgets,
 * guards and error steering here each exist because a real model tripped on
 * their absence.
 */

import { renderContext, type Context } from "./context";
import {
  callWith190proof,
  type CallModel,
  type ModelFunction,
  type ModelFunctionCall,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolResult,
} from "./model";
import { codeModeInstructions, DEFAULT_INSTRUCTIONS, EXECUTE_CODE_SCHEMA, useSkillsSchema } from "./prompt";
import { CodeRunner, FETCH_DECLARATION, type RunnerEvent, type RunnerLimits, type SandboxConfig } from "./runner";
import { buildToolsApi } from "./schema-to-ts";
import type { Skill } from "./skill";
import { resolveTool, type FileAttachment, type ModelImage, type Tool } from "./tool";
import { AbortedError, indent, safeStringify, silentLogger, truncateMiddle, type Logger } from "./util";

export interface AgentLimits extends RunnerLimits {
  /** execute_code calls per run; skills can raise it via maxExecuteCalls. Default 10. */
  maxExecuteCalls?: number;
  /**
   * use_skills calls per run. After this many, use_skills is withdrawn so the
   * model must proceed with code (weak models loop re-loading skills). Default 2.
   */
  maxUseSkillsCalls?: number;
  /** Tool-injected images kept visible in the transcript (oldest evicted). Default 3. */
  maxVisibleImages?: number;
}

export interface AgentOptions<TState = any> {
  /** Model for every step, as a 190proof model string (e.g. "anthropic:claude-sonnet-5") */
  model: string;
  /** Model for steps that carry images; defaults to `model` */
  visionModel?: string;
  /** Retried with when the primary model call fails */
  fallbackModel?: string;
  /**
   * Whether a model accepts images. Decides if a skill's model override may
   * run an image-bearing step or defers to `visionModel`. Default: always true.
   */
  imageCapable?: (model: string) => boolean;
  /** Your system prompt: who the agent is and how it should behave */
  instructions?: string | ((state: TState) => string | Promise<string>);
  /** Skills the model can load with use_skills */
  skills?: Skill<TState>[];
  /** Tools available in every execute_code run, no skill needed */
  tools?: Tool<TState>[];
  /** Contexts rendered into the system message on every run */
  contexts?: Context<TState>[];
  sandbox?: SandboxConfig;
  limits?: AgentLimits;
  /**
   * Seed the sandbox's `state.messages` with the conversation's full text so
   * code can pass user content to tools verbatim. Default true.
   */
  exposeMessagesToCode?: boolean;
  /**
   * Replace or wrap the model call. Receives the request and the default
   * implementation (190proof's callWithRetries).
   */
  callModel?: (request: ModelRequest, defaultCall: CallModel) => Promise<ModelResponse>;
  temperature?: number;
  logger?: Logger;
}

/** A conversation message handed to `agent.run`. */
export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
  /** Images (or other files your model accepts) on this message */
  files?: { mimeType: string; url?: string; data?: string }[];
}

export type AgentEvent =
  | RunnerEvent
  | { type: "model_call"; model: string; step: number }
  /** Text the model wrote alongside a tool call: a progress note for the user */
  | { type: "narration"; text: string }
  | { type: "skills_loaded"; skills: string[] }
  | { type: "code"; code: string; purpose?: string }
  | { type: "code_result"; ok: boolean; output: string };

export interface RunOptions<TState = any> {
  /** Caller-defined state handed to every tool, context and instructions function */
  state?: TState;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentStep =
  | { type: "use_skills"; skills: string[]; output: string }
  | { type: "execute_code"; code: string; purpose?: string; ok: boolean; output: string };

export interface RunResult {
  /** Final reply; null when a tool ended the run without one */
  text: string | null;
  /** Files tools produced during the run */
  files: FileAttachment[];
  /** use_skills / execute_code calls, in order */
  steps: AgentStep[];
  /** Skills loaded during the run */
  skillsLoaded: string[];
  usage: {
    modelCalls: number;
    executeCalls: number;
    promptTokens: number;
    completionTokens: number;
  };
  /** How the run ended */
  stopReason: "reply" | "end_turn" | "wrap_up" | "fallback";
  /** The native transcript (assistant tool calls + tool results) this run produced */
  transcript: ModelMessage[];
}

const DEFAULT_LIMITS = {
  maxExecuteCalls: 10,
  maxUseSkillsCalls: 2,
  maxVisibleImages: 3,
};

const FALLBACK_MESSAGE = "I'm sorry, I was unable to complete your request. Please try again.";

/**
 * A tool call emitted as literal text instead of through the function-calling
 * interface. Several OpenAI-compatible endpoints miss the model's own
 * tool-call syntax and return it as content; shipping that verbatim shows the
 * user raw markup and silently skips the action. Retry with a steering error.
 */
const TOOL_CALL_AS_TEXT_RE =
  /<(?:use|load)_skills\b|<execute_code\b|<tool_call\b|<invoke name="(?:use|load)_skills"|<invoke name="execute_code"/;

const TOOL_CALL_AS_TEXT_ERROR =
  "<error>Your tool call was written as plain text — it was NOT executed and NOT shown to the user. Emit use_skills/execute_code through the function-calling interface only, or reply with the final plain-text answer. Never write these tags in reply text.</error>";

const stripToolCallAsText = (content: string): string => {
  const idx = content.search(TOOL_CALL_AS_TEXT_RE);
  return idx === -1 ? content : content.slice(0, idx).trim();
};

const UNDEFINED_GLOBAL_RE = /\bReferenceError: ['"`]?([A-Za-z_$][\w$]*)['"`]? is not defined/;

/**
 * Pick the model for one loop step. Any loaded skill that declares a model
 * overrides the loop (last loaded wins). Image-bearing steps keep an override
 * only when it accepts images; otherwise they use the vision model.
 */
export function selectLoopModel(
  loadedSkills: Skill[],
  models: { text: string; vision: string },
  stepHasImages: boolean,
  imageCapable: (model: string) => boolean = () => true,
): string {
  const base = stepHasImages ? models.vision : models.text;
  let override: string | undefined;
  for (const skill of loadedSkills) if (skill.model) override = skill.model;
  if (!override) return base;
  if (stepHasImages && !imageCapable(override)) return base;
  return override;
}

export class Agent<TState = any> {
  private readonly limits: Required<AgentLimits>;
  private readonly log: Logger;
  private readonly skills: Skill<TState>[];

  constructor(private readonly options: AgentOptions<TState>) {
    if (!options?.model) throw new Error("Agent needs a `model`");
    this.limits = {
      maxToolCallsPerRun: 25,
      maxReturnChars: 50_000,
      maxLogChars: 8_000,
      ...DEFAULT_LIMITS,
      ...options.limits,
    };
    this.log = options.logger ?? silentLogger;
    this.skills = options.skills ?? [];
    const names = new Set<string>();
    for (const skill of this.skills) {
      if (names.has(skill.name)) throw new Error(`Duplicate skill name "${skill.name}"`);
      names.add(skill.name);
    }
    // Validate tool shapes and names up front rather than mid-run. The same
    // tool object may appear in several skills; two different tools may not
    // share a name.
    const byName = new Map<string, Tool<TState>>();
    for (const tool of [...(options.tools ?? []), ...this.skills.flatMap((s) => s.tools ?? [])]) {
      const { name } = resolveTool(tool).schema;
      const existing = byName.get(name);
      if (existing && existing !== tool) {
        throw new Error(`Two different tools are named "${name}". Rename one (MCP skills take a \`prefix\`).`);
      }
      byName.set(name, tool);
    }
  }

  /** Run the agent on a conversation (or a single user message) until it replies. */
  async run(input: string | AgentMessage[], runOptions: RunOptions<TState> = {}): Promise<RunResult> {
    const messages: AgentMessage[] = typeof input === "string" ? [{ role: "user", content: input }] : input;
    const state = runOptions.state as TState;
    const signal = runOptions.signal;
    const emit = (event: AgentEvent) => {
      try {
        runOptions.onEvent?.(event);
      } catch (err: any) {
        this.log.warn("onEvent handler threw", err?.message || String(err));
      }
    };
    const throwIfAborted = () => {
      if (signal?.aborted) throw new AbortedError();
    };
    throwIfAborted();

    const globalTools = this.options.tools ?? [];
    const runner = new CodeRunner<TState>({
      tools: globalTools,
      state,
      sandbox: this.options.sandbox,
      limits: this.limits,
      initialState:
        this.options.exposeMessagesToCode === false
          ? undefined
          : { messages: messages.map((m) => ({ role: m.role, content: m.content })) },
      logger: this.log,
      onEvent: emit,
    });

    const hasSkills = this.skills.length > 0;
    const systemMessage: ModelMessage = {
      role: "system",
      content: await this.buildSystemPrompt(state, runner.fetchEnabled),
    };
    const history: ModelMessage[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.files?.length ? { files: m.files } : {}),
    }));
    const functions: ModelFunction[] = hasSkills
      ? [useSkillsSchema(this.skills, this.limits.maxUseSkillsCalls), EXECUTE_CODE_SCHEMA]
      : [EXECUTE_CODE_SCHEMA];
    const hasImages = messages.some((m) => m.files?.some((f) => f.mimeType?.startsWith("image/")));
    const models = {
      text: hasImages ? (this.options.visionModel ?? this.options.model) : this.options.model,
      vision: this.options.visionModel ?? this.options.model,
    };

    // Per-run state
    const loadedSkills = new Map<string, Skill<TState>>();
    const emittedContexts = new Set<Context<TState>>(this.options.contexts ?? []);
    const collectedFiles: FileAttachment[] = [];
    const priorCalls: ModelFunctionCall[] = [];
    const steps: AgentStep[] = [];
    const transcript: ModelMessage[] = [];
    const usage = { modelCalls: 0, executeCalls: 0, promptTokens: 0, completionTokens: 0 };
    let useSkillsCallsUsed = 0;

    const executeMax = () => {
      let max = this.limits.maxExecuteCalls;
      for (const skill of loadedSkills.values()) {
        if (skill.maxExecuteCalls && skill.maxExecuteCalls > max) max = skill.maxExecuteCalls;
      }
      return max;
    };
    // Headroom for the use_skills turns and the final reply, re-evaluated every
    // step: a skill loaded mid-run can raise the budget immediately.
    const maxIterations = () => executeMax() + this.limits.maxUseSkillsCalls + 1;

    // Tool-injected images: shown as a user turn after the tool results
    // (tool-role messages can't carry images on any provider), with pixels
    // beyond the visible cap evicted oldest-first.
    const pendingImages: { tool: string; image: ModelImage }[] = [];
    const imageTurns: ModelMessage[] = [];
    const flushPendingImages = () => {
      if (pendingImages.length === 0) return;
      const shown = pendingImages.splice(0);
      const tools = [...new Set(shown.map((p) => p.tool))].join(", ");
      const urls = shown.map((p) => p.image.url).filter((u): u is string => !!u);
      const turn: ModelMessage = {
        role: "user",
        content: `[${shown.length} image${shown.length === 1 ? "" : "s"} from ${tools}${urls.length ? `: ${urls.join(", ")}` : ""} — shown to you, not the user]`,
        files: shown.map((p) => ({ mimeType: p.image.mimeType, data: p.image.data })),
      };
      transcript.push(turn);
      imageTurns.push(turn);
      let visible = 0;
      for (let k = imageTurns.length - 1; k >= 0; k--) {
        const t = imageTurns[k];
        if (!t.files?.length) continue;
        if (visible + t.files.length <= this.limits.maxVisibleImages) {
          visible += t.files.length;
          continue;
        }
        const keep = this.limits.maxVisibleImages - visible;
        const dropped = t.files.length - keep;
        t.files = keep > 0 ? t.files.slice(-keep) : undefined;
        t.content += ` [${dropped} earlier image${dropped === 1 ? "" : "s"} removed]`;
        visible += keep;
      }
    };

    const callModel = async (callMessages: ModelMessage[], opts: { function_call?: "none" | "auto"; functions?: ModelFunction[] }, step: number) => {
      const model = selectLoopModel([...loadedSkills.values()], models, hasImages || imageTurns.length > 0, this.options.imageCapable);
      emit({ type: "model_call", model, step });
      const request: ModelRequest = {
        model,
        fallbackModel: this.options.fallbackModel,
        messages: callMessages,
        functions: opts.functions?.length ? opts.functions : undefined,
        function_call: opts.functions?.length ? opts.function_call : undefined,
        temperature: this.options.temperature,
        signal,
      };
      const response = this.options.callModel
        ? await this.options.callModel(request, callWith190proof)
        : await callWith190proof(request);
      usage.modelCalls++;
      usage.promptTokens += response.usage?.prompt_tokens ?? 0;
      usage.completionTokens += response.usage?.completion_tokens ?? 0;
      return response;
    };

    const finish = (text: string | null, stopReason: RunResult["stopReason"]): RunResult => ({
      text,
      files: collectedFiles,
      steps,
      skillsLoaded: [...loadedSkills.keys()],
      usage,
      stopReason,
      transcript,
    });

    const runCode = async (args: Record<string, any>) => {
      const code = typeof args?.code === "string" ? args.code : "";
      const purpose = typeof args?.purpose === "string" ? args.purpose : undefined;
      emit({ type: "code", code, purpose });
      const outcome = await runner.run(code, { signal });
      throwIfAborted();
      collectedFiles.push(...outcome.files);
      pendingImages.push(...outcome.images);
      if (outcome.ran) usage.executeCalls++;
      const extra: string[] = [];
      if (!outcome.result.ok && !outcome.endTurn) {
        const hint = this.unloadedSkillHint(
          outcome.result.error ?? "",
          loadedSkills,
          useSkillsCallsUsed < this.limits.maxUseSkillsCalls,
        );
        if (hint) extra.push(hint);
      }
      const attrs = purpose ? ` purpose='${purpose.replace(/[\n']/g, " ").trim()}'` : "";
      const output = outcome.endTurn ? "" : CodeRunner.format(outcome, extra, attrs);
      steps.push({ type: "execute_code", code, purpose, ok: outcome.result.ok, output });
      emit({ type: "code_result", ok: outcome.result.ok, output });
      return { outcome, output };
    };

    // Narration from a discarded final turn: a last resort if wrap-up fails
    let lastResortContent: string | null = null;

    try {
      for (let i = 0; i < maxIterations(); i++) {
        throwIfAborted();
        const lastIteration = i === maxIterations() - 1;
        // Budgets are enforced structurally: exhausted functions are withdrawn.
        // On the last step the tools stay declared (stable prompt prefix) with
        // function_call "none" to force a text answer.
        const iterationFunctions = functions.filter(
          (f) =>
            !(f.name === "execute_code" && usage.executeCalls >= executeMax()) &&
            !(f.name === "use_skills" && useSkillsCallsUsed >= this.limits.maxUseSkillsCalls),
        );

        const response = await callModel(
          [systemMessage, ...history, ...transcript],
          { functions: iterationFunctions, function_call: lastIteration ? "none" : "auto" },
          i + 1,
        ).catch((err: unknown) => {
          throwIfAborted();
          // A final-step failure (providers that wanted to tool-call can
          // return nothing under "none") falls through to the wrap-up call.
          if (lastIteration) return null;
          throw err;
        });
        throwIfAborted();
        if (!response) break;

        const calls: ModelFunctionCall[] = response.function_calls?.length
          ? response.function_calls
          : response.function_call
            ? [response.function_call]
            : [];

        if (calls.length === 0) {
          if (!response.content) {
            throw new Error("Model returned neither text nor a tool call");
          }
          if (!TOOL_CALL_AS_TEXT_RE.test(response.content)) {
            return finish(response.content, "reply");
          }
          this.log.warn("tool_call_as_text: tool call emitted as text, retrying", truncateMiddle(response.content, 500));
          transcript.push({
            role: "assistant",
            content: response.content,
            reasoning: response.reasoning,
            reasoningDetails: response.reasoningDetails,
          });
          if (lastIteration) {
            lastResortContent = stripToolCallAsText(response.content) || null;
            break;
          }
          transcript.push({ role: "user", content: TOOL_CALL_AS_TEXT_ERROR });
          continue;
        }

        // Final step: function_call "none" should have prevented calls, but
        // several endpoints ignore it. Still run one execute_code (it may end
        // the run), then hand everything to the wrap-up call.
        if (lastIteration) {
          lastResortContent = stripToolCallAsText(response.content ?? "").trim() || null;
          const codeCall = calls.find((c) => c.name === "execute_code");
          if (codeCall && usage.executeCalls < executeMax()) {
            const { outcome, output } = await runCode(codeCall.arguments);
            if (outcome.endTurn) return finish(outcome.endTurn.reply, "end_turn");
            transcript.push({
              role: "assistant",
              content: response.content ?? "",
              functionCalls: [codeCall],
              reasoning: response.reasoning,
              reasoningDetails: response.reasoningDetails,
            });
            transcript.push({
              role: "tool",
              content: "",
              toolResults: [{ toolCallId: codeCall.id ?? "call_0", name: codeCall.name, content: output }],
            });
            flushPendingImages();
          }
          break;
        }

        // Text alongside a tool call is a progress note, never the answer.
        if (response.content?.trim() && !TOOL_CALL_AS_TEXT_RE.test(response.content)) {
          emit({ type: "narration", text: response.content.trim() });
        }

        // Answer every call with exactly one tool result, keyed by call id —
        // an unanswered tool call is a hard error on every provider.
        const toolResults: ModelToolResult[] = [];
        let ranCodeThisResponse = false;
        for (let idx = 0; idx < calls.length; idx++) {
          const call = calls[idx];
          const toolCallId = call.id ?? `call_${idx}`;
          const reply = (content: string) => toolResults.push({ toolCallId, name: call.name, content });

          // Loop guard: a third identical call means the model is thrashing
          // (one identical retry is allowed for transient failures).
          const argsString = safeStringify(call.arguments ?? {});
          const priorIdentical = priorCalls.filter(
            (prev) => prev.name === call.name && safeStringify(prev.arguments ?? {}) === argsString,
          ).length;
          priorCalls.push(call);
          if (priorIdentical >= 2) {
            reply(`<error>You already ran exactly this ${call.name} call twice (see above). Do something different, or reply with the final answer.</error>`);
            continue;
          }

          if (call.name === "use_skills" && hasSkills) {
            // Enforced per call, not just by withdrawing the schema: several
            // use_skills in one response must not blow through the budget.
            if (useSkillsCallsUsed >= this.limits.maxUseSkillsCalls) {
              reply("<error>use_skills budget exhausted for this request. Continue with the functions already loaded, or reply with the final answer.</error>");
              continue;
            }
            const requested = requestedSkillNames(call.arguments);
            if (requested.length === 0) {
              reply(`<error>No skills given. Pass e.g. {"skills": ["${this.skills[0].name}"]}.</error>`);
              continue;
            }
            let content = "";
            const loadedNow: string[] = [];
            for (const name of requested) {
              const loaded = await this.loadSkill(name, state, loadedSkills, emittedContexts, runner);
              content += loaded.content;
              if (loaded.loaded) loadedNow.push(name);
            }
            useSkillsCallsUsed++;
            if (loadedNow.length) emit({ type: "skills_loaded", skills: loadedNow });
            steps.push({ type: "use_skills", skills: requested, output: content });
            reply(content);
          } else if (call.name === "execute_code") {
            // Only the first execute_code per response runs (parallel siblings
            // otherwise double-fire side effects).
            if (ranCodeThisResponse) {
              reply("<error>Only the first execute_code in a response is run; this parallel execute_code was skipped. Put all your logic in one execute_code call.</error>");
              continue;
            }
            ranCodeThisResponse = true;
            const max = executeMax();
            if (usage.executeCalls >= max) {
              reply(`<error>execute_code budget exhausted (${max}/${max}). Reply with the final answer using the data above.</error>`);
              continue;
            }
            const { outcome, output } = await runCode(call.arguments);
            // A tool ended the run: return before any sibling call can run.
            if (outcome.endTurn) return finish(outcome.endTurn.reply, "end_turn");
            reply(output);
          } else {
            this.log.warn(`Model called unknown function: ${call.name}`);
            reply(`<error>Unknown function "${call.name}". Only ${functions.map((f) => f.name).join(" and ")} exist.</error>`);
          }
        }

        if (toolResults.length) {
          // Recomputed after this step's calls: a use_skills just now may have
          // raised the budget, and the model should see the new denominator.
          const budgetNote = usage.executeCalls > 0 ? ` (execute_code used ${usage.executeCalls}/${executeMax()})` : "";
          toolResults[toolResults.length - 1].content +=
            i === maxIterations() - 2
              ? "\n(FINAL TURN: tool budget exhausted — you MUST respond with the final plain-text answer, built from everything gathered above. Tool calls will not be executed.)"
              : `\n(Do not repeat succeeded actions${budgetNote}. Continue, or reply with the final answer.)`;
        }
        transcript.push({
          role: "assistant",
          content: response.content ?? "",
          functionCalls: calls,
          reasoning: response.reasoning,
          reasoningDetails: response.reasoningDetails,
        });
        transcript.push({ role: "tool", content: "", toolResults });
        flushPendingImages();
      }

      // Iteration cap: one extra call for a best-effort answer from the
      // gathered data. Tools stay declared with "none" because the transcript
      // carries tool turns, which some providers reject without a tools param.
      this.log.warn("Agent hit its iteration cap without a final reply; running wrap-up");
      try {
        const wrapUp = await callModel(
          [
            systemMessage,
            ...history,
            ...transcript,
            {
              role: "user",
              content:
                "(SYSTEM: The tool phase is over — no more tool calls are possible. Write the final reply now from the data gathered above. If the task is incomplete, say plainly what you found and what is still missing. Plain text only.)",
            },
          ],
          { functions, function_call: "none" },
          maxIterations() + 1,
        );
        throwIfAborted();
        const text = wrapUp.content?.trim() ? stripToolCallAsText(wrapUp.content) : "";
        if (text) return finish(text, "wrap_up");
        this.log.error("Wrap-up call returned no usable content");
      } catch (err) {
        throwIfAborted();
        this.log.error("Wrap-up call failed", err);
      }
      return finish(lastResortContent ?? FALLBACK_MESSAGE, "fallback");
    } finally {
      runner.dispose();
    }
  }

  private async buildSystemPrompt(state: TState, fetchEnabled: boolean): Promise<string> {
    const instructions =
      typeof this.options.instructions === "function"
        ? await this.options.instructions(state)
        : (this.options.instructions ?? DEFAULT_INSTRUCTIONS);

    // Static sections first and per-run contexts last, so provider prompt
    // caches (which match on prefixes) keep hitting.
    const sections = [
      `<system_instructions>\n${indent(instructions.trim(), 2)}\n</system_instructions>`,
      `<agent_instructions>\n${indent(
        codeModeInstructions({
          hasSkills: this.skills.length > 0,
          maxUseSkillsCalls: this.limits.maxUseSkillsCalls,
          fetch: fetchEnabled,
        }),
        2,
      )}\n</agent_instructions>`,
    ];
    if (this.skills.length > 0) {
      sections.push(
        `<skills_available>\n${indent(this.skills.map((s) => `\`${s.name}\` - ${s.description}`).join("\n"), 2)}\n</skills_available>`,
      );
    }
    const globalDecls = [
      buildToolsApi((this.options.tools ?? []).map((t) => resolveTool(t).schema)),
      fetchEnabled ? FETCH_DECLARATION : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (globalDecls) {
      sections.push(
        `<global_functions>\n// These global functions are always available in execute_code\n${globalDecls}\n</global_functions>`,
      );
    }
    const contexts = await Promise.all((this.options.contexts ?? []).map((c) => renderContext(c, state)));
    sections.push(...contexts.filter((c): c is string => !!c));
    return sections.join("\n\n");
  }

  private async loadSkill(
    name: string,
    state: TState,
    loadedSkills: Map<string, Skill<TState>>,
    emittedContexts: Set<Context<TState>>,
    runner: CodeRunner<TState>,
  ): Promise<{ content: string; loaded: boolean }> {
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) {
      const available = this.skills.map((s) => s.name).join(", ");
      return {
        content: `<use_skill skill='${name}'>\n  <error>Unknown skill. Available skills: ${available}</error>\n</use_skill>\n`,
        loaded: false,
      };
    }
    if (loadedSkills.has(skill.name)) {
      return {
        content: `<use_skill skill='${skill.name}'>\n  <error>Skill already loaded. Its functions are available in execute_code.</error>\n</use_skill>\n`,
        loaded: false,
      };
    }

    const instructions =
      typeof skill.instructions === "function" ? await skill.instructions(state) : (skill.instructions ?? "");

    const contextSections: string[] = [];
    for (const context of skill.contexts ?? []) {
      if (emittedContexts.has(context)) continue;
      emittedContexts.add(context);
      const rendered = await renderContext(context, state, 4);
      if (rendered) contextSections.push(rendered.replace(/\n<\//, "\n  </"));
    }

    // A tool the agent also exposes globally is already declared; drop it here
    const globalNames = new Set((this.options.tools ?? []).map((t) => resolveTool(t).schema.name));
    const schemas = (skill.tools ?? []).map((t) => resolveTool(t).schema).filter((s) => !globalNames.has(s.name));
    const api = buildToolsApi(schemas) || "// this skill adds no functions of its own";

    loadedSkills.set(skill.name, skill);
    runner.addTools(skill.tools ?? []);

    const sections = [
      `<description>${skill.description}</description>`,
      ...(instructions.trim() ? [`<instructions>\n${indent(instructions.trim(), 4)}\n  </instructions>`] : []),
      ...contextSections,
      // Unindented: the largest payload, and indentation costs a token a line
      `<global_functions>\n// these are the global functions ${skill.name} adds, callable in execute_code:\n${api}\n  </global_functions>`,
    ];
    return {
      content: `<use_skill skill='${skill.name}'>\n  ${sections.join("\n  ")}\n</use_skill>\n`,
      loaded: true,
    };
  }

  /**
   * A skill's tool called before its skill loaded gets a bare ReferenceError,
   * which models read as a broken backend. Name the owning skill so the retry
   * lands on a use_skills call instead of an apology.
   */
  private unloadedSkillHint(error: string, loadedSkills: Map<string, Skill<TState>>, canLoadSkills: boolean): string | null {
    const fn = error.match(UNDEFINED_GLOBAL_RE)?.[1];
    if (!fn) return null;
    const unloaded = this.skills.filter((s) => !loadedSkills.has(s.name));
    const owners = unloaded
      .filter((s) => (s.tools ?? []).some((t) => resolveTool(t).schema.name === fn))
      .map((s) => s.name);
    if (owners.length === 0) return null;
    const list = owners.map((s) => `"${s}"`).join(" or ");
    return canLoadSkills
      ? `<hint>${fn}() is provided by the ${list} skill, which is not loaded in this request. It is available, not broken: call use_skills(["${owners[0]}"]) first, then retry the same code.</hint>`
      : `<hint>${fn}() is provided by the ${list} skill, which can no longer be loaded in this request. Do not retry it — continue without it.</hint>`;
  }
}

/** Skill names requested by a use_skills call (tolerates a singular slip). */
function requestedSkillNames(args: Record<string, any>): string[] {
  if (Array.isArray(args?.skills)) return args.skills.map(String).filter(Boolean);
  if (typeof args?.skill === "string" && args.skill) return [args.skill];
  return [];
}
