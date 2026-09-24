import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    sandbox: "src/sandbox/index.ts",
    mcp: "src/mcp/index.ts",
    "ai-sdk": "src/adapters/ai-sdk.ts",
    "openai-agents": "src/adapters/openai-agents.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // Optional peers stay external so installing komode never pulls them in.
  external: ["190proof", "ai", "@openai/agents", "@modelcontextprotocol/sdk"],
});
