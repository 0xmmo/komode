/**
 * A seeded fake SaaS API: paginated customers and orders, like a billing or
 * CRM backend. Deterministic, so answers can be checked.
 */
import { defineTool } from "komode";

const REGIONS = ["EU", "US", "APAC"] as const;
const FIRST = ["Ada", "Alan", "Grace", "Linus", "Barbara", "Ken", "Margaret", "Dennis", "Radia", "Guido", "Frances", "Edsger"];
const LAST = ["Lovelace", "Turing", "Hopper", "Torvalds", "Liskov", "Thompson", "Hamilton", "Ritchie", "Perlman", "Rossum", "Allen", "Dijkstra"];

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

export interface Customer { id: string; name: string; region: (typeof REGIONS)[number] }
export interface Order { id: string; customerId: string; date: string; amount: number; status: "paid" | "refunded" }

const r = rng(42);
export const customers: Customer[] = Array.from({ length: 144 }, (_, i) => ({
  id: `c${String(i + 1).padStart(3, "0")}`,
  name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]}`,
  region: REGIONS[Math.floor(r() * 3)],
}));
export const orders: Order[] = Array.from({ length: 600 }, (_, i) => {
  const month = 1 + Math.floor(r() * 9);
  return {
    id: `o${String(i + 1).padStart(4, "0")}`,
    customerId: customers[Math.floor(r() * customers.length)].id,
    date: `2026-${String(month).padStart(2, "0")}-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`,
    amount: Math.round((20 + r() * 480) * 100) / 100,
    status: r() < 0.1 ? "refunded" : "paid",
  };
});

const PAGE = 50;
const page = <T>(rows: T[], n = 1) => ({
  items: rows.slice((n - 1) * PAGE, n * PAGE),
  page: n,
  totalPages: Math.ceil(rows.length / PAGE),
});

export const listCustomers = defineTool<{ page?: number }>({
  name: "listCustomers",
  description: "List customers, 50 per page.",
  parameters: { type: "object", properties: { page: { type: "integer", description: "1-based, default 1" } } },
  returns: {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, region: { type: "string", enum: [...REGIONS] } }, required: ["id", "name", "region"] } },
      page: { type: "integer" },
      totalPages: { type: "integer" },
    },
    required: ["items", "page", "totalPages"],
  },
  run: ({ page: n = 1 }) => page(customers, n),
});

export const listOrders = defineTool<{ page?: number }>({
  name: "listOrders",
  description: "List all orders, 50 per page. Amounts are in USD. Refunded orders do not count as revenue.",
  parameters: { type: "object", properties: { page: { type: "integer", description: "1-based, default 1" } } },
  returns: {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, customerId: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, amount: { type: "number" }, status: { type: "string", enum: ["paid", "refunded"] } }, required: ["id", "customerId", "date", "amount", "status"] } },
      page: { type: "integer" },
      totalPages: { type: "integer" },
    },
    required: ["items", "page", "totalPages"],
  },
  run: ({ page: n = 1 }) => page(orders, n),
});

/** The correct answer to "top 3 EU customers by paid Q2 2026 revenue". */
export function expectedTopEu(n = 3): { name: string; total: number }[] {
  const eu = new Map(customers.filter((c) => c.region === "EU").map((c) => [c.id, c.name]));
  const totals = new Map<string, number>();
  for (const o of orders) {
    if (o.status !== "paid" || !eu.has(o.customerId) || o.date < "2026-04-01" || o.date > "2026-06-30") continue;
    totals.set(o.customerId, (totals.get(o.customerId) ?? 0) + o.amount);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, total]) => ({ name: eu.get(id)!, total: Math.round(total * 100) / 100 }));
}

/** 30 SKUs, one lookup each (no list endpoint), like a product or pricing API. */
export const skus = Array.from({ length: 30 }, (_, i) => {
  const rr = rng(7919 * (i + 1) + 13);
  rr();
  rr();
  return { sku: `SKU-${String(i + 1).padStart(3, "0")}`, stock: rr() < 0.2 ? 0 : Math.floor(rr() * 40), price: Math.round((5 + rr() * 95) * 100) / 100 };
});

export const getItem = defineTool<{ sku: string }>({
  name: "getItem",
  description: "Stock level and unit price (USD) for one SKU. SKUs are SKU-001 to SKU-030.",
  parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] },
  returns: { type: "object", properties: { sku: { type: "string" }, stock: { type: "number" }, price: { type: "number" } }, required: ["sku", "stock", "price"] },
  run: ({ sku }) => {
    const item = skus.find((s) => s.sku === sku);
    if (!item) throw new Error(`Unknown SKU ${sku}`);
    return item;
  },
});

export const expectedInventory = () => ({
  value: Math.round(skus.reduce((a, s) => a + s.stock * s.price, 0) * 100) / 100,
  outOfStock: skus.filter((s) => s.stock === 0).map((s) => s.sku),
});
