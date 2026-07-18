import fs from 'node:fs'
import path from 'node:path'

/** Persisted state for an idempotent side effect. */
export interface EffectRecord {
  name: string
  status: 'started' | 'completed'
  startedAt: string
  completedAt?: string
  result?: unknown
  compensation?: {
    status: 'started' | 'completed'
    startedAt: string
    completedAt?: string
  }
}

/** Persisted state for a loop.suspend() wait, keyed by its caller-provided key. */
export interface WaitRecord {
  /** Name of the suspend step that owns this wait. */
  step: string
  status: 'pending' | 'delivered'
  startedAt: string
  deliveredAt?: string
  /** The value delivered via Loop.deliver() — only set once status is 'delivered'. */
  payload?: unknown
}

export interface Checkpoint {
  loop: string
  session: string
  savedAt: string
  /** Names of every step that completed successfully before this checkpoint. */
  completedSteps: string[]
  /** Index of the last completed step (0-based). -1 if no steps completed yet. */
  lastCompletedIndex: number
  /** Full ctx.snapshot() at the time of the checkpoint. */
  state: Record<string, unknown>
  /** Side effects keyed by their caller-provided idempotency key. */
  effects?: Record<string, EffectRecord>
  /** Pending/delivered loop.suspend() waits keyed by their caller-provided key. */
  waits?: Record<string, WaitRecord>
}

export function writeCheckpoint(file: string, data: Checkpoint): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

export function readCheckpoint(file: string): Checkpoint {
  const raw = fs.readFileSync(file, 'utf8')
  return JSON.parse(raw) as Checkpoint
}

export function checkpointExists(file: string): boolean {
  return fs.existsSync(file)
}

export function deleteCheckpoint(file: string): void {
  try { fs.unlinkSync(file) } catch {}
}
