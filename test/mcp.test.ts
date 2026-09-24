import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { connectMcp, mcpSkill, toIdentifier, type McpConnection } from "../src/mcp/index";
import { createCodeModeTool } from "../src/code-mode";
import { Agent } from "../src/agent";
import { code, lastToolResult, scriptedModel, text } from "./helpers";

function makeServer() {
  const server = new McpServer({ name: "issues", version: "1.0.0" }, { instructions: "Issue tracker for the acme repo." });
  const issues = [
    { id: 1, title: "Crash on start", open: true },
    { id: 2, title: "Typo in docs", open: false },
  ];
  server.registerTool(
    "list-issues",
    {
      description: "List issues, optionally only open ones.",
      inputSchema: { openOnly: z.boolean().optional() },
      outputSchema: { issues: z.array(z.object({ id: z.number(), title: z.string(), open: z.boolean() })) },
    },
    async ({ openOnly }) => {
      const list = openOnly ? issues.filter((i) => i.open) : issues;
      return { content: [{ type: "text", text: JSON.stringify(list) }], structuredContent: { issues: list } };
    },
  );
  server.registerTool(
    "close_issue",
    { description: "Close an issue.", inputSchema: { id: z.number() } },
    async ({ id }) => {
      const issue = issues.find((i) => i.id === id);
      if (!issue) return { content: [{ type: "text", text: `No issue ${id}` }], isError: true };
      issue.open = false;
      return { content: [{ type: "text", text: `Closed #${id}` }] };
    },
  );
  return server;
}

async function linked(): Promise<McpConnection> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await makeServer().connect(serverTransport);
  return connectMcp({ name: "issues", server: { transport: clientTransport } });
}

describe("MCP", () => {
  let conn: McpConnection;
  beforeAll(async () => {
    conn = await linked();
  });
  afterAll(async () => {
    await conn.close();
  });

  it("turns MCP tools into JS-safe typed functions", () => {
    expect(conn.tools.map((t) => t.name)).toEqual(["listIssues", "closeIssue"]);
    expect(conn.instructions).toBe("Issue tracker for the acme repo.");
    expect(toIdentifier("repo.list_all")).toBe("repoListAll");
    expect(toIdentifier("2fa-code")).toBe("_2faCode");
  });

  it("lets code chain MCP calls, with structured output and isError as throws", async () => {
    const tool = createCodeModeTool({ mcp: [conn], sandbox: { fetch: false } });
    expect(tool.description).toContain("declare function listIssues(input: {");
    expect(tool.description).toContain("openOnly?: boolean;");
    expect(tool.description).toContain("Promise<{");
    try {
      const out = await tool.execute({
        code: `const { issues } = await listIssues({ openOnly: true });
for (const i of issues) await closeIssue({ id: i.id });
let err = "";
try { await closeIssue({ id: 99 }); } catch (e) { err = e.message; }
return { closed: issues.map(i => i.id), err, remaining: (await listIssues({ openOnly: true })).issues.length };`,
      });
      expect(out).toContain('"closed":[1]');
      expect(out).toContain('"err":"No issue 99"');
      expect(out).toContain('"remaining":0');
    } finally {
      tool.dispose();
    }
  });

  it("packages a server as a skill for the Agent", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await makeServer().connect(serverTransport);
    const skill = await mcpSkill({ name: "issues", server: { transport: clientTransport } });
    expect(skill.description).toBe("Issue tracker for the acme repo.");
    const model = scriptedModel([
      { content: null, function_calls: [{ id: "a", name: "use_skills", arguments: { skills: ["issues"] } }] },
      code(`return (await listIssues({})).issues.length;`),
      (req) => text(/<return_value>\s+2\s/.test(lastToolResult(req)) ? "two issues" : lastToolResult(req)),
    ]);
    const agent = new Agent({ model: "test:m", callModel: model.callModel, skills: [skill], sandbox: { fetch: false } });
    try {
      expect((await agent.run("how many issues?")).text).toBe("two issues");
    } finally {
      await skill.close();
    }
  });
});
