import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import type { Context } from './context.js'
import { spawnAsync } from './claude-cli.js'

export interface CodexCliOptions {
  /** Model name, passed as -m (e.g. "gpt-5-codex"). Defaults to the CLI's configured default. */
  model?: string
  /** Working directory for the codex subprocess (a repo path makes it a build worker). Supports '~'. */
  cwd?: string
  /** Subprocess timeout in milliseconds. Default: 240000 (4 min). */
  timeout?: number
  /** Number of retry attempts on network errors. Default: 3. */
  retries?: number
}

export interface CodexCliResult {
  ok: true
  output: string
}

/**
 * codexCli — run OpenAI's Codex CLI as a loop step (`codex exec`).
 *
 * Mirrors claudeCli: same RESULT protocol, same workdir semantics, isolated
 * from the user's personal config (--ignore-user-config; auth still works).
 * Text/file work only — no browser MCP tools (Codex has no HTTP MCP client).
 *
 * Requires `codex` on PATH (npm i -g @openai/codex).
 */
export async function codexCli(
  ctx: Context,
  prompt: string,
  { model, cwd, timeout = 240_000, retries = 3 }: CodexCliOptions = {}
): Promise<CodexCliResult> {
  const finalPrompt = `${prompt}

At the very end of your response, on its own line, write exactly one of:
RESULT: ok
RESULT: failed — <brief reason>

Use "failed" if you could not complete the task.`

  const outFile = join(tmpdir(), `loop-codex-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`)
  const args = [
    'exec', finalPrompt,
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ephemeral',
    '--dangerously-bypass-approvals-and-sandbox',
    '--color', 'never',
    '--output-last-message', outFile,
  ]
  if (model) args.push('-m', model)

  const workdir = cwd?.trim()
    ? cwd.trim().replace(/^~(?=\/|$)/, homedir())
    : tmpdir()
  if (!existsSync(workdir)) {
    throw new Error(`workdir does not exist: ${workdir}`)
  }

  let raw = ''
  let lastError = ''

  try {
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (ctx.signal?.aborted) throw new Error('cancelled')

      const result = await spawnAsync('codex', args, { timeout, cwd: workdir, signal: ctx.signal })
      if (result.aborted) throw new Error('cancelled')

      if (result.error?.code === 'ENOENT') {
        throw new Error('Codex CLI not found — install it with: npm install -g @openai/codex')
      }

      if (!result.error && result.exitCode === 0) {
        try { raw = readFileSync(outFile, 'utf8').trim() } catch {}
        if (!raw) raw = result.stdout.trim()
        break
      }

      const stderrTail = result.stderr.trim().split('\n').pop()?.slice(0, 200)
      const errMsg = result.error?.message ?? result.error?.code ??
        `exit ${result.exitCode}${stderrTail ? ` — ${stderrTail}` : ''}`
      lastError = errMsg

      if (attempt < retries && isRetryable(errMsg)) {
        ctx.log(`codexCli: retry ${attempt}/${retries} — ${errMsg.slice(0, 80)}`)
        await sleep(3000 * attempt)
      } else {
        break
      }
    }
  } finally {
    try { unlinkSync(outFile) } catch {}
  }

  if (!raw && lastError) {
    throw new Error(`codex CLI failed (${lastError})`)
  }

  const statusLine = raw.match(/^RESULT:\s*(ok|failed.*)$/im)
  if (statusLine?.[1] && !statusLine[1].toLowerCase().startsWith('ok')) {
    throw new Error(`codex reported: ${statusLine[1].replace(/^failed\s*[-—]\s*/i, '')}`)
  }

  const output = raw.replace(/\n*^RESULT:\s*(ok|failed.*)$/im, '').trim()
  if (output) ctx.log(`codex: ${output.split('\n')[0].slice(0, 120)}${output.includes('\n') ? ' …' : ''}`)

  return { ok: true, output }
}

function isRetryable(msg: string): boolean {
  return ['fetch failed', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'stream disconnected'].some(s => msg.includes(s))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
