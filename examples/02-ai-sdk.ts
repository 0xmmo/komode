/**
 * Code mode inside the Vercel AI SDK: one execute_code tool whose
 * description carries your tools as a typed TypeScript API. The model writes
 * one script that calls several tools, instead of one round trip per call.
 *
 *   OPENAI_API_KEY=... npx tsx examples/02-ai-sdk.ts
 */
import { openai } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { defineTool } from "komode";
import { codeModeTool } from "komode/ai-sdk";

const inventory: Record<string, { stock: number; price: number }> = {
  "SKU-1": { stock: 4, price: 19.5 },
  "SKU-2": { stock: 0, price: 42 },
  "SKU-3": { stock: 12, price: 7.25 },
};

const listSkus = defineTool({
  name: "listSkus",
  description: "List every SKU in the catalog.",
  returns: { type: "array", items: { type: "string" } },
  run: () => Object.keys(inventory),
});

const getItem = defineTool<{ sku: string }>({
  name: "getItem",
  description: "Stock level and unit price for one SKU.",
  parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  returns: {
    type: "object",
    properties: { stock: { type: "number" }, price: { type: "number" } },
    required: ["stock", "price"],
  },
  run: ({ sku }) => inventory[sku],
});

const executeCode = codeModeTool({ tools: [listSkus, getItem] });

const { text, steps } = await generateText({
  model: openai("gpt-5-mini"),
  tools: { execute_code: executeCode },
  stopWhen: stepCountIs(5),
  prompt: "What is the total value of in-stock inventory? Which SKUs are out of stock?",
});

console.log(text);
console.log(`\n(${steps.length} model steps)`);
executeCode.codeMode.dispose();
