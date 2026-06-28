/**
 * parallel.js — step-level and loop-level parallelism
 *
 * Shows:
 *   1. loop.parallel() — concurrent steps within a single loop
 *   2. Loop.runAll()   — multiple loops running at the same time
 *   3. .loop file with action: parallel
 *
 * Usage:
 *   npm run build && node examples/parallel.js
 */

import { Loop, claudeCli, runFile } from '../dist/index.js'
import { MockSession } from './mock-session.js'

// ── 1. Step-level parallel via loop.parallel() ────────────────────────────────

console.log('═══ 1. loop.parallel() ═══\n')

const loop = new Loop('research')

loop.parallel('gather', {
  'topic-a': async (ctx) => {
    const r = await claudeCli(ctx, 'In one sentence: what is event-driven architecture?')
    ctx.set('topic-a', r.output)
  },
  'topic-b': async (ctx) => {
    const r = await claudeCli(ctx, 'In one sentence: what is message passing?')
    ctx.set('topic-b', r.output)
  },
  'topic-c': async (ctx) => {
    const r = await claudeCli(ctx, 'In one sentence: what is the actor model?')
    ctx.set('topic-c', r.output)
  },
})

loop.step('summarize', async (ctx) => {
  const r = await claudeCli(ctx,
    `These three concepts are related. Write one sentence connecting them:\n` +
    `1. ${ctx.get('topic-a')}\n` +
    `2. ${ctx.get('topic-b')}\n` +
    `3. ${ctx.get('topic-c')}`
  )
  ctx.set('summary', r.output)
  console.log('\n── Summary ──')
  console.log(ctx.get('summary'))
})

await loop.run({ session: new MockSession('parallel-steps') })

// ── 2. Loop-level parallel via Loop.runAll() ──────────────────────────────────

console.log('\n\n═══ 2. Loop.runAll() ═══\n')

function makeQuestionLoop(name, question) {
  const l = new Loop(name)
  l.step('ask', async (ctx) => {
    const r = await claudeCli(ctx, question)
    ctx.set('answer', r.output)
    console.log(`[${name}] ${r.output}`)
  })
  return l
}

const logs = await Loop.runAll([
  {
    loop: makeQuestionLoop('databases', 'In one sentence: what is a B-tree index?'),
    session: new MockSession('db'),
  },
  {
    loop: makeQuestionLoop('networking', 'In one sentence: what is TCP backpressure?'),
    session: new MockSession('net'),
  },
  {
    loop: makeQuestionLoop('security', 'In one sentence: what is a timing attack?'),
    session: new MockSession('sec'),
  },
])

console.log(`\nAll ${logs.length} loops completed: ${logs.map(l => l.status).join(', ')}`)

// ── 3. .loop file with action: parallel ──────────────────────────────────────

console.log('\n\n═══ 3. parallel.loop ═══\n')

await runFile('./examples/parallel.loop', new MockSession('loopfile-parallel'))
