/**
 * Skills: progressive disclosure for tools. The model starts out seeing only
 * each skill's name and description. Calling `use_skills` injects a skill's
 * instructions and contexts and unlocks its tools as typed globals inside
 * execute_code — so an agent can carry dozens of integrations while paying
 * prompt tokens only for the ones a request needs.
 */

import type { Context } from "./context";
import type { Tool } from "./tool";

export interface Skill<TState = any> {
  /** Identifier passed to use_skills, e.g. "calendar" */
  name: string;
  /** One line shown in the skill catalog so the model can pick it */
  description: string;
  /** Guidance injected when the skill loads; the function form can read state */
  instructions?: string | ((state: TState) => string | Promise<string>);
  /** Tools whose typed bindings become available once the skill is loaded */
  tools?: Tool<TState>[];
  /** Contexts built and injected when the skill loads */
  contexts?: Context<TState>[];
  /**
   * Model override while this skill is loaded (the final reply included).
   * When several loaded skills declare one, the last loaded wins.
   */
  model?: string;
  /**
   * Raise the execute_code budget for requests that load this skill. The
   * highest declared value wins; it can never lower the agent's default.
   */
  maxExecuteCalls?: number;
}

export function defineSkill<TState = any>(skill: Skill<TState>): Skill<TState> {
  if (!/^[a-z0-9][\w-]*$/i.test(skill.name ?? "")) {
    throw new Error(`Skill name "${skill.name}" must be alphanumeric (with - or _)`);
  }
  if (!skill.description?.trim()) {
    throw new Error(`Skill "${skill.name}" needs a description`);
  }
  return skill;
}
