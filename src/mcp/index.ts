/**
 * MCP servers as code-mode tools. Connect to a server and every tool it lists
 * becomes a typed async function the model can call from execute_code,
 * chaining several calls in one run instead of round-tripping each through
 * the model.
 *
 *   const github = await connectMcp({ name: "github", server: { url: "https://…/mcp" } });
 *   codeModeTool({ mcp: [github] })            // in your framework, or
 *   new Agent({ skills: [await mcpSkill({ name: "github", server: { url } })] })
 *
 * Auth stays with you (headers, a custom transport); the sandbox never sees
 * credentials — it only sees the functions.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JsonSchema } from "../schema-to-ts";
import type { Skill } from "../skill";
import { RESERVED_NAMES, toolResult, type ModelImage, type ToolDefinition } from "../tool";

export type McpServerConfig =
  /** Streamable HTTP server */
  | { url: string; headers?: Record<string, string> }
  /** Local server spawned over stdio */
  | { command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  /** Any MCP transport you construct yourself */
  | { transport: Transport };

export interface ConnectMcpOptions {
  /** Label for errors and the default skill description */
  name: string;
  server: McpServerConfig;
  /** Prefix for generated function names, e.g. "github" → githubListIssues */
  prefix?: string;
  /** Only expose these MCP tool names */
  include?: string[];
  /** Hide these MCP tool names */
  exclude?: string[];
}

export interface McpConnection {
  name: string;
  /** One komode tool per MCP tool, with JS-safe names */
  tools: ToolDefinition[];
  /** Server-provided usage instructions, if any */
  instructions?: string;
  client: Client;
  close(): Promise<void>;
}

const VERSION = "0.1.1";

export async function connectMcp(opts: ConnectMcpOptions): Promise<McpConnection> {
  const transport = await createTransport(opts.server);
  const client = new Client({ name: "komode", version: VERSION }, { capabilities: {} });
  await client.connect(transport);

  const listed: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    listed.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);

  const used = new Set<string>();
  const tools: ToolDefinition[] = listed
    .filter((t) => (!opts.include || opts.include.includes(t.name)) && !opts.exclude?.includes(t.name))
    .map((mcpTool) => {
      let name = toIdentifier(opts.prefix ? `${opts.prefix}_${mcpTool.name}` : mcpTool.name);
      for (let n = 2; used.has(name); n++) name = `${name.replace(/\d+$/, "")}${n}`;
      used.add(name);
      const description = [mcpTool.title, mcpTool.description].filter(Boolean).join("\n\n") || `${mcpTool.name} (MCP tool from ${opts.name})`;
      return {
        name,
        description,
        parameters: (mcpTool.inputSchema ?? { type: "object", properties: {} }) as JsonSchema,
        returns: mcpTool.outputSchema as JsonSchema | undefined,
        run: async (args: Record<string, unknown>, ctx) => {
          const result: any = await client.callTool({ name: mcpTool.name, arguments: args }, undefined, {
            signal: ctx.signal,
          });
          return mcpResultToToolReturn(result, mcpTool.name);
        },
      } satisfies ToolDefinition;
    });

  return {
    name: opts.name,
    tools,
    instructions: client.getInstructions(),
    client,
    close: () => client.close(),
  };
}

export interface McpSkillOptions extends ConnectMcpOptions {
  /** Skill description shown in the catalog; defaults to the server's own or a generic line */
  description?: string;
  /** Extra guidance appended after the server's own instructions */
  instructions?: string;
  model?: string;
  maxExecuteCalls?: number;
}

/** Connect to an MCP server and package its tools as a loadable skill. */
export async function mcpSkill<TState = any>(
  opts: McpSkillOptions,
): Promise<Skill<TState> & { connection: McpConnection; close(): Promise<void> }> {
  const connection = await connectMcp(opts);
  const serverFirstLine = connection.instructions?.trim().split("\n")[0];
  return {
    name: opts.name,
    description: opts.description ?? serverFirstLine ?? `Tools from the ${opts.name} MCP server`,
    instructions: [connection.instructions, opts.instructions].filter(Boolean).join("\n\n"),
    tools: connection.tools,
    model: opts.model,
    maxExecuteCalls: opts.maxExecuteCalls,
    connection,
    close: () => connection.close(),
  };
}

async function createTransport(server: McpServerConfig): Promise<Transport> {
  if ("transport" in server) return server.transport;
  if ("url" in server) {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    return new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: server.headers ? { headers: server.headers } : undefined,
    });
  }
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  return new StdioClientTransport({ command: server.command, args: server.args, env: server.env, cwd: server.cwd });
}

/** MCP CallToolResult → komode tool return (value, images) or a thrown error. */
export function mcpResultToToolReturn(result: any, toolName: string): unknown {
  const content: any[] = Array.isArray(result?.content) ? result.content : [];
  const texts: string[] = [];
  const images: ModelImage[] = [];
  for (const part of content) {
    if (part?.type === "text") texts.push(part.text);
    else if (part?.type === "image") images.push({ mimeType: part.mimeType, data: part.data });
    else if (part?.type === "resource" && typeof part.resource?.text === "string") texts.push(part.resource.text);
    else if (part?.type === "resource_link") texts.push(`${part.name ?? "resource"}: ${part.uri}`);
  }
  const text = texts.join("\n");
  if (result?.isError) throw new Error(text || `${toolName} failed`);
  // Structured output is the typed value the model's code can use directly
  const value = result?.structuredContent ?? (result?.toolResult !== undefined ? result.toolResult : text);
  return images.length ? toolResult({ value, images }) : value;
}

/** "get-issue" → "getIssue", "repo.list_all" → "repoListAll" */
export function toIdentifier(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return "tool";
  const camel = parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
  const id = /^[0-9]/.test(camel) ? `_${camel}` : camel;
  // "delete" / "fetch" would be keywords or shadow sandbox globals
  return RESERVED_NAMES.has(id) || id.startsWith("__") ? `${id.replace(/^_+/, "")}Tool` : id;
}
