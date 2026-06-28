import { Session, type ClickOptions, type ScrollOptions } from '../session.js'

/**
 * PlaywrightSession — Session adapter for the aria-playwright daemon.
 *
 * Wraps the daemon's HTTP API (http://localhost:4848 by default).
 * Exposes mcpUrl so agent() can give AI models live browser tool access.
 *
 * @example
 * import { PlaywrightSession } from 'loop-sdk/playwright'
 *
 * const session = new PlaywrightSession('my-session')
 * await session.ensure()
 * await loop.run({ session })
 * await session.destroy()
 */
export class PlaywrightSession extends Session {
  readonly daemon: string

  constructor(id: string, { daemon = 'http://localhost:4848' }: { daemon?: string } = {}) {
    super(id)
    this.daemon = daemon
  }

  // ── lifecycle ────────────────────────────────────────────────────────────────

  async ensure(): Promise<boolean> {
    const list = await this._fetch('/sessions').then(r => r.json()) as Array<{ id: string }>
    if (list.some(s => s.id === this.id)) return false
    await this._fetch('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: this.id }),
    })
    await sleep(3000)
    return true
  }

  async destroy(): Promise<void> {
    await this._fetch(`/sessions/${this.id}`, { method: 'DELETE' }).catch(() => {})
  }

  async recreate(): Promise<void> {
    await this.destroy()
    await sleep(1000)
    await this.ensure()
  }

  // ── Session interface ────────────────────────────────────────────────────────

  async navigate(url: string): Promise<void> {
    await this._post('/navigate', { url })
  }

  async click({ x, y, selector, text, button }: ClickOptions): Promise<void> {
    if (x != null && y != null) {
      await this._post('/click', { x, y, button })
    } else if (selector) {
      await this._mcpRunCode(selectorClickCode(selector))
    } else if (text) {
      await this._mcpRunCode(textClickCode(text))
    } else {
      throw new Error('click() requires x+y, selector, or text')
    }
  }

  async type(text: string): Promise<void> {
    await this._post('/type', { text })
  }

  async key(key: string): Promise<void> {
    await this._post('/key', { key })
  }

  async scroll({ x = 760, y = 400, deltaX = 0, deltaY = 300 }: ScrollOptions = {}): Promise<void> {
    await this._post('/scroll', { x, y, deltaX, deltaY })
  }

  async screenshot(): Promise<Buffer> {
    const res = await this._fetch(`/sessions/${this.id}/screenshot`)
    if (!res.ok) throw new Error(`screenshot failed: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  // ── MCP integration ──────────────────────────────────────────────────────────

  override get mcpUrl(): string {
    return `${this.daemon}/sessions/${this.id}/mcp`
  }

  async mcp(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this._post('/mcp', {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    })
  }

  async evaluate(fn: string | (() => unknown)): Promise<string | null> {
    const fnStr = typeof fn === 'function' ? fn.toString() : fn
    const r = await this.mcp('browser_evaluate', { function: fnStr }) as {
      result?: { content?: Array<{ text?: string }> }
    }
    const text = r?.result?.content?.[0]?.text ?? ''
    const m = text.match(/### Result\s*\n"([^"]+)"/)
    return m?.[1] ?? null
  }

  async currentUrl(): Promise<string | null> {
    return this.evaluate('() => window.location.href')
  }

  // ── internal ─────────────────────────────────────────────────────────────────

  private async _mcpRunCode(code: string): Promise<unknown> {
    return this.mcp('browser_run_code_unsafe', { code })
  }

  private async _fetch(path: string, opts: RequestInit = {}): Promise<Response> {
    const url = `${this.daemon}${path}`
    let last: Error = new Error('fetch failed')
    for (let i = 0; i < 4; i++) {
      try { return await fetch(url, opts) } catch (e) {
        last = e instanceof Error ? e : new Error(String(e))
        await sleep(800 * (i + 1))
      }
    }
    throw last
  }

  private async _post(endpoint: string, body: unknown): Promise<unknown> {
    const res = await this._fetch(`/sessions/${this.id}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${endpoint} failed: HTTP ${res.status}: ${await res.text()}`)
    return res.json()
  }
}

// ── click helpers ─────────────────────────────────────────────────────────────

function selectorClickCode(selector: string): string {
  const sel = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `async (page) => {
    for (const f of page.frames()) {
      try {
        const loc = f.locator('${sel}')
        if (await loc.count() > 0) { await loc.first().click(); return 'ok' }
      } catch(e) {}
    }
    throw new Error('No element matching: ${sel}')
  }`
}

function textClickCode(text: string): string {
  const txt = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `async (page) => {
    for (const f of page.frames()) {
      try {
        const loc = f.locator('button,a,[role=button],input[type=submit]').filter({ hasText: '${txt}' })
        if (await loc.count() > 0) { await loc.first().click(); return 'ok' }
      } catch(e) {}
    }
    throw new Error('No element with text: ${txt}')
  }`
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
