import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from './context.js'

export interface ClaudeCliOptions {
  /** Claude model name, passed as --model. Defaults to the CLI's configured default. */
  model?: string
  /** Attach a screenshot of the current browser state before invoking claude. */
  screenshot?: boolean
  /** Restrict the AI to specific MCP tool names. */
  tools?: string[]
  /** Subprocess timeout in milliseconds. Default: 240000 (4 min). */
  timeout?: number
  /** Number of retry attempts on network errors. Default: 3. */
  retries?: number
}

export interface ClaudeCliResult {
  ok: true
  output: string
}

/**
 * claudeCli — spawn `claude -p` as a loop step.
 *
 * Unlike agent(), which calls a provider directly, claudeCli() delegates the
 * entire tool-use loop to the Claude Code CLI subprocess. Use this when you
 * want Claude's built-in retry logic, permission model, and MCP handling.
 *
 * Requires `claude` to be installed and on PATH.
 * If ctx.session.mcpUrl is set, claude gets browser tool access via --mcp-config.
 *
 * @example
 * await claudeCli(ctx, 'Fill out the visible form fields.', {
 *   screenshot: true,
 *   model: 'claude-opus-4-8',
 * })
 */
export async function claudeCli(
  ctx: Context,
  prompt: string,
  {
    model,
    screenshot = false,
    tools = [],
    timeout = 240_000,
    retries = 3,
  }: ClaudeCliOptions = {}
): Promise<ClaudeCliResult> {
  const finalPrompt = `${prompt}

At the very end of your response, on its own line, write exactly one of:
RESULT: ok
RESULT: failed — <brief reason>

Use "failed" if you could not complete the task.`

  const args: string[] = ['-p', finalPrompt, '--dangerously-skip-permissions']

  if (model) args.push('--model', model)
  if (tools.length) args.push('--allowedTools', ...tools)

  if (ctx.session?.mcpUrl) {
    const mcpConfig = {
      mcpServers: {
        browser: { type: 'http', url: ctx.session.mcpUrl },
      },
    }
    const configFile = join(tmpdir(), `loop-mcp-${ctx.session.id}-${Date.now()}.json`)
    writeFileSync(configFile, JSON.stringify(mcpConfig))
    args.push('--mcp-config', configFile)
  }

  if (screenshot && ctx.session?.screenshot) {
    const imgBytes = await ctx.session.screenshot()
    const shotFile = join(tmpdir(), `loop-shot-${ctx.session.id}-${Date.now()}.jpg`)
    writeFileSync(shotFile, imgBytes)
    args.push(shotFile)
  }

  let raw = ''
  let lastError = ''

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (ctx.signal?.aborted) throw new Error('cancelled')

    const result = await spawnAsync('claude', args, { timeout, cwd: tmpdir(), signal: ctx.signal })

    if (result.aborted) throw new Error('cancelled')

    if (!result.error && result.exitCode === 0) {
      raw = result.stdout.trim()
      break
    }

    const errMsg = result.error?.message ?? result.error?.code ?? `exit ${result.exitCode}`
    lastError = errMsg

    if (attempt < retries && isRetryable(errMsg)) {
      ctx.log(`claudeCli: retry ${attempt}/${retries} — ${errMsg.slice(0, 80)}`)
      await sleep(3000 * attempt)
    } else {
      break
    }
  }

  if (!raw && lastError) {
    throw new Error(`claude CLI failed (${lastError})`)
  }

  const statusLine = raw.match(/^RESULT:\s*(ok|failed.*)$/im)
  if (statusLine?.[1] && !statusLine[1].toLowerCase().startsWith('ok')) {
    throw new Error(`claude reported: ${statusLine[1].replace(/^failed\s*[-—]\s*/i, '')}`)
  }

  // Strip the RESULT: signal line before returning — it's a protocol marker, not content
  const output = raw.replace(/\n*^RESULT:\s*(ok|failed.*)$/im, '').trim()

  if (output) ctx.log(`claude: ${output.split('\n')[0].slice(0, 120)}${output.includes('\n') ? ' …' : ''}`)

  return { ok: true, output }
}

function isRetryable(msg: string): boolean {
  return ['fetch failed', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].some(s => msg.includes(s))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: NodeJS.ErrnoException
  aborted: boolean
}

function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number; cwd: string; signal?: AbortSignal | null }
): Promise<SpawnResult> {
  return new Promise(resolve => {
    const proc = spawn(cmd, args, { cwd: opts.cwd })
    let stdout = ''
    let stderr = ''
    let settled = false
    let aborted = false

    const timeoutId = setTimeout(() => {
      if (!settled) { settled = true; proc.kill('SIGTERM'); resolve({ stdout, stderr, exitCode: null, error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) as NodeJS.ErrnoException, aborted: false }) }
    }, opts.timeout)

    const onAbort = () => {
      if (!settled) { settled = true; aborted = true; clearTimeout(timeoutId); proc.kill('SIGTERM'); resolve({ stdout, stderr, exitCode: null, aborted: true }) }
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) { settled = true; clearTimeout(timeoutId); opts.signal?.removeEventListener('abort', onAbort); resolve({ stdout, stderr, exitCode: null, error: err, aborted }) }
    })

    proc.on('close', (code: number | null) => {
      if (!settled) { settled = true; clearTimeout(timeoutId); opts.signal?.removeEventListener('abort', onAbort); resolve({ stdout, stderr, exitCode: code, aborted }) }
    })
  })
}
