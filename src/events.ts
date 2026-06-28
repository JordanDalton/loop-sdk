/**
 * events.ts — typed event system for loop lifecycle and custom step events.
 *
 * The Loop fires built-in events at every lifecycle moment. Steps can emit
 * custom events via ctx.emit(). Listeners can be async — the loop awaits all
 * listeners before continuing, so a listener can pause execution (e.g. a
 * human-in-the-loop gate that waits for approval).
 *
 * @example
 * loop.on('step:complete', async ({ step, durationMs }) => {
 *   await slack.send(`✓ ${step} finished in ${durationMs}ms`)
 * })
 *
 * loop.on('loop:error', async ({ error }) => {
 *   await pagerduty.alert(error.message)
 * })
 *
 * // Custom event from inside a step:
 * loop.step('review', async (ctx) => {
 *   const result = await agent(ctx, 'Draft the email.')
 *   await ctx.emit('draft:ready', { text: result.text })
 * })
 *
 * loop.on('draft:ready', async ({ text }) => {
 *   await humanReview(text)  // blocks until approved
 * })
 */

// ── Built-in event payloads ───────────────────────────────────────────────────

export interface LoopStartEvent {
  loop: string
  session: string
  totalSteps: number
  resumedFrom?: string
}

export interface LoopCompleteEvent {
  loop: string
  session: string
  status: 'completed' | 'failed' | 'cancelled'
  durationMs: number
  stepsCompleted: number
}

export interface StepStartEvent {
  loop: string
  step: string
  index: number   // 0-based
  total: number
}

export interface StepCompleteEvent {
  loop: string
  step: string
  index: number
  durationMs: number
}

export interface StepErrorEvent {
  loop: string
  step: string
  index: number
  error: Error
  durationMs: number
}

export interface StepSkipEvent {
  loop: string
  step: string
  index: number
  reason: 'checkpoint' | 'range' | 'error'
}

export interface StepRetryEvent {
  loop: string
  step: string
  index: number
  plugin: string
}

export interface CheckpointSavedEvent {
  loop: string
  file: string
  step: string
  completedCount: number
  totalSteps: number
}

/** Map of all built-in event names → their payload types. */
export interface LoopEvents {
  'loop:start':          LoopStartEvent
  'loop:complete':       LoopCompleteEvent
  'step:start':          StepStartEvent
  'step:complete':       StepCompleteEvent
  'step:error':          StepErrorEvent
  'step:skip':           StepSkipEvent
  'step:retry':          StepRetryEvent
  'checkpoint:saved':    CheckpointSavedEvent
}

// ── Emitter ───────────────────────────────────────────────────────────────────

type KnownListener<K extends keyof LoopEvents> = (data: LoopEvents[K]) => void | Promise<void>
type AnyListener = (data: unknown) => void | Promise<void>

export class Emitter {
  private readonly _listeners = new Map<string, Set<AnyListener>>()

  /** Listen to a built-in lifecycle event (fully typed). */
  on<K extends keyof LoopEvents>(event: K, listener: KnownListener<K>): this
  /** Listen to a custom event emitted via ctx.emit(). */
  on(event: string, listener: AnyListener): this
  on(event: string, listener: AnyListener): this {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event)!.add(listener)
    return this
  }

  /** Remove a listener. */
  off<K extends keyof LoopEvents>(event: K, listener: KnownListener<K>): this
  off(event: string, listener: AnyListener): this
  off(event: string, listener: AnyListener): this {
    this._listeners.get(event)?.delete(listener)
    return this
  }

  /**
   * Fire an event. Awaits all listeners concurrently.
   * Listener errors are caught and logged — they never crash the loop.
   */
  async emit<K extends keyof LoopEvents>(event: K, data: LoopEvents[K]): Promise<void>
  async emit(event: string, data: unknown): Promise<void>
  async emit(event: string, data: unknown): Promise<void> {
    const listeners = this._listeners.get(event)
    if (!listeners?.size) return
    await Promise.all(
      [...listeners].map(fn =>
        Promise.resolve(fn(data)).catch(err => {
          console.error(`  [event:${event}] listener error: ${(err as Error).message}`)
        })
      )
    )
  }

  /** True if any listeners are registered for the given event. */
  hasListeners(event: string): boolean {
    return (this._listeners.get(event)?.size ?? 0) > 0
  }
}
