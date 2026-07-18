import type { Context } from './context.js'
import type { WaitRecord } from './checkpoint.js'
import { effect } from './effect.js'

/**
 * Thrown by waitFor() to unwind the current run when a wait key has no
 * delivered payload yet. Caught specially by Loop.run()/runWith() — it is
 * not a step failure, so it bypasses retries, onError, and skipOnError.
 */
export class SuspendSignal extends Error {
  readonly key: string
  constructor(key: string) {
    super(`loop suspended — waiting for delivery on key "${key}"`)
    this.name = 'SuspendSignal'
    this.key = key
  }
}

/** Thrown by waitFor() when `timeout` elapses before the key is delivered. */
export class WaitTimeoutError extends Error {
  readonly key: string
  constructor(key: string, timeoutMs: number) {
    super(`wait "${key}" timed out after ${timeoutMs}ms without delivery`)
    this.name = 'WaitTimeoutError'
    this.key = key
  }
}

export interface SuspendOptions<T = unknown> {
  /**
   * A stable key identifying this wait. Whoever will deliver the result
   * (a webhook handler, another process, a human approval flow) calls
   * Loop.deliver(checkpointFile, key, payload) with this same key.
   */
  key: string | ((ctx: Context) => string)
  /**
   * Milliseconds since the wait started. Checked on each resume attempt —
   * there is no background timer, so a stale wait is only caught the next
   * time something tries to resume it. Throws WaitTimeoutError, which flows
   * through the step's normal retries/onError/skipOnError like any other
   * step failure.
   */
  timeout?: number
}

export type DispatchFn = (ctx: Context, key: string) => Promise<void>

/**
 * Suspend the run until an external caller delivers a value for `key`.
 *
 * `dispatch`, if given, fires the external async operation exactly once —
 * it's wrapped in effect() so a resumed run never re-dispatches. Pass `null`
 * when the external operation was already triggered elsewhere and this step
 * only needs to wait.
 */
export async function waitFor<T = unknown>(
  ctx: Context,
  name: string,
  dispatch: DispatchFn | null,
  { key: keyOption, timeout }: SuspendOptions<T>
): Promise<T> {
  const key = typeof keyOption === 'function' ? keyOption(ctx) : keyOption
  if (!key) throw new Error(`suspend "${name}" requires a non-empty wait key`)

  if (dispatch) {
    await effect(ctx, `${name}:dispatch`, (c, k) => dispatch(c, k), { key })
  }

  const wait = ctx._waits.get(key)

  if (wait?.status === 'delivered') {
    ctx._waits.delete(key)
    ctx.set(name, wait.payload)
    return wait.payload as T
  }

  if (wait?.status === 'pending' && timeout != null) {
    const elapsed = Date.now() - new Date(wait.startedAt).getTime()
    if (elapsed > timeout) throw new WaitTimeoutError(key, timeout)
  }

  if (!wait) {
    const record: WaitRecord = { step: name, status: 'pending', startedAt: new Date().toISOString() }
    ctx._waits.set(key, record)
  }

  throw new SuspendSignal(key)
}
