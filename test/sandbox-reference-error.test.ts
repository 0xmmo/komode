import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createSandboxSession } from "../src/sandbox/quickjs";
import type { SandboxBinding, SandboxSession } from "../src/sandbox/types";

// Guard regression : a guest call to a hallucinated
// function name surfaced a bare "ReferenceError: 'X' is not defined", after
// which the model brute-forced more invented names across several
// execute_code runs and finally apologized to the user instead of calling the
// real function (resetUser). The error now lists what is actually callable so
// one retry lands on a real name.
describe("sandbox ReferenceError function hint", () => {
  let session: SandboxSession;
  let bindings: SandboxBinding[];

  beforeAll(async () => {
    session = await createSandboxSession({ timeoutMs: 10_000 });
  });

  afterAll(() => {
    session.dispose();
  });

  beforeEach(() => {
    bindings = [
      { name: "resetUser", fn: async () => "ok" },
      { name: "editUserProfile", fn: async () => "ok" },
      { name: "__fetch", fn: async () => "internal" },
    ];
  });

  test("calling an undefined function lists the available ones", async () => {
    const result = await session.run("await deleteProfileAndMemory();", bindings);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/is not defined/);
    expect(result.error).toMatch(
      /Available functions: resetUser, editUserProfile/
    );
    // Internal __-prefixed bindings are not advertised
    expect(result.error).not.toContain("__fetch");
  });

  // Second failure mode (prod 2026-08-31): the name is a REAL tool that just
  // isn't loaded — 71 of ~95 ReferenceErrors in a 2h glm-5.3-flash sample were
  // `webSearch`. With only the "available functions" list the model reads it as
  // "no such capability" and answers without it, so the error must also raise
  // the not-loaded possibility. The owning skill is deliberately not named.
  test("an undefined function also raises the unloaded-skill possibility", async () => {
    const result = await session.run("await webSearch({ q: 'hi' });", bindings);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/is not defined/);
    expect(result.error).toMatch(/gated behind a skill you have not loaded/);
  });

  test("a plain guest throw gets no hint", async () => {
    const result = await session.run('throw new Error("boom");', bindings);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/boom/);
    expect(result.error).not.toContain("Available functions:");
    expect(result.error).not.toContain("gated behind a skill");
  });
});
