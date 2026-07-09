/**
 * effects.js — durable idempotent effects and compensation sagas.
 *
 * Usage:
 *   npm run build && node examples/effects.js
 *
 * No network or credentials needed. The mock API models an external service
 * that deduplicates requests by the idempotency key supplied by Loop.effect().
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Loop, NullSession, effect } from '../dist/index.js'

const directory = mkdtempSync(join(tmpdir(), 'loop-effects-'))
const session = new NullSession('effects-example')

// Replace this with your own API client. Real APIs should receive `key` in
// their idempotency header or request body, just as this mock receives it here.
const api = {
  records: new Map(),
  async create(kind, key) {
    if (this.records.has(key)) {
      console.log(`API: reused ${kind} for ${key}`)
      return this.records.get(key)
    }
    const result = { id: `${kind}-${this.records.size + 1}`, key }
    this.records.set(key, result)
    console.log(`API: created ${result.id}`)
    return result
  },
  async remove(result, key) {
    console.log(`API: removed ${result.id} with ${key}`)
  },
}

// ── Resume without duplicate external writes ─────────────────────────────────

const resumeCheckpoint = join(directory, 'resume.json')
const resumeLoop = new Loop('resume-effect')
let firstAttempt = true

// The helper is useful when an effect is only part of a larger step. Here the
// step fails after the API call, which would normally make a resume call again.
resumeLoop.step('publish', async ctx => {
  const receipt = await effect(ctx, 'send-receipt', async (_ctx, key) => {
    return api.create('receipt', key)
  }, { key: 'receipt:order-42' })

  console.log(`Receipt: ${receipt.id}`)
  if (firstAttempt) {
    firstAttempt = false
    throw new Error('simulated crash after the API accepted the receipt')
  }
})

console.log('\n--- First run: effect succeeds, enclosing step fails ---')
await resumeLoop.run({ session, checkpointFile: resumeCheckpoint, keepCheckpointOnSuccess: true })

console.log('\n--- Resume: saved receipt is returned; API is not called ---')
await resumeLoop.run({
  session,
  checkpointFile: resumeCheckpoint,
  resumeFrom: resumeCheckpoint,
  keepCheckpointOnSuccess: true,
})

// ── Compensation saga ────────────────────────────────────────────────────────

const sagaCheckpoint = join(directory, 'saga.json')
const saga = new Loop('compensate-effects')

saga.effect('reserve-inventory', async (_ctx, key) => api.create('reservation', key), {
  key: 'reservation:order-42',
  compensate: async (reservation, _ctx, key) => {
    await api.remove(reservation, `undo:${key}`)
  },
})

saga.effect('charge-card', async (_ctx, key) => api.create('charge', key), {
  key: 'charge:order-42',
  compensate: async (charge, _ctx, key) => {
    await api.remove(charge, `undo:${key}`)
  },
})

saga.step('fulfill-order', async () => {
  throw new Error('simulated fulfillment failure')
})

console.log('\n--- Saga: compensators run charge, then reservation ---')
await saga.run({
  session,
  checkpointFile: sagaCheckpoint,
  keepCheckpointOnSuccess: true,
  compensateOnError: true,
})

console.log(`\nCheckpoints retained for inspection: ${directory}`)
