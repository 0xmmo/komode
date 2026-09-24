/**
 * Issue triage against the real GitHub API. The model pages through open
 * issues, groups them and ranks them in code, and only the summary comes
 * back into its context. Read-only.
 *
 *   OPENAI_API_KEY=... npx tsx examples/06-github-triage.ts [owner/repo]
 *   (set GITHUB_TOKEN for a higher rate limit)
 */
import { Agent, defineTool } from "komode";

const gh = async (path: string, signal: AbortSignal) => {
  const res = await fetch(`https://api.github.com${path}`, {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "komode-example",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const listIssues = defineTool<{ repo: string; page?: number }>({
  name: "listIssues",
  description: "Open issues of a GitHub repo, newest first. Pull requests are removed, so a page can hold fewer than 50 issues. An empty page means no more issues.",
  parameters: {
    type: "object",
    properties: { repo: { type: "string", description: "owner/name" }, page: { type: "integer", description: "1-based" } },
    required: ["repo"],
  },
  returns: {
    type: "array",
    items: {
      type: "object",
      properties: {
        number: { type: "integer" },
        title: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        comments: { type: "integer" },
        reactions: { type: "integer" },
        createdAt: { type: "string" },
        body: { type: "string", description: "first 1,500 characters" },
      },
      required: ["number", "title", "labels", "comments", "reactions", "createdAt", "body"],
    },
  },
  run: async ({ repo, page = 1 }, { signal }) => {
    const rows: any[] = await gh(`/repos/${repo}/issues?state=open&per_page=50&page=${page}`, signal);
    return rows
      .filter((r) => !r.pull_request)
      .map((r) => ({
        number: r.number,
        title: r.title,
        labels: r.labels.map((l: any) => l.name),
        comments: r.comments,
        reactions: r.reactions?.total_count ?? 0,
        createdAt: r.created_at,
        body: (r.body ?? "").slice(0, 1500),
      }));
  },
});

const repo = process.argv[2] ?? "vercel/ai";
const agent = new Agent({
  model: process.env.MODEL ?? "openai:gpt-5-mini",
  instructions: "You are a maintainer's triage assistant. Be concise.",
  tools: [listIssues],
});

const result = await agent.run(
  `Triage the 40 newest open issues in ${repo}. Group them by area, flag likely duplicates, and list the 5 that need attention first (most reactions and comments, or bugs with no label). Give issue numbers.`,
  { onEvent: (e) => e.type === "tool_call" && console.log("· listIssues", JSON.stringify(e.args)) },
);
console.log("\n" + result.text);
console.log("\nusage:", result.usage);
