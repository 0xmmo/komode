# Contributing

komode is maintained by one person, so the scope is deliberately narrow: the code-mode runtime (sandbox, tool/skill/context model, agent loop), MCP support, and thin adapters for major TypeScript agent frameworks.

- **Bugs:** open an issue with a minimal repro (a failing test is ideal; `test/helpers.ts` has a scripted fake model).
- **Features:** open an issue before a PR. Built-in tool packs, hosted services and UI are out of scope.
- **PRs:** `npm run typecheck && npm test` must pass on Node and `bun --bun vitest run` on Bun.
- **Security issues:** email mo@olly.bot instead of filing a public issue.
