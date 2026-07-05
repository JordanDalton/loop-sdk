import { spawn } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import type { Context } from './context.js'

export interface ClaudeCliOptions {
  /** Claude model name, passed as --model. Defaults to the CLI's configured default. */
  model?: string
  /** Attach a screenshot of the current browser state before invoking claude. */
  screenshot?: boolean
  /** Restrict the AI to these tool names (Claude Code names, e.g. Read, Bash, mcp__browser). */
  tools?: string[]
  /**
   * Enforce the tool allowlist. When true, permissions are NOT skipped and the
   * subprocess is scoped to `tools` (or a conservative default) — any unlisted
   * tool is denied. When false (default), the step runs frictionless with
   * permissions skipped UNLESS `tools` is explicitly declared. See
   * buildPermissionArgs for the full policy.
   */
  enforce?: boolean
  /** Cap on agentic turns (tool-use cycles), passed as --max-turns. */
  maxTurns?: number
  /**
   * Working directory for the claude subprocess. Claude Code's file tools,
   * git, and the project's own CLAUDE.md operate here — set it to a repo
   * path to make the step a real build worker. Supports a leading '~'.
   * Default: the OS temp dir (no file access to anything real).
   */
  cwd?: string
  /** Subprocess timeout in milliseconds. Default: 240000 (4 min). */
  timeout?: number
  /** Number of retry attempts on network errors. Default: 3. */
  retries?: number
  /**
   * Extra MCP servers for this invocation (same shape as Claude Code's
   * mcpServers config). Merged with the browser server when a session is
   * attached — this is how loops gain arbitrary capabilities.
   */
  mcpServers?: Record<string, unknown>
}

export interface ClaudeCliResult {
  ok: true
  output: string
}

/**
 * Conservative allowlist for an enforced step that declared no `tools` of its
 * own — enough for a build worker (read/edit/run/search/web) without leaving
 * the door wide open. Authors narrow it with a step-level `tools:`.
 */
export const STRICT_DEFAULT_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebFetch', 'WebSearch']

/**
 * Translate a step's tool policy into Claude Code permission flags.
 *
 *   no allowlist, not enforced (explore default) → --dangerously-skip-permissions
 *   any declared allowlist                       → enforce it (unlisted tools denied)
 *   enforced (strict) with no declared allowlist → enforce STRICT_DEFAULT_TOOLS
 *
 * Declaring `tools` always enforces, regardless of mode — if you list tools you
 * mean them. A live browser session always adds the browser MCP server so
 * enforced browser steps keep working. In `-p` mode a non-allowed tool call
 * can't be prompted for, so it is denied outright — that's the enforcement.
 */
export function buildPermissionArgs(tools: string[], enforce: boolean, hasSession: boolean): string[] {
  const declared = tools.length ? tools : (enforce ? STRICT_DEFAULT_TOOLS : [])
  if (declared.length === 0) return ['--dangerously-skip-permissions']
  const allow = [...declared]
  if (hasSession) allow.push('mcp__browser')
  // Comma-joined single value — unambiguous vs. a variadic flag swallowing args
  return ['--allowedTools', allow.join(',')]
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
    enforce = false,
    maxTurns,
    cwd,
    timeout = 240_000,
    retries = 3,
    mcpServers,
  }: ClaudeCliOptions = {}
): Promise<ClaudeCliResult> {
  let screenshotNote = ''
  if (screenshot && ctx.session?.screenshot) {
    const imgBytes = await ctx.session.screenshot()
    const shotFile = join(tmpdir(), `loop-shot-${ctx.session.id}-${Date.now()}.jpg`)
    writeFileSync(shotFile, imgBytes)
    screenshotNote = `\n\nA screenshot of the current browser state is saved at ${shotFile} — view it with the Read tool.`
  }

  // Tell the model a live browser exists — otherwise page-referencing prompts
  // ("what is the headline?") look ambiguous and it never reaches for the tools.
  const browserNote = ctx.session?.mcpUrl
    ? `\n\nA live browser session is attached and already showing the page this task refers to. You have browser tools: browser_read_page, browser_screenshot, browser_click, browser_type, browser_press_key, browser_scroll, browser_navigate. When the task mentions the page, its content, a headline, a button, etc., start with browser_read_page. When your answer should include links/URLs (to posts, profiles, articles), use browser_read_links — read_page strips them. To attach a file (image upload etc.), use browser_upload_file with its absolute path — NEVER click buttons that open a native file picker; it cannot be automated. If the task refers to a tab the user ALREADY has open, use browser_list_tabs and browser_use_tab (if available) to find and adopt it. If a page is still loading or a response is still streaming/"thinking", use browser_wait and read the page again — NEVER end your turn to wait for something; finish the task first. Do not navigate elsewhere unless the task explicitly says to.`
    : ''

  // Name the attached servers so the model reaches for their tools —
  // discovery alone often isn't enough of a hint
  const extraServerNames = Object.keys(mcpServers ?? {})
  const mcpNote = extraServerNames.length
    ? `\n\nAdditional tool servers are connected: ${extraServerNames.join(', ')}. Their tools are available to you directly — prefer them over shell workarounds when the task matches what they offer.`
    : ''

  const finalPrompt = `${prompt}${browserNote}${mcpNote}${screenshotNote}

At the very end of your response, on its own line, write exactly one of:
RESULT: ok
RESULT: failed — <brief reason>

Use "failed" if you could not complete the task.`

  // Isolate from the user's personal Claude Code config (global CLAUDE.md,
  // skills, MCP servers) — loop steps must only see what the loop provides.
  // stream-json (requires --verbose in -p mode) gives us a live transcript
  // of assistant text/tool calls plus cost+token usage in the result event.
  const args: string[] = [
    '-p', finalPrompt,
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--output-format', 'stream-json',
    '--verbose',
  ]

  if (model) args.push('--model', model)
  if (maxTurns) args.push('--max-turns', String(maxTurns))

  // Permission posture: skip-permissions for a frictionless default, or a real
  // enforced allowlist when the step opts in (strict mode / declared tools).
  const permArgs = buildPermissionArgs(tools, enforce, Boolean(ctx.session?.mcpUrl))
  if (permArgs[0] === '--allowedTools') ctx.log(`🔒 tool scope: ${permArgs[1]}`)
  args.push(...permArgs)

  const servers: Record<string, unknown> = { ...(mcpServers ?? {}) }
  if (ctx.session?.mcpUrl) {
    servers.browser = { type: 'http', url: ctx.session.mcpUrl }
  }
  if (Object.keys(servers).length) {
    const configFile = join(tmpdir(), `loop-mcp-${ctx.session?.id ?? 'nosession'}-${Date.now()}.json`)
    writeFileSync(configFile, JSON.stringify({ mcpServers: servers }))
    // = form: --mcp-config is variadic and would swallow any following argument
    args.push(`--mcp-config=${configFile}`)
  }

  const workdir = cwd?.trim()
    ? cwd.trim().replace(/^~(?=\/|$)/, homedir())
    : tmpdir()
  // Node reports a missing cwd as "spawn <cmd> ENOENT" — indistinguishable
  // from a missing binary. Catch it here with an error that says what's wrong.
  if (!existsSync(workdir)) {
    throw new Error(`workdir does not exist: ${workdir}`)
  }

  let raw = ''
  let lastError = ''
  let resultEvent: StreamResultEvent | null = null
  let streamModel: string | undefined

  // Parse the JSONL stream as it arrives — assistant text and tool calls
  // become live 'agent' events; the final 'result' event carries the answer
  // text plus cost/token usage.
  const onLine = (line: string) => {
    if (!line.startsWith('{')) return
    let ev: Record<string, any>
    try { ev = JSON.parse(line) } catch { return }

    if (ev.type === 'system' && ev.subtype === 'init') {
      streamModel = typeof ev.model === 'string' ? ev.model : undefined
      void ctx.emit('agent', { kind: 'init', detail: streamModel })
    } else if (ev.type === 'assistant') {
      for (const block of ev.message?.content ?? []) {
        if (block?.type === 'text' && block.text?.trim()) {
          void ctx.emit('agent', { kind: 'text', text: block.text.trim() })
        } else if (block?.type === 'tool_use') {
          void ctx.emit('agent', { kind: 'tool_use', tool: block.name, detail: compactValue(block.input) })
        }
      }
    } else if (ev.type === 'user') {
      const content = ev.message?.content
      if (!Array.isArray(content)) return
      for (const block of content) {
        if (block?.type === 'tool_result') {
          void ctx.emit('agent', {
            kind: 'tool_result',
            detail: compactValue(block.content),
            ...(block.is_error ? { isError: true } : {}),
          })
        }
      }
    } else if (ev.type === 'result') {
      resultEvent = ev as StreamResultEvent
    }
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (ctx.signal?.aborted) throw new Error('cancelled')

    resultEvent = null
    const result = await spawnAsync('claude', args, { timeout, cwd: workdir, signal: ctx.signal, onLine })

    if (result.aborted) throw new Error('cancelled')

    // Snapshot — onLine mutates resultEvent from a closure, which defeats
    // TypeScript's narrowing on the variable itself
    const rev = resultEvent as StreamResultEvent | null

    // Cost was incurred even if the step ends up failing — always report it
    if (rev) emitUsage(ctx, rev, streamModel)

    if (!result.error && result.exitCode === 0) {
      raw = typeof rev?.result === 'string'
        ? rev.result.trim()
        : result.stdout.trim()   // non-stream fallback (older CLI)

      if (rev?.subtype && rev.subtype !== 'success') {
        throw new Error(`claude CLI: ${rev.subtype}${raw ? ` — ${raw.slice(0, 200)}` : ''}`)
      }
      break
    }

    const stderrTail = result.stderr.trim().split('\n').pop()?.slice(0, 200)
    const errMsg = result.error?.message ?? result.error?.code ??
      `exit ${result.exitCode}${stderrTail ? ` — ${stderrTail}` : ''}`
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

/** The terminal event of a stream-json run: final text + cost/token usage. */
interface StreamResultEvent {
  type: 'result'
  subtype?: string          // 'success' | 'error_max_turns' | 'error_during_execution' | …
  result?: string
  total_cost_usd?: number
  num_turns?: number
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

function emitUsage(ctx: Context, ev: StreamResultEvent, model?: string): void {
  const u = ev.usage ?? {}
  void ctx.emit('usage', {
    costUsd: Number(ev.total_cost_usd) || 0,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    model,
    numTurns: ev.num_turns,
  })
}

/** One-line preview of a tool input/result for the live transcript. */
function compactValue(val: unknown, max = 160): string {
  let text: string
  if (typeof val === 'string') {
    text = val
  } else if (Array.isArray(val)) {
    // tool_result content: [{type:'text', text}, …]
    text = val
      .map(b => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join(' ') || JSON.stringify(val)
  } else {
    try { text = JSON.stringify(val) ?? '' } catch { text = String(val) }
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max) + '…' : text
}

function isRetryable(msg: string): boolean {
  return ['fetch failed', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].some(s => msg.includes(s))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: NodeJS.ErrnoException
  aborted: boolean
}

export function spawnAsync(
  cmd: string,
  args: string[],
  opts: { timeout: number; cwd: string; signal?: AbortSignal | null; onLine?: (line: string) => void }
): Promise<SpawnResult> {
  return new Promise(resolve => {
    const proc = spawn(cmd, args, { cwd: opts.cwd })
    // Close stdin immediately — codex exec (and anything stdin-aware) would
    // otherwise block forever waiting for EOF on the open pipe
    proc.stdin?.end()
    let stdout = ''
    let stderr = ''
    let lineBuf = ''
    let settled = false
    let aborted = false

    const flushLine = (line: string) => {
      const trimmed = line.trim()
      if (trimmed) try { opts.onLine?.(trimmed) } catch {}
    }

    const timeoutId = setTimeout(() => {
      if (!settled) { settled = true; proc.kill('SIGTERM'); resolve({ stdout, stderr, exitCode: null, error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) as NodeJS.ErrnoException, aborted: false }) }
    }, opts.timeout)

    const onAbort = () => {
      if (!settled) { settled = true; aborted = true; clearTimeout(timeoutId); proc.kill('SIGTERM'); resolve({ stdout, stderr, exitCode: null, aborted: true }) }
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    proc.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stdout += chunk
      if (opts.onLine) {
        lineBuf += chunk
        let nl
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          flushLine(lineBuf.slice(0, nl))
          lineBuf = lineBuf.slice(nl + 1)
        }
      }
    })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (!settled) { settled = true; clearTimeout(timeoutId); opts.signal?.removeEventListener('abort', onAbort); resolve({ stdout, stderr, exitCode: null, error: err, aborted }) }
    })

    proc.on('close', (code: number | null) => {
      if (!settled) {
        settled = true
        clearTimeout(timeoutId)
        opts.signal?.removeEventListener('abort', onAbort)
        if (lineBuf) { flushLine(lineBuf); lineBuf = '' }
        resolve({ stdout, stderr, exitCode: code, aborted })
      }
    })
  })
}
