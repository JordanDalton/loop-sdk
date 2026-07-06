import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  parseLoopFile, describeLoop, loadLoop, Session,
  buildPermissionArgs, STRICT_DEFAULT_TOOLS, resolveMode,
  codexMcpArgs,
} from '../dist/index.js'

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

// ── enforcement: tool policy ──────────────────────────────────────────

test('buildPermissionArgs: explore default skips permissions (frictionless)', () => {
  assert.deepEqual(buildPermissionArgs([], false, false), ['--dangerously-skip-permissions'])
})

test('buildPermissionArgs: declaring tools always enforces, even in explore', () => {
  const args = buildPermissionArgs(['Read', 'Grep'], false, false)
  assert.deepEqual(args, ['--allowedTools', 'Read,Grep'])
  assert.ok(!args.includes('--dangerously-skip-permissions'))
})

test('buildPermissionArgs: strict with no declared tools enforces the default allowlist', () => {
  const args = buildPermissionArgs([], true, false)
  assert.equal(args[0], '--allowedTools')
  assert.equal(args[1], STRICT_DEFAULT_TOOLS.join(','))
})

test('buildPermissionArgs: a browser session adds the browser MCP server when enforced', () => {
  assert.deepEqual(buildPermissionArgs(['Read'], false, true), ['--allowedTools', 'Read,mcp__browser'])
  // ...but not when unenforced (frictionless path never lists tools)
  assert.deepEqual(buildPermissionArgs([], false, true), ['--dangerously-skip-permissions'])
})

// ── codex: MCP server → -c config overrides ───────────────────────────

test('codexMcpArgs: none → no args', () => {
  assert.deepEqual(codexMcpArgs(undefined), [])
  assert.deepEqual(codexMcpArgs({}), [])
})

test('codexMcpArgs: stdio server → command/args/env overrides', () => {
  const args = codexMcpArgs({
    github: { command: 'npx', args: ['-y', '@mcp/github'], env: { TOKEN: 'abc' } },
  })
  assert.deepEqual(args, [
    '-c', 'mcp_servers.github.command="npx"',
    '-c', 'mcp_servers.github.args=["-y", "@mcp/github"]',
    '-c', 'mcp_servers.github.env.TOKEN="abc"',
  ])
})

test('codexMcpArgs: HTTP server → url override', () => {
  assert.deepEqual(codexMcpArgs({ search: { type: 'http', url: 'http://localhost:1234/mcp' } }), [
    '-c', 'mcp_servers.search.url="http://localhost:1234/mcp"',
  ])
})

// ── enforcement: mode + auto-escalation ───────────────────────────────

test('resolveMode: default explore, explicit wins, side-effects auto-escalate', () => {
  assert.equal(resolveMode({ name: 'a' }), 'explore')
  assert.equal(resolveMode({ name: 'a', worktree: true }), 'strict')
  assert.equal(resolveMode({ name: 'a', onSuccess: 'pr' }), 'strict')
  assert.equal(resolveMode({ name: 'a', onSuccess: 'merge' }), 'strict')
  // explicit explore overrides the auto-escalation
  assert.equal(resolveMode({ name: 'a', worktree: true, mode: 'explore' }), 'explore')
})

test('describe: reports effective mode incl. escalation', () => {
  assert.equal(describeLoop(BASIC).mode, 'explore')
  const escalated = describeLoop(`---
name: Ship
worktree: true
workdir: /tmp
---

## build
action: claudeCli
prompt: do the thing
`)
  assert.equal(escalated.mode, 'strict')
})

// ── enforcement: output contract gate ─────────────────────────────────

function expectLoop(value, expect) {
  return `---
name: Contract
---

## produce
action: set-variable
key: out
value: ${JSON.stringify(value)}
expect: ${expect}
`
}

test('run: expect json fails the step on non-JSON output', async () => {
  const file = writeLoop(expectLoop('not json at all', 'json'))
  const log = await loadLoop(file).run({ session: new NullSession('c1') })
  assert.equal(log.status, 'failed')
})

test('run: expect json passes on valid JSON output', async () => {
  const file = writeLoop(expectLoop('{"ok":true}', 'json'))
  const log = await loadLoop(file).run({ session: new NullSession('c2') })
  assert.equal(log.status, 'completed')
})

test('run: expect contains gates on substring', async () => {
  const pass = await loadLoop(writeLoop(`---
name: C
---

## produce
action: set-variable
key: out
value: "hello world"
expect:
  contains: world
`)).run({ session: new NullSession('c3') })
  assert.equal(pass.status, 'completed')

  const fail = await loadLoop(writeLoop(`---
name: C
---

## produce
action: set-variable
key: out
value: "hello there"
expect:
  contains: world
`)).run({ session: new NullSession('c4') })
  assert.equal(fail.status, 'failed')
})

// ── CLI: `loop-sdk run <file>` ─────────────────────────────────────────

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

test('cli: runs a browserless loop and exits 0', () => {
  const file = writeLoop(`---
name: cli-test
---

## g
action: set-variable
key: k
value: ok

## show
action: log
message: "val {{k}}"
`)
  const r = spawnSync('node', [CLI, 'run', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /val ok/)
})

test('cli: refuses a browser loop with a clear message', () => {
  const file = writeLoop(`---
name: b
session: browser
---

## open
action: navigate
url: https://example.com
`)
  const r = spawnSync('node', [CLI, 'run', file], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /session: browser/)
})

test('cli: --json emits a parseable run log to stdout', () => {
  const file = writeLoop(`---
name: j
---

## g
action: set-variable
key: k
value: yo
`)
  const r = spawnSync('node', [CLI, 'run', file, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const log = JSON.parse(r.stdout)
  assert.equal(log.status, 'completed')
  assert.deepEqual(log.steps.map((s) => s.name), ['g'])
})

test('cli: install skill copies SKILL.md and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-install-'))
  const r = spawnSync('node', [CLI, 'install', 'skill'], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(existsSync(join(dir, '.claude/skills/loop-sdk/SKILL.md')))
  // re-running without --force is a successful no-op
  const again = spawnSync('node', [CLI, 'install', 'skill'], { cwd: dir, encoding: 'utf8' })
  assert.equal(again.status, 0)
  assert.match(again.stdout, /already installed/)
})

test('cli: fails fast when a referenced var has no source', () => {
  const file = writeLoop(`---
name: nv
---

## show
action: log
message: "hi {{topic}}"
`)
  const r = spawnSync('node', [CLI, 'run', file], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /topic/)
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
