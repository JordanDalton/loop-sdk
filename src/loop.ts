import { Context } from './context.js'
import { Logger, type RunStatus } from './logger.js'
import type { Session } from './session.js'
import {
  readCheckpoint,
  writeCheckpoint,
  deleteCheckpoint,
  checkpointExists,
  type Checkpoint,
} from './checkpoint.js'
import { Emitter, type LoopEvents } from './events.js'

export type StepFn = (ctx: Context) => Promise<unknown>

export interface StepOptions {
  /**
   * Run this function if the step fails (after all retries are exhausted).
   * If the fallback succeeds, the loop continues rather than aborting.
   *
   * @example
   * loop.step('fetch-live', fetchLive, {
   *   onError: async (err, ctx) => {
   *     ctx.set('data', FALLBACK_DATA)
   *   }
   * })
   */
  onError?: (err: Error, ctx: Context) => Promise<unknown>

  /**
   * Skip this step on failure and continue the loop instead of aborting.
   * The step is recorded as 'skipped' in the run log.
   *
   * @example
   * loop.step('post-metrics', postMetrics, { skipOnError: true })
   */
  skipOnError?: boolean

  /**
   * Retry the step this many additional times before giving up.
   * Combined with retryDelay / retryBackoff for pacing.
   *
   * @example
   * loop.step('call-api', callApi, { retries: 3, retryDelay: 500, retryBackoff: 'exponential' })
   */
  retries?: number

  /** Milliseconds to wait before the first retry. Default: 0. */
  retryDelay?: number

  /**
   * How to scale the delay across retry attempts.
   * - 'flat'        — same delay every time
   * - 'linear'      — delay * attempt  (1x, 2x, 3x …)
   * - 'exponential' — delay * 2^attempt  (1x, 2x, 4x …)
   *
   * Default: 'flat'
   */
  retryBackoff?: 'flat' | 'linear' | 'exponential'
}

export interface Plugin {
  name: string
  hooks?: {
    /**
     * Called when a step throws. Return true to signal that the error was
     * handled and the step should be retried once.
     */
    onStepError?: (
      err: Error,
      step: { name: string; index: number },
      ctx: Context
    ) => Promise<boolean | void>
  }
}

export type HandleStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'paused'

/**
 * A handle to a loop running in the background via loop.runBackground().
 *
 * @example
 * const handle = loop.runBackground({ session })
 *
 * handle.status           // 'running'
 * await handle.wait()     // resolves when done
 * handle.cancel()         // stop — state discarded
 * handle.pause()          // stop — state saved for resume
 * handle.resume()         // returns a new handle for the continued run
 */
export interface RunHandle {
  readonly id: string
  readonly status: HandleStatus
  /** Resolves with the RunLog on completion/cancellation. Rejects on unrecovered step failure. */
  wait(): Promise<RunLog>
  /** Stop after the current step finishes. State is discarded — cannot be resumed. */
  cancel(): void
  /** Stop after the current step finishes. State is saved — resume with handle.resume(). */
  pause(): void
  /**
   * Resume a paused loop from the last completed step.
   * Returns a new RunHandle for the continued run.
   * Throws if the handle is not in 'paused' state.
   */
  resume(): RunHandle
}

export interface RunOptions {
  session: Session
  vars?: Record<string, unknown>
  logDir?: string | null
  startAt?: number | null
  stopAt?: number | null
  /** AbortSignal to cancel the loop between steps. Use loop.runBackground() for a managed handle. */
  signal?: AbortSignal | null
  checkpointFile?: string | null
  resumeFrom?: string | null
  keepCheckpointOnSuccess?: boolean
  /**
   * Called when the loop fails — after all step-level retries, fallbacks, and
   * plugin hooks are exhausted. Use for cleanup, alerting, or partial saves.
   *
   * Errors thrown inside onError are swallowed so they don't mask the original failure.
   *
   * @example
   * loop.run({
   *   session,
   *   onError: async (err, ctx, failedStep) => {
   *     await slack.send(`Loop failed at "${failedStep}": ${err.message}`)
   *     await ctx.get('partialResults')?.save()
   *   }
   * })
   */
  onError?: (err: Error, ctx: Context, failedStep: string) => Promise<void>
}

export interface StepResult {
  name: string
  status: 'ok' | 'error' | 'skipped' | 'recovered'
  error?: string
}

export interface RunLog {
  loop: string
  session: string
  startedAt: string
  finishedAt: string
  status: RunStatus
  resumedFrom?: string
  steps: StepResult[]
}

type KnownListener<K extends keyof LoopEvents> = (data: LoopEvents[K]) => void | Promise<void>
type AnyListener = (data: unknown) => void | Promise<void>

export class Loop {
  readonly name: string
  private readonly _steps: Array<{ name: string; fn: StepFn; opts: StepOptions }>
  private readonly _plugins: Plugin[]
  private readonly _emitter: Emitter
  private _defaultVars: Record<string, unknown> = {}

  constructor(name: string) {
    this.name = name
    this._steps = []
    this._plugins = []
    this._emitter = new Emitter()
  }

  /**
   * Default vars merged UNDER run-time vars — loadLoop() seeds these from the
   * .loop front-matter `vars:` block, so declared input defaults apply even
   * when the host passes nothing.
   */
  defaults(vars: Record<string, unknown>): this {
    this._defaultVars = { ...this._defaultVars, ...vars }
    return this
  }

  step(name: string, fn: StepFn, opts: StepOptions = {}): this {
    this._steps.push({ name, fn, opts })
    return this
  }

  /**
   * Add a parallel step — all named functions run concurrently.
   * The step only completes when every sub-step resolves.
   * Each sub-step's return value is stored in ctx under its name.
   *
   * @example
   * loop.parallel('gather', {
   *   'fetch-prices':  async (ctx) => { ctx.set('fetch-prices', await getPrice()) },
   *   'fetch-reviews': async (ctx) => { ctx.set('fetch-reviews', await getReviews()) },
   * })
   *
   * loop.step('summarize', async (ctx) => {
   *   const prices  = ctx.get('fetch-prices')
   *   const reviews = ctx.get('fetch-reviews')
   * })
   */
  parallel(name: string, fns: Record<string, StepFn>, opts: StepOptions = {}): this {
    const parallelFn: StepFn = async (ctx) => {
      await Promise.all(
        Object.entries(fns).map(async ([subName, fn]) => {
          const result = await fn(ctx)
          if (result !== undefined) ctx.set(subName, result)
        })
      )
    }
    this._steps.push({ name, fn: parallelFn, opts })
    return this
  }

  /**
   * Run multiple loops concurrently and return all results.
   *
   * @example
   * const logs = await Loop.runAll([
   *   { loop: researchLoop, session: sessionA },
   *   { loop: reportLoop,   session: sessionB },
   * ])
   */
  static async runAll(jobs: Array<{ loop: Loop } & RunOptions>): Promise<RunLog[]> {
    const handles = jobs.map(({ loop, ...opts }) => loop.runBackground(opts as RunOptions))
    return Promise.all(handles.map(h => h.wait()))
  }

  use(plugin: Plugin): this {
    this._plugins.push(plugin)
    return this
  }

  on<K extends keyof LoopEvents>(event: K, listener: KnownListener<K>): this
  on(event: string, listener: AnyListener): this
  on(event: string, listener: AnyListener): this {
    this._emitter.on(event, listener)
    return this
  }

  off<K extends keyof LoopEvents>(event: K, listener: KnownListener<K>): this
  off(event: string, listener: AnyListener): this
  off(event: string, listener: AnyListener): this {
    this._emitter.off(event, listener)
    return this
  }

  /** Run steps against an existing Context — used by sub() and each(). */
  async runWith(ctx: Context): Promise<void> {
    const loopStartMs = Date.now()
    let stepsCompleted = 0
    let loopStatus: 'completed' | 'failed' | 'cancelled' = 'completed'
    await this._emitter.emit('loop:start', {
      loop: this.name, session: ctx.session.id, totalSteps: this._steps.length,
    })
    try {
      for (let i = 0; i < this._steps.length; i++) {
        const { name, fn, opts } = this._steps[i]
        const startMs = Date.now()
        process.stdout.write(`  [${i + 1}/${this._steps.length}] ${name} ... `)
        await this._emitter.emit('step:start', { loop: this.name, step: name, index: i, total: this._steps.length })
        try {
          await fn(ctx)
          console.log('ok')
          ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... ok`)
          stepsCompleted++
          await this._emitter.emit('step:complete', { loop: this.name, step: name, index: i, durationMs: Date.now() - startMs })
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          console.log(`ERROR: ${error.message}`)
          ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... ERROR: ${error.message}`)
          await this._emitter.emit('step:error', { loop: this.name, step: name, index: i, error, durationMs: Date.now() - startMs })
          const recovered = await this._runErrorHooks(error, { name, index: i }, ctx)
          if (recovered) { i--; continue }
          loopStatus = 'failed'
          throw error
        }
      }
    } finally {
      await this._emitter.emit('loop:complete', {
        loop: this.name, session: ctx.session.id,
        status: loopStatus, durationMs: Date.now() - loopStartMs, stepsCompleted,
      })
    }
  }

  /** Full run: create a fresh Context, execute all steps, return a run log. */
  async run({
    session,
    vars = {},
    logDir = null,
    startAt = null,
    stopAt = null,
    checkpointFile = null,
    resumeFrom = null,
    keepCheckpointOnSuccess = false,
    onError,
    signal = null,
  }: RunOptions): Promise<RunLog> {
    const logger = new Logger(logDir, this.name, session.id)
    const ctx = new Context({
      session,
      vars: { ...this._defaultVars, ...vars },
      logger, checkpointFile, emitter: this._emitter, signal,
    })

    ctx._loopName = this.name
    ctx._checkpointFile = checkpointFile

    // ── resume from checkpoint ───────────────────────────────────────────────
    let resumeIndex = -1
    let checkpoint: Checkpoint | null = null

    if (resumeFrom && checkpointExists(resumeFrom)) {
      checkpoint = readCheckpoint(resumeFrom)
      resumeIndex = checkpoint.lastCompletedIndex
      for (const [k, v] of Object.entries(checkpoint.state)) ctx.set(k, v)
      ctx._completedSteps = [...checkpoint.completedSteps]
      ctx._lastCompletedIndex = checkpoint.lastCompletedIndex
      console.log(`\nResuming: ${this.name} (from step ${resumeIndex + 2} of ${this._steps.length})`)
      console.log(`Restored: ${Object.keys(checkpoint.state).length} state keys from ${resumeFrom}`)
      ctx.emitLine(`Resuming: ${this.name} (from step ${resumeIndex + 2} of ${this._steps.length})`)
      ctx.emitLine(`Restored: ${Object.keys(checkpoint.state).length} state keys`)
    } else {
      console.log(`\nLoop:    ${this.name}`)
      ctx.emitLine(`Loop:    ${this.name}`)
    }

    console.log(`Session: ${session.id}`)
    console.log(`Steps:   ${this._steps.length}`)
    console.log('---')
    ctx.emitLine(`Session: ${session.id}`)
    ctx.emitLine(`Steps:   ${this._steps.length}`)
    ctx.emitLine('---')

    const loopStartMs = Date.now()
    const runLog: RunLog = {
      loop: this.name,
      session: session.id,
      startedAt: new Date().toISOString(),
      finishedAt: '',
      status: 'running',
      steps: [],
      ...(resumeFrom ? { resumedFrom: resumeFrom } : {}),
    }

    await this._emitter.emit('loop:start', {
      loop: this.name,
      session: session.id,
      totalSteps: this._steps.length,
      ...(resumeFrom ? { resumedFrom: resumeFrom } : {}),
    })

    for (let i = 0; i < this._steps.length; i++) {
      const { name, fn, opts } = this._steps[i]

      // Skip steps already completed in a prior run
      if (i <= resumeIndex) {
        console.log(`[${i + 1}/${this._steps.length}] ${name} ... skipped (completed in prior run)`)
        ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... skipped (completed in prior run)`)
        await this._emitter.emit('step:skip', { loop: this.name, step: name, index: i, reason: 'checkpoint' })
        runLog.steps.push({ name, status: 'skipped' })
        continue
      }

      // Check for cancellation before starting each step
      if (signal?.aborted) {
        console.log(`[${i + 1}/${this._steps.length}] ${name} ... cancelled`)
        ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... cancelled`)
        runLog.status = 'cancelled'
        break
      }

      if (startAt != null && i + 1 < startAt) {
        console.log(`[${i + 1}/${this._steps.length}] ${name} ... skipped`)
        ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... skipped`)
        await this._emitter.emit('step:skip', { loop: this.name, step: name, index: i, reason: 'range' })
        continue
      }
      if (stopAt != null && i + 1 > stopAt) break

      const stepStartMs = Date.now()
      process.stdout.write(`[${i + 1}/${this._steps.length}] ${name} ... `)
      logger.stepStart(name)
      await this._emitter.emit('step:start', { loop: this.name, step: name, index: i, total: this._steps.length })

      // ── attempt the step ─────────────────────────────────────────────────
      let stepSucceeded = false
      let lastErr: Error | null = null

      try {
        await fn(ctx)
        stepSucceeded = true
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err))
      }

      // ── step-level retries ───────────────────────────────────────────────
      if (!stepSucceeded && (opts.retries ?? 0) > 0) {
        for (let attempt = 0; attempt < (opts.retries ?? 0); attempt++) {
          const wait = computeDelay(attempt, opts.retryDelay ?? 0, opts.retryBackoff ?? 'flat')
          const label = `attempt ${attempt + 2}/${(opts.retries ?? 0) + 1}`
          process.stdout.write(wait > 0 ? `\n  retrying in ${wait}ms (${label}) ... ` : `\n  retrying (${label}) ... `)
          ctx.emitLine(wait > 0 ? `retrying in ${wait}ms (${label}) ...` : `retrying (${label}) ...`)
          if (wait > 0) await sleep(wait)
          await this._emitter.emit('step:retry', { loop: this.name, step: name, index: i, plugin: 'step.retries' })
          try {
            await fn(ctx)
            stepSucceeded = true
            break
          } catch (retryErr) {
            lastErr = retryErr instanceof Error ? retryErr : new Error(String(retryErr))
          }
        }
      }

      // ── plugin onStepError hooks ─────────────────────────────────────────
      if (!stepSucceeded) {
        const pluginRetry = await this._runErrorHooks(lastErr!, { name, index: i }, ctx)
        if (pluginRetry) { i--; continue }
      }

      // ── step-level onError fallback ──────────────────────────────────────
      if (!stepSucceeded && opts.onError) {
        try {
          process.stdout.write(`\n  running fallback for "${name}" ... `)
          await opts.onError(lastErr!, ctx)
          stepSucceeded = true
          console.log('ok (fallback)')
          ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... ok (fallback)`)
          const durationMs = Date.now() - stepStartMs
          logger.stepDone('fallback')
          runLog.steps.push({ name, status: 'recovered', error: lastErr!.message })
          await this._emitter.emit('step:complete', { loop: this.name, step: name, index: i, durationMs })
        } catch (fallbackErr) {
          lastErr = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr))
          console.log(`ERROR in fallback: ${lastErr.message}`)
          ctx.emitLine(`ERROR in fallback: ${lastErr.message}`)
        }
      }

      // ── skipOnError ──────────────────────────────────────────────────────
      if (!stepSucceeded && opts.skipOnError) {
        console.log(`skipped (${lastErr!.message})`)
        ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... skipped (${lastErr!.message})`)
        await this._emitter.emit('step:skip', { loop: this.name, step: name, index: i, reason: 'error' })
        runLog.steps.push({ name, status: 'skipped', error: lastErr!.message })
        continue
      }

      // ── success path ─────────────────────────────────────────────────────
      if (stepSucceeded && !runLog.steps.find(s => s.name === name)) {
        const durationMs = Date.now() - stepStartMs
        console.log('ok')
        ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... ok`)
        logger.stepDone()
        runLog.steps.push({ name, status: 'ok' })
        await this._emitter.emit('step:complete', { loop: this.name, step: name, index: i, durationMs })

        if (checkpointFile) {
          ctx._completedSteps.push(name)
          ctx._lastCompletedIndex = i
          writeCheckpoint(checkpointFile, {
            loop: this.name,
            session: session.id,
            savedAt: new Date().toISOString(),
            completedSteps: [...ctx._completedSteps],
            lastCompletedIndex: i,
            state: ctx.snapshot(),
          })
          const count = ctx._completedSteps.length
          console.log(`  ✓ checkpoint saved (${count}/${this._steps.length} steps) → ${checkpointFile}`)
          ctx.emitLine(`✓ checkpoint saved (${count}/${this._steps.length} steps)`)
          await this._emitter.emit('checkpoint:saved', {
            loop: this.name,
            file: checkpointFile,
            step: name,
            completedCount: count,
            totalSteps: this._steps.length,
          })
        }
      }

      // ── unrecoverable failure ────────────────────────────────────────────
      if (!stepSucceeded) {
        const durationMs = Date.now() - stepStartMs
        console.log(`ERROR: ${lastErr!.message}`)
        ctx.emitLine(`[${i + 1}/${this._steps.length}] ${name} ... ERROR: ${lastErr!.message}`)
        await this._emitter.emit('step:error', { loop: this.name, step: name, index: i, error: lastErr!, durationMs })
        logger.stepError(lastErr!)
        runLog.steps.push({ name, status: 'error', error: lastErr!.message })
        runLog.status = 'failed'

        // Loop-level onError handler
        if (onError) {
          try { await onError(lastErr!, ctx, name) } catch {}
        }

        break
      }
    }

    if (runLog.status === 'running') {
      runLog.status = signal?.aborted ? 'cancelled' : 'completed'
    }
    runLog.finishedAt = new Date().toISOString()
    logger.finish(runLog.status)

    if (checkpointFile && runLog.status === 'completed' && !keepCheckpointOnSuccess) {
      deleteCheckpoint(checkpointFile)
    }

    await this._emitter.emit('loop:complete', {
      loop: this.name,
      session: session.id,
      status: runLog.status as 'completed' | 'failed',
      durationMs: Date.now() - loopStartMs,
      stepsCompleted: runLog.steps.filter(s => s.status === 'ok' || s.status === 'recovered').length,
    })

    console.log('---')
    console.log(`Loop ${runLog.status}.`)
    if (logger.logFile) console.log(`Log: ${logger.logFile}`)
    ctx.emitLine('---')
    ctx.emitLine(`Loop ${runLog.status}.`)
    if (logger.logFile) ctx.emitLine(`Log: ${logger.logFile}`)

    return runLog
  }

  /**
   * Start the loop in the background and return a RunHandle immediately.
   * Auto-generates a checkpoint file so pause/resume works without any configuration.
   *
   * @example
   * const handle = loop.runBackground({ session })
   *
   * // Pause after the current step, resume later
   * handle.pause()
   * const handle2 = handle.resume()
   * await handle2.wait()
   *
   * // Parallel loops
   * const [log1, log2] = await Promise.all([h1.wait(), h2.wait()])
   */
  runBackground(opts: RunOptions): RunHandle {
    const id = `${this.name}-${Date.now()}`

    // Auto-generate a checkpoint path so pause/resume works out of the box.
    // Respects a user-provided checkpointFile if one was passed.
    const checkpointFile = opts.checkpointFile ?? `.loop/${id}.checkpoint.json`
    const controller = new AbortController()
    let currentStatus: HandleStatus = 'running'

    const promise = this.run({ ...opts, checkpointFile, signal: controller.signal })
      .then(log => {
        // Don't overwrite 'paused' — the loop reports 'cancelled' internally when aborted,
        // but we distinguish pause vs cancel at the handle level.
        if (currentStatus !== 'paused') currentStatus = log.status as HandleStatus
        return log
      })
      .catch(err => {
        if (currentStatus !== 'paused') {
          currentStatus = controller.signal.aborted ? 'cancelled' : 'failed'
        }
        throw err
      })

    const loop = this
    const resumeOpts: RunOptions = { ...opts, checkpointFile }

    return {
      id,
      get status() { return currentStatus },
      wait: () => promise,
      cancel: () => {
        if (currentStatus !== 'running') return
        currentStatus = 'cancelled'
        controller.abort()
      },
      pause: () => {
        if (currentStatus !== 'running') return
        currentStatus = 'paused'
        controller.abort()
        // The checkpoint was written after the last completed step automatically —
        // nothing extra to do here. It will exist at checkpointFile when resume() is called.
      },
      resume: () => {
        if (currentStatus !== 'paused') {
          throw new Error(`Cannot resume: loop is "${currentStatus}" (must be "paused")`)
        }
        return loop.runBackground({ ...resumeOpts, resumeFrom: checkpointFile })
      },
    }
  }

  private async _runErrorHooks(
    err: Error,
    step: { name: string; index: number },
    ctx: Context
  ): Promise<boolean> {
    for (const plugin of this._plugins) {
      if (!plugin.hooks?.onStepError) continue
      const recovered = await plugin.hooks.onStepError(err, step, ctx).catch(() => false)
      if (recovered) return true
    }
    return false
  }
}

/** Functional API — define and run a loop in one call. */
export async function run(
  name: string,
  session: Session,
  fn: StepFn,
  opts: Omit<RunOptions, 'session'> = {}
): Promise<RunLog> {
  const loop = new Loop(name)
  loop.step(name, fn)
  return loop.run({ session, ...opts })
}

// ── helpers ──────────────────────────────────────────────────────────────────

function computeDelay(
  attempt: number,
  base: number,
  backoff: 'flat' | 'linear' | 'exponential'
): number {
  if (base === 0) return 0
  if (backoff === 'linear') return base * (attempt + 1)
  if (backoff === 'exponential') return base * Math.pow(2, attempt)
  return base
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
