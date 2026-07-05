import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from './context.js'
import type { WorktreeCreatedEvent } from './events.js'

const WORKTREES_DIR = join(homedir(), '.loopdeloop', 'worktrees')

/** Reserved ctx state key — maps workdir path → its run worktree. */
export const WORKTREE_STATE_KEY = '__worktree'

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Get or create this run's git worktree for the repo at workdir.
 *
 * The first claudeCli/codexCli/verify step that resolves the workdir creates
 * a worktree on a fresh branch (loop/<slug>-<id>) cut from the repo's HEAD;
 * later steps in the same run reuse it via ctx state. Parallel `each` lanes
 * fork with isolated state, so each lane gets its OWN worktree — that's the
 * point: concurrent workers can't trample one repo's working tree.
 *
 * Emits 'worktree:created' so runners can track (and later commit/prune)
 * every worktree the run produced, including ones made in isolated forks.
 */
export function ensureWorktree(ctx: Context, workdir: string, loopName: string): string {
  const map = { ...((ctx.get(WORKTREE_STATE_KEY) as Record<string, WorktreeCreatedEvent>) ?? {}) }
  const existing = map[workdir]
  if (existing) return existing.path

  let repo: string
  try {
    repo = git(workdir, 'rev-parse', '--show-toplevel')
  } catch {
    throw new Error(`worktree: workdir is not inside a git repository — ${workdir}`)
  }

  let baseRef: string
  try {
    baseRef = git(repo, 'rev-parse', 'HEAD')
  } catch {
    throw new Error(`worktree: repository has no commits yet — ${repo}`)
  }

  const slug = (loopName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'loop'
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const branch = `loop/${slug}-${id}`
  const path = join(WORKTREES_DIR, `${slug}-${id}`)

  mkdirSync(WORKTREES_DIR, { recursive: true })
  git(repo, 'worktree', 'add', path, '-b', branch)

  const info: WorktreeCreatedEvent = { repo, path, branch, baseRef }
  map[workdir] = info
  ctx.set(WORKTREE_STATE_KEY, map)
  ctx.log(`⎇ worktree: ${branch}`)
  void ctx.emit('worktree:created', info)
  return path
}
