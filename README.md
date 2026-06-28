# loop-sdk

Framework for building long-running agentic loops. Steps can be browser actions, AI agent calls, data operations, or anything else — composed into named, resumable sequences with structured logging and a plugin system for cross-cutting concerns like crash recovery.

## Install

```bash
npm install loop-sdk
npm install @ai-sdk/anthropic   # or @ai-sdk/openai, @ai-sdk/google, etc.
```

## Quick start

```js
import { Loop } from 'loop-sdk'
import { PlaywrightSession } from 'loop-sdk/playwright'
import { agent } from 'loop-sdk'
import { anthropic } from '@ai-sdk/anthropic'

const session = new PlaywrightSession('my-session')
await session.ensure()

const loop = new Loop('read-page')

loop.step('open', async (ctx) => {
  await ctx.navigate('https://example.com')
})

loop.step('summarize', async (ctx) => {
  const result = await agent(ctx, 'Summarize the main content of this page.', {
    model: anthropic('claude-opus-4-8'),
    screenshot: true,
  })
  ctx.set('summary', result.text)
})

await loop.run({ session })
await session.destroy()
```

---

## Concepts

### Loop

A named sequence of steps. Steps are plain async functions that receive a `ctx` (Context).

```js
const loop = new Loop('my-loop')

loop.step('step-name', async (ctx) => {
  // do work
})

await loop.run({ session })
```

**`loop.run(opts)`** options:

| Option | Type | Description |
|--------|------|-------------|
| `session` | `Session` | Required. The session to run against. |
| `vars` | `object` | Initial variables available as `ctx.vars`. |
| `logDir` | `string` | Directory to write a JSON run log. |
| `startAt` | `number` | Skip steps before this 1-based index. |
| `stopAt` | `number` | Stop after this 1-based index. |

Returns a run log object: `{ loop, session, status, steps, startedAt, finishedAt }`.

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

  // Optional: expose an MCP URL so agent() can give the AI browser tool access
  get mcpUrl() { return `http://my-daemon/sessions/${this.id}/mcp` }
}
```

### agent()

Run any AI model as a loop step. Uses the [Vercel AI SDK](https://sdk.vercel.ai) so every `@ai-sdk/*` provider works.

```js
import { agent } from 'loop-sdk'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'

loop.step('fill', async (ctx) => {
  const result = await agent(ctx, 'Fill out the visible form fields.', {
    model: anthropic('claude-opus-4-8'),  // swap to openai('gpt-4o') with no other changes
    screenshot: true,                     // attach a screenshot before calling the model
    maxSteps: 50,                         // max tool-use steps (default: 50)
    system: 'You are a form-filling assistant.',
  })

  ctx.set('agentOutput', result.text)
})
```

If `ctx.session.mcpUrl` is set, the model automatically gets access to the session's browser tools via MCP.

### each()

Iterate over a list of items sequentially. Each item gets its own forked context with per-item vars.

```js
import { each } from 'loop-sdk'

loop.step('process-pages', async (ctx) => {
  const pages = ['https://a.com', 'https://b.com', 'https://c.com']

  await each(ctx, pages, async (ctx) => {
    await ctx.navigate(ctx.vars.item)
    await agent(ctx, 'Summarize this page.', { model })
  }, { continueOnError: true })
})
```

Items can also carry subtypes:

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

**`each()` options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `continueOnError` | `boolean` | `false` | Log failures and continue rather than throwing. |

### sub()

Run a `Loop` as a sub-step, sharing the current session.

```js
import { sub } from 'loop-sdk'

const loginLoop = new Loop('login')
loginLoop.step('authenticate', async (ctx) => {
  await ctx.navigate(ctx.vars.loginUrl)
  await agent(ctx, `Log in as ${ctx.vars.username}.`, { model })
})

// In a parent loop:
loop.step('login', async (ctx) => {
  await sub(ctx, loginLoop, { loginUrl: '/login', username: 'admin' })
})
```

### claudeCli()

Spawn the `claude` CLI subprocess (`claude -p`) as a loop step instead of calling a provider directly. Use this when you want Claude Code's built-in tool-use loop, retry logic, and MCP permission model.

Requires `claude` to be installed and on PATH.

```js
import { claudeCli } from 'loop-sdk'

loop.step('fill', async (ctx) => {
  await claudeCli(ctx, 'Fill out the visible form fields with test data.', {
    screenshot: true,              // attach a screenshot before invoking claude
    model: 'claude-opus-4-8',     // passed as --model (optional)
    tools: ['browser_click'],     // restrict to specific MCP tools (optional)
    timeout: 240_000,             // subprocess timeout in ms (default: 240000)
    retries: 3,                   // retry on network errors (default: 3)
  })
})
```

If `ctx.session.mcpUrl` is set, claude automatically gets browser tool access via `--mcp-config`.

**`agent()` vs `claudeCli()`:**

| | `agent()` | `claudeCli()` |
|-|-----------|---------------|
| Provider | Any `@ai-sdk/*` model | Claude CLI only |
| Tool-use loop | Managed by Vercel AI SDK | Managed by Claude Code CLI |
| Streaming | Yes (via SDK) | No (waits for subprocess) |
| Best for | Multi-provider, programmatic control | Delegating full control to Claude |

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

### Functional API

For one-off scripts that don't need a named Loop:

```js
import { run } from 'loop-sdk'

await run('quick-task', session, async (ctx) => {
  await ctx.navigate('https://example.com')
  await agent(ctx, 'What do you see?', { model })
})
```

---

## PlaywrightSession

The built-in provider. Wraps the [aria-playwright](../aria-playwright) daemon.

```js
import { PlaywrightSession } from 'loop-sdk/playwright'

const session = new PlaywrightSession('session-id', {
  daemon: 'http://localhost:4848',  // default
})

await session.ensure()    // create if it doesn't exist
await session.recreate()  // destroy + re-create (after a crash)
await session.destroy()   // tear down

// Extra methods beyond the base Session interface:
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
    { "name": "open",      "status": "ok" },
    { "name": "summarize", "status": "ok" }
  ]
}
```

Possible statuses: `completed`, `failed`, `running` (if the process was killed mid-run).

---

## Writing a custom provider

Any class that extends `Session` and implements the required methods works as a provider:

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
```

Then use it exactly like `PlaywrightSession`:

```js
const session = new PuppeteerSession('puppeteer-session')
await session.ensure()
await loop.run({ session })
await session.destroy()
```
