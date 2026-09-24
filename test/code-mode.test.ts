import { describe, it, expect } from "vitest";
import { createCodeModeTool, defineTool, toolResult } from "../src/index";
import { codeModeTool as aiSdkTool } from "../src/adapters/ai-sdk";
import { codeModeTool as openAiAgentsTool } from "../src/adapters/openai-agents";

const add = defineTool<{ a: number; b: number }>({
  name: "add",
  description: "Adds two numbers.",
  parameters: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  returns: { type: "number" },
  run: ({ a, b }) => a + b,
});

describe("createCodeModeTool", () => {
  it("describes the typed API and runs code against it", async () => {
    const tool = createCodeModeTool({ tools: [add], sandbox: { fetch: false } });
    try {
      expect(tool.name).toBe("execute_code");
      expect(tool.description).toContain("declare function add(input: {");
      expect(tool.description).toContain("}): Promise<number>;");
      expect(tool.description).not.toContain("declare function fetch");
      const out = await tool.execute({ code: `const [x, y] = await Promise.all([add({a:1,b:2}), add({a:3,b:4})]);\nreturn x * y;` });
      expect(out).toContain("<return_value>\n    21");
      expect(out).toContain("add({\"a\":1,\"b\":2}) -> ok");
    } finally {
      tool.dispose();
    }
  });

  it("keeps state between calls and reports errors as text, not throws", async () => {
    const tool = createCodeModeTool({ tools: [add], sandbox: { fetch: false } });
    try {
      await tool.execute({ code: "state.total = await add({ a: 5, b: 5 });" });
      expect(await tool.execute({ code: "return state.total;" })).toContain("10");
      const err = await tool.execute({ code: "await subtract({ a: 1 });" });
      expect(err).toContain("<error>");
      expect(err).toContain("Available functions: add");
      const badArg = await tool.execute({ code: "await add(5);" });
      expect(badArg).toContain("takes a single object argument");
    } finally {
      tool.dispose();
    }
  });

  it("collects files and declares fetch when enabled", async () => {
    const pdf = defineTool({
      name: "pdf",
      description: "Makes a PDF.",
      run: () => toolResult({ files: [{ fileName: "a.pdf", mimeType: "application/pdf" }] }),
    });
    const tool = createCodeModeTool({ tools: [pdf] });
    try {
      expect(tool.description).toContain("declare function fetch(url: string");
      await tool.execute({ code: "return await pdf();" });
      expect(tool.files.map((f) => f.fileName)).toEqual(["a.pdf"]);
    } finally {
      tool.dispose();
    }
  });

  it("caps tool fan-out per run", async () => {
    const tool = createCodeModeTool({ tools: [add], sandbox: { fetch: false }, limits: { maxToolCallsPerRun: 3 } });
    try {
      const out = await tool.execute({ code: "for (let i = 0; i < 5; i++) await add({ a: i, b: i });" });
      expect(out).toContain("Too many function calls");
    } finally {
      tool.dispose();
    }
  });
});

describe("framework adapters", () => {
  it("Vercel AI SDK tool executes code", async () => {
    const tool: any = aiSdkTool({ tools: [add], sandbox: { fetch: false } });
    try {
      expect(tool.description).toContain("declare function add");
      expect(tool.inputSchema).toBeDefined();
      const out = await tool.execute({ code: "return await add({ a: 2, b: 2 });" }, { toolCallId: "t", messages: [] });
      expect(out).toContain("4");
    } finally {
      tool.codeMode.dispose();
    }
  });

  it("OpenAI Agents SDK tool is a strict function tool that executes code", async () => {
    const tool: any = openAiAgentsTool({ tools: [add], sandbox: { fetch: false } });
    try {
      expect(tool.type).toBe("function");
      expect(tool.name).toBe("execute_code");
      expect(tool.strict).toBe(true);
      expect(tool.parameters.required).toEqual(["code"]);
      const out = await tool.codeMode.execute({ code: "return await add({ a: 1, b: 1 });" });
      expect(out).toContain("2");
    } finally {
      tool.codeMode.dispose();
    }
  });
});
