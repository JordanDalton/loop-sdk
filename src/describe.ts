import { parseLoopFile, type LoopFileSchema, type LoopFileStep } from './loopfile.js'
import type { McpSpec } from './mcp-registry.js'

/**
 * Static analysis of a .loop file — everything a runner needs to know BEFORE
 * executing: session requirements, capabilities, and which {{vars}} must be
 * supplied. Replaces runners' ad-hoc regex scans of loop text.
 */

export interface LoopDescription {
  name: string
  /** The entry loop or any reachable sub-loop declares `session: browser`. */
  needsBrowser: boolean
  /** Resolved browser flavor: fresh launch, CDP attach, or the user's Chrome via extension. */
  browserMode: 'launch' | 'cdp' | 'extension'
  /** Raw value — may contain {{vars}} for the runner to resolve per run. */
  browserProfile?: string
  cdpUrl?: string
  mcp?: McpSpec
  /** Declared inputs (front-matter `vars:` block) and their defaults. */
  inputs: Record<string, string>
  stepNames: string[]
  /**
   * {{refs}} used by this loop's steps that have NO local source — not a step
   * output, not a set-variable key, not a declared input, not an each-item
   * alias. The runner must supply these at run time (card vars, trigger vars,
   * webhook payload…) or refuse the run.
   */
  referencedVars: string[]
  /** Dep keys (e.g. "helper.loop") reachable from the entry loop via sub/each refs, transitively. */
  reachableDeps: string[]
}

// Step fields that are identifiers or file refs, never {{templates}}
const NON_TEMPLATE_FIELDS = new Set([
  'name', 'action', 'as', 'output', 'loop', 'key', 'channel',
  'retryBackoff', 'onError', 'model',
])

// Vars every each-iteration provides implicitly
const EACH_IMPLICIT = ['item', '_index', '_total']

const normalizeDepKey = (ref: string) => ref.replace(/^\.\//, '').trim()

function collectRefs(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\{\{([\w-]+)\}\}/g)) into.add(m[1])
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, into)
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectRefs(v, into)
  }
}

function walkSteps(
  steps: LoopFileStep[],
  refs: Set<string>,
  sources: Set<string>,
  insideEach: boolean,
): void {
  for (const step of steps) {
    sources.add(step.name)
    if (step.action === 'set-variable' && step.key) sources.add(step.key)
    if (step.action === 'each') {
      sources.add(step.as ?? 'item')
      for (const v of EACH_IMPLICIT) sources.add(v)
    }
    for (const [field, value] of Object.entries(step)) {
      if (NON_TEMPLATE_FIELDS.has(field) || field === 'steps') continue
      collectRefs(value, refs)
    }
    if (step.steps?.length) walkSteps(step.steps, refs, sources, insideEach || step.action === 'each')
  }
}

function loopRefsOf(steps: LoopFileStep[]): string[] {
  const out: string[] = []
  for (const step of steps) {
    if (typeof step.loop === 'string' && step.loop.trim()) out.push(normalizeDepKey(step.loop))
    if (step.steps?.length) out.push(...loopRefsOf(step.steps))
  }
  return out
}

const modeOf = (m: string | undefined): 'cdp' | 'extension' | null =>
  m === 'chrome' ? 'cdp' : m === 'extension' ? 'extension' : null

/**
 * Describe a loop from its content plus the dep map runners already carry
 * (dep key → .loop content). Dep parsing failures are ignored — a broken dep
 * fails at run time with its own error, not here.
 */
export function describeLoop(content: string, deps: Record<string, string> = {}): LoopDescription {
  const schema = parseLoopFile(content)
  return describeSchema(schema, deps)
}

export function describeSchema(schema: LoopFileSchema, deps: Record<string, string> = {}): LoopDescription {
  // Reachable deps: transitive closure over sub/each `loop:` refs
  const depSchemas = new Map<string, LoopFileSchema>()
  const reachable: string[] = []
  const queue = loopRefsOf(schema.steps)
  while (queue.length) {
    const key = queue.shift()!
    if (depSchemas.has(key) || !(key in deps)) continue
    try {
      const depSchema = parseLoopFile(deps[key])
      depSchemas.set(key, depSchema)
      reachable.push(key)
      queue.push(...loopRefsOf(depSchema.steps))
    } catch { /* broken dep — its own run-time problem */ }
  }

  const all = [schema, ...depSchemas.values()]
  const needsBrowser = all.some(s => s.meta.session === 'browser')
  const browserMode =
    modeOf(schema.meta.browserMode) ??
    all.map(s => modeOf(s.meta.browserMode)).find(Boolean) ??
    'launch'

  const metaVars = (schema.meta as unknown as { vars?: Record<string, unknown> }).vars
  const inputs: Record<string, string> = {}
  if (metaVars && typeof metaVars === 'object') {
    for (const [k, v] of Object.entries(metaVars)) inputs[k] = String(v ?? '')
  }

  // Refs vs sources — only the ENTRY loop's steps are validated; sub-loops
  // inherit the parent context and are too dynamic to judge statically.
  const refs = new Set<string>()
  const sources = new Set<string>(Object.keys(inputs))
  walkSteps(schema.steps, refs, sources, false)
  collectRefs(schema.meta.browserProfile, refs)

  const referencedVars = [...refs].filter(r => !sources.has(r)).sort()

  return {
    name: schema.meta.name,
    needsBrowser,
    browserMode,
    browserProfile: schema.meta.browserProfile,
    cdpUrl: schema.meta.cdpUrl,
    mcp: schema.meta.mcp,
    inputs,
    stepNames: schema.steps.map(s => s.name),
    referencedVars,
    reachableDeps: reachable,
  }
}
