/**
 * Code mode inside the OpenAI Agents SDK.
 *
 *   OPENAI_API_KEY=... npx tsx examples/03-openai-agents.ts
 */
import { Agent, run } from "@openai/agents";
import { defineTool } from "komode";
import { codeModeTool } from "komode/openai-agents";

const orders = [
  { id: "o1", customer: "ada", total: 120 },
  { id: "o2", customer: "grace", total: 80 },
  { id: "o3", customer: "ada", total: 45 },
];

const searchOrders = defineTool<{ customer?: string }>({
  name: "searchOrders",
  description: "Find orders, optionally filtered by customer.",
  parameters: { type: "object", properties: { customer: { type: "string" } } },
  returns: {
    type: "array",
    items: {
      type: "object",
      properties: { id: { type: "string" }, customer: { type: "string" }, total: { type: "number" } },
      required: ["id", "customer", "total"],
    },
  },
  run: ({ customer }) => orders.filter((o) => !customer || o.customer === customer),
});

const executeCode = codeModeTool({ tools: [searchOrders] });

const agent = new Agent({
  name: "Order analyst",
  instructions: "Answer questions about orders. Use execute_code to compute answers.",
  tools: [executeCode],
});

const result = await run(agent, "Which customer has spent the most, and how much?");
console.log(result.finalOutput);
executeCode.codeMode.dispose();
