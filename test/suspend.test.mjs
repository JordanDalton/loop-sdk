import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Loop, NullSession } from '../dist/index.js'

// ── Fixtures ──────────────────────────────────────────────────────────

function tmpCheckpointFile(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return join(dir, 'run.checkpoint.json')
}

// ── Tests ─────────────────────────────────────────────────────────────

test('suspend: dispatch fires once, resume without delivery re-suspends, delivery completes the run', async () => {
  const checkpointFile = tmpCheckpointFile('loop-suspend-')
  const session = new NullSession('s1')
  let dispatchCount = 0
  let finalValue

  function buildLoop() {
    const loop = new Loop('suspend-demo')
    loop.suspend('wait-step', async (_ctx, _key) => {
      dispatchCount++
    }, { key: 'task:1' })
    loop.step('after', async (ctx) => {
      finalValue = ctx.get('wait-step')
    })
    return loop
  }

  const log1 = await buildLoop().run({ session, checkpointFile })
  assert.equal(log1.status, 'suspended')
  assert.equal(dispatchCount, 1)
  assert.equal(existsSync(checkpointFile), true)
  assert.equal(finalValue, undefined) // 'after' never ran

  // Resuming before delivery re-suspends — dispatch must not fire again.
  const log2 = await buildLoop().run({ session, resumeFrom: checkpointFile, checkpointFile })
  assert.equal(log2.status, 'suspended')
  assert.equal(dispatchCount, 1)

  Loop.deliver(checkpointFile, 'task:1', { value: 42 })

  const log3 = await buildLoop().run({ session, resumeFrom: checkpointFile, checkpointFile })
  assert.equal(log3.status, 'completed')
  assert.equal(dispatchCount, 1)
  assert.deepEqual(finalValue, { value: 42 })
})

test('suspend: dispatch-less wait (external trigger already fired elsewhere)', async () => {
  const checkpointFile = tmpCheckpointFile('loop-suspend-nodispatch-')
  const session = new NullSession('s2')

  const loop1 = new Loop('no-dispatch')
  loop1.suspend('wait-step', null, { key: 'task:approval' })
  const log1 = await loop1.run({ session, checkpointFile })
  assert.equal(log1.status, 'suspended')

  Loop.deliver(checkpointFile, 'task:approval', 'approved')

  const loop2 = new Loop('no-dispatch')
  loop2.suspend('wait-step', null, { key: 'task:approval' })
  const log2 = await loop2.run({ session, resumeFrom: checkpointFile, checkpointFile })
  assert.equal(log2.status, 'completed')
})

test('suspend: timeout surfaces as a normal step failure on resume', async () => {
  const checkpointFile = tmpCheckpointFile('loop-suspend-timeout-')
  const session = new NullSession('s3')

  function buildLoop() {
    const loop = new Loop('timeout-demo')
    loop.suspend('wait-step', null, { key: 'task:2', timeout: 10 })
    return loop
  }

  const log1 = await buildLoop().run({ session, checkpointFile })
  assert.equal(log1.status, 'suspended')

  // Backdate the wait's startedAt so the timeout reads as elapsed without a real sleep.
  const raw = JSON.parse(readFileSync(checkpointFile, 'utf8'))
  raw.waits['task:2'].startedAt = new Date(Date.now() - 1000).toISOString()
  writeFileSync(checkpointFile, JSON.stringify(raw))

  const log2 = await buildLoop().run({ session, resumeFrom: checkpointFile, checkpointFile })
  assert.equal(log2.status, 'failed')
  assert.equal(log2.steps[0].status, 'error')
  assert.match(log2.steps[0].error, /timed out/)
})

test('suspend: loop.suspend() without a checkpointFile throws (unresumable)', async () => {
  const session = new NullSession('s4')
  const loop = new Loop('no-checkpoint')
  loop.suspend('wait-step', null, { key: 'task:3' })
  await assert.rejects(
    () => loop.run({ session }),
    /requires checkpointFile/
  )
})

test('runBackground(): handle.resume({ key, payload }) delivers and resumes in one call', async () => {
  const checkpointFile = tmpCheckpointFile('loop-suspend-bg-')
  const session = new NullSession('s5')
  const loop = new Loop('bg-demo')
  loop.suspend('wait-step', async () => {}, { key: 'task:4' })
  loop.step('after', async (ctx) => { ctx.set('done', true) })

  const handle = loop.runBackground({ session, checkpointFile })
  const log1 = await handle.wait()
  assert.equal(log1.status, 'suspended')
  assert.equal(handle.status, 'suspended')

  const handle2 = handle.resume({ key: 'task:4', payload: { ok: true } })
  const log2 = await handle2.wait()
  assert.equal(log2.status, 'completed')
})
