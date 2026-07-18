/**
 * suspend.js — park a run until an external event delivers a result, then
 * resume it (possibly from a totally different process).
 *
 * Usage:
 *   npm run build && node examples/suspend.js
 *
 * No network or credentials needed. The mock "bridge" models a browser task
 * dispatched to another machine — the result arrives later via Loop.deliver().
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Loop, NullSession } from '../dist/index.js'

const directory = mkdtempSync(join(tmpdir(), 'loop-suspend-'))
const session = new NullSession('suspend-example')

// Replace this with a real dispatch — post to a queue, call a webhook, hand a
// task to a browser bridge. It only needs to fire the async operation; the
// result comes back later via Loop.deliver(), not as this function's return.
const bridge = {
  dispatched: 0,
  async dispatch(taskId, url) {
    this.dispatched++
    console.log(`bridge: dispatched task ${taskId} for ${url}`)
  },
}

// ── Suspend, resume-without-delivery (re-suspends), then deliver ────────────

function buildScrapeLoop() {
  const loop = new Loop('scrape-page')

  loop.suspend('page-result', async (ctx, key) => {
    await bridge.dispatch(key, ctx.vars.url)
  }, {
    key: ctx => `task:${ctx.vars.taskId}`,
  })

  loop.step('summarize', async (ctx) => {
    const result = ctx.get('page-result')
    console.log(`summarize: got ${JSON.stringify(result)}`)
  })

  return loop
}

const checkpointFile = join(directory, 'scrape.checkpoint.json')
const vars = { taskId: 'abc123', url: 'https://example.com' }

console.log('\n--- First run: dispatches the task, then suspends ---')
const log1 = await buildScrapeLoop().run({ session, checkpointFile, vars })
console.log(`status: ${log1.status}`)

console.log('\n--- Resume before delivery: re-suspends, does NOT re-dispatch ---')
const log2 = await buildScrapeLoop().run({ session, checkpointFile, resumeFrom: checkpointFile, vars })
console.log(`status: ${log2.status} (bridge.dispatched is still ${bridge.dispatched})`)

console.log('\n--- External callback delivers the result ---')
Loop.deliver(checkpointFile, 'task:abc123', { title: 'Example Domain', wordCount: 42 })

console.log('\n--- Resume after delivery: picks the payload back up and completes ---')
const log3 = await buildScrapeLoop().run({ session, checkpointFile, resumeFrom: checkpointFile, vars })
console.log(`status: ${log3.status}`)

// ── runBackground() + handle.resume({ key, payload }) sugar ─────────────────

console.log('\n--- Background run: suspend, then deliver+resume in one call ---')

const bgLoop = new Loop('approve-post')
bgLoop.suspend('approval', null, { key: 'approval:post-9' }) // dispatch already happened elsewhere
bgLoop.step('publish', async () => console.log('publish: post-9 is live'))

const handle = bgLoop.runBackground({ session })
const bgLog1 = await handle.wait()
console.log(`handle.status: ${handle.status} (${bgLog1.status})`)

const handle2 = handle.resume({ key: 'approval:post-9', payload: 'approved' })
const bgLog2 = await handle2.wait()
console.log(`handle2.status: ${handle2.status} (${bgLog2.status})`)
