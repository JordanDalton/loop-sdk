import { spawnSync } from 'node:child_process'
import type { Loop } from './loop.js'
import type { LoopEvents } from './events.js'

export interface NotifyOptions {
  /** Notification title. Default: 'loop-sdk'. */
  title?: string
  /** Subtitle shown below the title. */
  subtitle?: string
  /** Play the default notification sound. Default: false. */
  sound?: boolean
}

/**
 * Send a macOS notification via osascript. No-op on non-macOS platforms.
 *
 * @example
 * notify('Loop completed in 12.3s', { title: 'My Loop', sound: true })
 */
export function notify(message: string, opts: NotifyOptions = {}): void {
  if (process.platform !== 'darwin') return

  const title = opts.title ?? 'loop-sdk'
  const subtitle = opts.subtitle ?? ''
  const sound = opts.sound ?? false

  let script = `display notification ${osa(message)} with title ${osa(title)}`
  if (subtitle) script += ` subtitle ${osa(subtitle)}`
  if (sound) script += ` sound name "default"`

  spawnSync('osascript', ['-e', script], { stdio: 'ignore' })
}

// ── Pre-wired listener sets ───────────────────────────────────────────────────

export interface NotifyOnOptions {
  /** Notify when the loop starts. Default: false. */
  onStart?: boolean
  /** Notify when the loop completes successfully. Default: true. */
  onComplete?: boolean
  /** Notify when the loop fails. Default: true. */
  onError?: boolean
  /** Notify when a step fails (in addition to the loop-level error). Default: false. */
  onStepError?: boolean
  /** Notification title. Default: loop name. */
  title?: string
  /** Play the default notification sound on completion. Default: false. */
  sound?: boolean
}

/**
 * Attach macOS notification listeners to a loop. Call before loop.run().
 *
 * @example
 * import { notifyOn } from 'loop-sdk/notify'
 *
 * const loop = new Loop('research')
 * notifyOn(loop, { onComplete: true, onError: true, title: 'Research Loop' })
 *
 * await loop.run({ session })
 */
export function notifyOn(loop: Loop, opts: NotifyOnOptions = {}): void {
  const title = opts.title ?? loop.name
  const onStart = opts.onStart ?? false
  const onComplete = opts.onComplete ?? true
  const onError = opts.onError ?? true
  const onStepError = opts.onStepError ?? false
  const sound = opts.sound ?? false

  if (onStart) {
    loop.on('loop:start', ({ totalSteps }: LoopEvents['loop:start']) => {
      notify(`Starting — ${totalSteps} step${totalSteps === 1 ? '' : 's'}`, { title, subtitle: 'Started' })
    })
  }

  if (onComplete) {
    loop.on('loop:complete', ({ status, durationMs, stepsCompleted }: LoopEvents['loop:complete']) => {
      if (status !== 'completed') return
      notify(
        `Finished in ${(durationMs / 1000).toFixed(1)}s — ${stepsCompleted} steps`,
        { title, subtitle: 'Completed', sound }
      )
    })
  }

  if (onError) {
    loop.on('loop:complete', ({ status, durationMs }: LoopEvents['loop:complete']) => {
      if (status !== 'failed') return
      notify(
        `Failed after ${(durationMs / 1000).toFixed(1)}s`,
        { title, subtitle: 'Failed', sound: true }
      )
    })
  }

  if (onStepError) {
    loop.on('step:error', ({ step, error }: LoopEvents['step:error']) => {
      notify(error.message, { title, subtitle: `Step failed: ${step}`, sound: true })
    })
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function osa(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`
}
