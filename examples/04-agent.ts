/**
 * The full komode Agent: skills load on demand, tools are typed globals,
 * per-user state flows into every tool, and files come back with the reply.
 *
 *   OPENAI_API_KEY=... npx tsx examples/04-agent.ts
 *   (any 190proof model works: MODEL=anthropic:claude-sonnet-5, MODEL=openrouter:…)
 */
import { Agent, defineContext, defineSkill, defineTool, toolResult } from "komode";

type State = { userId: string; city: string };

const getForecast = defineTool<{ city: string; days?: number }, State>({
  name: "getForecast",
  description: "Daily forecast for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" }, days: { type: "integer", description: "1-7, default 3" } },
    required: ["city"],
  },
  returns: {
    type: "array",
    items: {
      type: "object",
      properties: { day: { type: "string" }, highC: { type: "number" }, rain: { type: "boolean" } },
      required: ["day", "highC", "rain"],
    },
  },
  run: ({ city, days = 3 }) =>
    Array.from({ length: days }, (_, i) => ({
      day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i],
      highC: 24 + ((city.length * 7 + i * 3) % 9),
      rain: (city.length + i) % 3 === 0,
    })),
});

const saveCsv = defineTool<{ fileName: string; rows: string[][] }, State>({
  name: "saveCsv",
  description: "Save rows as a CSV file attached to the reply.",
  parameters: {
    type: "object",
    properties: {
      fileName: { type: "string" },
      rows: { type: "array", items: { type: "array", items: { type: "string" } } },
    },
    required: ["fileName", "rows"],
  },
  run: ({ fileName, rows }, { state }) => {
    const csv = rows.map((r) => r.join(",")).join("\n");
    return toolResult({
      value: `saved for ${state.userId}`,
      files: [{ fileName, mimeType: "text/csv", data: Buffer.from(csv).toString("base64") }],
    });
  },
});

const agent = new Agent<State>({
  model: process.env.MODEL ?? "openai:gpt-5-mini",
  instructions: "You are a concise travel assistant.",
  contexts: [defineContext({ tag: "user_location", build: (s: State) => `The user lives in ${s.city}.` })],
  skills: [
    defineSkill({ name: "weather", description: "Forecasts for any city", tools: [getForecast] }),
    defineSkill({ name: "files", description: "Create CSV files for the user", tools: [saveCsv] }),
  ],
});

const result = await agent.run("Compare the next 3 days in my city and in Lisbon, and give me a CSV of it.", {
  state: { userId: "u_42", city: "Cairo" },
  onEvent: (e) => {
    if (e.type === "skills_loaded") console.log("· loaded", e.skills.join(", "));
    if (e.type === "tool_call") console.log("· called", e.name);
    if (e.type === "narration") console.log("·", e.text);
  },
});

console.log("\n" + result.text);
console.log("\nfiles:", result.files.map((f) => f.fileName));
console.log("usage:", result.usage);
