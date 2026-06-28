import fs from 'node:fs'
import path from 'node:path'

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
