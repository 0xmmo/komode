import { describe, it, expect } from "vitest";
import { createSandbox } from "../src/sandbox/index";
import { createSandboxSession } from "../src/sandbox/quickjs";

describe("createSandbox (komode/sandbox)", () => {
  it("runs TypeScript against host bindings and returns the value", async () => {
    const sb = await createSandbox({
      bindings: { add: async ({ a, b }: { a: number; b: number }) => a + b },
    });
    try {
      const result = await sb.run(`const n: number = await add({ a: 2, b: 3 });\nreturn n * 10;`);
      expect(result.ok).toBe(true);
      expect(result.returnValue).toBe(50);
    } finally {
      sb.dispose();
    }
  });

  it("marshals object results into native guest values", async () => {
    const sb = await createSandbox({
      bindings: { user: async () => ({ name: "Ada", tags: ["x", "y"] }) },
    });
    try {
      const result = await sb.run(`const u = await user(); return u.tags.length + u.name;`);
      expect(result.returnValue).toBe("2Ada");
    } finally {
      sb.dispose();
    }
  });

  it("persists globals and `state` across runs", async () => {
    const sb = await createSandbox();
    try {
      await sb.run(`state.rows = [1, 2, 3];`);
      const result = await sb.run(`return state.rows.reduce((a, b) => a + b, 0);`);
      expect(result.returnValue).toBe(6);
    } finally {
      sb.dispose();
    }
  });

  it("captures console output", async () => {
    const sb = await createSandbox();
    try {
      const result = await sb.run(`console.log("hi", { a: 1 }); console.warn("careful"); return 1;`);
      expect(result.logs).toEqual(['hi {"a":1}', "[warn] careful"]);
    } finally {
      sb.dispose();
    }
  });

  it("surfaces binding errors as catchable guest exceptions", async () => {
    const sb = await createSandbox({
      bindings: {
        boom: async () => {
          throw new Error("nope");
        },
      },
    });
    try {
      const caught = await sb.run(`try { await boom(); } catch (e) { return "caught: " + e.message; }`);
      expect(caught.returnValue).toBe("caught: nope");
      const uncaught = await sb.run(`await boom();`);
      expect(uncaught.ok).toBe(false);
      expect(uncaught.error).toContain("nope");
    } finally {
      sb.dispose();
    }
  });

  it("fetch is off by default and fails with steering text", async () => {
    const sb = await createSandbox();
    try {
      const result = await sb.run(`try { await fetch("https://example.com"); } catch (e) { return e.message; }`);
      expect(result.returnValue).toMatch(/fetch is not available in this sandbox/);
    } finally {
      sb.dispose();
    }
  });

  it("stops CPU-bound loops at the wall-clock limit and breaks the session", async () => {
    const session = await createSandboxSession({ timeoutMs: 1_500 });
    try {
      const result = await session.run(`while (true) {}`, []);
      expect(result.ok).toBe(false);
    } finally {
      session.dispose();
    }
  });

  it("times out a hung binding and marks the session broken", async () => {
    const session = await createSandboxSession({ timeoutMs: 500 });
    try {
      const result = await session.run(`await hang(); return 1;`, [
        { name: "hang", fn: () => new Promise(() => {}) },
      ]);
      expect(result.ok).toBe(false);
      expect(result.sessionBroken).toBe(true);
      expect(result.error).toMatch(/timed out/);
    } finally {
      session.dispose();
    }
  });

  it("rejects un-awaited host work instead of letting it leak into the next run", async () => {
    const session = await createSandboxSession({ timeoutMs: 5_000 });
    try {
      const result = await session.run(`async function main() { await slow(); }\nmain();\nreturn "done";`, [
        { name: "slow", fn: () => new Promise((r) => setTimeout(() => r("x"), 200)) },
      ]);
      expect(result.ok).toBe(false);
      expect(result.sessionBroken).toBe(true);
      expect(result.error).toMatch(/was not awaited/);
    } finally {
      session.dispose();
    }
  });

  it("reports transpile errors before execution", async () => {
    const session = await createSandboxSession();
    try {
      const result = await session.run(`return (;`, []);
      expect(result.ok).toBe(false);
    } finally {
      session.dispose();
    }
  });
});
