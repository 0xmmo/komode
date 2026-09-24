# Changelog

## 0.1.2

- README: the benchmark table shows the exact questions.

## 0.1.1

- README rewritten in ASD-STE100, with benchmark results against plain tool calling.
- `npm run bench`: code mode vs plain tool calling on the same tools and model.
- Examples: GitHub issue triage, Wikipedia research, and a paginated-API data join.

## 0.1.0

First release.

- `komode/sandbox`: in-process QuickJS sandbox with persistent sessions, typed bindings, guarded fetch, and time/memory/fan-out limits.
- `komode`: `Agent` (use_skills + execute_code loop), `defineTool` / `BaseTool`, `defineSkill`, `defineContext` / `BaseContext`, `createCodeModeTool`.
- `komode/ai-sdk`, `komode/openai-agents`: drop-in `execute_code` tools.
- `komode/mcp`: MCP servers as code-mode tools or loadable skills.
