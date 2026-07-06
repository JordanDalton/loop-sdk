/**
 * basic.js — loop-sdk usage examples
 *
 * Prerequisites:
 *   npm install
 *   npm install @ai-sdk/anthropic @ai-sdk/openai   # or any other @ai-sdk/* provider
 *   npm run build                                   # compile TypeScript → dist/
 *   # A Session provider running (e.g. a Playwright browser daemon on :4848)
 */

import { Loop, agent, claudeCli, each, sub } from '../dist/index.js'
import { PlaywrightSession } from '../dist/providers/playwright.js'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'

const MODEL = anthropic('claude-opus-4-8')

// ── Example 1: minimal loop — navigate and read a page ───────────────────────

{
  const session = new PlaywrightSession('ex1')
  await session.ensure()

  const loop = new Loop('read-page')

  loop.step('open', async (ctx) => {
    await ctx.navigate('https://news.ycombinator.com')
  })

  loop.step('summarize', async (ctx) => {
    const result = await agent(ctx, 'List the top 5 story titles on this page.', {
      model: MODEL,
      screenshot: true,
    })
    ctx.set('summary', result.text)
  })

  const log = await loop.run({ session })
  console.log('Summary:', log)

  await session.destroy()
}

// ── Example 2: each() — visit a list of URLs in sequence ─────────────────────

{
  const session = new PlaywrightSession('ex2')
  await session.ensure()

  const loop = new Loop('check-pages')

  loop.step('audit', async (ctx) => {
    const pages = [
      'https://example.com',
      'https://example.org',
      'https://example.net',
    ]

    await each(ctx, pages, async (ctx) => {
      await ctx.navigate(ctx.vars.item)
      const result = await agent(ctx, 'What is the page title and main heading?', {
        model: MODEL,
        screenshot: true,
      })
      ctx.log(`${ctx.vars.item} → ${result.text.slice(0, 80)}`)
    }, { continueOnError: true })
  })

  await loop.run({ session, logDir: './logs' })
  await session.destroy()
}

// ── Example 3: sub() — compose a reusable login loop ─────────────────────────

{
  // Define a reusable login sub-loop once
  const loginLoop = new Loop('login')
  loginLoop.step('fill-credentials', async (ctx) => {
    await ctx.navigate(ctx.vars.loginUrl)
    await agent(ctx, `Log in with username "${ctx.vars.username}" and password "${ctx.vars.password}".`, {
      model: MODEL,
      screenshot: true,
    })
  })

  // Use it inside a larger loop
  const session = new PlaywrightSession('ex3')
  await session.ensure()

  const mainLoop = new Loop('authenticated-task')

  mainLoop.step('login', async (ctx) => {
    await sub(ctx, loginLoop, {
      loginUrl: 'https://app.example.com/login',
      username: 'demo@example.com',
      password: 'hunter2',
    })
  })

  mainLoop.step('do-work', async (ctx) => {
    await agent(ctx, 'Navigate to the dashboard and summarize what you see.', {
      model: MODEL,
      screenshot: true,
    })
  })

  await mainLoop.run({ session })
  await session.destroy()
}

// ── Example 4: plugin — recover from session crashes ─────────────────────────

{
  const crashRecovery = {
    name: 'crash-recovery',
    hooks: {
      onStepError: async (err, step, ctx) => {
        if (!err.message.includes('about:blank') && !err.message.includes('context was lost')) return false
        ctx.log(`session crashed at step "${step.name}" — recreating`)
        await ctx.session.recreate()
        return true  // returning true signals the loop to retry the step
      },
    },
  }

  const session = new PlaywrightSession('ex4')
  await session.ensure()

  const loop = new Loop('resilient-loop')
  loop.use(crashRecovery)

  loop.step('do-something', async (ctx) => {
    await ctx.navigate('https://example.com')
    await agent(ctx, 'Describe what you see.', { model: MODEL })
  })

  await loop.run({ session })
  await session.destroy()
}

// ── Example 5: claudeCli() — use the Claude Code CLI instead of the SDK ────────
//
// Use this when you want the full `claude -p` experience: Claude's built-in
// tool-use loop, retry logic, and MCP permission model.
// Requires the `claude` CLI to be installed on PATH.

{
  const session = new PlaywrightSession('ex5-cli')
  await session.ensure()

  const loop = new Loop('cli-loop')

  loop.step('fill', async (ctx) => {
    await ctx.navigate('https://example.com/form')
    await claudeCli(ctx, 'Fill out the contact form with realistic placeholder data.', {
      screenshot: true,
      model: 'claude-opus-4-8',   // optional: override the default model
    })
  })

  await loop.run({ session })
  await session.destroy()
}

// ── Example 6: swap the AI provider — only the model arg changes ──────────────

{
  const session = new PlaywrightSession('ex5')
  await session.ensure()

  const loop = new Loop('provider-swap')
  loop.step('read', async (ctx) => {
    await ctx.navigate('https://example.com')

    // Swap anthropic → openai by changing one argument
    const result = await agent(ctx, 'Describe this page.', {
      model: openai('gpt-4o'),
      screenshot: true,
    })
    ctx.log('done', { chars: result.text.length })
  })

  await loop.run({ session })
  await session.destroy()
}
