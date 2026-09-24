/**
 * Regressions from the pre-release review: each test reproduces a finding
 * that was confirmed against the first draft.
 */
import { describe, it, expect } from "vitest";
import { Agent, CodeRunner, createCodeModeTool, defineSkill, defineTool, toolResult } from "../src/index";
import { guardedHttp } from "../src/sandbox/safe-url";
import { sanitizeHeaders } from "../src/sandbox/fetch";
import { createSandbox } from "../src/sandbox/index";
import { toIdentifier } from "../src/mcp/index";
import { lastToolResult, scriptedModel, text } from "./helpers";

const echo = defineTool({ name: "echo", description: "Echo.", run: (a: any) => a.v ?? "e" });

describe("review regressions", () => {
  it("guarded fetches never use an implicit HTTP(S)_PROXY", () => {
    expect(guardedHttp.defaults.proxy).toBe(false);
  });

  it("header names are trimmed before the blocklist", () => {
    expect(sanitizeHeaders({ " Host ": "evil", " Transfer-Encoding ": "chunked", "Bad Name": "x", Accept: "a" })).toEqual({
      Accept: "a",
    });
  });

  it("a tool reference saved across runs still counts against the current run", async () => {
    const runner = new CodeRunner({ tools: [echo], sandbox: { fetch: false }, limits: { maxToolCallsPerRun: 2 } });
    try {
      await runner.run(`state.saved = echo; return 1;`);
      const out = await runner.run(`for (let i = 0; i < 4; i++) await state.saved({ v: i }); return "no cap";`);
      expect(out.result.ok).toBe(false);
      expect(out.result.error).toContain("Too many function calls");
      expect(out.calls.length).toBe(2);
    } finally {
      runner.dispose();
    }
  });

  it("a saved reference can't run after a tool ended the run", async () => {
    let afterCalls = 0;
    const finish = defineTool({ name: "finish", description: "End.", run: () => toolResult({ endTurn: { reply: "bye" } }) });
    const after = defineTool({ name: "after", description: "x", run: () => void afterCalls++ });
    const runner = new CodeRunner({ tools: [finish, after], sandbox: { fetch: false } });
    try {
      await runner.run(`state.a = after; return 1;`);
      const out = await runner.run(`await finish(); try { await state.a(); } catch {} return 1;`);
      expect(out.endTurn).toEqual({ reply: "bye" });
      expect(afterCalls).toBe(0);
    } finally {
      runner.dispose();
    }
  });

  it("concurrent executions of one code-mode tool are serialized", async () => {
    const slow = defineTool({ name: "slow", description: "Slow.", run: () => new Promise((r) => setTimeout(() => r("s"), 150)) });
    const tool = createCodeModeTool({ tools: [slow], sandbox: { fetch: false } });
    try {
      const [a, b] = await Promise.all([
        tool.execute({ code: `return await slow();` }),
        tool.execute({ code: `return "fast";` }),
      ]);
      expect(a).toContain("<return_value>");
      expect(a).not.toContain("<error>");
      expect(b).toContain("fast");
    } finally {
      tool.dispose();
    }
  });

  it("a later run's abort signal interrupts guest CPU work", async () => {
    const runner = new CodeRunner({ sandbox: { fetch: false, timeoutMs: 20_000 } });
    try {
      await runner.run(`return 1;`, { signal: new AbortController().signal });
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 200);
      const started = Date.now();
      const out = await runner.run(`while (true) {}`, { signal: ctrl.signal });
      expect(out.result.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(10_000);
      // and an aborted earlier signal doesn't poison the next run
      expect((await runner.run(`return 2;`)).result.returnValue).toBe(2);
    } finally {
      runner.dispose();
    }
  });

  it("two different tools with one name are rejected; the same tool in two skills is fine", () => {
    const other = defineTool({ name: "echo", description: "Other echo.", run: () => "o" });
    expect(() => new Agent({ model: "m", tools: [echo], skills: [defineSkill({ name: "s", description: "d", tools: [other] })] })).toThrow(
      /Two different tools are named "echo"/,
    );
    expect(
      () =>
        new Agent({
          model: "m",
          skills: [
            defineSkill({ name: "a", description: "d", tools: [echo] }),
            defineSkill({ name: "b", description: "d", tools: [echo] }),
          ],
        }),
    ).not.toThrow();
    expect(() => createCodeModeTool({ tools: [echo, other] })).toThrow(/Two different tools/);
  });

  it("reserved words and sandbox globals can't be tool names; MCP names are remapped", () => {
    expect(() => defineTool({ name: "delete", description: "x", run: () => 1 })).toThrow(/reserved/);
    expect(() => defineTool({ name: "fetch", description: "x", run: () => 1 })).toThrow(/reserved/);
    expect(() => defineTool({ name: "__secret", description: "x", run: () => 1 })).toThrow(/reserved/);
    expect(toIdentifier("delete")).toBe("deleteTool");
    expect(toIdentifier("fetch")).toBe("fetchTool");
  });

  it("null tool results arrive as null, not an empty string", async () => {
    const sb = await createSandbox({ bindings: { nothing: async () => null } });
    try {
      expect((await sb.run(`return (await nothing()) === null;`)).returnValue).toBe(true);
    } finally {
      sb.dispose();
    }
  });

  it("several use_skills calls in one response can't exceed the budget", async () => {
    const skills = ["a", "b", "c"].map((name) => defineSkill({ name, description: name }));
    const model = scriptedModel([
      {
        content: null,
        function_calls: ["a", "b", "c"].map((s, i) => ({ id: `u${i}`, name: "use_skills", arguments: { skills: [s] } })),
      },
      (req) => {
        expect(lastToolResult(req)).toContain("use_skills budget exhausted");
        return text("ok");
      },
    ]);
    const agent = new Agent({ model: "m", callModel: model.callModel, skills, limits: { maxUseSkillsCalls: 1 }, sandbox: { fetch: false } });
    return agent.run("x").then((r) => expect(r.skillsLoaded).toEqual(["a"]));
  });
});
