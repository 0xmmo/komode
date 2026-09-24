/**
 * The sandbox on its own: no LLM, no keys. Host functions become async
 * globals; TypeScript in, a JSON value out.
 *
 *   npx tsx examples/01-sandbox-only.ts
 */
import { createSandbox } from "komode/sandbox";

const prices: Record<string, number> = { AAPL: 231.4, MSFT: 512.9, NVDA: 187.2 };

const sb = await createSandbox({
  bindings: {
    getPrice: async ({ ticker }: { ticker: string }) => prices[ticker] ?? null,
  },
});

const result = await sb.run(`
  const tickers = ["AAPL", "MSFT", "NVDA"];
  const quotes = await Promise.all(tickers.map((t) => getPrice({ ticker: t })));
  state.quotes = quotes;                       // persists into the next run
  return tickers.map((t, i) => \`\${t}: $\${quotes[i]}\`).join(", ");
`);
console.log(result.returnValue);

const total = await sb.run(`return state.quotes.reduce((a: number, b: number) => a + b, 0).toFixed(2);`);
console.log("total:", total.returnValue);

sb.dispose();
