# loop-sdk

Framework for building long-running agentic loops. Steps can be browser actions, AI agent calls, data operations, or anything else — composed into named, resumable sequences with structured logging, checkpointing, events, and a plugin system.

## Install

```bash
npm install loop-sdk
npm install @ai-sdk/anthropic   # or @ai-sdk/openai, @ai-sdk/google, etc.
```

## Quick start

```js
import { Loop } from 'loop-sdk'
import { claudeCli } from 'loop-sdk'

const loop = new Loop('research')

loop.step('gather', async (ctx) => {
  const result = await claudeCli(ctx, 'List the top 5 JS frameworks in 2026.')
  ctx.set('frameworks', result.text)
})

loop.step('summarize', async (ctx) => {
  const list = ctx.get('frameworks')
  await claudeCli(ctx, `Summarize this list in one sentence: ${list}`)
})

await loop.run({ session: null })
```

---

## Concepts

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
  })
  ctx.set('output', result.text)
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
description: Does something useful
---

## step-one

action: claudeCli
prompt: Write a haiku about the ocean.

## step-two

action: log
message: Done! Output was {{step-one}}
```

**Supported actions:**

| Action | Description |
|--------|-------------|
| `claudeCli` | Run `claude -p` with `prompt`. |
| `navigate` | Navigate to `url`. |
| `screenshot` | Take a screenshot. |
| `log` | Print `message` to stdout. |
| `parallel` | Run multiple steps concurrently (nested `steps` list). |
| `sub` | Run another `.loop` file (`file` path). |
| `each` | Iterate over `items` (array, context key, or `claudeCli` prompt) and run `steps` or `file` per item. |

**`{{step-name}}` interpolation** — reference the output of any previous step by name.

**Running a `.loop` file:**

```js
import { loadLoop, runFile, runFileBackground } from 'loop-sdk'

// Run synchronously (returns run log)
await runFile('./my-loop.loop', { session: null })

// Run in the background (returns RunHandle)
const handle = await runFileBackground('./my-loop.loop', { session: null })
await handle.wait()

// Parse and build a Loop instance manually
const loop = await loadLoop('./my-loop.loop')
await loop.run({ session: null })
```

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

The built-in browser provider. Wraps the aria-playwright daemon.

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
