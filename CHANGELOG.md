# Changelog

## 0.7.1

Suspend & resume — park a run until an external event delivers a result.

### Added

- **`Loop.suspend()` / `waitFor()`** — a step that parks the run until an external caller delivers a value for a caller-provided key, instead of blocking a process. The optional `dispatch` fires the external async operation exactly once (checkpointed like `Loop.effect()`), so a resumed run never re-dispatches. Common uses: a long browser task handled by another machine, a webhook callback, or a human approval gate.
- **`Loop.deliver(checkpointFile, key, payload)`** — deliver a value for a pending wait from any process. Resuming with `loop.run({ resumeFrom })` (or `handle.resume({ key, payload })`) picks the delivered payload back up at the suspended step.
- **`'suspended'` run status** — a new terminal-but-resumable status alongside `completed`/`failed`/`cancelled`, on `RunLog.status`, `RunHandle.status`, and the `loop:suspend` / `loop:complete` events. A suspend is not a step failure — it bypasses retries, `onError`, and `skipOnError`, and propagates correctly out of `sub()`/`each()`.
- **`timeout`** on `Loop.suspend()` — checked lazily on each resume attempt (no background timer); throws `WaitTimeoutError`, which flows through normal step failure handling.

## 0.7.0

Durable idempotent effects and compensation sagas.

### Added

- **`Loop.effect()` / `effect()`** — checkpoint-backed external effects with caller-provided idempotency keys. Completed effects return their persisted result after a resume instead of calling the external service again; interrupted calls retry with the same key.
- **`compensateOnError`** — opt-in saga rollback for completed `Loop.effect()` steps. Compensators run in reverse order and their progress is checkpointed so rollback APIs can also be idempotent.
- **`npm run demo:effects`** — a no-credentials executable example of resume deduplication and compensation.

## 0.6.0

Editor & CI tooling for `.loop` files.

### Added

- **`loop.schema.json`** — a canonical JSON Schema for `.loop` files (the normalized `{ meta, steps }` form), derived from the type definitions and the per-action required-field rules. It's the machine-readable spec that external tooling and a future editor extension consume. Bundled in the package and installable into a project with `loop-sdk install schema`.
- **`loop-sdk validate <file.loop>`** — lint a `.loop` file without running it. Runs the same fail-fast checks as `loadLoop()` (unknown actions with "did you mean…?" suggestions, duplicate or non-referenceable step names, missing required fields) and exits non-zero on problems, so it drops straight into CI or a pre-commit hook.

### Notes

- No `yaml.schemas` auto-wiring: `.loop` files are YAML front-matter plus markdown `## step` sections, not a single YAML document, so a naive schema mapping would misparse valid files. Use `loop-sdk validate` today; the schema is the foundation a VS Code extension will build on.

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
