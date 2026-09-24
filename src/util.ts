/** Small internal helpers shared across layers. Not part of the public API. */

/** Minimal logger shape; defaults to silent. Pass `console` to see everything. */
export interface Logger {
  debug?(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Keep the head and tail of a long string, eliding the middle. */
export function truncateMiddle(
  text: string,
  maxLength: number,
  indicator = "…",
): string {
  if (text.length <= maxLength) return text;
  const half = Math.max(0, Math.floor((maxLength - indicator.length) / 2));
  if (half === 0) return indicator;
  return text.substring(0, half) + indicator + text.substring(text.length - half);
}

/** Indent each line of text by a given number of spaces. */
export function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

/** JSON.stringify that never throws or returns undefined (BigInt, Symbol, circular). */
export function safeStringify(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)) ??
      String(value)
    );
  } catch {
    return String(value);
  }
}

/** Combine abort signals; undefined when none are present. */
export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/** Thrown when a run is cancelled through its AbortSignal. */
export class AbortedError extends Error {
  constructor(message = "The run was aborted") {
    super(message);
    this.name = "AbortedError";
  }
}

/**
 * Escape XML metacharacters in untrusted text so it can't break out of the
 * <tag> it renders into (a prompt-injection vector).
 */
export const escapeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
