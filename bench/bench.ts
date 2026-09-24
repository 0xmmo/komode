/**
 * Code mode vs plain tool calling, same tools, same model, same questions.
 *
 *   OPENAI_API_KEY=... npx tsx bench/bench.ts            (MODEL, RUNS to override)
 *
 * "Plain tool calling" is the standard loop: every tool is a function the
 * model calls directly (parallel calls allowed), each result goes back into
 * the context, repeat until the model answers in text.
 */
import { setLogger } from "190proof";
import { Agent, callWith190proof, resolveToolForBench, type ModelMessage, type Tool } from "./internal";
import { expectedInventory, expectedTopEu, getItem, listCustomers, listOrders, skus } from "../examples/shared/store";

setLogger(null);
const MODEL = process.env.MODEL ?? "openai:gpt-5-mini";
const RUNS = Number(process.env.RUNS ?? 3);

interface Task {
  name: string;
  prompt: string;
  tools: Tool[];
  check(text: string): boolean;
}

const plain = (t: string) => t.replace(/[,$*]/g, "");
const top = expectedTopEu();
const inv = expectedInventory();
const sku7 = skus.find((s) => s.sku === "SKU-007")!;

const TASKS: Task[] = [
  {
    name: "single lookup",
    prompt: "What is the unit price of SKU-007?",
    tools: [getItem],
    check: (t) => plain(t).includes(sku7.price.toFixed(2)),
  },
  {
    name: "fan-out (30 lookups)",
    prompt: "What is the total inventory value (stock x unit price) across SKU-001 to SKU-030, and which SKUs are out of stock?",
    tools: [getItem],
    check: (t) => plain(t).includes(inv.value.toFixed(2)) && inv.outOfStock.every((s) => t.includes(s)),
  },
  {
    name: "join + aggregate (15 pages)",
    prompt: "Which 3 EU customers had the highest paid revenue in Q2 2026 (April to June)? Give each name and total.",
    tools: [listCustomers, listOrders],
    check: (t) => top.every((c) => t.includes(c.name) && plain(t).includes(c.total.toFixed(2))),
  },
];

interface Result {
  correct: boolean;
  modelCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  ms: number;
  error?: string;
}

async function runKomode(task: Task): Promise<Result> {
  const started = Date.now();
  let toolCalls = 0;
  const agent = new Agent({
    model: MODEL,
    tools: task.tools,
    sandbox: { fetch: false },
    limits: { maxToolCallsPerRun: 60 },
  });
  const r = await agent.run(task.prompt, { onEvent: (e) => e.type === "tool_call" && toolCalls++ });
  return {
    correct: task.check(r.text ?? ""),
    modelCalls: r.usage.modelCalls,
    toolCalls,
    promptTokens: r.usage.promptTokens,
    completionTokens: r.usage.completionTokens,
    ms: Date.now() - started,
  };
}

async function runToolCalling(task: Task): Promise<Result> {
  const started = Date.now();
  const tools = task.tools.map(resolveToolForBench);
  const messages: ModelMessage[] = [
    { role: "system", content: "You are a helpful assistant. Use the tools to answer." },
    { role: "user", content: task.prompt },
  ];
  const res: Result = { correct: false, modelCalls: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, ms: 0 };
  for (let step = 0; step < 40; step++) {
    const response = await callWith190proof({
      model: MODEL,
      messages,
      functions: tools.map((t) => ({ name: t.schema.name, description: t.schema.description, parameters: t.schema.parameters ?? { type: "object", properties: {} } })),
      function_call: "auto",
    });
    res.modelCalls++;
    res.promptTokens += response.usage?.prompt_tokens ?? 0;
    res.completionTokens += response.usage?.completion_tokens ?? 0;
    const calls = response.function_calls?.length ? response.function_calls : response.function_call ? [response.function_call] : [];
    if (calls.length === 0) {
      res.correct = task.check(response.content ?? "");
      break;
    }
    messages.push({ role: "assistant", content: response.content ?? "", functionCalls: calls, reasoning: response.reasoning, reasoningDetails: response.reasoningDetails });
    const toolResults = [];
    for (const [i, call] of calls.entries()) {
      res.toolCalls++;
      const tool = tools.find((t) => t.schema.name === call.name);
      let content: string;
      try {
        content = JSON.stringify(await tool!.run(call.arguments ?? {}, { state: undefined, signal: new AbortController().signal, logger: console }));
      } catch (e: any) {
        content = `Error: ${e.message}`;
      }
      toolResults.push({ toolCallId: call.id ?? `call_${i}`, name: call.name, content });
    }
    messages.push({ role: "tool", content: "", toolResults });
  }
  res.ms = Date.now() - started;
  return res;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function measure(task: Task, mode: "komode" | "tool calling") {
  const results = await Promise.all(
    Array.from({ length: RUNS }, () =>
      (mode === "komode" ? runKomode(task) : runToolCalling(task)).catch(
        (e): Result => ({ correct: false, modelCalls: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, ms: 0, error: String(e?.message ?? e) }),
      ),
    ),
  );
  const ok = results.filter((r) => !r.error);
  return {
    task: task.name,
    mode,
    correct: `${results.filter((r) => r.correct).length}/${RUNS}`,
    modelCalls: median(ok.map((r) => r.modelCalls)),
    toolCalls: median(ok.map((r) => r.toolCalls)),
    tokens: median(ok.map((r) => r.promptTokens + r.completionTokens)),
    seconds: Math.round(median(ok.map((r) => r.ms)) / 100) / 10,
    errors: results.filter((r) => r.error).map((r) => r.error),
  };
}

const rows = await Promise.all(TASKS.flatMap((t) => [measure(t, "tool calling"), measure(t, "komode")]));
console.log(`model: ${MODEL}, runs per cell: ${RUNS}, medians\n`);
console.log("| task | mode | correct | model calls | tool calls | tokens | seconds |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.task} | ${r.mode} | ${r.correct} | ${r.modelCalls} | ${r.toolCalls} | ${r.tokens?.toLocaleString("en-US")} | ${r.seconds} |`);
}
const errors = rows.flatMap((r) => r.errors.map((e) => `${r.task} / ${r.mode}: ${e}`));
if (errors.length) console.log("\nerrors:\n" + errors.join("\n"));
