/**
 * An MCP server as a komode skill. The model loads it with use_skills, then
 * chains its tools in one script. Here the server runs in-process so the
 * example is self-contained; pass { url } or { command, args } for real ones.
 *
 *   OPENAI_API_KEY=... npx tsx examples/05-mcp.ts
 *   (any 190proof model works: MODEL=anthropic:claude-sonnet-5, MODEL=openrouter:…)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { Agent } from "komode";
import { mcpSkill } from "komode/mcp";

// A tiny notes server
const notes = new Map<string, string[]>([["groceries", ["eggs", "rice"]], ["todo", ["file taxes"]]]);
const server = new McpServer({ name: "notes", version: "1.0.0" }, { instructions: "Personal notes: lists of items." });
server.registerTool(
  "list-notes",
  { description: "Names of all note lists.", outputSchema: { names: z.array(z.string()) } },
  async () => ({ content: [{ type: "text", text: [...notes.keys()].join(", ") }], structuredContent: { names: [...notes.keys()] } }),
);
server.registerTool(
  "read-note",
  { description: "Items in one note list.", inputSchema: { name: z.string() } },
  async ({ name }) => ({ content: [{ type: "text", text: (notes.get(name) ?? []).join("\n") }] }),
);
server.registerTool(
  "add-item",
  { description: "Append an item to a note list.", inputSchema: { name: z.string(), item: z.string() } },
  async ({ name, item }) => {
    notes.set(name, [...(notes.get(name) ?? []), item]);
    return { content: [{ type: "text", text: `added to ${name}` }] };
  },
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);

const notesSkill = await mcpSkill({ name: "notes", server: { transport: clientTransport } });

const agent = new Agent({ model: process.env.MODEL ?? "openai:gpt-5-mini", skills: [notesSkill] });
const result = await agent.run("Add milk to my groceries, then tell me everything across all my lists.");
console.log(result.text);
console.log("\nsteps:", result.steps.map((s) => s.type).join(" → "));
await notesSkill.close();
