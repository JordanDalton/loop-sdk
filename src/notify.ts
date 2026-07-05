import { spawnSync, spawn } from 'node:child_process'
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

/**
 * Send an iMessage via the macOS Messages app. Sending to your own phone
 * number or Apple ID lands in the "message to self" thread on all devices.
 * First use prompts the user to grant Automation permission for Messages.
 * No-op on non-macOS platforms.
 */
export function sendIMessage(message: string, to: string): Promise<void> {
  if (process.platform !== 'darwin') return Promise.reject(new Error('iMessage requires macOS'))
  if (!to?.trim()) return Promise.reject(new Error('iMessage requires a "to" (your phone number or Apple ID email)'))

  const script = `tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to participant ${osa(to.trim())} of targetService
  send ${osa(message)} to targetBuddy
end tell`

  // Async with a hard timeout — a pending macOS permission dialog must never
  // block the runner's event loop (it froze the whole sidecar once)
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-e', script])
    let stderr = ''
    proc.stderr?.on('data', d => { stderr += d.toString() })
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('iMessage send timed out — is a macOS permission dialog waiting? Approve "control Messages" and retry'))
    }, 60_000)
    proc.on('error', err => { clearTimeout(timer); reject(err) })
    proc.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`iMessage send failed: ${stderr.trim() || `exit ${code}`}`))
    })
  })
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
