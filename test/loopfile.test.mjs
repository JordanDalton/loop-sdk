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
  resolveModel, registerProvider, knownProviders, DEFAULT_PROVIDER,
  validateLoopSchema,
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

// ── model registry ────────────────────────────────────────────────────

// Minimal LanguageModelV3 stub (AI SDK 6) so we can drive the `agent` action
// end-to-end without any network or real provider package.
function stubModel(reply) {
  return {
    specificationVersion: 'v3',
    provider: 'stub',
    modelId: 'stub-model',
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: 'text', text: reply }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
    async doStream() { throw new Error('not implemented') },
  }
}

// An older-AI-SDK (V2 = AI SDK 5) model — used to prove the version guard fires.
function oldSpecModel() {
  return { specificationVersion: 'v2', provider: 'stub', modelId: 'old', async doGenerate() {}, async doStream() {} }
}

test('resolveModel: a wrong-AI-SDK-version model fails with an actionable error', async () => {
  await assert.rejects(() => resolveModel(oldSpecModel()), /AI SDK model spec "v2".*loop-sdk uses AI SDK 6/s)
})

test('resolveModel: a LanguageModel object passes through untouched', async () => {
  const model = stubModel('hi')
  assert.equal(await resolveModel(model), model)
})

test('resolveModel: unknown provider throws a directed error', async () => {
  await assert.rejects(
    () => resolveModel('nope:whatever'),
    /Unknown model provider "nope".*Known providers/s,
  )
})

test('resolveModel: a known-but-uninstalled provider names the npm package', async () => {
  // codex-cli provider is an optional peer, not installed in this repo
  await assert.rejects(
    () => resolveModel('codex:gpt-5-codex'),
    /npm i ai-sdk-provider-codex-cli/,
  )
})

test('resolveModel: a bare id routes to the default provider', async () => {
  assert.equal(DEFAULT_PROVIDER, 'claude-code')
  // Stub the default provider so this holds whether or not the real package is
  // installed: a bare "sonnet" (no prefix) must resolve through claude-code.
  let seen
  registerProvider('claude-code', (id) => { seen = id; return stubModel('ok') })
  await resolveModel('sonnet')
  assert.equal(seen, 'sonnet')
})

test('registerProvider: a custom provider becomes usable as a prefix', async () => {
  const model = stubModel('registered')
  registerProvider('stub', (id) => { assert.equal(id, 'my-model'); return model })
  assert.ok(knownProviders().includes('stub'))
  assert.equal(await resolveModel('stub:my-model'), model)
})

test('parseLoopFile: an agent step parses and its prompt/system refs are collected', () => {
  const src = `---
name: Agent Loop
---

## think
action: agent
model: "stub:my-model"
system: "You are {{persona}}."
prompt: "Summarize {{topic}}."
`
  const schema = parseLoopFile(src)
  assert.equal(schema.steps[0].action, 'agent')
  assert.equal(schema.steps[0].model, 'stub:my-model')
  const d = describeLoop(src)
  assert.ok(d.referencedVars.includes('persona'))
  assert.ok(d.referencedVars.includes('topic'))
})

test('agent action: runs via a registered provider, output flows downstream', async () => {
  registerProvider('stub', () => stubModel('the answer'))
  const dir = mkdtempSync(join(tmpdir(), 'sdk-test-'))
  const file = join(dir, 'agent.loop')
  writeFileSync(file, `---
name: Agent Run
---

## ask
action: agent
model: "stub:x"
prompt: "anything"

## echo
action: log
message: "GOT {{ask}}"
`)
  const lines = []
  const loop = loadLoop(file)
  loop.on('log', e => lines.push(e.message))
  const log = await loop.run({ session: new NullSession('agent-1') })
  assert.equal(log.status, 'completed')
  assert.ok(lines.some(l => l.includes('GOT the answer')), lines.join('\n'))
})

test('agent action: a missing model is caught at load time (fail fast)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-test-'))
  const file = join(dir, 'nomodel.loop')
  writeFileSync(file, `---
name: No Model
---

## ask
action: agent
prompt: "anything"
`)
  assert.throws(() => loadLoop(file), /requires a "model"/)
})

// ── subloop action (with `sub` back-compat alias) ─────────────────────

test('subloop action: runs a nested .loop and propagates its output; `sub` alias still works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-test-'))
  writeFileSync(join(dir, 'child.loop'), `---
name: Child
---

## make
action: set-variable
key: greeting
value: "hi {{who}}"
`)
  for (const action of ['subloop', 'sub']) {
    const parent = join(dir, `${action}-parent.loop`)
    writeFileSync(parent, `---
name: Parent ${action}
---

## call
action: ${action}
loop: ./child.loop
output: greeting
vars:
  who: world

## echo
action: log
message: "RESULT {{call}}"
`)
    const lines = []
    const loop = loadLoop(parent)
    loop.on('log', e => lines.push(e.message))
    const log = await loop.run({ session: new NullSession(`sl-${action}`) })
    assert.equal(log.status, 'completed', `${action} status`)
    assert.ok(lines.some(l => l.includes('RESULT hi world')), `${action}: ${lines.join(' | ')}`)
  }
})

// ── validateLoopSchema (load-time fail-fast) ──────────────────────────

test('validate: a clean schema returns no problems', () => {
  assert.deepEqual(validateLoopSchema(parseLoopFile(BASIC)), [])
})

test('validate: unknown action is rejected with a typo suggestion', () => {
  const problems = validateLoopSchema(parseLoopFile(`---
name: X
---

## go
action: claudeCLI
prompt: hi
`))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /unknown action "claudeCLI".*did you mean "claudeCli"/)
})

test('validate: a custom action passes when registered, fails when not', () => {
  const src = `---
name: X
---

## approve
action: approve
`
  assert.deepEqual(validateLoopSchema(parseLoopFile(src), ['approve']), [])
  assert.match(validateLoopSchema(parseLoopFile(src))[0], /unknown action "approve"/)
})

test('validate: un-referenceable and duplicate step names are flagged', () => {
  const problems = validateLoopSchema(parseLoopFile(`---
name: X
---

## Fetch Names
action: log
message: hi

## Fetch Names
action: log
message: bye
`))
  assert.ok(problems.some(p => /not referenceable.*kebab-case.*fetch-names/.test(p)), problems.join('\n'))
  assert.ok(problems.some(p => /duplicate step name "Fetch Names"/.test(p)), problems.join('\n'))
})

test('validate: missing required fields are reported (incl. or-groups)', () => {
  const problems = validateLoopSchema(parseLoopFile(`---
name: X
---

## a
action: claudeCli

## b
action: verify

## c
action: navigate
`))
  assert.ok(problems.some(p => /"a".*requires "prompt"/.test(p)), problems.join('\n'))
  assert.ok(problems.some(p => /"b".*requires "assert" or "prompt"/.test(p)), problems.join('\n'))
  assert.ok(problems.some(p => /"c".*requires "url" or "prompt"/.test(p)), problems.join('\n'))
})

test('validate: recurses into inline parallel/each steps', () => {
  const problems = validateLoopSchema(parseLoopFile(`---
name: X
---

## fan
action: parallel
steps:
  - name: ok-child
    action: log
    message: hi
  - name: bad child
    action: nope
`))
  assert.ok(problems.some(p => /inline step "bad child": name is not referenceable/.test(p)), problems.join('\n'))
  assert.ok(problems.some(p => /unknown action "nope"/.test(p)), problems.join('\n'))
})

test('validate: loadLoop throws an aggregated, readable error', () => {
  const file = writeLoop(`---
name: Broken
---

## go
action: nope
`)
  assert.throws(() => loadLoop(file), /Invalid \.loop file.*unknown action "nope"/s)
})

// ── subloop: inline steps (self-contained, no dependent file) ─────────

test('subloop action: runs inline steps with no dependent file', async () => {
  const file = writeLoop(`---
name: Inline Subloop
---

## group
action: subloop
vars:
  who: inline-world
steps:
  - name: build
    action: set-variable
    key: greeting
    value: "hi {{who}}"
output: greeting

## echo
action: log
message: "RESULT {{group}}"
`)
  const lines = []
  const loop = loadLoop(file)
  loop.on('log', e => lines.push(e.message))
  const log = await loop.run({ session: new NullSession('sl-inline') })
  assert.equal(log.status, 'completed')
  assert.ok(lines.some(l => l.includes('RESULT hi inline-world')), lines.join(' | '))
})

test('validate: subloop with neither loop nor steps is rejected; either alone passes', () => {
  const bad = validateLoopSchema(parseLoopFile(`---
name: X
---

## g
action: subloop
`))
  assert.ok(bad.some(p => /requires "loop" or "steps"/.test(p)), bad.join('\n'))

  const inline = validateLoopSchema(parseLoopFile(`---
name: X
---

## g
action: subloop
steps:
  - name: a
    action: log
    message: hi
`))
  assert.deepEqual(inline, [])
})

// ── subloop recursion guard: depth cap + cycle detection ──────────────

test('subloop guard: a circular loop: reference fails fast with a clear error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-'))
  writeFileSync(join(dir, 'A.loop'), `---\nname: A\n---\n\n## toB\naction: subloop\nloop: ./B.loop\n`)
  writeFileSync(join(dir, 'B.loop'), `---\nname: B\n---\n\n## toA\naction: subloop\nloop: ./A.loop\n`)
  const log = await loadLoop(join(dir, 'A.loop')).run({ session: new NullSession('cyc') })
  assert.equal(log.status, 'failed')
  const err = log.steps.map(s => s.error).find(Boolean) ?? ''
  assert.match(err, /subloop cycle detected/)
})

test('subloop guard: a self-referencing loop is caught', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-'))
  writeFileSync(join(dir, 'S.loop'), `---\nname: S\n---\n\n## again\naction: subloop\nloop: ./S.loop\n`)
  const log = await loadLoop(join(dir, 'S.loop')).run({ session: new NullSession('self') })
  assert.equal(log.status, 'failed')
  assert.match(log.steps.map(s => s.error).find(Boolean) ?? '', /cycle detected/)
})

test('subloop guard: unbounded inline recursion trips the depth cap', async () => {
  // A file whose only step is an each over a 1-item list running... itself.
  const dir = mkdtempSync(join(tmpdir(), 'deep-'))
  writeFileSync(join(dir, 'R.loop'), `---\nname: R\n---\n\n## rec\naction: subloop\nloop: ./R.loop\n`)
  const log = await loadLoop(join(dir, 'R.loop')).run({ session: new NullSession('deep') })
  assert.equal(log.status, 'failed')
  // self-reference is caught as a cycle before the depth cap, which is fine —
  // both are the "runaway recursion" class of error.
  assert.match(log.steps.map(s => s.error).find(Boolean) ?? '', /cycle detected|max subloop depth/)
})

test('subloop guard: legitimate nesting well within the cap still runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ok-'))
  // 3 chained files: L0 -> L1 -> L2 (leaf) — nowhere near MAX_SUBLOOP_DEPTH
  writeFileSync(join(dir, 'L2.loop'), `---\nname: L2\n---\n\n## leaf\naction: set-variable\nkey: deep\nvalue: reached\n`)
  writeFileSync(join(dir, 'L1.loop'), `---\nname: L1\n---\n\n## down\naction: subloop\nloop: ./L2.loop\noutput: deep\n`)
  writeFileSync(join(dir, 'L0.loop'), `---\nname: L0\n---\n\n## down\naction: subloop\nloop: ./L1.loop\noutput: down\n\n## echo\naction: log\nmessage: "GOT {{down}}"\n`)
  const lines = []
  const loop = loadLoop(join(dir, 'L0.loop'))
  loop.on('log', e => lines.push(e.message))
  const log = await loop.run({ session: new NullSession('ok') })
  assert.equal(log.status, 'completed')
  assert.ok(lines.some(l => l.includes('GOT reached')), lines.join(' | '))
})

// ── agent action: mcp servers + permission posture reach the provider ─

test('agent action: step mcp + explore mode reach the model as provider settings', async () => {
  let captured
  registerProvider('probe', (id, settings) => { captured = settings; return stubModel('ok') })
  const file = writeLoop(`---
name: MCP Wiring
---

## ask
action: agent
model: "probe:x"
mcp:
  jordan:
    type: http
    url: https://example.com/mcp
prompt: hi
`)
  const log = await loadLoop(file).run({ session: new NullSession('mcp-wire') })
  assert.equal(log.status, 'completed')
  assert.equal(captured?.mcpServers?.jordan?.url, 'https://example.com/mcp')
  // explore (default) → frictionless so MCP tool calls aren't blocked
  assert.equal(captured?.permissionMode, 'bypassPermissions')
})

test('agent action: strict mode enforces an allowlist instead of bypassing', async () => {
  let captured
  registerProvider('probe', (id, settings) => { captured = settings; return stubModel('ok') })
  const file = writeLoop(`---
name: MCP Strict
mode: strict
tools: [mcp__jordan__get-services]
---

## ask
action: agent
model: "probe:x"
mcp:
  jordan:
    type: http
    url: https://example.com/mcp
prompt: hi
`)
  const log = await loadLoop(file).run({ session: new NullSession('mcp-strict') })
  assert.equal(log.status, 'completed')
  assert.equal(captured?.permissionMode, 'default')
  assert.deepEqual(captured?.allowedTools, ['mcp__jordan__get-services'])
})
