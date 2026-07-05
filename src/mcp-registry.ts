import fs from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * The MCP registry — named server definitions loops can reference by name.
 *
 * File shape (same server format as Claude Code's mcpServers config):
 * {
 *   "mcpServers": {
 *     "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {...} },
 *     "search": { "type": "http", "url": "http://localhost:1234/mcp" }
 *   }
 * }
 *
 * A loop opts in via front-matter:
 *   mcp: [github, search]        — names resolved from the registry
 * or inline definitions:
 *   mcp: { github: { command: ... } }
 */
export const MCP_REGISTRY_PATH = join(homedir(), '.loopdeloop', 'mcp.json')

export type McpServerDef = Record<string, unknown>
export type McpSpec = string[] | Record<string, McpServerDef>

export function loadMcpRegistry(): Record<string, McpServerDef> {
  try {
    const raw = JSON.parse(fs.readFileSync(MCP_REGISTRY_PATH, 'utf8')) as unknown
    const map = (raw && typeof raw === 'object' && 'mcpServers' in raw)
      ? (raw as { mcpServers: unknown }).mcpServers
      : raw
    return map && typeof map === 'object' ? map as Record<string, McpServerDef> : {}
  } catch {
    return {}
  }
}

/** Resolve a loop/step `mcp:` spec to concrete server definitions. */
export function resolveMcpServers(spec: McpSpec | undefined): Record<string, McpServerDef> {
  if (!spec) return {}

  if (Array.isArray(spec)) {
    const registry = loadMcpRegistry()
    const out: Record<string, McpServerDef> = {}
    for (const entry of spec) {
      const name = String(entry)
      const def = registry[name]
      if (!def || typeof def !== 'object') {
        const known = Object.keys(registry)
        throw new Error(
          `mcp: no server named "${name}" in ${MCP_REGISTRY_PATH}` +
          (known.length ? ` (available: ${known.join(', ')})` : ' — the registry is empty')
        )
      }
      out[name] = def
    }
    return out
  }

  // Inline definitions — pass through as-is
  return spec
}
