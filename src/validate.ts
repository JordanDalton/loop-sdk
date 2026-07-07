import type { LoopFileSchema, LoopFileStep, LoopFileMeta } from './loopfile.js'

/**
 * The actions the engine handles natively (the `switch` in loopfile.ts is the
 * runtime source of truth; this set mirrors it for load-time validation).
 * `sub` is the deprecated alias of `subloop`.
 */
export const BUILTIN_ACTIONS: readonly string[] = [
  'claudeCli', 'codexCli', 'agent', 'verify',
  'send', 'navigate', 'click', 'type', 'key', 'scroll', 'screenshot',
  'wait', 'log', 'set-variable', 'subloop', 'sub', 'each', 'parallel',
]

/** A step name is only reachable via {{name}} when it's word-chars and hyphens. */
const REFERENCEABLE = /^[\w-]+$/

/**
 * Required fields per built-in action — the ones whose absence is always a bug.
 * Each entry lists field-groups; a group passes if ANY field in it is present,
 * so `['assert', 'prompt']` means "assert or prompt". Actions absent here (wait,
 * screenshot, click, …) have no hard requirement. Custom actions are never
 * checked — their handler decides what it needs.
 */
const REQUIRED: Record<string, string[][]> = {
  claudeCli: [['prompt']],
  codexCli: [['prompt']],
  agent: [['prompt']],
  verify: [['assert', 'prompt']],
  navigate: [['url', 'prompt']],
  log: [['message', 'prompt']],
  send: [['message', 'prompt']],
  'set-variable': [['key']],
  key: [['key']],
  subloop: [['loop']],
  sub: [['loop']],
  each: [['items'], ['loop', 'steps']],
  parallel: [['steps']],
}

const has = (step: LoopFileStep, field: string): boolean => {
  const v = (step as unknown as Record<string, unknown>)[field]
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')
}

/**
 * Validate a parsed .loop schema, returning a list of human-readable problems
 * (empty = valid). Catches the format's silent/late failure modes BEFORE a run
 * starts: unknown actions, un-referenceable or duplicate step names, and
 * missing required fields — recursively through inline `steps`.
 *
 * @param customActions names registered via the `actions` map — treated as known.
 */
export function validateLoopSchema(
  schema: LoopFileSchema,
  customActions: readonly string[] = [],
): string[] {
  const errors: string[] = []
  const known = new Set([...BUILTIN_ACTIONS, ...customActions])

  if (!schema.meta?.name) errors.push('front-matter is missing a "name" field')

  walk(schema.steps, schema.meta, known, customActions, errors, 'step')
  return errors
}

function walk(
  steps: LoopFileStep[],
  meta: LoopFileMeta,
  known: Set<string>,
  customActions: readonly string[],
  errors: string[],
  scope: string,
): void {
  const seen = new Set<string>()

  for (const step of steps) {
    const where = `${scope} "${step.name}"`

    if (!step.name || !step.name.trim()) {
      errors.push(`a ${scope} is missing a name`)
    } else {
      if (seen.has(step.name)) {
        errors.push(`duplicate ${scope} name "${step.name}" — names must be unique (later output clobbers earlier)`)
      }
      seen.add(step.name)
      if (!REFERENCEABLE.test(step.name)) {
        errors.push(`${where}: name is not referenceable via {{...}} — use kebab-case (letters, digits, hyphens), e.g. "${toKebab(step.name)}"`)
      }
    }

    if (!step.action) {
      errors.push(`${where}: missing an "action"`)
      continue
    }
    const isCustom = customActions.includes(step.action)
    if (!known.has(step.action)) {
      errors.push(`${where}: unknown action "${step.action}"${suggest(step.action, known)}`)
      continue
    }

    // Only built-ins have known required fields; custom handlers read their own.
    if (!isCustom) {
      for (const group of REQUIRED[step.action] ?? []) {
        if (!group.some(f => has(step, f))) {
          const label = group.length === 1 ? `"${group[0]}"` : group.map(f => `"${f}"`).join(' or ')
          errors.push(`${where}: action "${step.action}" requires ${label}`)
        }
      }
      // agent needs a model somewhere (step or meta) to resolve a provider.
      if (step.action === 'agent' && !has(step, 'model') && !meta.model) {
        errors.push(`${where}: agent requires a "model" on the step or a default "model" in front-matter (e.g. "claude-code:sonnet")`)
      }
    }

    if (step.steps?.length) {
      walk(step.steps, meta, known, customActions, errors, `${scope} > inline step`)
    }
  }
}

function toKebab(name: string): string {
  return name.trim().toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'step'
}

/** Suggest the closest known action for a likely typo (edit distance ≤ 2). */
function suggest(action: string, known: Set<string>): string {
  let best: string | null = null
  let bestDist = 3
  for (const candidate of known) {
    const d = editDistance(action.toLowerCase(), candidate.toLowerCase())
    if (d < bestDist) { bestDist = d; best = candidate }
  }
  return best ? ` — did you mean "${best}"?` : ''
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}
