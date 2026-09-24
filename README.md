# komode

```
     _      ╻┏ ┏━┓┏┳┓┏━┓╺┳┓┏━╸
    | |     ┣┻┓┃ ┃┃┃┃┃ ┃ ┃┃┣╸
 ___| |     ╹ ╹┗━┛╹ ╹┗━┛╺┻┛┗━╸
(    .'
 )  (       code mode agent
```

komode is a code-mode agent runtime for TypeScript. Your tools become a typed TypeScript API. The model writes one script that calls the tools. komode runs the script in a QuickJS sandbox, in your Node.js or Bun process.

## Results

We gave the same tools and the same questions to `gpt-5-mini` two times. The first time, the model called each tool directly (plain tool calling). The second time, the model used komode. Each cell is the median of 3 runs.

| Task | Mode | Correct | Model calls | Tool calls | Tokens | Seconds |
|---|---|---|---|---|---|---|
| Join and aggregate 15 pages of an API | tool calling | 1/3 | 3 | 15 | 40,958 | 219.2 |
| | **komode** | **3/3** | 2 | 15 | **3,731** | **18.8** |
| Read 30 items and add the totals | tool calling | 3/3 | 2 | 30 | 4,159 | 33.4 |
| | **komode** | 3/3 | 2 | 30 | **3,009** | **14.2** |
| Read 1 item | tool calling | 3/3 | 2 | 1 | **420** | **2.8** |
| | komode | 3/3 | 2 | 1 | 2,009 | 8.7 |

When a task has many tool calls or large results, komode is faster, uses fewer tokens and gives more correct answers. When a task has one tool call, plain tool calling is better. To run the benchmark, use `npm run bench`.

## Why code mode works

With plain tool calling, each tool result goes into the context of the model. The model then copies values from the context into the next call. Each page of a 12-page result stays in the context for all later calls.

With code mode, the model writes a script. Loops, joins and `Promise.all` occur in the sandbox. Large results stay in variables. Only the value that the script returns goes to the model.

Models know TypeScript well. A typed API with JSDoc is easy for a model to read and use correctly.

## What the model sees

komode changes each tool into a TypeScript declaration:

```ts
/**
 * List all orders, 50 per page. Amounts are in USD. Refunded orders do not count as revenue.
 */
declare function listOrders(input: {
  /** 1-based, default 1 */
  page?: number;
}): Promise<{
  items: { id: string; customerId: string; /** YYYY-MM-DD */ date: string; amount: number; status: "paid" | "refunded" }[];
  page: number;
  totalPages: number;
}>;
```

For the join task above, the model wrote this script in one step (shortened here):

```ts
const customers = await fetchAllPages(listCustomers);   // 3 pages, in parallel
const orders = await fetchAllPages(listOrders);         // 12 pages, in parallel

const eu = new Map(customers.filter((c) => c.region === "EU").map((c) => [c.id, c.name]));
const sums = new Map();
for (const o of orders) {
  if (o.status !== "paid" || o.date < "2026-04-01" || o.date > "2026-06-30" || !eu.has(o.customerId)) continue;
  sums.set(o.customerId, (sums.get(o.customerId) ?? 0) + o.amount);
}
return [...sums].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, total]) => ({ name: eu.get(id), total }));
```

The 600 orders did not go into the context of the model. Only the 3 results went to the model.

## Quick start

1. Install komode and a model client:

   ```bash
   npm i komode 190proof
   ```

2. Set the API key for your model provider, for example `OPENAI_API_KEY`.

3. Write an agent:

   ```ts
   import { Agent, defineTool } from "komode";

   const getWeather = defineTool<{ city: string }>({
     name: "getWeather",
     description: "Current weather for a city.",
     parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
     run: async ({ city }) => `Sunny in ${city}, 31°C`,
   });

   const agent = new Agent({ model: "openai:gpt-5-mini", tools: [getWeather] });
   const { text } = await agent.run("Is it warmer in Cairo or Lisbon?");
   ```

komode needs Node.js 20 or later, or Bun.

## Three ways to use komode

You can use each layer alone. The framework packages and the MCP package are optional peer dependencies. Install only the packages that you use.

| Layer | Import | Use it when |
|---|---|---|
| Agent | `komode` | You want a full agent with skills. |
| Framework tool | `komode/ai-sdk`, `komode/openai-agents` | You have an agent. You want to add code mode to it. |
| Sandbox | `komode/sandbox` | You want to run model code with your functions. You do not need an LLM. |

### 1. The agent

```ts
import { Agent, defineSkill } from "komode";

const agent = new Agent({
  model: "anthropic:claude-sonnet-5",        // any 190proof model string
  instructions: "You are a concise assistant.",
  tools: [whoAmI],                           // always available
  skills: [calendar, email, github],         // loaded when the model asks for them
});

const { text, files, steps, usage } = await agent.run(messages, {
  state: { userId: "u_42" },                 // sent to each tool
  signal: controller.signal,                 // stops the run
  onEvent: (e) => console.log(e.type),       // model_call, narration, tool_call, and more
});
```

The model sees two functions:

- `use_skills` loads the instructions and the typed API of one or more skills.
- `execute_code` runs TypeScript. Each loaded function is an async global.

The run stops when the model replies with text.

### 2. A tool for your framework

Vercel AI SDK:

```ts
import { generateText, stepCountIs } from "ai";
import { codeModeTool } from "komode/ai-sdk";

const execute_code = codeModeTool({ tools: [listCustomers, listOrders] });
const { text } = await generateText({ model, tools: { execute_code }, stopWhen: stepCountIs(5), prompt });
```

OpenAI Agents SDK:

```ts
import { Agent, run } from "@openai/agents";
import { codeModeTool } from "komode/openai-agents";

const agent = new Agent({ name: "analyst", tools: [codeModeTool({ tools: [searchOrders] })] });
```

Other frameworks: `createCodeModeTool()` gives a JSON-schema tool with `name`, `description`, `parameters` and `execute({ code })`. The description contains the TypeScript declarations.

### 3. The sandbox

```ts
import { createSandbox } from "komode/sandbox";

const sb = await createSandbox({ bindings: { getPrice: async ({ ticker }) => prices[ticker] } });
const { ok, returnValue, logs, error } = await sb.run(`
  const q = await Promise.all(["AAPL", "MSFT"].map((t) => getPrice({ ticker: t })));
  state.q = q;           // state stays between runs
  return q;
`);
sb.dispose();
```

## Tools, skills and contexts

A **tool** is a function with a JSON schema. Make one with `defineTool`, or extend `BaseTool` if the tool needs its own class.

```ts
const search = defineTool<{ q: string }, State>({
  name: "search",
  description: "Search the docs. Returns the top hits.",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  returns: { type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } } } },
  run: async ({ q }, { state, signal }) => searchDocs(q, { user: state.userId, signal }),
});
```

- A tool returns a JSON value. The `returns` schema gives the value a type for the model.
- A tool throws an error when it fails. The script of the model receives the error.
- To attach files, show an image to the model or stop the run, return `toolResult({ value, files, images, endTurn })`.

A **skill** is a group of tools with instructions. At the start, the model sees only the name and description of each skill. The model loads a skill when it needs it. Thus, an agent can have many integrations and still use a small prompt.

```ts
defineSkill({
  name: "coding",
  description: "Write and run code",
  instructions: "Run the tests after each change.",
  tools: [readFile, writeFile, runTests],
  model: "anthropic:claude-opus-5",   // optional: this model runs the loop while the skill is loaded
  maxExecuteCalls: 25,                // optional: more execute_code calls for this skill
});
```

A **context** puts data in the prompt, for example the preferences of a user. Make one with `defineContext` or `BaseContext`.

## MCP servers

komode connects to an MCP server and changes each MCP tool into a typed function.

```ts
import { connectMcp, mcpSkill } from "komode/mcp";

const github = await connectMcp({ name: "github", server: { url: "https://…/mcp", headers: { Authorization: `Bearer ${token}` } } });
codeModeTool({ mcp: [github] });

const notes = await mcpSkill({ name: "notes", server: { command: "npx", args: ["-y", "some-mcp-server"] } });
new Agent({ model, skills: [notes] });
```

- komode changes MCP tool names into camelCase names. For example, `list-issues` becomes `listIssues`.
- If the MCP tool has an `outputSchema`, komode uses it as the return type.
- If the MCP tool returns `isError`, the function throws an error.

## Examples

| Example | Workload | Needs |
|---|---|---|
| [`01-sandbox-only`](examples/01-sandbox-only.ts) | Run code with host functions | Nothing |
| [`02-ai-sdk`](examples/02-ai-sdk.ts) | Code mode in the Vercel AI SDK | `OPENAI_API_KEY` |
| [`03-openai-agents`](examples/03-openai-agents.ts) | Code mode in the OpenAI Agents SDK | `OPENAI_API_KEY` |
| [`04-agent`](examples/04-agent.ts) | Skills, state, contexts and a file attachment | `OPENAI_API_KEY` |
| [`05-mcp`](examples/05-mcp.ts) | An MCP server as a skill | `OPENAI_API_KEY` |
| [`06-github-triage`](examples/06-github-triage.ts) | Triage the open issues of a real GitHub repo | `OPENAI_API_KEY`, optional `GITHUB_TOKEN` |
| [`07-research`](examples/07-research.ts) | Read 6 full Wikipedia articles and compare facts | `OPENAI_API_KEY` |
| [`08-data-join`](examples/08-data-join.ts) | Join and aggregate a paginated API | `OPENAI_API_KEY` |

In one run of `07-research`, the tools fetched 129,119 characters of article text. The model read 4,790 characters of script output.

To run an example, use `npx tsx examples/08-data-join.ts`.

## Security

- **No access by default.** Model code runs in QuickJS (WebAssembly). It has no file system, no processes, no modules and no network. Your functions are its only access. Thus, put authorization checks in your tools.
- **Guarded fetch.** The agent gives model code a `fetch` function. This function uses only GET and HEAD, and only public http(s) URLs. komode checks each redirect and each DNS result. Private addresses are blocked. The limits are 2 MB, 10 seconds and 16 requests for each run. To disable `fetch`, set `sandbox: { fetch: false }`.
- **Limits.** Each run has a wall-clock limit, a CPU limit, a memory limit and a tool-call limit. If a run exceeds a limit, komode stops it and makes a new VM.
- **In-process isolation.** QuickJS runs in your process. This isolation is weaker than a virtual machine. If untrusted users send code and your tools can cause damage, run the agent in a separate container. The `Executor` interface lets you add a remote executor.

## When not to use komode

- **Tasks with one tool call.** Plain tool calling is faster and uses fewer tokens. See [Results](#results).
- **Streamed replies.** The agent does not stream the reply token by token yet.
- **Approval before an action.** The agent cannot stop before a tool and ask a person for approval yet. Put the approval step in the tool.

## Other code-mode runtimes

| Runtime | Language | Where the code runs |
|---|---|---|
| komode | TypeScript | QuickJS in your Node.js or Bun process |
| [`@cloudflare/codemode`](https://developers.cloudflare.com/agents/api-reference/codemode/) | TypeScript | Cloudflare Workers |
| [smolagents](https://github.com/huggingface/smolagents) `CodeAgent` | Python | A local Python interpreter or a remote sandbox |

## Limits

| Limit | Default | Option |
|---|---|---|
| `execute_code` calls in a run | 10 | `limits.maxExecuteCalls` (a skill can increase it) |
| `use_skills` calls in a run | 2 | `limits.maxUseSkillsCalls` |
| Tool calls in one `execute_code` | 25 | `limits.maxToolCallsPerRun` |
| Time for one `execute_code` | 120 s | `sandbox.timeoutMs` |
| Memory of the sandbox | 64 MB | `sandbox.memoryLimitBytes` |
| Characters of a return value | 50,000 | `limits.maxReturnChars` |

## Notes

- komode uses the `typescript` package at run time. It removes the types from the code of the model before QuickJS runs it.
- 190proof writes a log line for each model call. To stop these lines, call `setLogger(null)` from `190proof` (1.0.120 or later).
- Bun does not decode GBK text. On Bun, `fetch` decodes GBK responses as UTF-8.
- This README uses [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/).

## License

MIT

<sub>toilet by Randy Ransom (rr), logo rendered with <a href="http://caca.zoy.org/wiki/toilet">toilet(1)</a></sub>
