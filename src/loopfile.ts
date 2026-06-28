import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { Loop } from './loop.js'
import { claudeCli } from './claude-cli.js'
import { notifyOn } from './notify.js'
import type { Context } from './context.js'
import type { Session } from './session.js'
import type { RunOptions, RunLog, RunHandle } from './loop.js'

// ── Schema ────────────────────────────────────────────────────────────────────

export interface LoopFileMeta {
  name: string
  /** Informational — tells the runner what session type to expect. */
  session?: string
  /** Default model for claudeCli/agent steps. */
  model?: string
}

export interface LoopFileStep {
  name: string
  /**
   * Built-in actions: claudeCli | navigate | screenshot | log | sub | each
   * Custom: any string key registered in the actions map passed to loadLoop()
   */
  action: string

  // ── claudeCli / agent
  /** Prompt text. Supports {{step-name}} interpolation. */
  prompt?: string
  /** Model override for this step. */
  model?: string

  // ── navigate
  /** URL for navigate steps. Supports {{step-name}} interpolation. */
  url?: string

  // ── log
  /** Message for log steps. Supports {{step-name}} interpolation. */
  message?: string

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
  /** Which step's output to collect per iteration. Defaults to the last step. */
  output?: string
  /** If true, each continues past failed items instead of aborting. */
  continueOnError?: boolean

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
 * Load a .loop file and return a configured Loop instance ready to run.
 *
 * Built-in actions: claudeCli, navigate, screenshot, log, sub, each
 * Pass `actions` to register custom action handlers.
 */
export function loadLoop(filePath: string, actions: ActionRegistry = {}): Loop {
  const schema = loadLoopFile(filePath)
  const basePath = path.dirname(path.resolve(filePath))
  const loop = buildLoopFromSteps(schema.meta.name, schema.steps, schema.meta, basePath, actions)

  // Auto-apply notify config so sub-loops honor their own notification settings
  const n = (schema.meta as unknown as Record<string, unknown>).notify as Record<string, unknown> | undefined
  if (n) {
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

function buildLoopFromSteps(
  name: string,
  steps: LoopFileStep[],
  meta: LoopFileMeta,
  basePath: string,
  actions: ActionRegistry
): Loop {
  const loop = new Loop(name)
  for (const step of steps) {
    loop.step(
      step.name,
      buildStepFn(step, meta, basePath, actions),
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
  actions: ActionRegistry
) {
  return async (ctx: Context): Promise<void> => {
    switch (step.action) {

      case 'claudeCli': {
        if (!step.prompt) throw new Error(`Step "${step.name}": claudeCli requires a prompt`)
        const prompt = interpolate(step.prompt, ctx)
        const result = await claudeCli(ctx, prompt, { model: step.model ?? meta.model })
        ctx.set(step.name, result.output)
        break
      }

      case 'navigate': {
        const url = interpolate(step.url ?? step.prompt ?? '', ctx)
        if (!url) throw new Error(`Step "${step.name}": navigate requires a url or prompt`)
        await ctx.navigate(url)
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

      // ── parallel: run inline steps concurrently, wait for all ─────────────
      case 'parallel': {
        if (!step.steps?.length) {
          throw new Error(`Step "${step.name}": parallel requires inline "steps"`)
        }

        await Promise.all(
          step.steps.map(subStep => buildStepFn(subStep, meta, basePath, actions)(ctx))
        )
        break
      }

      // ── sub: run a .loop file as a nested step, sharing context ────────────
      case 'sub': {
        if (!step.loop) throw new Error(`Step "${step.name}": sub requires a "loop" file path`)
        const loopPath = path.resolve(basePath, step.loop)
        const subLoop = loadLoop(loopPath, actions)
        // Resolve any {{ref}} in var values from the parent context before forking
        const resolvedVars: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(step.vars ?? {})) {
          resolvedVars[k] = typeof v === 'string' ? interpolate(v, ctx) : v
        }
        const childCtx = ctx.fork(resolvedVars)
        await subLoop.runWith(childCtx)
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
          itemLoop = loadLoop(loopPath, actions)
          lastStepName = step.output ?? schema.steps[schema.steps.length - 1].name
        } else if (step.steps?.length) {
          itemLoop = buildLoopFromSteps(`${step.name}-each`, step.steps, meta, basePath, actions)
          lastStepName = step.output ?? step.steps[step.steps.length - 1].name
        } else {
          throw new Error(`Step "${step.name}": each requires a "loop" file path or inline "steps"`)
        }

        // Iterate — collect each item's output into an array
        const results: unknown[] = []

        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          const childCtx = ctx.fork({ [asVar]: item, _index: i, _total: items.length })

          try {
            await itemLoop.runWith(childCtx)
            results.push(childCtx.get(lastStepName))
          } catch (err) {
            if (!step.continueOnError) throw err
            const msg = err instanceof Error ? err.message : String(err)
            ctx.log(`each[${i}]: failed — ${msg}`)
            results.push(null)
          }
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
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveItems(step: LoopFileStep, ctx: Context): unknown[] {
  const raw = step.items

  if (Array.isArray(raw)) return raw

  if (typeof raw === 'string') {
    const refMatch = raw.match(/^\{\{([\w-]+)\}\}$/)
    const key = refMatch ? refMatch[1] : raw
    const val = ctx.get(key)

    if (Array.isArray(val)) return val

    // claudeCli often returns JSON arrays as strings — auto-parse
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed) } catch {}
      }
    }

    throw new Error(
      `each "${step.name}": "{{${key}}}" must be an array or a JSON array string (got ${typeof val})`
    )
  }

  throw new Error(`Step "${step.name}": each requires an "items" field ({{step-name}} reference or YAML array)`)
}

function interpolate(template: string, ctx: Context): string {
  return template.replace(/\{\{([\w-]+)\}\}/g, (_, key) => {
    // Check state first (prior step outputs), then vars (per-iteration values from fork())
    const val = ctx.get(key) ?? ctx.vars[key]
    if (val == null) return `{{${key}}}`
    return typeof val === 'object' ? JSON.stringify(val) : String(val)
  })
}
