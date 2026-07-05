import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseLoopFile, describeLoop, loadLoop, Session } from '../dist/index.js'

// ── Fixtures ──────────────────────────────────────────────────────────

const BASIC = `---
name: Basic
vars:
  city: Austin
---

## greet
action: set-variable
key: greeting
value: "hello from {{city}}"

## announce
action: log
message: "{{greeting}} / {{greet}}"
`

const STAGE_LOOP = `---
name: Draft Reply
session: browser
browserMode: extension
browserProfile: "{{profile}}"
vars:
  profile: ""
  voice: friendly
---

## open-post
action: navigate
url: "{{post-url}}"

## draft
action: claudeCli
prompt: "Reply to {{card-title}} ({{card-notes}}) in {{voice}} voice about {{post-url}}"

## route
action: card
move: "{{decision}}"
`

const PARENT = `---
name: Parent
---

## fan-out
action: each
loop: ./child.loop
items:
  - a
  - b
`

const CHILD_BROWSER = `---
name: Child
session: browser
browserMode: chrome
---

## open
action: navigate
url: https://example.com
`

const EACH_INLINE = `---
name: Inline Each
---

## walk
action: each
as: city
items:
  - Austin
  - Boston
steps:
  - name: note
    action: log
    message: "{{city}} ({{_index}}/{{_total}})"
`

// ── parseLoopFile ─────────────────────────────────────────────────────

test('parseLoopFile: front-matter + steps', () => {
  const schema = parseLoopFile(BASIC)
  assert.equal(schema.meta.name, 'Basic')
  assert.deepEqual(schema.steps.map(s => s.name), ['greet', 'announce'])
  assert.equal(schema.steps[0].action, 'set-variable')
})

test('parseLoopFile: rejects missing front-matter and empty loops', () => {
  assert.throws(() => parseLoopFile('no front matter'), /front-matter/)
  assert.throws(() => parseLoopFile('---\nname: X\n---\n'), /no steps/)
})

// ── describeLoop ──────────────────────────────────────────────────────

test('describe: step outputs, set-variable keys, and inputs are sources', () => {
  const d = describeLoop(BASIC)
  assert.equal(d.needsBrowser, false)
  assert.deepEqual(d.referencedVars, [])   // city (input), greeting (set-variable), greet (step)
  assert.deepEqual(d.inputs, { city: 'Austin' })
})

test('describe: card/stage vars are reported as required', () => {
  const d = describeLoop(STAGE_LOOP)
  assert.equal(d.needsBrowser, true)
  assert.equal(d.browserMode, 'extension')
  assert.equal(d.browserProfile, '{{profile}}')
  // profile & voice have input defaults; the rest must come from the runner
  assert.deepEqual(d.referencedVars, ['card-notes', 'card-title', 'decision', 'post-url'])
})

test('describe: browser requirement propagates through reachable deps only', () => {
  const withDep = describeLoop(PARENT, { 'child.loop': CHILD_BROWSER })
  assert.equal(withDep.needsBrowser, true)
  assert.equal(withDep.browserMode, 'cdp')
  assert.deepEqual(withDep.reachableDeps, ['child.loop'])

  // Same dep present but NOT referenced → no browser
  const unrelated = describeLoop(BASIC, { 'child.loop': CHILD_BROWSER })
  assert.equal(unrelated.needsBrowser, false)
  assert.deepEqual(unrelated.reachableDeps, [])
})

test('describe: each item aliases are implicit sources', () => {
  const d = describeLoop(EACH_INLINE)
  assert.deepEqual(d.referencedVars, [])
})

// ── run behavior: interpolation + vars ───────────────────────────────

class NullSession extends Session {
  async navigate() {}
  async click() {}
  async type() {}
  async key() {}
  async scroll() {}
  async screenshot() { return Buffer.alloc(0) }
  async destroy() {}
}

function writeLoop(content) {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-test-'))
  const file = join(dir, 'test.loop')
  writeFileSync(file, content)
  return file
}

test('run: vars flow into interpolation, provided vars beat defaults', async () => {
  const file = writeLoop(BASIC)
  const lines = []
  const loop = loadLoop(file)
  loop.on('log', e => lines.push(e.message))
  const log = await loop.run({ session: new NullSession('t1'), vars: { city: 'Denver' } })
  assert.equal(log.status, 'completed')
  assert.ok(lines.some(l => l.includes('hello from Denver / hello from Denver')), lines.join('\n'))
})

test('run: unresolved refs warn but keep the literal (engine-level behavior)', async () => {
  const file = writeLoop(`---
name: Warny
---

## announce
action: log
message: "value is {{nope}}"
`)
  const lines = []
  const loop = loadLoop(file)
  loop.on('log', e => lines.push(e.message))
  const log = await loop.run({ session: new NullSession('t2') })
  assert.equal(log.status, 'completed')
  assert.ok(lines.some(l => l.includes('unresolved {{nope}}')), lines.join('\n'))
})

test('run: checkpoint state round-trips step outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-test-'))
  const checkpointFile = join(dir, 'cp.json')
  const file = writeLoop(BASIC)
  const loop = loadLoop(file)
  const log = await loop.run({
    session: new NullSession('t3'),
    checkpointFile,
    keepCheckpointOnSuccess: true,
  })
  assert.equal(log.status, 'completed')
  const { readFileSync } = await import('node:fs')
  const cp = JSON.parse(readFileSync(checkpointFile, 'utf8'))
  assert.equal(cp.state.greeting, 'hello from Austin')
})
