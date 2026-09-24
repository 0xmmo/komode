/**
 * Research over large documents. The model fetches several full Wikipedia
 * articles in parallel, keeps the raw text in the sandbox's `state`, and
 * extracts only the facts it needs. The articles never enter its context.
 *
 *   OPENAI_API_KEY=... npx tsx examples/07-research.ts
 */
import { Agent, defineTool } from "komode";

const wiki = async (params: Record<string, string>, signal: AbortSignal) => {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", ...params })) url.searchParams.set(k, v);
  const res = await fetch(url, { signal, headers: { "User-Agent": "komode-example (https://github.com/0xmmo/komode)" } });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  return res.json() as Promise<any>;
};

const searchWikipedia = defineTool<{ query: string }>({
  name: "searchWikipedia",
  description: "Search English Wikipedia. Returns the top 5 article titles with snippets.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  returns: { type: "array", items: { type: "object", properties: { title: { type: "string" }, snippet: { type: "string" } }, required: ["title", "snippet"] } },
  run: async ({ query }, { signal }) => {
    const data = await wiki({ action: "query", list: "search", srsearch: query, srlimit: "5" }, signal);
    return data.query.search.map((s: any) => ({ title: s.title, snippet: s.snippet.replace(/<[^>]+>/g, "") }));
  },
});

const readArticle = defineTool<{ title: string }>({
  name: "readArticle",
  description: "Full plain text of a Wikipedia article (often 20,000+ characters). Keep it in state and extract what you need.",
  parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  run: async ({ title }, { signal }) => {
    const data = await wiki({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", titles: title }, signal);
    const page = data.query.pages[0];
    if (page.missing) throw new Error(`No article titled "${title}"`);
    fetchedChars += page.extract.length;
    return page.extract as string;
  },
});

let fetchedChars = 0;
const agent = new Agent({
  model: process.env.MODEL ?? "openai:gpt-5-mini",
  tools: [searchWikipedia, readArticle],
});

let readChars = 0;
const result = await agent.run(
  "For Rust, Go, Zig, Elixir, Kotlin and Swift (the programming languages): who designed each one, and in what year was its first public release? Answer as a short table. Do not ask questions.",
  {
    onEvent: (e) => {
      if (e.type === "tool_call") console.log("·", e.name, JSON.stringify(e.args));
    },
  },
);
for (const step of result.steps) if (step.type === "execute_code") readChars += step.output.length;
console.log("\n" + result.text);
console.log(`\nusage: ${JSON.stringify(result.usage)}`);
console.log(`article text fetched: ${fetchedChars.toLocaleString()} chars, code output the model read: ${readChars.toLocaleString()} chars`);
