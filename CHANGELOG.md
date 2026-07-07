# Changelog

## 0.5.0

Model registry, the `agent` step, AI SDK 6, and safer `.loop` files.

### ⚠️ Breaking

- **Vercel AI SDK 4 → 6 (LanguageModelV3).** `agent()` now runs on AI SDK 6. Update your provider packages: peers are now `@ai-sdk/anthropic` / `@ai-sdk/openai` `>= 3` and `ai-sdk-provider-claude-code >= 3`. A model built for a different AI SDK major fails fast with a directed "install a v3-compatible build" error instead of a cryptic spec-version failure.
- **`AgentResult.usage` fields renamed** to match AI SDK 6: `promptTokens` → `inputTokens`, `completionTokens` → `outputTokens` (`totalTokens` unchanged).
- **`.loop` validation is now fail-fast.** `loadLoop()` rejects files with unknown actions (with a "did you mean…?" suggestion), duplicate or non-referenceable step names (names must be kebab-case to be reachable via `{{…}}`), and missing required fields — *before* any step runs. Files that previously loaded but were malformed will now throw at load.

### Added

- **Model registry.** A friendly `"provider:model"` string (the AI SDK's own convention) resolves to a live `LanguageModel`, so the same identifier works in JS and in a `.loop` file — e.g. `claude-code:sonnet`, `codex:gpt-5.2-codex`, `anthropic:claude-opus-4-8`. Providers are optional peer deps, loaded on demand with an `npm i …` hint when missing. Extend with `registerProvider()`; a bare id uses the default provider (`claude-code`). New exports: `resolveModel`, `registerProvider`, `knownProviders`, `DEFAULT_PROVIDER`.
- **`agent` `.loop` action.** Run any AI SDK model declaratively (`model:` accepts a registry string, falls back to `meta.model`). Supports `system`, `maxSteps`, `screenshot`, `expect`, and `mcp:`.
- **MCP for the `agent` action.** A step's `mcp:` servers (registry names or inline defs, incl. remote HTTP) are handed to the CLI-backed providers as `mcpServers`, with a permission posture mirroring the loop `mode` (explore = frictionless, strict = enforce the `tools:` allowlist). Verified live against the Claude CLI + a remote HTTP MCP server.
- **`subloop` inline steps.** The `subloop` action now takes inline `steps:` (self-contained, no dependent file) as an alternative to a `loop:` path — the same either/or as `each`.
- **Nesting recursion guard.** A circular `loop:` reference or runaway depth (> `MAX_SUBLOOP_DEPTH`, 50) in `subloop`/`each` now fails fast with a readable chain error instead of hanging forever or overflowing the stack.
- **`validateLoopSchema` / `BUILTIN_ACTIONS`** exported for editor/lint integration.

### Changed

- The `.loop` `sub` action is renamed **`subloop`** (JS helper `subloop()` added). `sub` remains as a deprecated alias.
