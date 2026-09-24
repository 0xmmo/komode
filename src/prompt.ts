/** Default prompt text and the two meta-function schemas the Agent exposes. */

import type { ModelFunction } from "./model";
import type { Skill } from "./skill";

export const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

export function codeModeInstructions(opts: { hasSkills: boolean; maxUseSkillsCalls: number; fetch: boolean }): string {
  const lines: string[] = ["Working the request:"];
  let n = 1;
  if (opts.hasSkills) {
    lines.push(
      `${n++}. use_skills(): loads one or more skills. Returns their instructions and the typed functions they add; those functions become globals inside execute_code. You can call it at most ${opts.maxUseSkillsCalls} time${opts.maxUseSkillsCalls === 1 ? "" : "s"} per request, so pass every skill you need in your first call.`,
    );
  }
  const x = n++;
  lines.push(
    `${x}. execute_code(): runs TypeScript in a sandbox with custom globals. Call it at most once per turn.`,
    `  ${x}.1. Code is transpiled to ES2020 and runs in QuickJS: the standard library (Math, JSON, Array/Object/String, Map/Set, RegExp, Promise, …) is available. console and state are wired up${opts.fetch ? ", and so is fetch" : ""}. import/require are not.`,
    `  ${x}.2. End with a return statement: the return value and console output come back to you. Functions throw on failure and you will see the error. If a function is unavailable or fails, adapt and continue without it.`,
    `  ${x}.3. Top-level await works: write statements inline and end with \`return\`. Don't wrap logic in \`async function main(){...}\`. Use Promise.all for independent calls.`,
    `  ${x}.4. The global \`state\` persists across execute_code calls in this request. Stash raw data there (state.results = data) and return only a compact digest. state.messages holds the conversation's full text as { role, content } objects; pass it to functions instead of retyping long content.`,
    `  ${x}.5. The functions in <global_functions> are always available.${opts.fetch ? " fetch(url) makes real GET/HEAD requests to public URLs; prefer a provided function when one fits." : ""}`,
    `  ${x}.6. Your execute_code budget is limited: chain several function calls in one run instead of running one just to look at its result.`,
    `${n++}. Plain conversation, or questions you can answer from your own knowledge: reply directly with text, no tools.`,
    `${n++}. Never repeat an action that already succeeded; the calls you made and their results are listed above each turn.`,
    "",
    "Replying:",
    "- When you have what you need, reply with the final answer as plain text.",
    "- Files produced by functions attach to your reply automatically; never include their URLs.",
    "- Never make up information. Only present data, quotes, or completed actions you actually obtained or performed during this request; say plainly what is missing.",
  );
  return lines.join("\n");
}

export function useSkillsSchema(skills: Skill[], maxCalls: number): ModelFunction {
  return {
    name: "use_skills",
    description: `Load skills' instructions and typed APIs; their functions become available in execute_code. You can call this at most ${maxCalls} time${maxCalls === 1 ? "" : "s"} per request, so pass every skill you need in your first call.`,
    parameters: {
      type: "object",
      properties: {
        skills: {
          type: "array",
          items: { type: "string", enum: skills.map((s) => s.name) },
          description: skills.map((s) => `${s.name}: ${s.description}`).join("\n"),
        },
      },
      required: ["skills"],
    },
  };
}

export const EXECUTE_CODE_SCHEMA: ModelFunction = {
  name: "execute_code",
  description:
    "Run TypeScript; the standard library and <global_functions> are always available, plus any loaded skills' functions. Output is reported back to you.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "TypeScript source." },
      purpose: { type: "string", description: "What this run does, under 8 words." },
    },
    required: ["code"],
  },
};
