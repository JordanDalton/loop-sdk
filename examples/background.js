/**
 * background.js — cancel, pause, and resume loops running in the background.
 *
 * Usage:
 *   npm run build && node examples/background.js
 */

import { Loop, claudeCli } from '../dist/index.js'
import { MockSession } from './mock-session.js'

// ── Shared step factory ───────────────────────────────────────────────────────

function makeLoop(name, questions) {
  const loop = new Loop(name)
  for (const [stepName, prompt] of Object.entries(questions)) {
    loop.step(stepName, async (ctx) => {
      const r = await claudeCli(ctx, prompt)
      ctx.set(stepName, r.output)
    })
  }
  return loop
}

// ── Loop A — runs to completion ───────────────────────────────────────────────

const loopA = makeLoop('loop-a', {
  q1: 'In one sentence: what is recursion?',
  q2: 'In one sentence: what is memoization?',
  q3: 'In one sentence: what is tail-call optimisation?',
})

// ── Loop B — will be cancelled after step 1 ───────────────────────────────────

const loopB = makeLoop('loop-b', {
  b1: 'In one sentence: what is concurrency?',
  b2: 'In one sentence: what is parallelism?',   // never runs
  b3: 'In one sentence: what is a race condition?', // never runs
})

loopB.on('step:complete', ({ step }) => {
  if (step === 'b1') {
    console.log('\n[main] b1 done — cancelling loop-b')
    handleB.cancel()
  }
})

// ── Loop C — will be paused after step 1 then resumed ────────────────────────

const loopC = makeLoop('loop-c', {
  c1: 'In one sentence: what is a deadlock?',
  c2: 'In one sentence: what is a semaphore?',   // skipped during first run
  c3: 'In one sentence: what is a mutex?',        // skipped during first run
})

loopC.on('step:complete', ({ step }) => {
  if (step === 'c1') {
    console.log('\n[main] c1 done — pausing loop-c (state saved)')
    handleC.pause()
    console.log(`[main] loop-c status: ${handleC.status}`)
  }
})

// ── Start all three in the background ────────────────────────────────────────

const handleA = loopA.runBackground({ session: new MockSession('session-a') })
const handleB = loopB.runBackground({ session: new MockSession('session-b') })
const handleC = loopC.runBackground({ session: new MockSession('session-c') })

console.log(`loop-a: ${handleA.status}`)
console.log(`loop-b: ${handleB.status}`)
console.log(`loop-c: ${handleC.status}\n`)

// Await B and C (A runs in the background still)
await Promise.all([
  handleB.wait().catch(() => {}),
  handleC.wait().catch(() => {}),
])

console.log(`\n── After first wave ──`)
console.log(`loop-b: ${handleB.status}  (cancelled — ran 1 of 3 steps)`)
console.log(`loop-c: ${handleC.status}  (paused — ran 1 of 3 steps, checkpoint saved)\n`)

// Resume loop-c — picks up from step 2
console.log('[main] Resuming loop-c from checkpoint...')
const handleC2 = handleC.resume()

await Promise.all([handleA.wait(), handleC2.wait()])

console.log(`\n── Final ──`)
console.log(`loop-a: ${handleA.status}  (completed — ran all 3 steps)`)
console.log(`loop-b: ${handleB.status}  (cancelled)`)
console.log(`loop-c: ${handleC2.status}  (completed — resumed from step 2)`)
