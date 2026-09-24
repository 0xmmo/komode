/**
 * Contexts: dynamic facts rendered into the prompt, each inside its own
 * <tag>…</tag>. Agent-level contexts go in the system message; skill-level
 * ones are injected when the skill loads. Output is XML-escaped unless the
 * context opts into `rawXml`.
 */

import { escapeXml } from "./util";

/** A context defined as a plain object. */
export interface ContextDefinition<TState = any> {
  /** snake_case tag this context renders into, e.g. "user_profile" */
  tag: string;
  /**
   * Set when build() returns trusted XML with intentional child elements; the
   * context is then responsible for escaping its own untrusted fields.
   */
  rawXml?: boolean;
  /** Return the context text; an empty string skips the section */
  build(state: TState): string | Promise<string>;
}

export function defineContext<TState = any>(def: ContextDefinition<TState>): ContextDefinition<TState> {
  assertTag(def.tag);
  return def;
}

/** Class form of a context. A fresh instance is constructed per run. */
export abstract class BaseContext<TState = any> {
  abstract readonly tag: string;
  readonly rawXml: boolean = false;

  constructor(protected readonly state: TState) {}

  abstract build(): string | Promise<string>;
}

export interface ContextClass<TState = any> {
  new (state: TState): BaseContext<TState>;
}

/** Either context form. */
export type Context<TState = any> = ContextDefinition<TState> | ContextClass<TState>;

/** Build a context and render it as `<tag>…</tag>`, or null when empty. */
export async function renderContext<TState>(
  context: Context<TState>,
  state: TState,
  indentBy = 2,
): Promise<string | null> {
  let tag: string;
  let rawXml: boolean;
  let content: string;
  if (typeof context === "function") {
    const instance = new context(state);
    tag = instance.tag;
    rawXml = instance.rawXml;
    content = await instance.build();
  } else {
    tag = context.tag;
    rawXml = context.rawXml ?? false;
    content = await context.build(state);
  }
  assertTag(tag);
  content = (content ?? "").trim();
  if (!content) return null;
  const body = rawXml ? content : escapeXml(content);
  const pad = " ".repeat(indentBy);
  return `<${tag}>\n${body
    .split("\n")
    .map((line) => pad + line)
    .join("\n")}\n</${tag}>`;
}

function assertTag(tag: string): void {
  if (!/^[A-Za-z_][\w.-]*$/.test(tag ?? "")) {
    throw new Error(`Context tag "${tag}" must be a valid XML tag name`);
  }
}
