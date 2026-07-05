---
name: loop-sdk
description: Author, validate, and run .loop automation files (loop-sdk). Use when writing or editing a .loop file, composing automation loops with claudeCli/verify/browser steps, or using the loop-sdk JavaScript API.
---

# Authoring .loop files

A `.loop` file is YAML front-matter followed by `## step` sections. Steps run
in order; each step's output is referenceable downstream as `{{step-name}}`.

```
---
name: research-topic
model: claude-sonnet-5
vars:
  topic: browser automation
---

## gather
action: claudeCli
prompt: List 5 recent developments in {{topic}}. One line each.

## check
action: verify
assert: "{{gather}} contains exactly 5 items, each about {{topic}}"

## report
action: log
message: "{{gather}}"
```

## Front-matter reference

| Field | Meaning |
|---|---|
| `name` | Required. |
| `vars:` | Declared inputs with defaults — applied by the engine; run-time vars override. |
| `model` | Default model for claudeCli/verify steps. |
| `mode` | `explore` (default) \| `strict`. Explore runs workers frictionless (permissions skipped) unless a step declares `tools:`. Strict scopes every worker step to an allowlist and denies unlisted tools. Auto-escalates to `strict` when unset and the loop ships hard-to-reverse changes (`worktree`, `onSuccess: merge\|pr`); set explicitly to override. |
| `tools` | Default tool allowlist for claudeCli/verify steps (Claude Code names, e.g. `[Read, Grep, Bash]`). A step's own `tools:` overrides. Declaring any allowlist enforces it regardless of `mode`. |
| `session: browser` | This loop drives a browser. Omit for pure AI/data loops. |
| `browserMode` | `isolated` (fresh Chrome, default) \| `chrome` (CDP attach) \| `extension` (the user's running Chrome via the LoopDeLoop extension). |
| `browserProfile` | Which Chrome profile/identity acts. May be a `{{var}}` so one loop serves several accounts. |
| `workdir` | cwd for claudeCli/verify — set to a repo path to make them build workers. `~` and `{{refs}}` ok. |
| `worktree: true` | Each run's file changes go to an isolated git worktree + branch `loop/<name>-<id>`. |
| `onSuccess` | Runner action after a successful worktree run: `keep` \| `merge` \| `pr`. |
| `mcp:` | List of MCP server names (from `~/.loopdeloop/mcp.json`) or inline defs — extra tools for Claude workers. Step-level `mcp:` overrides. |
| `reflexion: false` | Disable the failed-verify → retry-prior-prompt-step-with-critique behavior (on by default). |
| `notify:` | `{onStart, onComplete, onError, onStepError, sound}` — macOS notifications. |

## Actions

| Action | Key fields | Notes |
|---|---|---|
| `claudeCli` | `prompt`, `model`, `maxSteps`, `screenshot`, `workdir`, `mcp`, `tools`, `expect` | Spawns `claude -p`. Output = the step's `{{ref}}`. `tools:` scopes it to an allowlist; `expect:` gates its output. |
| `codexCli` | `prompt`, `model`, `expect` | OpenAI Codex CLI. |
| `verify` | `assert` | AI judge; failure fails the step. Put one after any step whose output matters. |

**`expect:`** — a deterministic output contract enforced in code after ANY step (not just claudeCli) runs. `json` (parseable) \| `non-empty`, or an object `{ json, nonEmpty, contains, matches }` (all declared checks must hold). Fails the step if it doesn't. Prefer this over a `verify` AI-judge whenever the check is mechanical — it's a true guarantee, not a probabilistic one.
| `send` | `message`, `channel: imessage\|ntfy`, `to`/`topic` | Push to the user's phone. |
| `navigate` | `url` | Browser. Also `click` (`selector`/`text`/`x`+`y`), `type` (`text`), `key`, `scroll` (`deltaY`), `screenshot`, `wait` (`ms`). |
| `log` | `message` | Emit to the run log. |
| `set-variable` | `key`, `value` | Referenceable as `{{key}}` and `{{step-name}}`. |
| `sub` | `loop: ./other.loop`, `vars`, `output` | Nested loop sharing context. |
| `each` | `items`, `as`, `steps` or `loop`, `concurrency: 1-8`, `continueOnError`, `output` | Iterate. `items` may be a YAML array, a `{{ref}}` (array/JSON/lines), or literal lines. Inside: `{{item}}` (or `as` name), `{{_index}}`, `{{_total}}`. Concurrency > 1 gives each item isolated state. |
| `parallel` | `steps` | Run inline steps concurrently. |
| per-step error handling | `retries`, `retryDelay`, `retryBackoff: flat\|linear\|exponential`, `onError: skip` | |

Runners may register **custom actions** (e.g. LoopDeLoop adds `approve` — human
gate with a `message`, and `card` — `move:` a kanban card). Only use those when
the target runner is known to support them.

## Interpolation rules (the part people get wrong)

- `{{name}}` resolves **prior step outputs first, then vars**. Step names
  containing spaces are referenced with hyphens (`## my step` → `{{my-step}}`).
- Every `{{ref}}` needs a source: a prior step's name, a `set-variable` key, a
  declared input under `vars:`, or a var the runner supplies at run time
  (webhook payload fields, kanban card vars like `{{card-title}}`,
  `{{card-notes}}`, `{{previous-output}}`, trigger vars).
- A ref with no source is left as literal braces at run time (with a warning) —
  runners using pre-flight validation will refuse the run instead. When writing
  a loop that DEPENDS on runner-supplied context (e.g. a kanban stage loop),
  that's correct — just don't expect it to run standalone.
- Multiline YAML values: use `|` block scalars for prompts. Never put a block
  scalar inside `vars:` — quote with escaped `\n` instead.

## Validating and running

```bash
# Quick smoke test with a mock browser (steps log instead of acting):
node examples/run-loopfile.js path/to/file.loop     # from the loop-sdk repo
```

```js
import { describeLoop, loadLoop, runFile } from 'loop-sdk'

// Static check BEFORE running: what does this loop need?
const d = describeLoop(content, depsMap)
d.needsBrowser        // true if this loop or a REACHABLE sub-loop declares session: browser
d.mode                // effective posture: 'explore' | 'strict' (incl. auto-escalation)
d.referencedVars      // {{refs}} with no local source — must be supplied or the run should be refused
d.reachableDeps       // sub/each loop files actually referenced

// Run (front-matter vars: defaults apply automatically; provided vars win)
await runFile('./file.loop', session, { vars: { topic: 'X' } })

// Custom actions + runtime overlay (e.g. test runs)
const loop = loadLoop('./file.loop', { approve: async (ctx, step) => {} },
                      { maxTurnsCap: 10, skipNotify: true })
```

## Authoring guidance

- Prefer **one claudeCli step per intent** with a clear output contract
  ("Output ONLY the reply text — no preamble") over mega-prompts; downstream
  steps consume `{{refs}}`.
- Add a `verify` step after any step whose failure should stop the pipeline —
  reflexion then gives the prior step one self-correction attempt for free.
- Gate mechanical checks with `expect:` (deterministic, a true guarantee) and
  reserve `verify` for judgment calls that genuinely need an AI judge.
- Leave `mode` unset for exploration; the engine auto-escalates to `strict` for
  loops that merge/PR or use a worktree. For an unattended factory loop, set
  `mode: strict` and give each worker step a tight `tools:` allowlist.
- Put human gates (runner `approve` action) before irreversible side effects
  (posting, sending, merging).
- Capabilities belong in tools, not shell commands: if a prompt needs `curl`,
  the runner is missing an MCP tool — prefer `mcp:` servers.
- Loops that act as a specific identity should take `browserProfile: "{{profile}}"`
  and receive `profile` from the runner (board/trigger vars) rather than
  hardcoding it.
