/**
 * SSRF guard for URLs the model chose.
 *
 * Any url model code fetches is model-supplied from user-influenced text (the
 * user asks directly, or a page the agent read earlier tells it to), and what
 * we fetch flows back to the model and usually to the user. A host inside a
 * private network turns an unguarded fetch from "read this page for me" into
 * "read something on the internal network and hand me the bytes": localhost,
 * other services on the private network (*.internal), or cloud metadata at
 * 169.254.169.254.
 *
 * A complete guard needs BOTH hooks below — each covers what the other misses:
 *
 *   guardedLookup       vets the address a named host actually resolves to, at
 *                       connect time, on every hop. Literal-IP hosts never hit
 *                       DNS, so it never sees them.
 *   guardedBeforeRedirect  vets each redirect hop's host by name — which is the
 *                       only thing that catches a redirect straight to
 *                       http://127.0.0.1. It is sync (it cannot await a
 *                       lookup), so it can only match name patterns.
 *
 * Use `safeGet` unless the call site needs a bespoke request config; then take
 * `guardedLookup` + `guardedBeforeRedirect` and validate the url yourself.
 * Exported from "komode/sandbox" so host tools can reuse the same guard.
 */
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import ipaddr from "ipaddr.js";
import { Agent as HttpAgent } from "http";
import { Agent as HttpsAgent } from "https";
import { lookup as dnsLookup } from "dns";
import type { LookupAddress, LookupOptions } from "dns";

/** Thrown when a model-supplied url is refused before or during the fetch. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

/**
 * True if `err` is (or wraps) a BlockedUrlError. A block raised in a hook
 * surfaces wrapped: a DNS-lookup block is AxiosError→cause, and a beforeRedirect
 * block is AxiosError→RedirectionError→cause — TWO levels. So walk the `.cause`
 * chain, not one link. The 10-link bound guards against a pathological cycle;
 * real axios chains are 1–3 deep, so it never truncates a genuine one. Call
 * sites use this to tell "this url is forbidden" from "this fetch failed
 * transiently."
 */
export function isBlockedUrlError(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 10; i++) {
    if (e instanceof BlockedUrlError) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The axios instance every guarded fetch must go through. Two deliberate
 * choices, both load-bearing:
 *
 * Its own agents, with keep-alive OFF. Node's http.globalAgent pools sockets by
 * host:port and shares them across every axios instance in the process — so a
 * guarded request could be served an already-open socket that *unguarded* code
 * opened, skipping the connect entirely. No connect means no DNS lookup, which
 * means guardedLookup never runs and the guard is silently bypassed. (Caught by
 * a test that fetched a real "internal secret" through a fully-configured
 * guard: axios reported reusedSocket: true.) A private pool with no reuse
 * guarantees every request connects, so the hook always fires.
 *
 * Proxies are off for the same reason (see `proxy: false` below).
 *
 * A non-default instance, so interceptors or retry patches an application
 * installs on the default axios never apply: guarded fetches are one-shot, so
 * a dead host costs one timeout and a blocked host errors once.
 */
export const guardedHttp = axios.create({
  httpAgent: new HttpAgent({ keepAlive: false }),
  httpsAgent: new HttpsAgent({ keepAlive: false }),
  // No implicit HTTP(S)_PROXY: through a proxy, guardedLookup would vet the
  // proxy's address instead of the destination's, and a private-resolving
  // host would sail through to the internal network.
  proxy: false,
});

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * True if `host` is a literal IP that is NOT a public unicast address —
 * loopback, private, link-local, CGNAT, unspecified, multicast, reserved, and
 * every IPv6 equivalent. False if `host` is not an IP literal at all (a real
 * hostname), so name-pattern checks still run for those.
 *
 * Delegates to ipaddr.js rather than hand-rolled range math: the hand-rolled
 * version shipped a loopback bypass — it matched `::ffff:127.0.0.1` but not the
 * hex form `::ffff:7f00:1` that WHATWG URL parsing normalizes to. `process()`
 * canonicalizes every encoding (v4-mapped hex/dotted, decimal-int like
 * 2130706433, compressed IPv6) before the range check, and "block anything but
 * unicast" fails closed on formats not yet imagined. `version` is unused —
 * kept only so existing call sites (isPrivateIp(ip, family)) don't change.
 */
export function isPrivateIp(host: string, _version?: number): boolean {
  let addr: ReturnType<typeof ipaddr.process>;
  try {
    addr = ipaddr.process(host); // unwraps v4-mapped to its embedded v4
  } catch {
    return false; // not an IP literal
  }
  return addr.range() !== "unicast";
}

const notPublicHost = (host: string, label: string) =>
  `${label} host "${host}" is not a public host; only public web URLs can be fetched.`;

/**
 * Blocks a host by name pattern (localhost / internal suffixes) or, when it is
 * a literal IP, by range. isPrivateIp returns false for real hostnames, so
 * domains that merely look like IPv6 prefixes (fda.gov, fc2.com, fdroid.org)
 * are not false-positived. A hostname that RESOLVES to a private address is
 * guardedLookup's job, not this one.
 */
export function hostBlockReason(rawHost: string, label = "url"): string | null {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    isPrivateIp(host)
  ) {
    return notPublicHost(host, label);
  }
  return null;
}

/** Pre-fetch validation of the parts that don't need the network. */
export function urlBlockReason(parsed: URL, label = "url"): string | null {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `${label} must be an http(s) URL, got "${parsed.protocol}//".`;
  }
  return hostBlockReason(parsed.hostname, label);
}

/**
 * Parse + vet a model-supplied url. Throws BlockedUrlError with a message meant
 * for the model (it explains what to do instead), so tools can surface it as a
 * tool error rather than a crash.
 */
export function assertPublicUrl(rawUrl: string, label = "url"): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`${label} is not a valid URL: ${rawUrl}`);
  }
  const reason = urlBlockReason(parsed, label);
  if (reason) throw new BlockedUrlError(reason);
  return parsed;
}

/**
 * DNS hook handed to axios, so the address the socket actually connects to is
 * the one we vetted. Checking resolution up-front instead would be advisory
 * only: Node re-resolves at connect time, leaving a DNS-rebinding window. This
 * runs on every hop.
 */
// Node's callback contract is (err, address: string, family: number) when
// `all` is false; axios types the hook with its own narrower LookupAddress, so
// the callback args are cast rather than restructured.
export const guardedLookup: NonNullable<AxiosRequestConfig["lookup"]> = (
  hostname,
  options,
  cb,
) => {
  dnsLookup(
    hostname,
    { ...(options as LookupOptions), all: true },
    (err, addresses: LookupAddress[]) => {
      if (err) return cb(err, []);
      const blocked = addresses.find((a) => isPrivateIp(a.address, a.family));
      if (blocked) {
        // A BlockedUrlError (not a bare Error) so callers can tell an SSRF
        // refusal apart from a transient network failure and refuse the url
        // outright instead of retrying it through a weaker fetch strategy.
        return cb(
          new BlockedUrlError(
            `${notPublicHost(hostname, "url")} (it resolves to ${blocked.address})`,
          ),
          [],
        );
      }
      if ((options as LookupOptions).all) return cb(null, addresses as any);
      cb(null, addresses[0].address as any, addresses[0].family as 4 | 6);
    },
  );
};

/**
 * Redirect hook. guardedLookup cannot see a hop to a literal IP (net.connect
 * skips DNS for those), so a 302 to http://127.0.0.1 would otherwise sail
 * through — this is what stops it. Sync by contract, hence name patterns only.
 */
export function guardedBeforeRedirect(
  label = "url",
): NonNullable<AxiosRequestConfig["beforeRedirect"]> {
  return (options) => {
    const reason = hostBlockReason(String(options.hostname ?? ""), label);
    if (reason) throw new BlockedUrlError(reason);
  };
}

/** Request config carrying both hooks; spread into a bespoke axios call. */
export function urlGuardConfig(label = "url"): AxiosRequestConfig {
  return { lookup: guardedLookup, beforeRedirect: guardedBeforeRedirect(label) };
}

/**
 * Guarded GET for a model-supplied url: validates the url, then vets every
 * redirect hop and every resolved address. Rejects with BlockedUrlError if
 * refused — `async` so a refusal is always a rejection, never a synchronous
 * throw a `.catch()`-style call site would miss.
 */
export async function safeGet<T = any>(
  rawUrl: string,
  config: AxiosRequestConfig = {},
  label = "url",
): Promise<AxiosResponse<T>> {
  const parsed = assertPublicUrl(rawUrl, label);
  return guardedHttp.get<T>(parsed.href, {
    ...config,
    // A default UA (many hosts 403 the axios one); a caller's own headers win.
    headers: { "User-Agent": BROWSER_UA, ...config.headers },
    // Guard hooks last: a call site must not be able to override them.
    ...urlGuardConfig(label),
  });
}
