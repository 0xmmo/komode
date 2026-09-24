# komode

```
     _      ╻┏ ┏━┓┏┳┓┏━┓╺┳┓┏━╸
    | |     ┣┻┓┃ ┃┃┃┃┃ ┃ ┃┃┣╸
 ___| |     ╹ ╹┗━┛╹ ╹┗━┛╺┻┛┗━╸
(    .'
 )  (       code mode agent
```
**Code mode for TypeScript agents.** Your tools become a typed TypeScript API; the model writes
one script that calls them, and komode runs it in an in-process QuickJS sandbox.

```ts
const result = await agent.run("Compare the next 3 days in Cairo and Lisbon and send me a CSV");
```

```ts
// what the model writes, in one step:
const [cairo, lisbon] = await Promise.all([
  getForecast({ city: "Cairo", days: 3 }),
  getForecast({ city: "Lisbon", days: 3 }),
]);
await saveCsv({ fileName: "forecast.csv", rows: [["day", "cairo", "lisbon"], ...cairo.map((d, i) => [d.day, `${d.highC}`, `${lisbon[i].highC}`])] });
return { cairo, lisbon };
```

- **Runs anywhere Node or Bun runs.** In-process QuickJS WASM. No containers, no Workers, no sandbox SaaS.
- **Drop-in.** Use the sandbox alone, add one `execute_code` tool to your Vercel AI SDK or OpenAI Agents
  app, or use the full agent.
- **Skills.** Progressive disclosure: the model sees a one-line catalog and loads only the skills a
  request needs, so dozens of integrations stay cheap.
- **MCP → typed TS.** Connect an MCP server and its tools become typed functions the model can chain.
- **Production-proven.** Extracted from the agent behind [Olly](https://olly.bot), which serves real users
  over iMessage, SMS and the web. The budgets, guards and error messages exist because real models
  tripped without them.

## Why code mode

Classic tool calling makes the model emit one JSON call per step, wait, read the result, and emit the
next. Every intermediate result flows through the context window. With code mode:

- **Fewer round trips.** Loops, joins and `Promise.all` happen in code, in one step.
- **Less context.** Big results stay in the sandbox (`state.rows = data`); only the digest comes back.
- **Better calls.** Models have seen far more real TypeScript than synthetic tool-call transcripts, and a
  typed API with JSDoc is exactly what they're good at reading.

## Install

```bash
npm i komode
# the full Agent calls models through 190proof (OpenAI, Anthropic, Google, Groq, OpenRouter, Bedrock):
npm i 190proof
```

Node 20+ or Bun. Framework and MCP packages are optional peers: install only what you use.

## 1. The full agent

```ts
import { Agent, defineSkill, defineTool } from "komode";

const getWeather = defineTool<{ city: string }>({
  name: "getWeather",
  description: "Current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  run: async ({ city }) => `Sunny in ${city}, 31°C`,
});

const agent = new Agent({
  model: "anthropic:claude-sonnet-5", // any 190proof model string
  instructions: "You are a concise assistant.",
  skills: [defineSkill({ name: "weather", description: "Weather lookups", tools: [getWeather] })],
});

const { text, files, steps, usage } = await agent.run("Weather in Cairo?");
```

The model sees two functions. `use_skills` loads skills' instructions and typed APIs.
`execute_code` runs TypeScript with every loaded function as an async global. The run ends when the
model replies in plain text.

### State, contexts, events

```ts
type State = { userId: string };

const agent = new Agent<State>({
  model: "openai:gpt-5",
  instructions: (s) => `You're helping ${s.userId}.`,
  contexts: [defineContext({ tag: "user_prefs", build: (s) => loadPrefs(s.userId) })],
  tools: [whoAmI],              // always available, no skill needed
  skills: [calendar, email],    // loaded on demand
});

await agent.run(messages, {
  state: { userId: "u_42" },    // handed to every tool, context and instructions fn
  signal: controller.signal,    // cancels model calls and in-flight tools
  onEvent: (e) => {             // model_call, narration, skills_loaded, code, tool_call, tool_result, fetch, code_result
    if (e.type === "narration") sendProgress(e.text);
  },
});
```

### Tools: object or class

```ts
// object form
const search = defineTool<{ q: string }, State>({
  name: "search",
  description: "Search the docs. Returns the top hits.",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  returns: { type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } } } },
  run: async ({ q }, { state, signal }) => searchDocs(q, { user: state.userId, signal }),
});

// class form, constructed per call
class SendEmail extends BaseTool<State, { to: string; body: string }> {
  static schema = { name: "sendEmail", description: "Send an email.", parameters: { /* … */ } };
  async execute({ to, body }) {
    await mailer.send(this.state.userId, to, body);
    return "sent";
  }
}
```

A tool returns any JSON value (typed for the model by `returns`) and throws to fail. Return
`toolResult({ value, files, images, endTurn })` to attach files to the reply, show the model an image,
or end the run from inside a script.

### Per-skill model and budget

```ts
defineSkill({ name: "coding", description: "Write and run code", tools: [...], model: "anthropic:claude-opus-5", maxExecuteCalls: 25 });
```

While a skill is loaded its `model` runs the loop (last loaded wins), and `maxExecuteCalls` can raise
the run's code budget. Image-bearing steps route to `visionModel` unless the override accepts images
(`imageCapable`).

### Bring your own model client

```ts
new Agent({
  model: "anthropic:claude-sonnet-5",
  callModel: async (request, defaultCall) => {
    const res = await defaultCall(request);   // or call anything returning the same shape
    meter(res.usage);
    return res;
  },
});
```

## 2. Code mode in your framework

### Vercel AI SDK

```ts
import { generateText, stepCountIs } from "ai";
import { codeModeTool } from "komode/ai-sdk";

const execute_code = codeModeTool({ tools: [listSkus, getItem], mcp: [github] });
const { text } = await generateText({ model, tools: { execute_code }, stopWhen: stepCountIs(5), prompt });
```

### OpenAI Agents SDK

```ts
import { Agent, run } from "@openai/agents";
import { codeModeTool } from "komode/openai-agents";

const agent = new Agent({ name: "analyst", tools: [codeModeTool({ tools: [searchOrders] })] });
```

### Anything else

`createCodeModeTool()` returns `{ name, description, parameters, execute({ code }) }`: a plain JSON-schema
tool. The description carries the generated TypeScript declarations. `execute` resolves with the text
the model reads back and never throws for model mistakes.

## 3. MCP servers

```ts
import { connectMcp, mcpSkill } from "komode/mcp";

const github = await connectMcp({ name: "github", server: { url: "https://…/mcp", headers: { Authorization: `Bearer ${token}` } } });
codeModeTool({ mcp: [github] });                                             // as globals in your framework

const notes = await mcpSkill({ name: "notes", server: { command: "npx", args: ["-y", "some-mcp-server"] } });
new Agent({ model, skills: [notes] });                                        // as a loadable skill
```

MCP tool names become camelCase identifiers (`list-issues` → `listIssues`). `outputSchema` types the
result and `structuredContent` becomes the value. `isError` throws and image content is shown to the model.

## 4. The sandbox alone

```ts
import { createSandbox } from "komode/sandbox";

const sb = await createSandbox({ bindings: { getPrice: async ({ ticker }) => prices[ticker] } });
const { ok, returnValue, logs, error } = await sb.run(`
  const q = await Promise.all(["AAPL", "MSFT"].map((t) => getPrice({ ticker: t })));
  state.q = q;           // persists across runs
  return q;
`);
sb.dispose();
```

## Security model

- **No ambient authority.** Guest code runs in QuickJS (WASM) with no filesystem, no process, no
  modules, and no network unless `fetch` is enabled. The functions you pass are its only capabilities,
  so authorization belongs in your tools.
- **Guarded fetch** (Agent default on, `createSandbox` default off): GET/HEAD only, public http(s) URLs
  only. It is SSRF-checked on every redirect hop and at DNS-connect time (no rebinding), capped at 2 MB,
  10 s and 16 per run.
- **Limits.** Wall-clock time per run (tool calls included), CPU time per synchronous slice, a heap cap,
  a tool fan-out cap, and log/return truncation. A timed-out or leaky run is torn down so it can never
  resume inside the next one.
- **What it is not.** In-process isolation is weaker than a VM. For untrusted multi-tenant code with
  hostile tools in reach, run the agent in its own process or container. The `Executor` interface is
  the seam for a remote executor.

## Defaults

| limit | default | option |
|---|---|---|
| execute_code calls per run | 10 | `limits.maxExecuteCalls` (skills can raise it) |
| use_skills calls per run | 2 | `limits.maxUseSkillsCalls` |
| tool calls per execute_code | 25 | `limits.maxToolCallsPerRun` |
| wall clock per execute_code | 120 s | `sandbox.timeoutMs` |
| guest heap | 64 MB | `sandbox.memoryLimitBytes` |
| return value shown to the model | 50,000 chars | `limits.maxReturnChars` |

## Notes

- `typescript` is a runtime dependency (it strips types from model code before QuickJS runs it).
- 190proof logs every model call to the console. Silence or reroute it with `setLogger(null)` / `setLogger(yourLogger)` from `190proof` (>= 1.0.120). Model errors surfaced by the Agent never include request headers.
- On Bun, `fetch` decodes GBK/gb18030 bodies as UTF-8 because Bun's `TextDecoder` lacks those encodings.

## Examples

See [`examples/`](examples): sandbox only, AI SDK, OpenAI Agents, the full agent with files and state,
and an MCP skill.

## License

MIT

<sub>toilet by Randy Ransom (rr), logo rendered with <a href="http://caca.zoy.org/wiki/toilet">toilet(1)</a></sub>
