import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { lookup as dnsLookup } from "dns/promises";
import axios from "axios";
import {
  assertPublicUrl,
  BlockedUrlError,
  guardedBeforeRedirect,
  hostBlockReason,
  isBlockedUrlError,
  safeGet,
  urlBlockReason,
} from "../src/sandbox/safe-url";

/**
 * The guard's whole job is that a model-supplied url can't reach anything on
 * an internal network, so the load-bearing assertion in the fetch tests is
 * `hits === 0`: the local server stands in for an internal service, and it must
 * never see a request.
 *
 * Note what can't be tested from here: an *allowed* origin. Every address this
 * process can bind is a private one, so there is no way to host a public-looking
 * server locally — which also means the "public origin 302s to 127.0.0.1" chain
 * can't be driven end to end. That hop is covered by unit-testing
 * guardedBeforeRedirect directly (it is the hook axios calls on each hop).
 */
describe("safe-url SSRF guard", () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("INTERNAL SECRET");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    hits = 0;
  });

  describe("host and url predicates", () => {
    it("blocks loopback, private, link-local, and internal-DNS hosts", () => {
      for (const host of [
        "localhost",
        "foo.localhost",
        "127.0.0.1",
        "127.1.2.3",
        "0.0.0.0",
        "10.0.0.5",
        "172.16.0.1",
        "192.168.1.1",
        "100.64.0.1", // CGNAT
        "169.254.169.254", // cloud metadata
        "::1",
        "[::1]",
        "fd00::1", // unique-local
        "fe80::1", // link-local
        "::ffff:127.0.0.1", // v4-mapped
        "igpt.internal",
        "printer.local",
      ]) {
        expect(hostBlockReason(host)).toBeTruthy();
      }
    });

    it("blocks loopback written in every URL-normalizable encoding", () => {
      // WHATWG `new URL()` normalizes these to a literal IP before we ever see
      // the host; the guard must catch each. Regression: the hand-rolled range
      // check matched ::ffff:127.0.0.1 but NOT the hex form the URL parser emits
      // for it (::ffff:7f00:1) — a real loopback bypass.
      for (const raw of [
        "http://2130706433/", // decimal 127.0.0.1
        "http://0x7f000001/", // hex
        "http://0177.0.0.1/", // octal
        "http://127.1/", // short form
        "http://[::ffff:127.0.0.1]/", // v4-mapped, dotted
        "http://[::ffff:7f00:1]/", // v4-mapped, hex (the bypass)
        "http://[0:0:0:0:0:0:0:1]/", // expanded ::1
      ]) {
        const host = new URL(raw).hostname;
        expect(hostBlockReason(host)).toBeTruthy();
      }
    });

    it("allows a public address written as a v4-mapped IPv6", () => {
      // ::ffff:8.8.8.8 is a real way to write 8.8.8.8 — must NOT be blocked.
      expect(hostBlockReason("::ffff:8.8.8.8")).toBeNull();
      expect(hostBlockReason("[::ffff:8.8.8.8]")).toBeNull();
    });

    it("allows public hosts, including domains that look like private IPv6 prefixes", () => {
      // Regression: matching the fc/fd/fe8-b IPv6 regexes against hostnames
      // would false-positive all of these.
      for (const host of [
        "example.com",
        "fda.gov",
        "fc2.com",
        "fdroid.org",
        "feedly.com",
        "8.8.8.8",
        "localhost.example.com",
      ]) {
        expect(hostBlockReason(host)).toBeNull();
      }
    });

    it("blocks non-http(s) schemes", () => {
      expect(urlBlockReason(new URL("file:///etc/passwd"))).toMatch(/http\(s\)/);
      expect(urlBlockReason(new URL("gopher://example.com"))).toMatch(/http\(s\)/);
      expect(urlBlockReason(new URL("https://example.com"))).toBeNull();
    });

    it("assertPublicUrl throws BlockedUrlError, with the label in the message", () => {
      expect(() => assertPublicUrl("http://127.0.0.1/x", "readWebPage `url`")).toThrow(
        BlockedUrlError,
      );
      expect(() => assertPublicUrl("http://127.0.0.1/x", "readWebPage `url`")).toThrow(
        /readWebPage/,
      );
      expect(() => assertPublicUrl("not a url", "url")).toThrow(BlockedUrlError);
      expect(assertPublicUrl("https://example.com/a?b=1").href).toBe(
        "https://example.com/a?b=1",
      );
    });
  });

  describe("isBlockedUrlError", () => {
    it("sees a BlockedUrlError directly and wrapped up the .cause chain", () => {
      const blocked = new BlockedUrlError("nope");
      expect(isBlockedUrlError(blocked)).toBe(true);
      // One level: how axios surfaces a block from the DNS lookup hook.
      expect(isBlockedUrlError(Object.assign(new Error("connect fail"), { cause: blocked }))).toBe(
        true,
      );
      // Two levels: a beforeRedirect block is AxiosError -> RedirectionError ->
      // BlockedUrlError. A one-level check would miss this and let the caller
      // fall through to its weaker fetch path.
      const redirErr = Object.assign(new Error("redirect failed"), { cause: blocked });
      const axiosErr = Object.assign(new Error("request failed"), { cause: redirErr });
      expect(isBlockedUrlError(axiosErr)).toBe(true);
      expect(isBlockedUrlError(new Error("some other failure"))).toBe(false);
      expect(isBlockedUrlError(undefined)).toBe(false);
      // A cause cycle must not hang the walk.
      const a: any = new Error("a");
      const b: any = new Error("b");
      a.cause = b;
      b.cause = a;
      expect(isBlockedUrlError(a)).toBe(false);
    });
  });

  describe("guardedBeforeRedirect (the hop guardedLookup can't see)", () => {
    // A redirect to a literal IP never hits DNS, so the lookup hook is not
    // called for it — this is the only thing standing in the way.
    it("throws on a hop to a private literal IP or an internal name", () => {
      const hook = guardedBeforeRedirect("attachFile `url`");
      expect(() => hook({ hostname: "127.0.0.1" } as any, {} as any, "" as any)).toThrow(
        BlockedUrlError,
      );
      expect(() => hook({ hostname: "169.254.169.254" } as any, {} as any, "" as any)).toThrow(
        BlockedUrlError,
      );
      expect(() => hook({ hostname: "igpt.internal" } as any, {} as any, "" as any)).toThrow(
        BlockedUrlError,
      );
    });

    it("passes a public hop through", () => {
      const hook = guardedBeforeRedirect();
      expect(() =>
        hook({ hostname: "example.com" } as any, {} as any, "" as any),
      ).not.toThrow();
    });
  });

  describe("safeGet", () => {
    it("refuses a literal private IP without opening a socket", async () => {
      await expect(safeGet(`http://127.0.0.1:${port}/secret`)).rejects.toThrow(
        BlockedUrlError,
      );
      expect(hits).toBe(0);
    });

    it("refuses localhost by name", async () => {
      await expect(safeGet(`http://localhost:${port}/secret`)).rejects.toThrow(
        BlockedUrlError,
      );
      expect(hits).toBe(0);
    });

    it("refuses cloud metadata and file://", async () => {
      await expect(
        safeGet("http://169.254.169.254/latest/meta-data/"),
      ).rejects.toThrow(BlockedUrlError);
      await expect(safeGet("file:///etc/passwd")).rejects.toThrow(BlockedUrlError);
    });

    it("refuses a public hostname that resolves to a private address (DNS rebinding)", async () => {
      // 127.0.0.1.nip.io is a real public domain whose A record is 127.0.0.1:
      // it passes every name check, and is exactly the case that only the
      // connect-time lookup hook can catch. Needs DNS, so it self-skips where
      // the network is unavailable (e.g. a sandboxed runner).
      const host = "127.0.0.1.nip.io";
      let resolved: string | null = null;
      try {
        resolved = (await dnsLookup(host)).address;
      } catch {
        /* no DNS here */
      }
      if (resolved !== "127.0.0.1") {
        console.warn(`skipping rebinding test: ${host} resolved to ${resolved}`);
        return;
      }

      const url = `http://${host}:${port}/secret`;
      expect(hostBlockReason(host)).toBeNull(); // the name check sees nothing wrong

      // Prove the test isn't vacuous: unguarded, this request really does reach
      // the server standing in for an internal service.
      const unguarded = await axios.get(url);
      expect(unguarded.data).toBe("INTERNAL SECRET");
      expect(hits).toBe(1);

      hits = 0;
      await expect(safeGet(url)).rejects.toThrow(
        /not a public host.*resolves to 127\.0\.0\.1/s,
      );
      expect(hits).toBe(0); // the guarded one never connected
    });
  });
});
