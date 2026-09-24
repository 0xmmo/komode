import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { createSandboxSession } from "../src/sandbox/quickjs";
import type { SandboxBinding, SandboxSession } from "../src/sandbox/types";
import { decodeBody, sandboxFetch, SANDBOX_PRELUDE, sanitizeHeaders, type SandboxFetchResult } from "../src/sandbox/fetch";
import type { Logger } from "../src/util";

const fakeLog = (): Logger & { warns: string[] } => {
  const warns: string[] = [];
  return {
    warns,
    debug: () => {},
    info: () => {},
    warn: (...args: any[]) => warns.push(args.join(" ")),
    error: () => {},
  };
};

describe("sandbox fetch prelude (guest shim over a fake __fetch)", () => {
  let session: SandboxSession;
  let received: any[];
  let canned: SandboxFetchResult;
  let bindings: SandboxBinding[];

  beforeAll(async () => {
    session = await createSandboxSession({
      timeoutMs: 10_000,
      prelude: SANDBOX_PRELUDE,
    });
  });

  afterAll(() => {
    session.dispose();
  });

  beforeEach(() => {
    received = [];
    canned = {
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://api.example.com/final",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: '{"price": 63.58}',
    };
    bindings = [
      {
        name: "__fetch",
        fn: async (input: unknown) => {
          received.push(input);
          return canned;
        },
      },
    ];
  });

  test("fetch(url) returns a Response-like: ok/status/text()/json()", async () => {
    const result = await session.run(
      `const res = await fetch("https://api.example.com/q");
       return { ok: res.ok, status: res.status, statusText: res.statusText, url: res.url, text: await res.text(), json: await res.json() };`,
      bindings,
    );
    expect(result.error).toBeUndefined();
    expect(result.returnValue).toEqual({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://api.example.com/final",
      text: '{"price": 63.58}',
      json: { price: 63.58 },
    });
    expect(received).toEqual([
      { url: "https://api.example.com/q" },
    ]);
  });

  test("headers.get is case-insensitive and null for missing", async () => {
    const result = await session.run(
      `const res = await fetch("https://x.test/");
       return [res.headers.get("Content-Type"), res.headers.get("x-missing")];`,
      bindings,
    );
    expect(result.returnValue).toEqual([
      "application/json; charset=utf-8",
      null,
    ]);
  });

  test("init (method/headers/body) is forwarded to the host binding verbatim", async () => {
    const result = await session.run(
      `await fetch("https://x.test/", { method: "HEAD", headers: { Referer: "https://finance.sina.com.cn" }, body: "nope" });
       return "done";`,
      bindings,
    );
    expect(result.error).toBeUndefined();
    // body passes through so the HOST rejects it with steering text rather
    // than the shim silently dropping it.
    expect(received[0]).toEqual({
      url: "https://x.test/",
      method: "HEAD",
      headers: { Referer: "https://finance.sina.com.cn" },
      body: "nope",
    });
  });

  test("host binding errors surface as catchable guest exceptions", async () => {
    bindings[0].fn = async () => {
      throw new Error("fetch to x.test failed: boom");
    };
    const result = await session.run(
      `try { await fetch("https://x.test/"); return "no-throw"; }
       catch (e) { return String(e.message || e); }`,
      bindings,
    );
    expect(result.returnValue).toContain("fetch to x.test failed");
  });

  test("btoa/atob round-trip and TextEncoder produce real bytes", async () => {
    const result = await session.run(
      `const enc = btoa("hello:world");
       const dec = atob(enc);
       const bytes = Array.from(new TextEncoder().encode("hé"));
       const roundTrip = new TextDecoder().decode(new TextEncoder().encode("中国"));
       return { enc, dec, bytes, roundTrip };`,
      bindings,
    );
    expect(result.returnValue).toEqual({
      enc: "aGVsbG86d29ybGQ=",
      dec: "hello:world",
      bytes: [0x68, 0xc3, 0xa9],
      roundTrip: "中国",
    });
  });

  test("require and Buffer throw steering text, synchronously", async () => {
    const result = await session.run(
      `const errors = [];
       try { require("dayjs"); } catch (e) { errors.push(String(e.message)); }
       try { Buffer.from("abc"); } catch (e) { errors.push(String(e.message)); }
       try { new TextDecoder("gbk"); } catch (e) { errors.push(String(e.message)); }
       return errors;`,
      bindings,
    );
    expect(result.error).toBeUndefined();
    expect(result.sessionBroken).toBeUndefined();
    const errors = result.returnValue as string[];
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/is not available in this context/);
    expect(errors[1]).toMatch(/is not available in this context/);
    expect(errors[2]).toMatch(/utf-8/);
  });
});

describe("sandboxFetch host fn (real guard, live local server)", () => {
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

  test("loopback GET is refused and the server is never reached", async () => {
    const log = fakeLog();
    await expect(
      sandboxFetch({ url: `http://127.0.0.1:${port}/secret` }, undefined, log),
    ).rejects.toThrow(/fetch url/);
    expect(hits).toBe(0);
    expect(log.warns.join("\n")).toContain("sandbox-fetch-blocked");
  });

  test("metadata endpoint is refused", async () => {
    await expect(
      sandboxFetch({ url: "http://169.254.169.254/latest/meta-data/" }, undefined, fakeLog()),
    ).rejects.toThrow(/fetch url/);
  });

  test("POST is rejected before URL vetting — even to a blocked host", async () => {
    const log = fakeLog();
    await expect(
      sandboxFetch(
        { url: `http://127.0.0.1:${port}/`, method: "POST", body: "x=1" },
        undefined,
        log,
      ),
    ).rejects.toThrow(/GET and HEAD only/);
    expect(hits).toBe(0);
    expect(log.warns.join("\n")).toContain("sandbox-fetch-rejected");
    expect(log.warns.join("\n")).toContain("reason=method");
  });

  test("GET with a body is rejected", async () => {
    const log = fakeLog();
    await expect(
      sandboxFetch(
        { url: "https://example.com/", method: "GET", body: "payload" },
        undefined,
        log,
      ),
    ).rejects.toThrow(/no request bodies/);
    expect(log.warns.join("\n")).toContain("reason=body");
  });

  test("non-http schemes are refused", async () => {
    await expect(
      sandboxFetch({ url: "file:///etc/passwd" }, undefined, fakeLog()),
    ).rejects.toThrow();
  });
});

describe("sanitizeHeaders", () => {
  test("drops connection-level headers, strips CR/LF, and blocks smuggled keys", () => {
    expect(
      sanitizeHeaders({
        Referer: "https://finance.sina.com.cn",
        Host: "internal.example",
        "content-length": "999",
        "ho\rst": "smuggled.example",
        "X-Injected": "a\r\nEvil: b",
        "x-null": null,
      }),
    ).toEqual({
      Referer: "https://finance.sina.com.cn",
      "X-Injected": "aEvil: b",
    });
  });
});

// Bun's TextDecoder has no GBK/gb18030 support; decodeBody degrades to utf-8 there.
const gbkTest = test.skipIf(typeof (globalThis as any).Bun !== "undefined");

describe("decodeBody charset handling", () => {
  // GBK bytes for 中国
  const GBK_ZHONGGUO = Buffer.from([0xd6, 0xd0, 0xb9, 0xfa]);

  test("utf-8 with declared charset", () => {
    expect(decodeBody(Buffer.from("héllo 中国", "utf8"), "text/plain; charset=utf-8")).toBe(
      "héllo 中国",
    );
  });

  gbkTest("GBK bytes with declared charset=GBK", () => {
    expect(decodeBody(GBK_ZHONGGUO, "text/html; charset=GBK")).toBe("中国");
  });

  gbkTest("GBK bytes with NO charset fall back via strict-utf8 → gb18030 (the qt.gtimg.cn case)", () => {
    expect(decodeBody(GBK_ZHONGGUO, "text/html")).toBe("中国");
  });

  test("nonsense charset label falls back cleanly", () => {
    expect(decodeBody(Buffer.from("plain ascii"), "text/plain; charset=klingon")).toBe(
      "plain ascii",
    );
  });
});

