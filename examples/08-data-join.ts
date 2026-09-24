/**
 * Join and aggregate across a paginated API: 3 pages of customers and 12
 * pages of orders. The model loops and sums in code. With plain tool
 * calling, every page would pass through its context window.
 *
 *   OPENAI_API_KEY=... npx tsx examples/08-data-join.ts
 */
import { Agent } from "komode";
import { expectedTopEu, listCustomers, listOrders } from "./shared/store";

const agent = new Agent({
  model: process.env.MODEL ?? "openai:gpt-5-mini",
  tools: [listCustomers, listOrders],
  limits: { maxToolCallsPerRun: 40 },
});

const result = await agent.run(
  "Which 3 EU customers had the highest paid revenue in Q2 2026 (April to June)? Give each name and total.",
);
for (const step of result.steps) if (step.type === "execute_code") console.log("--- code the model wrote:\n" + step.code + "\n---");
console.log(result.text);
console.log("\nexpected:", expectedTopEu());
console.log("usage:", result.usage);
