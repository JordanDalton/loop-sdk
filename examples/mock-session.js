/**
 * MockSession — a fake Session for demos and tests.
 *
 * Logs every action instead of driving a real browser.
 * No daemon, no localhost, no setup required.
 */
import { Session } from '../dist/session.js'

export class MockSession extends Session {
  constructor(id = 'mock') {
    super(id)
    this._url = 'about:blank'
    this._actions = []
  }

  async navigate(url) {
    this._url = url
    this._record('navigate', { url })
  }

  async click(opts) {
    this._record('click', opts)
  }

  async type(text) {
    this._record('type', { text })
  }

  async key(key) {
    this._record('key', { key })
  }

  async scroll(opts) {
    this._record('scroll', opts)
  }

  async screenshot() {
    this._record('screenshot', { url: this._url })
    // Return a 1x1 white JPEG so callers that inspect the buffer don't break
    return Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVIP/2Q==', 'base64')
  }

  async destroy() {
    this._record('destroy', {})
  }

  // No mcpUrl — agent() will run without browser tools
  get mcpUrl() { return null }

  get actions() { return this._actions }

  _record(action, data) {
    const entry = { action, ...data }
    this._actions.push(entry)
    const detail = Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    console.log(`  [mock] ${action}${detail ? ` — ${detail}` : ''}`)
  }
}
