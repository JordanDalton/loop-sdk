import type { Plugin } from '../loop.js'

export interface RetryPluginOptions {
  /**
   * Total number of attempts per step (including the first).
   * e.g. attempts: 3 means 1 initial + 2 retries. Default: 3.
   */
  attempts?: number
  /** Milliseconds to wait before each retry. Default: 1000. */
  delay?: number
  /**
   * How to scale the delay across retry attempts.
   * - 'flat'        — same delay every time
   * - 'linear'      — delay * attempt  (1x, 2x, 3x …)
   * - 'exponential' — delay * 2^attempt  (1x, 2x, 4x …)
   * Default: 'flat'
   */
  backoff?: 'flat' | 'linear' | 'exponential'
  /** Only retry if this predicate returns true. Default: always retry. */
  retryIf?: (err: Error) => boolean
}

/**
 * Global retry plugin — retries every failing step up to `attempts` times.
 *
 * For per-step retry control, use the `retries` / `retryDelay` / `retryBackoff`
 * options on `loop.step()` instead. Both can coexist: step-level retries run
 * first, then the plugin gets a chance if the step is still failing.
 *
 * @example
 * import { RetryPlugin } from 'loop-sdk/plugins'
 *
 * loop.use(RetryPlugin({ attempts: 3, delay: 1000, backoff: 'exponential' }))
 *
 * // Only retry network errors:
 * loop.use(RetryPlugin({
 *   attempts: 5,
 *   delay: 2000,
 *   retryIf: (err) => err.message.includes('fetch failed'),
 * }))
 */
export function RetryPlugin(opts: RetryPluginOptions = {}): Plugin {
  const maxAttempts = opts.attempts ?? 3
  const delay = opts.delay ?? 1000
  const backoff = opts.backoff ?? 'flat'
  const retryIf = opts.retryIf ?? (() => true)

  // Track per-step attempt counts across retries
  const counts = new Map<string, number>()

  return {
    name: 'retry',
    hooks: {
      onStepError: async (err, step, ctx) => {
        if (!retryIf(err)) return false

        const attempt = counts.get(step.name) ?? 0
        if (attempt >= maxAttempts - 1) {
          counts.delete(step.name)
          return false
        }

        counts.set(step.name, attempt + 1)

        const wait =
          backoff === 'exponential' ? delay * Math.pow(2, attempt) :
          backoff === 'linear'      ? delay * (attempt + 1) :
                                      delay

        const label = `attempt ${attempt + 2}/${maxAttempts}`
        ctx.log(
          wait > 0
            ? `[retry] "${step.name}" — retrying in ${wait}ms (${label})`
            : `[retry] "${step.name}" — retrying (${label})`
        )
        if (wait > 0) await new Promise(r => setTimeout(r, wait))

        return true
      },
    },
  }
}
