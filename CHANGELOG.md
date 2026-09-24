# Changelog

## 0.1.0

First release.

- `komode/sandbox`: in-process QuickJS sandbox with persistent sessions, typed bindings, guarded fetch, and time/memory/fan-out limits.
- `komode`: `Agent` (use_skills + execute_code loop), `defineTool` / `BaseTool`, `defineSkill`, `defineContext` / `BaseContext`, `createCodeModeTool`.
- `komode/ai-sdk`, `komode/openai-agents`: drop-in `execute_code` tools.
- `komode/mcp`: MCP servers as code-mode tools or loadable skills.
