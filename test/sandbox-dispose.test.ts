import { describe, it, expect } from "vitest";
import { createSandboxSession } from "../src/sandbox/quickjs";
import type { SandboxBinding } from "../src/sandbox/types";

// Guest catches its own OOM (models wrap risky code in try/catch), so the run
// itself reports ok — the damage only surfaces at dispose.
const OOM_AFTER_AWAIT = `const a = await tool({});
const arr = [];
try { while (true) arr.push("x".repeat(1000000)); } catch (e) {}
return "survived";`;

const bindings: SandboxBinding[] = [
  { name: "tool", fn: async () => ({ data: "y".repeat(200000) }) },
];

describe("code-sandbox dispose crash containment", () => {
  it("survives dispose after a guest OOM in an await-continuation, then serves a fresh session", async () => {
    const session = await createSandboxSession({
      memoryLimitBytes: 16 * 1024 * 1024,
    });
    const result = await session.run(OOM_AFTER_AWAIT, bindings, {
      timeoutMs: 15_000,
    });
    // The run itself looks clean — that's the point of this regression.
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe("survived");

    // Before the fix this threw WebAssembly.RuntimeError ("Aborted(Assertion
    // failed: list_empty(&rt->gc_obj_list)...").
    expect(() => session.dispose()).not.toThrow();

    // If the abort fired, the old cached module is poisoned — a new session
    // must still work because the cache was reset.
    const fresh = await createSandboxSession({});
    try {
      const check = await fresh.run("return 21 * 2;", [], {
        timeoutMs: 5_000,
      });
      expect(check.ok).toBe(true);
      expect(check.returnValue).toBe(42);
    } finally {
      expect(() => fresh.dispose()).not.toThrow();
    }
  }, 30_000);
});
