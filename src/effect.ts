import type { Context } from './context.js'
import type { EffectRecord } from './checkpoint.js'

export interface EffectOptions<T = unknown> {
  /**
   * A stable key for this external operation. Pass this key to the downstream
   * API when it supports idempotency so an interrupted request is safe to retry.
   */
  key: string | ((ctx: Context) => string)
  /** Optional rollback for Loop.effect() when run with compensateOnError. */
  compensate?: EffectCompensation<T>
}

export type EffectFn<T> = (ctx: Context, key: string) => Promise<T>
export type EffectCompensation<T> = (result: T, ctx: Context, key: string) => Promise<void>

/**
 * Run a checkpoint-backed, idempotent side effect.
 *
 * The "started" record is checkpointed before calling fn. If the process dies
 * while fn is in flight, a resumed run calls fn again with the same key. Once
 * fn succeeds, its result is checkpointed immediately and later calls return
 * that result without invoking fn.
 */
export async function effect<T>(
  ctx: Context,
  name: string,
  fn: EffectFn<T>,
  { key: keyOption }: EffectOptions<T>
): Promise<T> {
  const key = typeof keyOption === 'function' ? keyOption(ctx) : keyOption
  if (!key) throw new Error(`Effect "${name}" requires a non-empty idempotency key`)

  const existing = ctx._effects.get(key)
  if (existing?.status === 'completed') {
    ctx.set(name, existing.result)
    return existing.result as T
  }

  const now = new Date().toISOString()
  const record: EffectRecord = existing ?? { name, status: 'started', startedAt: now }
  ctx._effects.set(key, record)
  ctx.saveCheckpointIfConfigured()

  const result = await fn(ctx, key)
  record.status = 'completed'
  record.completedAt = new Date().toISOString()
  record.result = result
  ctx.set(name, result)
  ctx.saveCheckpointIfConfigured()
  return result
}
