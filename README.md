# loop-sdk

**A loop engineering framework for building long-running agentic loops.** Steps can be browser actions, AI agent calls, data operations, or anything else — composed into named, resumable sequences with structured logging, checkpointing, events, tool-permission enforcement, and a plugin system.

## What is loop engineering?

**Loop engineering** is the practice of building reliable, long-running agentic loops — turning a one-shot AI call into a repeatable, observable, governable process. Where *prompt engineering* shapes a single model response, loop engineering shapes the **control flow around many model calls**: how steps are ordered, how their outputs are verified, how failures retry, how a run resumes after a crash, and how much authority each step is granted.

`loop-sdk` is a loop engineering framework that gives each of those concerns a first-class primitive — steps, context, checkpoints, events, `verify`/`expect` gates, tool allowlists, and git-worktree isolation — so AI agents, browser automation, and data pipelines compose into **durable workflows instead of brittle scripts**. The engine owns the control flow deterministically; the model is invoked only at the steps that need it, and each step's output and tool access can be constrained in code.

**Related concepts:** agentic loops, agent orchestration, AI workflow automation, durable / resumable agent workflows, multi-agent pipelines, AI agent frameworks, and the "software factory" pattern for autonomous code generation.

## Install

```bash
npm install loop-sdk
npm install @ai-sdk/anthropic   # or @ai-sdk/openai, @ai-sdk/google, etc.
```

## Test

```bash
npm test   # builds, then runs the node:test suite in test/
```

## Claude Code skill

`skills/loop-sdk/SKILL.md` teaches Claude Code how to author and validate
`.loop` files idiomatically. Install it into any project:

```bash
mkdir -p .claude/skills/loop-sdk
cp node_modules/loop-sdk/skills/loop-sdk/SKILL.md .claude/skills/loop-sdk/
```

Then ask Claude things like *"write a .loop that checks my mentions and drafts
replies"* and it produces valid, idiomatic loop files.

## Quick start

```js
import { Loop } from 'loop-sdk'
import { claudeCli } from 'loop-sdk'

const loop = new Loop('research')

loop.step('gather', async (ctx) => {
  const result = await claudeCli(ctx, 'List the top 5 JS frameworks in 2026.')
  ctx.set('frameworks', result.output)
})

loop.step('summarize', async (ctx) => {
  const list = ctx.get('frameworks')
  await claudeCli(ctx, `Summarize this list in one sentence: ${list}`)
})

await loop.run({ session: null })
```

---

## Concepts

These are the building blocks of loop engineering with this SDK — the primitives you compose into durable agentic workflows.

### Loop

A named sequence of steps. Steps are plain async functions that receive a `ctx` (Context).

```js
const loop = new Loop('my-loop')

loop.step('step-name', async (ctx) => {
  // do work
}, {
  retries: 3,           // retry this step up to 3 times on failure
  retryDelay: 1000,     // wait 1s between retries
  retryBackoff: 'exponential',  // 'flat' | 'linear' | 'exponential'
  skipOnError: false,   // skip this step instead of failing the loop
  onError: async (err, ctx) => {
    // fallback: return a value to use as the step result, or re-throw to fail
  },
})

await loop.run({ session })
```

**`loop.run(opts)`** options:

| Option | Type | Description |
|--------|------|-------------|
| `session` | `Session \| null` | The session to run against. |
| `vars` | `object` | Initial variables available as `ctx.vars`. |
| `logDir` | `string` | Directory to write a JSON run log. |
| `startAt` | `number` | Skip steps before this 1-based index. |
| `stopAt` | `number` | Stop after this 1-based index. |
| `signal` | `AbortSignal` | External abort signal to cancel the run. |
| `checkpointFile` | `string` | Path to write checkpoints after each step. |
| `resumeFrom` | `string` | Checkpoint file to resume from (skips completed steps). |
| `keepCheckpointOnSuccess` | `boolean` | Keep the checkpoint file after a successful run (default: `false`). |
| `onError` | `(err, ctx, failedStep) => Promise<void>` | Called when the loop fails. |

Returns a run log object: `{ loop, session, status, steps, startedAt, finishedAt }`.

---

### Parallel steps

Run multiple step functions concurrently within a single named step:

```js
loop.parallel('fetch-all', [
  async (ctx) => { ctx.set('a', await fetch('https://a.com')) },
  async (ctx) => { ctx.set('b', await fetch('https://b.com')) },
  async (ctx) => { ctx.set('c', await fetch('https://c.com')) },
])
```

All functions in a parallel group share the same context and run via `Promise.all`.

---

### Background execution

`runBackground()` starts the loop in the background and immediately returns a `RunHandle`.

```js
const handle = loop.runBackground({ session })

console.log(handle.id)      // unique run ID
console.log(handle.status)  // 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'

const log = await handle.wait()   // resolves when the loop finishes
handle.cancel()                   // cancel the loop
handle.pause()                    // pause after the current step
const newHandle = handle.resume() // resume from where it paused
```

Checkpoints are auto-written under `.loop/<id>.checkpoint.json` during background runs. Pause and resume use the checkpoint file automatically.

**Run multiple loops in parallel:**

```js
const handles = await Loop.runAll([
  { loop: loopA, opts: { session } },
  { loop: loopB, opts: { session } },
  { loop: loopC, opts: { session } },
])
```

---

### Checkpointing

Checkpoints save progress after each step so a loop can be resumed after a crash or pause.

```js
await loop.run({
  session,
  checkpointFile: '.loop/my-run.checkpoint.json',
})

// Later, resume from where it left off:
await loop.run({
  session,
  resumeFrom: '.loop/my-run.checkpoint.json',
})
```

Helpers:

```js
import { checkpointExists, deleteCheckpoint } from 'loop-sdk'

if (await checkpointExists('.loop/my-run.checkpoint.json')) {
  // resume
}
await deleteCheckpoint('.loop/my-run.checkpoint.json')
```

Checkpoint files are auto-deleted on successful completion unless `keepCheckpointOnSuccess: true`.

---

### Events

Loops emit typed events throughout their lifecycle. Listen with `loop.on()` / `loop.off()`.

```js
loop.on('loop:start', ({ totalSteps }) => {
  console.log(`Starting with ${totalSteps} steps`)
})

loop.on('loop:complete', ({ status, durationMs, stepsCompleted }) => {
  console.log(`Finished: ${status} in ${durationMs}ms`)
})

loop.on('step:start',    ({ step, index }) => { })
loop.on('step:complete', ({ step, durationMs }) => { })
loop.on('step:error',    ({ step, error, attempt }) => { })
loop.on('step:skip',     ({ step, reason }) => { })   // reason: 'checkpoint' | 'range' | 'error'
loop.on('step:retry',    ({ step, attempt, delay }) => { })
loop.on('checkpoint:saved', ({ file, completedSteps }) => { })

loop.on('log',   ({ message }) => { })                 // ctx.log lines, attributed per run
loop.on('usage', ({ costUsd, inputTokens, outputTokens }) => { })  // claudeCli spend, cumulative per step
loop.on('agent', ({ kind, text }) => { })              // live claudeCli transcript: text | tool_use | tool_result | error
loop.on('worktree:created', ({ path, branch, baseRef }) => { })
```

**Custom events** — emit from inside a step and listen anywhere:

```js
loop.step('draft', async (ctx) => {
  ctx.set('draft', '...')
  ctx.emit('draft:ready', { preview: ctx.get('draft') })
})

loop.on('draft:ready', async ({ preview }) => {
  // approve, notify, update UI, etc.
})
```

---

### Context

Passed to every step. Carries shared state, per-iteration variables, and browser shortcuts.

```js
// State — shared across all steps in a run
ctx.set('key', value)
ctx.get('key')
ctx.has('key')
ctx.snapshot()       // plain object of all state

// Variables — injected per-iteration by each()
ctx.vars.item
ctx.vars.subtype

// Emit a custom event
ctx.emit('my:event', { data: 123 })

// Logging
ctx.log('message', { optional: 'data' })

// Browser shortcuts (delegate to ctx.session)
ctx.navigate(url)
ctx.click({ selector, text, x, y })
ctx.type(text)
ctx.key('Enter')
ctx.scroll({ deltaY: 300 })
ctx.screenshot()     // returns Buffer

// Direct session access
ctx.session.mcp('browser_evaluate', { function: '() => document.title' })
```

---

### Session

Abstract interface that all browser providers implement. Extend it to add your own:

```js
import { Session } from 'loop-sdk'

export class MySession extends Session {
  async navigate(url) { /* ... */ }
  async click(opts)   { /* ... */ }
  async type(text)    { /* ... */ }
  async key(key)      { /* ... */ }
  async scroll(opts)  { /* ... */ }
  async screenshot()  { /* returns Buffer */ }
  async destroy()     { /* ... */ }

  // Optional: expose an MCP URL so agent() / claudeCli() gets browser tool access
  get mcpUrl() { return `http://my-daemon/sessions/${this.id}/mcp` }
}
```

---

### agent()

Run any AI model as a loop step. Uses the [Vercel AI SDK](https://sdk.vercel.ai) so every `@ai-sdk/*` provider works.

```js
import { agent } from 'loop-sdk'
import { anthropic } from '@ai-sdk/anthropic'

loop.step('summarize', async (ctx) => {
  const result = await agent(ctx, 'Summarize the main content of this page.', {
    model: anthropic('claude-opus-4-8'),
    screenshot: true,    // attach a screenshot before calling the model
    maxSteps: 50,
    system: 'You are a research assistant.',
  })
  ctx.set('summary', result.text)
})
```

If `ctx.session.mcpUrl` is set, the model automatically gets the session's browser tools via MCP.

---

### claudeCli()

Spawn the `claude` CLI subprocess (`claude -p`) as a loop step. Use this when you want Claude Code's built-in tool-use loop, retry logic, and MCP permission model.

Requires `claude` to be installed and on PATH.

```js
import { claudeCli } from 'loop-sdk'

loop.step('fill', async (ctx) => {
  const result = await claudeCli(ctx, 'Fill out the visible form fields with test data.', {
    screenshot: true,
    model: 'claude-opus-4-8',
    timeout: 240_000,
    tools: ['Read', 'Edit'],  // scope the step to an allowlist
    enforce: true,            // enforce it (deny unlisted tools) instead of skipping permissions
  })
  ctx.set('output', result.output)
})
```

**`agent()` vs `claudeCli()`:**

| | `agent()` | `claudeCli()` |
|-|-----------|---------------|
| Provider | Any `@ai-sdk/*` model | Claude CLI only |
| Tool-use loop | Managed by Vercel AI SDK | Managed by Claude Code CLI |
| Best for | Multi-provider, programmatic control | Delegating full control to Claude |

---

### each()

Iterate over a list of items. Each item gets its own forked context with per-item vars.

```js
import { each } from 'loop-sdk'

loop.step('process-pages', async (ctx) => {
  const pages = ['https://a.com', 'https://b.com', 'https://c.com']

  await each(ctx, pages, async (ctx) => {
    await ctx.navigate(ctx.vars.item)
    await claudeCli(ctx, 'Summarize this page.')
  }, { continueOnError: true })
})
```

Items can carry subtypes:

```js
const items = [
  { type: 'Category A', subtypes: ['Sub 1', 'Sub 2'] },
  'Category B',
]

await each(ctx, items, async (ctx) => {
  console.log(ctx.vars.item, ctx.vars.subtype)
  // → 'Category A', 'Sub 1'
  // → 'Category A', 'Sub 2'
  // → 'Category B', undefined
})
```

---

### sub()

Run a `Loop` as a sub-step, sharing the current session and state.

```js
import { sub } from 'loop-sdk'

const loginLoop = new Loop('login')
loginLoop.step('authenticate', async (ctx) => {
  await claudeCli(ctx, `Log in as ${ctx.vars.username}.`)
})

loop.step('login', async (ctx) => {
  await sub(ctx, loginLoop, { username: 'admin' })
})
```

State written inside the sub-loop is visible in the parent loop (shared `ctx` state Map).

---

### Plugins

Plugins hook into the loop lifecycle. Return `true` from `onStepError` to retry the failed step.

```js
const crashRecovery = {
  name: 'crash-recovery',
  hooks: {
    onStepError: async (err, step, ctx) => {
      if (!err.message.includes('context was lost')) return false
      await ctx.session.recreate()
      return true  // retry the step
    },
  },
}

loop.use(crashRecovery)
```

#### RetryPlugin

Built-in plugin for automatic step retries with backoff:

```js
import { RetryPlugin } from 'loop-sdk'

loop.use(RetryPlugin({
  attempts: 3,
  delay: 500,
  backoff: 'exponential',       // 'flat' | 'linear' | 'exponential'
  retryIf: (err) => !err.message.includes('auth'),  // optional filter
}))
```

---

### macOS Notifications

Send native macOS notifications from a loop:

```js
import { notify, notifyOn } from 'loop-sdk'

// One-off notification
notify('Step completed!', { title: 'My Loop', sound: true })

// Auto-wire lifecycle notifications to a loop
notifyOn(loop, {
  onStart: true,
  onComplete: true,
  onError: true,
  onStepError: false,
  title: 'My Loop',
  sound: true,
})
```

No-op on non-macOS platforms.

---

## .loop files

`.loop` files let you define loops in a simple text format. An AI agent can generate them via MCP; your app parses and runs them.

**Format:**

```
---
name: my-loop
session: browser            # this loop needs a browser session
browserMode: extension      # 'isolated' (default) | 'chrome' (CDP) | 'extension'
browserProfile: "{{profile}}"   # which Chrome profile/identity acts ({{vars}} ok)
model: claude-sonnet-5      # default model for claudeCli/verify steps
mode: strict                # 'explore' (default) | 'strict' — enforcement posture (see below)
tools:                      # default tool allowlist for worker steps (a step's own `tools:` wins)
  - Read
  - Edit
  - Bash
workdir: ~/Code/my-repo     # cwd for claudeCli/verify (a repo makes them build workers)
worktree: true              # isolate each run's changes in a git worktree + branch
onSuccess: pr               # runner action after success: keep | merge | pr
mcp:                        # MCP servers attached to this loop's Claude workers
  - boards
reflexion: true             # failed verify retries the prior prompt step once with the critique
vars:                       # declared inputs and their defaults
  city: Austin
---

## step-one
action: claudeCli
prompt: Write a haiku about {{city}}.

## check
action: verify
assert: "{{step-one}} is a haiku (5-7-5)"

## step-two
action: log
message: Done! Output was {{step-one}}
```

**Supported actions:**

| Action | Description |
|--------|-------------|
| `claudeCli` | Run `claude -p` with `prompt` (`model`, `maxSteps`, `screenshot`, `workdir`, `mcp`, `tools`, `expect` per step). |
| `codexCli` | Run the OpenAI Codex CLI with `prompt` (`model`, `expect`). |
| `verify` | AI judge checks `assert`; failure fails the step (and triggers reflexion). |
| `send` | Push a `message` to the user — `channel: imessage` (with `to`) or `ntfy` (with `topic`). |
| `navigate` / `click` / `type` / `key` / `scroll` / `screenshot` | Browser actions on the run's session. |
| `wait` | Pause `ms` milliseconds. |
| `log` | Emit `message` to the run log. |
| `set-variable` | Store `value` under `key` (referenceable as `{{key}}` or the step name). |
| `parallel` | Run nested `steps` concurrently. |
| `sub` | Run another `.loop` file (`loop` path) sharing context; pass `vars`. |
| `each` | Iterate `items` (array, `{{ref}}`, or lines) over `steps`/`loop`; `as` names the item var; `concurrency: 1-8` runs items in parallel with isolated state; `continueOnError`. |
| *custom* | Any action name registered via the `actions` map passed to `loadLoop()` — how runners add steps like `approve` or `card`. |

**`{{name}}` interpolation** — resolves prior step outputs first, then vars (declared inputs, run-time vars, each-item aliases). Unresolved refs warn and keep the literal; use `describeLoop()` to catch them before running.

**Reflexion** — when a `verify` step fails and the step before it is a prompt step, that step is retried once with the judge's critique appended, then re-verified. Opt out with `reflexion: false`.

**Enforcement (`mode` / `tools` / `expect`)** — the loop engineering primitives for making a run *governable*: how you turn "follow the steps" from best-effort into a guarantee. The control flow already lives in the engine (not the model); these three knobs constrain what each worker step may *do* and *return*:

- **`mode`** — `explore` (default) runs workers frictionless: permissions are skipped unless a step declares its own `tools:`. `strict` scopes every worker step to an allowlist and denies unlisted tools. When `mode` is unset it **auto-escalates to `strict`** for loops that ship hard-to-reverse changes (`worktree`, or `onSuccess: merge|pr`) — set it explicitly to override. The default path is unchanged from prior versions.
- **`tools`** — a tool allowlist (Claude Code names, e.g. `[Read, Edit, Bash]`) at the loop level or per step. **Declaring an allowlist enforces it regardless of `mode`** — if you list tools, unlisted ones are denied. A live browser session automatically keeps its `mcp__browser` tools.
- **`expect`** — a deterministic output contract checked in code *after* a step runs, for **any** action (not just `claudeCli`): `json` / `non-empty`, or an object `{ json, nonEmpty, contains, matches }`. If it doesn't hold, the step fails. Prefer this over a `verify` AI-judge whenever the check is mechanical — it's a true guarantee, not a probabilistic one.

```
## extract
action: claudeCli
prompt: Return the posts as a JSON array. Output ONLY JSON.
tools: [Read]          # this step may only read files
expect: json           # hard-fails unless the output parses as JSON
```

**Running a `.loop` file — the CLI:**

The fastest way to run a browserless loop (claudeCli / codexCli / verify / data steps):

```bash
npx loop-sdk run research.loop
npx loop-sdk run reply.loop --var topic=AI --var tone=casual
npx loop-sdk run research.loop --json    # print the run log as JSON to stdout
```

The CLI runs the loop with a built-in no-op session, streams step progress, and
exits non-zero if the run fails. `claudeCli` steps require the `claude` CLI on
PATH. Loops that declare `session: browser` need a browser provider — run those
via the JS API below with your own `Session`.

**Running a `.loop` file — the JS API:**

```js
import { loadLoop, runFile, runFileBackground, NullSession } from 'loop-sdk'

// Browserless loops use the built-in no-op session; browser loops pass a
// provider like PlaywrightSession (or your own Session) instead.
const session = new NullSession('run')

// Run synchronously (returns run log)
await runFile('./my-loop.loop', session)

// Run in the background (returns RunHandle)
const handle = runFileBackground('./my-loop.loop', session)
await handle.wait()

// Parse and build a Loop instance manually — with custom actions and a
// runtime overlay (LoadOptions) for things like test runs
const loop = loadLoop('./my-loop.loop', {
  approve: async (ctx, step) => { /* pause for human approval */ },
}, {
  maxTurnsCap: 10,    // clamp agentic turns on claudeCli/verify steps
  skipNotify: true,   // mute the loop's notify config
})
await loop.run({ session, vars: { city: 'Denver' } })
```

Front-matter `vars:` are applied as input defaults by the engine (`Loop.defaults()`), so declared inputs work even when the host passes nothing; provided vars win.

---

## describeLoop()

Static analysis for runners — everything you need to know **before** executing:

```js
import { describeLoop } from 'loop-sdk'

const desc = describeLoop(content, deps /* optional: { 'child.loop': contents } */)
// {
//   name, mode: 'explore'|'strict',      // effective posture (incl. auto-escalation)
//   needsBrowser, browserMode: 'launch'|'cdp'|'extension',
//   browserProfile, cdpUrl, mcp,
//   inputs: { city: 'Austin' },          // declared defaults
//   stepNames: [...],
//   referencedVars: ['post-url'],        // {{refs}} with NO local source —
//                                        // supply them at run time or refuse
//   reachableDeps: ['child.loop'],       // transitive sub/each references
// }
```

Browser requirements propagate only through deps the entry loop actually
references — an unrelated browser loop in the dep map doesn't force a browser.
Use `referencedVars` for pre-flight validation: refuse the run with a clear
message instead of letting literal `{{braces}}` leak into navigation and prompts.

---

## Worktrees & MCP registry

- `worktree: true` + `workdir` — each run's file changes land in an isolated
  git worktree on branch `loop/<name>-<id>` (`ensureWorktree`); parallel runs
  against one repo never collide. The runner decides what happens to the
  branch afterward (`onSuccess: keep | merge | pr`).
- `mcp:` — names are resolved from `~/.loopdeloop/mcp.json` (Claude Code
  `mcpServers` format) at step runtime via `resolveMcpServers()`; inline
  definitions also work. Step-level `mcp:` overrides the loop's.

---

## MCP server

The `loop-mcp` server lets AI agents create and manage `.loop` files via MCP tools.

**Start it:**

```bash
npx loop-mcp
# or
npm run mcp
```

**Available tools:**

| Tool | Description |
|------|-------------|
| `write_loop` | Write (or overwrite) a `.loop` file. Validates before writing. |
| `read_loop` | Read the contents of a `.loop` file. |
| `list_loops` | List all `.loop` files with step summaries. |
| `validate_loop` | Validate a `.loop` file without writing it. |

Loop files are stored in the directory set by `LOOP_DIR` (default: `.loop`).

**Claude Desktop config:**

```json
{
  "mcpServers": {
    "loop": {
      "command": "npx",
      "args": ["loop-mcp"]
    }
  }
}
```

---

## PlaywrightSession

The built-in browser provider. Wraps a Playwright browser daemon over its HTTP API (default `http://localhost:4848`).

```js
import { PlaywrightSession } from 'loop-sdk/playwright'

const session = new PlaywrightSession('session-id', {
  daemon: 'http://localhost:4848',  // default
})

await session.ensure()    // create if it doesn't exist
await session.recreate()  // destroy + re-create (after a crash)
await session.destroy()   // tear down

// Extra methods:
await session.evaluate('() => document.title')
await session.currentUrl()
await session.mcp('browser_snapshot', {})
```

---

## Run log

When `logDir` is passed to `loop.run()`, a JSON log is written incrementally:

```json
{
  "loop": "my-loop",
  "session": "my-session",
  "status": "completed",
  "startedAt": "2026-06-28T10:00:00.000Z",
  "finishedAt": "2026-06-28T10:01:23.456Z",
  "steps": [
    { "name": "gather",    "status": "ok" },
    { "name": "summarize", "status": "ok" }
  ]
}
```

Possible statuses: `completed`, `failed`, `running` (if the process was killed mid-run), `cancelled`.

---

## Writing a custom provider

Any class that extends `Session` works as a provider:

```js
import { Session } from 'loop-sdk'
import puppeteer from 'puppeteer'

export class PuppeteerSession extends Session {
  constructor(id) {
    super(id)
    this._browser = null
    this._page = null
  }

  async ensure() {
    this._browser = await puppeteer.launch()
    this._page = await this._browser.newPage()
  }

  async navigate(url) { await this._page.goto(url) }
  async click({ selector }) { await this._page.click(selector) }
  async type(text) { await this._page.keyboard.type(text) }
  async key(key) { await this._page.keyboard.press(key) }
  async scroll({ deltaY }) { await this._page.evaluate(dy => window.scrollBy(0, dy), deltaY) }
  async screenshot() { return this._page.screenshot({ type: 'jpeg' }) }
  async destroy() { await this._browser?.close() }
}

const session = new PuppeteerSession('puppeteer-session')
await session.ensure()
await loop.run({ session })
await session.destroy()
```
