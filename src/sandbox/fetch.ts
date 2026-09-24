/**
 * Guarded fetch() for the QuickJS sandbox.
 *
 * Model-written code reaches for web-standard fetch constantly (in Olly's
 * production traffic, mostly GET polling of public APIs), then burns agent
 * iterations recovering from a ReferenceError. This gives the guest the real
 * thing, host-mediated: `fetch` in guest code is a prelude shim over the
 * `__fetch` binding, whose host side (sandboxFetch) routes every request
 * through the safe-url SSRF guard.
 *
 * Deliberately GET/HEAD only, no request bodies: a POST that fires before a
 * crash is an untracked side effect a retry will repeat, and a body is a
 * large-payload exfil channel for injected instructions (guest `state` may
 * hold the whole conversation). Mutating actions belong in tools.
 */

import {
  assertPublicUrl,
  BROWSER_UA,
  guardedHttp,
  isBlockedUrlError,
  urlGuardConfig,
} from "./safe-url";
import { AbortedError, anySignal, silentLogger, type Logger } from "../util";

/** Fetches allowed within one code run (own budget — separate from the tool-call cap). */
export const MAX_FETCHES_PER_RUN = 16;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

/** Request headers the guest may not set: connection-level or length-bearing. */
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
]);

export interface SandboxFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  /** Final URL after redirects */
  url: string;
  /** Response headers, lowercased keys */
  headers: Record<string, string>;
  /** Charset-decoded text ("" for HEAD) */
  body: string;
}

/**
 * Decode a response buffer honoring the Content-Type charset. With no charset
 * declared, try strict utf-8 and fall back to gb18030 (strict superset of
 * GBK/GB2312): common public APIs (e.g. Chinese quote feeds) serve GBK
 * without declaring it, and decoding those as utf-8 produces mojibake.
 */
export function decodeBody(buf: Buffer, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // Unknown/misdeclared label — fall through to sniffing.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buf);
    } catch {
      return new TextDecoder("utf-8").decode(buf);
    }
  }
}

/** Exported for tests. */
export const sanitizeHeaders = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [rawKey, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    // Strip CR/LF BEFORE the blocklist check: "ho\rst" must not sanitize
    // into "host" after passing it.
    // Trim too: HTTP clients trim names, so " Host " would become "Host".
    const key = rawKey.replace(/[\r\n]/g, "").trim();
    if (!key || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) continue;
    if (FORBIDDEN_HEADERS.has(key.toLowerCase())) continue;
    out[key] = String(value).replace(/[\r\n]/g, "");
  }
  return out;
};

/**
 * Host side of the guest `fetch()` shim. Throws steering-quality errors (they
 * surface to the model verbatim as guest exceptions). The method/body gate
 * runs before any URL vetting or network so rejected calls are free.
 */
export async function sandboxFetch(
  input: unknown,
  signal: AbortSignal | undefined,
  log: Logger = silentLogger,
): Promise<SandboxFetchResult> {
  const args =
    typeof input === "string"
      ? { url: input }
      : ((input ?? {}) as Record<string, unknown>);
  const rawUrl = String(args.url ?? "");
  const method = String(args.method ?? "GET").toUpperCase();
  // Host for log lines only — never used for access decisions.
  const host = (() => {
    try {
      return new URL(rawUrl).hostname;
    } catch {
      return "?";
    }
  })();

  if (method !== "GET" && method !== "HEAD" || args.body != null) {
    log.warn(
      `sandbox-fetch-rejected host=${host} method=${method} reason=${
        method !== "GET" && method !== "HEAD" ? "method" : "body"
      }`,
    );
    throw new Error(
      "fetch() supports GET and HEAD only in this sandbox — no request bodies. It cannot perform write operations; continue the task without this request.",
    );
  }

  const startedAt = Date.now();
  try {
    // Inside the try so a pre-vetting refusal logs sandbox-fetch-blocked like
    // a connect-time one; sandboxFetch is async, so callers always see a
    // rejection, never a sync throw at the call site.
    assertPublicUrl(rawUrl, "fetch url");
    const res = await guardedHttp.request<ArrayBuffer>({
      method,
      url: rawUrl,
      responseType: "arraybuffer",
      // Web-fetch semantics: non-2xx RESOLVES with ok:false; only network-level
      // failures and blocked URLs reject.
      validateStatus: () => true,
      maxRedirects: 5,
      maxContentLength: MAX_RESPONSE_BYTES,
      // axios timeout is socket-inactivity; the AbortSignal.timeout is the
      // hard wall-clock deadline (slow-drip bodies pin a worker otherwise).
      timeout: FETCH_TIMEOUT_MS,
      signal: anySignal([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: { "User-Agent": BROWSER_UA, ...sanitizeHeaders(args.headers) },
      // Spread LAST: the lookup/beforeRedirect guard hooks must win.
      ...urlGuardConfig("fetch url"),
    });

    const buf = Buffer.from(res.data ?? new ArrayBuffer(0));
    if (buf.byteLength > MAX_RESPONSE_BYTES) {
      throw new Error(
        `Response from ${host} exceeded the ${MAX_RESPONSE_BYTES / 1024 / 1024} MB fetch cap. Request less data (paginate, or use a more specific endpoint).`,
      );
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.headers ?? {})) {
      if (typeof value === "string") headers[key.toLowerCase()] = value;
      else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ");
    }
    const body =
      method === "HEAD" ? "" : decodeBody(buf, headers["content-type"] ?? "");
    log.info(
      `sandbox-fetch host=${host} method=${method} status=${res.status} bytes=${buf.byteLength} ms=${Date.now() - startedAt}`,
    );
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText ?? "",
      url: (res.request?.res?.responseUrl as string) || rawUrl,
      headers,
      body,
    };
  } catch (error: any) {
    const ms = Date.now() - startedAt;
    if (isBlockedUrlError(error)) {
      log.warn(`sandbox-fetch-blocked host=${host} reason=ssrf`);
      throw error;
    }
    // Caller's signal (cancelled run / VM teardown) — not this URL's fault.
    if (signal?.aborted) {
      throw new AbortedError();
    }
    const message = String(error?.message || error);
    log.warn(`sandbox-fetch-failed host=${host} ms=${ms} error=${truncate(message)}`);
    if (
      error?.code === "ERR_CANCELED" ||
      error?.code === "ECONNABORTED" ||
      /abort|cancel/i.test(message)
    ) {
      throw new Error(
        `fetch to ${host} timed out after ${FETCH_TIMEOUT_MS / 1000}s.`,
      );
    }
    if (/maxContentLength/i.test(message)) {
      throw new Error(
        `Response from ${host} exceeded the ${MAX_RESPONSE_BYTES / 1024 / 1024} MB fetch cap. Request less data (paginate, or use a more specific endpoint).`,
      );
    }
    throw new Error(`fetch to ${host} failed: ${truncate(message)}`);
  }
}

const truncate = (s: string): string => (s.length > 200 ? s.slice(0, 200) + "…" : s);

/**
 * Guest-side prelude, evaluated once at sandbox-session creation (plain
 * ES2020 — never transpiled). Defines the fetch shim over __fetch plus the
 * small web globals model code reaches for, and sync steering throws for the
 * Node globals it must not use (an async binding at a sync call site would
 * leave a pending deferred and spuriously break the session — the throws
 * MUST stay synchronous).
 */
export const FETCH_PRELUDE = `
// fetch() over the __fetch host binding: enough of the Response surface for
// real code — ok/status/statusText/url/headers.get/text()/json().
globalThis.fetch = async function (url, init) {
  var r = await __fetch({
    url: String(url),
    method: init && init.method,
    headers: init && init.headers,
    body: init && init.body,
  });
  return {
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    url: r.url,
    headers: { get: function (k) { var v = r.headers[String(k).toLowerCase()]; return v === undefined ? null : v; } },
    text: async function () { return r.body; },
    json: async function () { return JSON.parse(r.body); },
  };
};
`;

/** Stands in for fetch when it is disabled: fails synchronously with steering text. */
export const NO_FETCH_PRELUDE = `
globalThis.fetch = function () {
  throw new Error("fetch is not available in this sandbox — network access is disabled. Use the provided global functions instead.");
};
`;

/** Small web globals (btoa/atob/TextEncoder/TextDecoder) plus steering throws for Node globals. */
export const WEB_PRELUDE = `
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
globalThis.btoa = function (input) {
  var str = String(input), out = "";
  for (var i = 0; i < str.length; ) {
    var c1 = str.charCodeAt(i++), c2 = str.charCodeAt(i++), c3 = str.charCodeAt(i++);
    var e1 = c1 >> 2, e2 = ((c1 & 3) << 4) | (c2 >> 4);
    var e3 = isNaN(c2) ? 64 : ((c2 & 15) << 2) | (c3 >> 6);
    var e4 = isNaN(c3) ? 64 : c3 & 63;
    out += B64.charAt(e1) + B64.charAt(e2) +
           (e3 === 64 ? "=" : B64.charAt(e3)) + (e4 === 64 ? "=" : B64.charAt(e4));
  }
  return out;
};
globalThis.atob = function (input) {
  var str = String(input).replace(/=+$/, ""), out = "";
  for (var bc = 0, bs = 0, i = 0; i < str.length; i++) {
    var idx = B64.indexOf(str.charAt(i));
    if (idx === -1) continue;
    bs = bc % 4 ? bs * 64 + idx : idx;
    if (bc++ % 4) out += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
  }
  return out;
};
globalThis.TextEncoder = function () {};
globalThis.TextEncoder.prototype.encode = function (s) {
  var utf8 = unescape(encodeURIComponent(String(s)));
  var arr = new Uint8Array(utf8.length);
  for (var i = 0; i < utf8.length; i++) arr[i] = utf8.charCodeAt(i);
  return arr;
};
// utf-8 only: host-side fetch already charset-decodes response bodies.
globalThis.TextDecoder = function (label) {
  if (label && String(label).toLowerCase().replace("_", "-") !== "utf-8" && String(label).toLowerCase() !== "utf8") {
    throw new Error("Only utf-8 is supported by the sandbox TextDecoder; fetch() responses are already charset-decoded.");
  }
};
globalThis.TextDecoder.prototype.decode = function (arr) {
  var s = "";
  for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return decodeURIComponent(escape(s));
};

// Node globals that don't exist here: fail with steering text, synchronously.
globalThis.require = function () {
  throw new Error("require is not available in this context — npm and Node modules cannot be imported. Use the standard library, the provided global functions, and fetch().");
};
var bufferError = function () {
  throw new Error("Buffer is not available in this context — use TextEncoder, btoa/atob, or plain strings.");
};
globalThis.Buffer = { from: bufferError, alloc: bufferError, concat: bufferError, isBuffer: function () { return false; } };
`;

/** Full default prelude: guarded fetch shim + web globals. */
export const SANDBOX_PRELUDE = FETCH_PRELUDE + WEB_PRELUDE;
