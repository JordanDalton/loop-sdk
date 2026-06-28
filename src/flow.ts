import type { Context } from './context.js'
import type { Loop } from './loop.js'

export type Item = string | { type: string; subtypes?: string[] }

export interface EachOptions {
  continueOnError?: boolean
}

/**
 * each — iterate over a list of items, running a step function for each one.
 *
 * Each item receives a forked Context with per-item vars merged in:
 *   ctx.vars.item    — the item value
 *   ctx.vars.subtype — the subtype (if applicable)
 *
 * @example
 * await each(ctx, ['https://a.com', 'https://b.com'], async (ctx) => {
 *   await ctx.navigate(ctx.vars.item as string)
 *   await agent(ctx, 'Summarize this page.', { model })
 * })
 */
export async function each(
  ctx: Context,
  items: Item[],
  fn: (ctx: Context) => Promise<unknown>,
  { continueOnError = false }: EachOptions = {}
): Promise<void> {
  const pairs = expandItems(items)

  for (const vars of pairs) {
    const label = vars.subtype ? `${vars.item} / ${vars.subtype}` : vars.item
    const childCtx = ctx.fork(vars)

    try {
      await fn(childCtx)
    } catch (err) {
      if (!continueOnError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      ctx.log(`each: "${label}" failed — ${msg}`)
    }
  }
}

/**
 * sub — run a Loop instance as a sub-step, sharing the current session.
 *
 * @example
 * const loginLoop = new Loop('login')
 * loginLoop.step('auth', async (ctx) => { ... })
 *
 * loop.step('login', async (ctx) => {
 *   await sub(ctx, loginLoop, { loginUrl: '/login', username: 'admin' })
 * })
 */
export async function sub(
  ctx: Context,
  loop: Loop,
  vars: Record<string, unknown> = {}
): Promise<void> {
  const childCtx = ctx.fork(vars)
  return loop.runWith(childCtx)
}

// ── internal ─────────────────────────────────────────────────────────────────

interface ItemPair {
  item: string
  subtype?: string
  [key: string]: unknown
}

function expandItems(items: Item[]): ItemPair[] {
  const pairs: ItemPair[] = []
  for (const entry of items) {
    if (typeof entry === 'string') {
      pairs.push({ item: entry })
    } else if (entry.subtypes?.length) {
      for (const subtype of entry.subtypes) {
        pairs.push({ item: entry.type, subtype })
      }
    } else {
      pairs.push({ item: entry.type })
    }
  }
  return pairs
}
