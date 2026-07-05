/**
 * Session — abstract base class every provider must extend.
 *
 * Extend this class to add support for any browser automation tool:
 *
 *   import { Session } from 'loop-sdk'
 *   export class MySession extends Session {
 *     async navigate(url: string) { ... }
 *     // etc.
 *   }
 */

export interface ClickOptions {
  x?: number
  y?: number
  selector?: string
  text?: string
  button?: 'left' | 'right' | 'middle'
}

export interface ScrollOptions {
  x?: number
  y?: number
  deltaX?: number
  deltaY?: number
}

export abstract class Session {
  readonly id: string

  constructor(id: string) {
    this.id = id
  }

  // ── Required — subclasses must implement ─────────────────────────────────────

  abstract navigate(url: string): Promise<void>
  abstract click(opts: ClickOptions): Promise<void>
  abstract type(text: string): Promise<void>
  abstract key(key: string): Promise<void>
  abstract scroll(opts: ScrollOptions): Promise<void>

  /** Capture a screenshot. Returns JPEG bytes. */
  abstract screenshot(): Promise<Buffer>

  /** Release all resources held by this session. */
  abstract destroy(): Promise<void>

  // ── Optional — providers implement for parallel lanes ────────────────────────

  /**
   * Create an independent sibling session (e.g. its own browser tab) for a
   * parallel lane. Lanes are destroyed by the runner when their item finishes.
   * When absent, parallel lanes share this session.
   */
  clone?(laneId: string): Promise<Session>

  // ── Optional — providers implement for AI agent tool access ──────────────────

  /**
   * MCP server URL for AI agent tool access, or null if not supported.
   * When set, agent() wires up an MCP client so the AI can call browser tools.
   */
  get mcpUrl(): string | null {
    return null
  }
}

/**
 * NullSession — a no-op session for loops that don't drive a browser
 * (pure AI / data loops). Every browser method does nothing and screenshot
 * returns empty bytes, so `runFile()` and the `loop-sdk run` CLI can execute
 * browserless loops without a real provider.
 */
export class NullSession extends Session {
  async navigate(): Promise<void> {}
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async key(): Promise<void> {}
  async scroll(): Promise<void> {}
  async screenshot(): Promise<Buffer> {
    return Buffer.alloc(0)
  }
  async destroy(): Promise<void> {}
}
