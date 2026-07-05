import type { Session, ClickOptions, ScrollOptions } from './session.js'
import type { Logger } from './logger.js'
import type { Emitter } from './events.js'
import { writeCheckpoint, type Checkpoint } from './checkpoint.js'

export interface ContextOptions {
  session: Session
  vars?: Record<string, unknown>
  state?: Map<string, unknown>
  logger?: Logger | null
  checkpointFile?: string | null
  emitter?: Emitter | null
  signal?: AbortSignal | null
}

export class Context {
  readonly session: Session
  readonly vars: Record<string, unknown>
  readonly signal: AbortSignal | null
  private readonly _state: Map<string, unknown>
  private readonly _logger: Logger | null
  _emitter: Emitter | null

  /** Set by the Loop runner — enables ctx.saveCheckpoint(). */
  _checkpointFile: string | null
  _loopName: string = ''
  _completedSteps: string[] = []
  _lastCompletedIndex: number = -1

  constructor({
    session,
    vars = {},
    state = new Map(),
    logger = null,
    checkpointFile = null,
    emitter = null,
    signal = null,
  }: ContextOptions) {
    this.session = session
    this.vars = vars
    this._state = state
    this._logger = logger
    this._checkpointFile = checkpointFile
    this._emitter = emitter
    this.signal = signal
  }

  // ── state ────────────────────────────────────────────────────────────────────

  get<T = unknown>(key: string): T | undefined {
    return this._state.get(key) as T | undefined
  }

  set(key: string, value: unknown): this {
    this._state.set(key, value)
    return this
  }

  has(key: string): boolean {
    return this._state.has(key)
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this._state)
  }

  // ── events ────────────────────────────────────────────────────────────────────

  /**
   * Emit a custom event from inside a step. Listeners on the Loop will receive
   * it and can block the step until they complete (useful for human-in-the-loop
   * gates, approval flows, or metrics).
   *
   * @example
   * loop.step('draft', async (ctx) => {
   *   const text = await generateDraft(ctx)
   *   await ctx.emit('draft:ready', { text })  // waits for approval listener
   *   await publish(text)
   * })
   */
  async emit(event: string, data?: unknown): Promise<void> {
    await this._emitter?.emit(event, data)
  }

  // ── checkpointing ─────────────────────────────────────────────────────────────

  saveCheckpoint(): void {
    if (!this._checkpointFile) {
      throw new Error('saveCheckpoint() requires checkpointFile to be set in loop.run()')
    }
    const data: Checkpoint = {
      loop: this._loopName,
      session: this.session.id,
      savedAt: new Date().toISOString(),
      completedSteps: [...this._completedSteps],
      lastCompletedIndex: this._lastCompletedIndex,
      state: this.snapshot(),
    }
    writeCheckpoint(this._checkpointFile, data)
    this.log(`checkpoint saved → ${this._checkpointFile}`)
  }

  // ── logging ──────────────────────────────────────────────────────────────────

  log(msg: string, data?: Record<string, unknown>): void {
    const extra = data ? ` ${JSON.stringify(data)}` : ''
    process.stdout.write(`  ${msg}${extra}\n`)
    this._logger?.write({ msg, data })
    this.emitLine(`${msg}${extra}`)
  }

  /**
   * Emit a human-readable line as a 'log' event on the run's root emitter
   * (fire-and-forget). Runners subscribe to this instead of scraping stdout —
   * the emitter is shared through fork(), so sub-loop lines attribute to the
   * run that owns them even with many runs in flight.
   */
  emitLine(message: string): void {
    void this._emitter?.emit('log', { message })
  }

  // ── forking ──────────────────────────────────────────────────────────────────

  fork(
    vars: Record<string, unknown> = {},
    session: Session | null = null,
    opts: { isolateState?: boolean } = {}
  ): Context {
    return new Context({
      session: session ?? this.session,
      vars: { ...this.vars, ...vars },
      // Isolated forks copy the state so concurrent children can't trample
      // each other's step outputs (used by parallel `each`).
      state: opts.isolateState ? new Map(this._state) : this._state,
      logger: this._logger,
      checkpointFile: this._checkpointFile,
      emitter: this._emitter,
      signal: this.signal,
    })
  }

  // ── session convenience methods ───────────────────────────────────────────────

  navigate(url: string): Promise<void> { return this.session.navigate(url) }
  click(opts: ClickOptions): Promise<void> { return this.session.click(opts) }
  type(text: string): Promise<void> { return this.session.type(text) }
  key(key: string): Promise<void> { return this.session.key(key) }
  scroll(opts: ScrollOptions): Promise<void> { return this.session.scroll(opts) }
  screenshot(): Promise<Buffer> { return this.session.screenshot() }
}
