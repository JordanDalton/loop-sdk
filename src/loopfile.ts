import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { Loop } from './loop.js'
import { ensureWorktree } from './worktree.js'
import { resolveMcpServers, type McpSpec } from './mcp-registry.js'
import { claudeCli } from './claude-cli.js'
import { codexCli } from './codex-cli.js'
import { notifyOn, sendIMessage } from './notify.js'
import type { Context } from './context.js'
import type { Session } from './session.js'
import type { RunOptions, RunLog, RunHandle } from './loop.js'

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * A deterministic output contract for a step. Either a shorthand keyword or an
 * object combining checks (all declared checks must pass).
 */
export type ExpectContract =
  | 'json'
  | 'non-empty'
  | 'nonempty'
  | {
      /** Output must parse as JSON. */
      json?: boolean
      /** Output (trimmed) must be non-empty. */
      nonEmpty?: boolean
      /** Output must contain this substring. */
      contains?: string
      /** Output must match this regular expression (JS syntax). */
      matches?: string
    }

export interface LoopFileMeta {
  name: string
  /** Informational — tells the runner what session type to expect. */
  session?: string
  /** Browser flavor: 'isolated' (fresh Chrome, default) or 'chrome' (attach to the user's real Chrome over CDP). */
  browserMode?: string
  /** CDP endpoint for browserMode: chrome. Default: http://localhost:9222 */
  cdpUrl?: string
  /**
   * Chrome profile for the run's browser (interpreted by the runner):
   * extension mode — the label of the profile whose extension should host the
   * tabs; isolated mode — a named persistent profile whose logins survive
   * across runs (~/.loopdeloop/profiles/<name>).
   */
  browserProfile?: string
  /** Default model for claudeCli/agent steps. */
  model?: string
  /**
   * Enforcement posture:
   *  - 'explore' (default): frictionless — worker steps run with permissions
   *    skipped unless a step declares its own `tools:` allowlist.
   *  - 'strict': every worker step is scoped to an allowlist (its own `tools:`,
   *    the loop-level `tools:`, or a conservative default) and unlisted tools
   *    are denied. Right for unattended, side-effectful runs.
   * When unset, auto-escalates to 'strict' for loops that ship hard-to-reverse
   * changes (worktree, onSuccess: merge|pr); set it explicitly to override.
   */
  mode?: 'explore' | 'strict'
  /** Default tool allowlist for claudeCli/verify steps (a step's own `tools:` overrides). */
  tools?: string[]
  /** Default working directory for claudeCli/verify steps (a repo path makes them build workers). */
  workdir?: string
  /**
   * Isolate this run's file changes in a git worktree. The workdir must be
   * inside a git repo; each run gets its own branch (loop/<name>-<id>) and
   * worktree, so parallel runs against the same repo never collide.
   */
  worktree?: boolean
  /**
   * What the runner should do with the run's worktree branch after a
   * SUCCESSFUL run: 'keep' (default), 'merge' back into the source branch,
   * or 'pr' (push + open a pull request). Informational — enforced by the
   * runner (sidecar), not the SDK.
   */
  onSuccess?: 'keep' | 'merge' | 'pr'
  /**
   * MCP servers for claudeCli/verify steps: a list of names resolved from
   * ~/.loopdeloop/mcp.json, or inline server definitions. This is how loops
   * gain capabilities beyond the built-in step types.
   */
  mcp?: McpSpec
  /**
   * When a verify step fails and the step before it is a prompt step,
   * retry that step ONCE with the judge's critique appended, then verify
   * again. Default: true. Set false to fail immediately.
   */
  reflexion?: boolean
}

export interface LoopFileStep {
  name: string
  /**
   * Built-in actions: claudeCli | codexCli | verify | send | navigate | click | type | key | scroll | screenshot | wait | log | set-variable | sub | each | parallel
   * Custom: any string key registered in the actions map passed to loadLoop()
   */
  action: string

  // ── claudeCli / agent
  /** Prompt text. Supports {{step-name}} interpolation. */
  prompt?: string
  /** Assertion for verify steps. Supports {{step-name}} interpolation. */
  assert?: string
  /** Model override for this step. */
  model?: string
  /** Attach a screenshot of the current browser state to the prompt. */
  screenshot?: boolean
  /** Cap on agentic turns for this step (claude --max-turns). */
  maxSteps?: number
  /** Working directory override for this step's claude subprocess. Supports {{refs}}. */
  workdir?: string
  /**
   * Restrict this worker step to these tools (Claude Code names, e.g. Read,
   * Bash, mcp__browser). Declaring an allowlist ENFORCES it regardless of mode.
   */
  tools?: string[]
  /**
   * Deterministic output contract — a HARD gate checked in code AFTER the step
   * runs, against the step's output. Shorthand strings 'json' | 'non-empty', or
   * an object { json, nonEmpty, contains, matches }. If it doesn't hold the step
   * fails (and a following verify's reflexion can retry a prompt step). Runs for
   * ANY action that produces output — provider-agnostic, not just claudeCli.
   */
  expect?: ExpectContract
  /** MCP servers override for this step (registry names or inline defs). */
  mcp?: McpSpec

  // ── navigate
  /** URL for navigate steps. Supports {{step-name}} interpolation. */
  url?: string

  // ── log
  /** Message for log steps. Supports {{step-name}} interpolation. */
  message?: string

  // ── wait
  /** Milliseconds to pause. Default: 1000. */
  ms?: number

  // ── send
  /** Delivery channel: 'imessage' (default) or 'ntfy'. */
  channel?: string
  /** iMessage recipient — your own phone number or Apple ID email. */
  to?: string
  /** ntfy.sh topic to publish to. */
  topic?: string
  /** Notification title (ntfy). */
  title?: string

  // ── set-variable / key
  /** Variable name (set-variable) or keyboard key to press (key). */
  key?: string
  /** Value to store. Supports {{step-name}} interpolation. */
  value?: string

  // ── click / type
  /** CSS selector to click. Supports {{step-name}} interpolation. */
  selector?: string
  /** Element text to click, or text to type. Supports {{step-name}} interpolation. */
  text?: string
  /** Click coordinates. */
  x?: number
  y?: number

  // ── scroll
  /** Vertical scroll amount in px. Default: 300. */
  deltaY?: number

  // ── sub
  /** Path to another .loop file to run as a nested sub-loop. */
  loop?: string
  /** Extra vars to pass into the sub-loop context. */
  vars?: Record<string, unknown>

  // ── each
  /**
   * Items to iterate over. Either a {{step-name}} reference (resolves from ctx)
   * or a literal YAML array.
   */
  items?: string | unknown[]
  /** Variable name for the current item inside each iteration. Default: 'item'. */
  as?: string
  /** Inline step definitions for each iteration (alternative to referencing a loop file). */
  steps?: LoopFileStep[]
  /** Which child step's output to collect (each: per iteration; sub: as this step's output). Defaults to the last step. */
  output?: string
  /** If true, each continues past failed items instead of aborting. */
  continueOnError?: boolean
  /** Run up to N items at once (1-8, default 1). Parallel items get isolated state. */
  concurrency?: number

  // ── error handling
  retries?: number
  retryDelay?: number
  retryBackoff?: 'flat' | 'linear' | 'exponential'
  skipOnError?: boolean
  /** 'skip' is shorthand for skipOnError: true */
  onError?: 'skip' | string
}

export interface LoopFileSchema {
  meta: LoopFileMeta
  steps: LoopFileStep[]
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseLoopFile(content: string): LoopFileSchema {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error('.loop file must begin with a YAML front-matter block (---)')

  const meta = yaml.load(match[1]) as LoopFileMeta
  if (!meta?.name) throw new Error('.loop front-matter must include a "name" field')

  const body = match[2]
  const sections = body.split(/\n(?=## )/).map(s => s.trim()).filter(Boolean)
  const steps: LoopFileStep[] = []

  for (const section of sections) {
    const lines = section.split('\n')
    const name = lines[0].replace(/^##\s*/, '').trim()
    const rest = lines.slice(1).join('\n').trim()
    if (!rest) throw new Error(`Step "${name}" has no configuration`)

    const stepConfig = yaml.load(rest) as Omit<LoopFileStep, 'name'>
    if (!stepConfig?.action) throw new Error(`Step "${name}" must have an "action" field`)

    steps.push({ name, ...stepConfig })
  }

  if (steps.length === 0) throw new Error('.loop file has no steps defined')
  return { meta, steps }
}

export function loadLoopFile(filePath: string): LoopFileSchema {
  const content = fs.readFileSync(filePath, 'utf8')
  return parseLoopFile(content)
}

// ── Builder ───────────────────────────────────────────────────────────────────

export type ActionRegistry = Record<string, (ctx: Context, step: LoopFileStep) => Promise<unknown>>

/**
 * Runtime overlay — behavior tweaks the RUNNER decides per run, without
 * rewriting loop source. Applies to the entry loop and every sub-loop.
 */
export interface LoadOptions {
  /** Cap agentic turns for claudeCli/verify steps (⚗ test runs). */
  maxTurnsCap?: number
  /** Skip the loop's notify config (⚗ test runs shouldn't ping the user's phone). */
  skipNotify?: boolean
}

/**
 * Load a .loop file and return a configured Loop instance ready to run.
 *
 * Built-in actions: claudeCli, codexCli, verify, send, navigate, click, type, key, scroll, screenshot, wait, log, set-variable, sub, each, parallel
 * Pass `actions` to register custom action handlers.
 */
export function loadLoop(filePath: string, actions: ActionRegistry = {}, loadOpts: LoadOptions = {}): Loop {
  const schema = loadLoopFile(filePath)
  const basePath = path.dirname(path.resolve(filePath))
  const loop = buildLoopFromSteps(schema.meta.name, schema.steps, schema.meta, basePath, actions, loadOpts)

  // Front-matter `vars:` are the loop's declared input defaults — apply them
  // even when the host passes no vars (they lose to any provided value)
  const metaVars = (schema.meta as unknown as Record<string, unknown>).vars
  if (metaVars && typeof metaVars === 'object') {
    loop.defaults(metaVars as Record<string, unknown>)
  }

  // Auto-apply notify config so sub-loops honor their own notification settings
  const n = (schema.meta as unknown as Record<string, unknown>).notify as Record<string, unknown> | undefined
  if (n && !loadOpts.skipNotify) {
    notifyOn(loop, {
      title:       schema.meta.name ?? loop.name,
      onStart:     Boolean(n.onStart     ?? false),
      onComplete:  Boolean(n.onComplete  ?? true),
      onError:     Boolean(n.onError     ?? true),
      onStepError: Boolean(n.onStepError ?? false),
      sound:       Boolean(n.sound       ?? false),
    })
  }

  return loop
}

/**
 * Load and run a .loop file in one call.
 *
 * @example
 * await runFile('./research.loop', new PlaywrightSession('run-1'))
 */
export async function runFile(
  filePath: string,
  session: Session,
  opts: Omit<RunOptions, 'session'> = {},
  actions: ActionRegistry = {}
): Promise<RunLog> {
  const loop = loadLoop(filePath, actions)
  return loop.run({ session, ...opts })
}

/**
 * Load and run a .loop file in the background, returning a RunHandle immediately.
 *
 * @example
 * const handle = runFileBackground('./research.loop', session)
 * const handle2 = runFileBackground('./report.loop', session2)
 *
 * const [log1, log2] = await Promise.all([handle.wait(), handle2.wait()])
 */
export function runFileBackground(
  filePath: string,
  session: Session,
  opts: Omit<RunOptions, 'session'> = {},
  actions: ActionRegistry = {}
): RunHandle {
  const loop = loadLoop(filePath, actions)
  return loop.runBackground({ session, ...opts })
}

// ── Internal builders ─────────────────────────────────────────────────────────

const REFLEXION_TYPES = ['claudeCli', 'codexCli']

function buildLoopFromSteps(
  name: string,
  steps: LoopFileStep[],
  meta: LoopFileMeta,
  basePath: string,
  actions: ActionRegistry,
  loadOpts: LoadOptions = {}
): Loop {
  const loop = new Loop(name)
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    let fn = buildStepFn(step, meta, basePath, actions, loadOpts)

    // Reflexion: a failed verify gives the preceding prompt step ONE shot
    // at fixing its output with the judge's critique, then judges again.
    const prev = i > 0 ? steps[i - 1] : null
    if (
      step.action === 'verify' &&
      meta.reflexion !== false &&
      prev && REFLEXION_TYPES.includes(prev.action) && prev.prompt
    ) {
      const verifyFn = fn
      const prevStep = prev
      fn = async (ctx: Context) => {
        try {
          await verifyFn(ctx)
        } catch (err) {
          const critique = (err instanceof Error ? err.message : String(err))
            .replace(/^claude reported:\s*/i, '')
          if (ctx.signal?.aborted) throw err
          ctx.log(`⚖ verify failed — retrying "${prevStep.name}" with the critique`)
          const revised: LoopFileStep = {
            ...prevStep,
            prompt: `${prevStep.prompt}\n\nIMPORTANT: your previous attempt was rejected by a verifier with this feedback — correct the problem:\n${critique}`,
          }
          await buildStepFn(revised, meta, basePath, actions, loadOpts)(ctx)
          await verifyFn(ctx)   // a second rejection fails the run for real
        }
      }
    }

    loop.step(
      step.name,
      fn,
      {
        retries: step.retries,
        retryDelay: step.retryDelay,
        retryBackoff: step.retryBackoff,
        skipOnError: step.skipOnError || step.onError === 'skip',
      }
    )
  }
  return loop
}

function buildStepFn(
  step: LoopFileStep,
  meta: LoopFileMeta,
  basePath: string,
  actions: ActionRegistry,
  loadOpts: LoadOptions = {}
) {
  // Test runs cap agentic turns without touching the loop's source
  const capTurns = (turns: number | undefined, fallback?: number): number | undefined => {
    const base = turns ?? fallback
    const cap = loadOpts.maxTurnsCap
    if (!cap) return base
    return Math.min(base ?? cap, cap)
  }

  return async (ctx: Context): Promise<void> => {
    switch (step.action) {

      case 'claudeCli': {
        if (!step.prompt) throw new Error(`Step "${step.name}": claudeCli requires a prompt`)
        const prompt = interpolate(step.prompt, ctx)
        const result = await claudeCli(ctx, prompt, {
          model: step.model ?? meta.model,
          screenshot: step.screenshot === true,
          maxTurns: capTurns(step.maxSteps),
          cwd: resolveWorkdir(step, meta, ctx),
          mcpServers: resolveMcpServers(step.mcp ?? meta.mcp),
          tools: resolveTools(step, meta),
          enforce: resolveMode(meta) === 'strict',
        })
        ctx.set(step.name, result.output)
        break
      }

      case 'codexCli': {
        if (!step.prompt) throw new Error(`Step "${step.name}": codexCli requires a prompt`)
        const prompt = interpolate(step.prompt, ctx)
        // No meta.model fallback — meta.model is a Claude id; codex has its own default
        const result = await codexCli(ctx, prompt, {
          model: step.model,
          cwd: resolveWorkdir(step, meta, ctx),
        })
        ctx.set(step.name, result.output)
        break
      }

      // ── verify: an AI judge checks an assertion; failure fails the step ────
      case 'verify': {
        const assertion = interpolate(step.assert ?? step.prompt ?? '', ctx)
        if (!assertion) throw new Error(`Step "${step.name}": verify requires an "assert" field`)
        const prompt = `You are a strict verifier for an automation run.

Assertion to verify (values in it were already filled in from prior steps):
"${assertion}"

How to judge:
- If the assertion is self-contained (it compares concrete values that are visible right in the text), judge it directly from the text — do not look for external sources.
- Only if it refers to the CURRENT state of a web page, and you have browser tools, read the current page (browser_read_page / browser_screenshot). NEVER navigate to a different URL — judge the page as it is.
- Be strict: if the assertion does not hold, or genuinely cannot be evaluated, it fails.

Reply with ONE sentence stating the observed value versus what the assertion expected.
If the assertion does not hold, your RESULT line must be exactly: failed — expected <expected>, got <observed>.`
        const result = await claudeCli(ctx, prompt, {
          model: step.model ?? meta.model,
          screenshot: step.screenshot === true,
          maxTurns: capTurns(step.maxSteps, 10),
          cwd: resolveWorkdir(step, meta, ctx),
          mcpServers: resolveMcpServers(step.mcp ?? meta.mcp),
          tools: resolveTools(step, meta),
          enforce: resolveMode(meta) === 'strict',
        })
        ctx.set(step.name, result.output)
        break
      }

      case 'navigate': {
        const url = interpolate(step.url ?? step.prompt ?? '', ctx)
        if (!url) throw new Error(`Step "${step.name}": navigate requires a url or prompt`)
        await ctx.navigate(url)
        // Record the resolved URL — referenceable downstream and lets runners
        // restore browser state when resuming from a checkpoint.
        ctx.set(step.name, url)
        break
      }

      case 'screenshot': {
        const buf = await ctx.screenshot()
        ctx.set(step.name, buf)
        break
      }

      case 'log': {
        const msg = interpolate(step.message ?? step.prompt ?? '', ctx)
        ctx.log(msg)
        break
      }

      // ── send: push a message to the user's phone ───────────────────────────
      case 'send': {
        // Typed "\n" almost always means "newline" in a message to a human
        const message = interpolate(step.message ?? step.prompt ?? '', ctx).replace(/\\n/g, '\n')
        if (!message) throw new Error(`Step "${step.name}": send requires a "message"`)
        const channel = step.channel ?? 'imessage'

        if (channel === 'imessage') {
          await sendIMessage(message, interpolate(step.to ?? '', ctx))
          ctx.log(`📱 sent iMessage to ${step.to}`)
        } else if (channel === 'ntfy') {
          if (!step.topic) throw new Error(`Step "${step.name}": ntfy requires a "topic"`)
          const res = await fetch(`https://ntfy.sh/${encodeURIComponent(step.topic)}`, {
            method: 'POST',
            body: message,
            headers: { Title: interpolate(step.title ?? meta.name ?? 'LoopDeLoop', ctx) },
          })
          if (!res.ok) throw new Error(`ntfy publish failed: HTTP ${res.status}`)
          ctx.log(`📱 pushed to ntfy.sh/${step.topic}`)
        } else {
          throw new Error(`Step "${step.name}": unknown send channel "${channel}"`)
        }
        ctx.set(step.name, message)
        break
      }

      case 'wait': {
        const ms = Number(step.ms) || 1000
        ctx.log(`wait ${ms}ms`)
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(done, ms)
          function done() { ctx.signal?.removeEventListener('abort', onAbort); resolve() }
          function onAbort() { clearTimeout(t); reject(new Error('cancelled')) }
          ctx.signal?.addEventListener('abort', onAbort, { once: true })
        })
        break
      }

      case 'set-variable': {
        if (!step.key) throw new Error(`Step "${step.name}": set-variable requires a "key"`)
        const value = interpolate(String(step.value ?? ''), ctx)
        ctx.set(step.key, value)
        // Every step's output is referenceable by its NAME — set-variable
        // included ({{my-step}} and {{my-key}} both resolve)
        if (step.name !== step.key) ctx.set(step.name, value)
        break
      }

      case 'click': {
        await ctx.click({
          selector: step.selector ? interpolate(step.selector, ctx) : undefined,
          text: step.text ? interpolate(step.text, ctx) : undefined,
          x: step.x,
          y: step.y,
        })
        break
      }

      case 'type': {
        await ctx.type(interpolate(step.text ?? '', ctx))
        break
      }

      case 'key': {
        if (!step.key) throw new Error(`Step "${step.name}": key requires a "key"`)
        await ctx.key(step.key)
        break
      }

      case 'scroll': {
        await ctx.scroll({ deltaY: step.deltaY ?? 300 })
        break
      }

      // ── parallel: run inline steps concurrently, wait for all ─────────────
      case 'parallel': {
        if (!step.steps?.length) {
          throw new Error(`Step "${step.name}": parallel requires inline "steps"`)
        }

        await Promise.all(
          step.steps.map(subStep => buildStepFn(subStep, meta, basePath, actions, loadOpts)(ctx))
        )
        break
      }

      // ── sub: run a .loop file as a nested step, sharing context ────────────
      case 'sub': {
        if (!step.loop) throw new Error(`Step "${step.name}": sub requires a "loop" file path`)
        const loopPath = path.resolve(basePath, step.loop)
        const subSchema = loadLoopFile(loopPath)
        const subLoop = loadLoop(loopPath, actions, loadOpts)
        // Resolve any {{ref}} in var values from the parent context before forking
        const resolvedVars: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(step.vars ?? {})) {
          resolvedVars[k] = typeof v === 'string' ? interpolate(v, ctx) : v
        }
        const childCtx = ctx.fork(resolvedVars)
        await subLoop.runWith(childCtx)
        // Propagate the child's result so {{step-name}} works downstream.
        // Defaults to the child's last step output; override with "output: <step>".
        const outputStep = step.output ?? subSchema.steps[subSchema.steps.length - 1].name
        const result = childCtx.get(outputStep)
        if (result !== undefined) ctx.set(step.name, result)
        break
      }

      // ── each: iterate over items, run a loop per item ───────────────────────
      case 'each': {
        const items = resolveItems(step, ctx)
        const asVar = step.as ?? 'item'

        // Build the per-item loop (file reference or inline steps)
        let itemLoop: Loop
        let lastStepName: string

        if (step.loop) {
          const loopPath = path.resolve(basePath, step.loop)
          const schema = loadLoopFile(loopPath)
          itemLoop = loadLoop(loopPath, actions, loadOpts)
          lastStepName = step.output ?? schema.steps[schema.steps.length - 1].name
        } else if (step.steps?.length) {
          itemLoop = buildLoopFromSteps(`${step.name}-each`, step.steps, meta, basePath, actions, loadOpts)
          lastStepName = step.output ?? step.steps[step.steps.length - 1].name
        } else {
          throw new Error(`Step "${step.name}": each requires a "loop" file path or inline "steps"`)
        }

        // Iterate — collect each item's output into an array.
        // With concurrency > 1, a worker pool runs items in parallel; each
        // item gets an isolated state fork so outputs can't cross-contaminate.
        const concurrency = Math.min(Math.max(Number(step.concurrency) || 1, 1), 8)
        const results: unknown[] = new Array(items.length).fill(null)

        if (concurrency === 1) {
          for (let i = 0; i < items.length; i++) {
            const childCtx = ctx.fork({ [asVar]: items[i], _index: i, _total: items.length })
            try {
              await itemLoop.runWith(childCtx)
              results[i] = childCtx.get(lastStepName)
            } catch (err) {
              if (!step.continueOnError) throw err
              const msg = err instanceof Error ? err.message : String(err)
              ctx.log(`each[${i}]: failed — ${msg}`)
            }
          }
        } else {
          ctx.log(`each: ${items.length} items, ${concurrency} at a time`)
          let nextIndex = 0
          let firstErr: Error | null = null
          const worker = async (): Promise<void> => {
            for (;;) {
              if (ctx.signal?.aborted) return
              if (firstErr && !step.continueOnError) return
              const i = nextIndex++
              if (i >= items.length) return
              // Give the lane its own session (e.g. browser tab) when supported
              const laneSession = ctx.session.clone
                ? await ctx.session.clone(`${ctx.session.id}-lane-${i}`)
                : null
              const childCtx = ctx.fork(
                { [asVar]: items[i], _index: i, _total: items.length },
                laneSession,
                { isolateState: true }
              )
              try {
                await itemLoop.runWith(childCtx)
                results[i] = childCtx.get(lastStepName)
              } catch (err) {
                const e = err instanceof Error ? err : new Error(String(err))
                if (!step.continueOnError) { firstErr ??= e }
                else ctx.log(`each[${i}]: failed — ${e.message}`)
              } finally {
                await laneSession?.destroy().catch(() => {})
              }
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
          )
          if (firstErr && !step.continueOnError) throw firstErr
        }

        ctx.set(step.name, results)
        break
      }

      default: {
        const handler = actions[step.action]
        if (!handler) {
          throw new Error(`Step "${step.name}": unknown action "${step.action}". Register it in the actions map passed to loadLoop().`)
        }
        const result = await handler(ctx, step)
        if (result !== undefined) ctx.set(step.name, result)
        break
      }
    }

    // Deterministic output gate — enforced in code, after the step ran, for
    // whatever the step wrote as its output. Provider-agnostic by design.
    if (step.expect !== undefined) {
      validateOutput(step.name, ctx.get(step.name), step.expect)
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Effective enforcement posture. Explicit `mode:` always wins; otherwise
 * auto-escalate to strict for loops that ship hard-to-reverse changes.
 */
export function resolveMode(meta: LoopFileMeta): 'explore' | 'strict' {
  if (meta.mode === 'strict' || meta.mode === 'explore') return meta.mode
  if (meta.worktree || meta.onSuccess === 'pr' || meta.onSuccess === 'merge') return 'strict'
  return 'explore'
}

/** A step's tool allowlist: its own `tools:`, else the loop default, else none. */
function resolveTools(step: LoopFileStep, meta: LoopFileMeta): string[] {
  return step.tools ?? meta.tools ?? []
}

function normalizeExpect(
  expect: ExpectContract,
  stepName: string
): { json?: boolean; nonEmpty?: boolean; contains?: string; matches?: string } {
  if (typeof expect === 'string') {
    const kw = expect.trim().toLowerCase()
    if (kw === 'json') return { json: true }
    if (kw === 'non-empty' || kw === 'nonempty') return { nonEmpty: true }
    throw new Error(
      `Step "${stepName}": unknown expect "${expect}" — use "json", "non-empty", or an object { json, nonEmpty, contains, matches }`
    )
  }
  return expect
}

/** Check a step's output against its declared contract; throw (fail the step) if it doesn't hold. */
export function validateOutput(stepName: string, output: unknown, expect: ExpectContract): void {
  const checks = normalizeExpect(expect, stepName)
  const text =
    output == null ? ''
    : typeof output === 'string' ? output
    : output instanceof Uint8Array ? ''
    : JSON.stringify(output)
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 80)
  const fail = (reason: string): never => {
    throw new Error(`Step "${stepName}": output contract failed — ${reason} (got: ${preview || '<empty>'})`)
  }
  if (checks.nonEmpty && !text.trim()) fail('expected non-empty output')
  if (checks.json) {
    try { JSON.parse(text.trim()) } catch { fail('expected valid JSON') }
  }
  if (checks.contains && !text.includes(checks.contains)) fail(`expected output to contain "${checks.contains}"`)
  if (checks.matches) {
    let re: RegExp
    try { re = new RegExp(checks.matches) }
    catch { throw new Error(`Step "${stepName}": invalid expect.matches regex /${checks.matches}/`) }
    if (!re.test(text)) fail(`expected output to match /${checks.matches}/`)
  }
}

function resolveItems(step: LoopFileStep, ctx: Context): unknown[] {
  const raw = step.items

  if (Array.isArray(raw)) return raw

  if (typeof raw === 'string') {
    const refMatch = raw.match(/^\{\{([\w-]+)\}\}$/)

    if (refMatch) {
      const key = refMatch[1]
      // Prior step outputs first, then loop inputs/vars — same order as interpolate()
      const val = ctx.get(key) ?? ctx.vars[key]

      if (Array.isArray(val)) return val

      if (typeof val === 'string') {
        const trimmed = val.trim()
        // claudeCli often returns JSON arrays as strings — auto-parse
        if (trimmed.startsWith('[')) {
          try { return JSON.parse(trimmed) } catch {}
        }
        // Plain text: one item per non-empty line (a single line = one item)
        const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean)
        if (lines.length) return lines
      }

      throw new Error(
        `each "${step.name}": "{{${key}}}" must resolve to an array, JSON array string, or text (got ${typeof val})`
      )
    }

    // Literal string: interpolate refs, then one item per non-empty line
    const lines = interpolate(raw, ctx).split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length) return lines
  }

  throw new Error(`Step "${step.name}": each requires an "items" field ({{step-name}} reference or YAML array)`)
}

function resolveWorkdir(step: LoopFileStep, meta: LoopFileMeta, ctx: Context): string | undefined {
  const raw = step.workdir ?? meta.workdir
  if (!raw) return undefined
  const resolved = interpolate(raw, ctx).replace(/^~(?=\/|$)/, os.homedir())
  if (meta.worktree) return ensureWorktree(ctx, resolved, meta.name)
  return resolved
}

function interpolate(template: unknown, ctx: Context): string {
  // YAML happily parses unquoted scalars as numbers/booleans — never assume string
  const out = String(template ?? '').replace(/\{\{([\w-]+)\}\}/g, (_, key) => {
    // Check state first (prior step outputs), then vars (per-iteration values from fork())
    const val = ctx.get(key) ?? ctx.vars[key]
    if (val == null) return `{{${key}}}`
    // Never inline binary data (screenshots) into prompts/messages
    if (val instanceof Uint8Array) return `[binary ${val.length} bytes]`
    return typeof val === 'object' ? JSON.stringify(val) : String(val)
  })
  // A ref that resolved to nothing is almost always a typo'd step/input name —
  // don't fail (braces can be intentional), but say so loudly
  const unresolved = out.match(/\{\{[\w-]+\}\}/g)
  if (unresolved) {
    ctx.log(`⚠ unresolved ${[...new Set(unresolved)].join(', ')} — no step or input has that name`)
  }
  return out
}
