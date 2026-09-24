import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createSandboxSession } from "../src/sandbox/quickjs";
import type { SandboxBinding, SandboxSession } from "../src/sandbox/types";

const MODULE_SYNTAX_ERROR = /import\/export are not available in the sandbox/;

// Guard regression: a raw-text module-syntax check matches inside string and
// template literals, so any script writing out a Python/JS/shell file gets
// rejected. The check is AST-based: only real top-level module syntax rejects,
// and a rejection happens before execution so it must not spend budget.
describe("sandbox module-syntax guard", () => {
  let session: SandboxSession;
  let attached: Array<{ fileName?: string; content?: string }>;
  let bindings: SandboxBinding[];

  beforeAll(async () => {
    session = await createSandboxSession({ timeoutMs: 10_000 });
  });

  afterAll(() => {
    session.dispose();
  });

  beforeEach(() => {
    attached = [];
    bindings = [
      {
        name: "attachFile",
        fn: async (input: any) => {
          attached.push(input);
          return { success: true, fileName: input?.fileName };
        },
      },
    ];
  });

  test("Python file content in a template literal runs and attaches", async () => {
    const code = [
      "const app = `# -*- coding: utf-8 -*-",
      "import os",
      "import json",
      "from flask import Flask",
      "",
      "app = Flask(__name__)",
      "`;",
      'await attachFile({ content: app, fileName: "app.py" });',
      'return "attached";',
    ].join("\n");

    const result = await session.run(code, bindings);

    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.rejectedBeforeExecution).toBeUndefined();
    expect(attached).toHaveLength(1);
    expect(attached[0].fileName).toBe("app.py");
    expect(attached[0].content).toContain("import os");
  });

  test("shell content with line-start `export` in a literal runs", async () => {
    const code = [
      "const sh = `#!/bin/sh",
      "export PATH=/usr/local/bin:$PATH",
      "echo hi",
      "`;",
      'await attachFile({ content: sh, fileName: "run.sh" });',
      'return "attached";',
    ].join("\n");

    const result = await session.run(code, bindings);

    expect(result.ok).toBe(true);
    expect(attached).toHaveLength(1);
  });

  test("escaped-newline string content runs (parity with the multi-line form)", async () => {
    const code = [
      'const app = "# app\\nimport os\\nimport json\\n";',
      'await attachFile({ content: app, fileName: "app.py" });',
      'return "attached";',
    ].join("\n");

    const result = await session.run(code, bindings);

    expect(result.ok).toBe(true);
    expect(attached).toHaveLength(1);
  });

  test("a real top-level import is rejected before execution", async () => {
    const result = await session.run(
      'import fs from "fs";\nreturn fs;',
      bindings,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(MODULE_SYNTAX_ERROR);
    expect(result.rejectedBeforeExecution).toBe(true);
  });

  test("a top-level export modifier is rejected before execution", async () => {
    const result = await session.run(
      "export const x = 1;\nreturn x;",
      bindings,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(MODULE_SYNTAX_ERROR);
    expect(result.rejectedBeforeExecution).toBe(true);
  });

  test("import without a following space is rejected (the old regex missed it)", async () => {
    const result = await session.run(
      'import{readFileSync}from"fs";\nreturn 1;',
      bindings,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(MODULE_SYNTAX_ERROR);
    expect(result.rejectedBeforeExecution).toBe(true);
  });
});

