#!/usr/bin/env node
/**
 * loop-sdk MCP server — exposes tools that let an AI agent author .loop files.
 *
 * Run via stdio transport (compatible with `claude -p --mcp-config`):
 *   node dist/mcp/server.js
 *
 * MCP config example:
 *   {
 *     "mcpServers": {
 *       "loop": {
 *         "command": "node",
 *         "args": ["./dist/mcp/server.js"],
 *         "env": { "LOOP_DIR": "./loops" }
 *       }
 *     }
 *   }
 *
 * Tools exposed:
 *   write_loop   — write a .loop file to disk
 *   read_loop    — read an existing .loop file
 *   list_loops   — list .loop files in a directory
 *   validate_loop — parse a .loop file and report any errors
 */

import fs from 'node:fs'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { parseLoopFile } from '../loopfile.js'

const LOOP_DIR = process.env.LOOP_DIR ?? '.loop'

const server = new Server(
  { name: 'loop-sdk', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

// ── Tool definitions ──────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'write_loop',
      description: 'Write a .loop file to disk. Use this to create or update agentic loop definitions. The content must be a valid .loop file (YAML front-matter + ## step sections).',
      inputSchema: {
        type: 'object',
        properties: {
          filename: {
            type: 'string',
            description: 'Filename for the .loop file, e.g. "research.loop". Will be created in the LOOP_DIR.',
          },
          content: {
            type: 'string',
            description: 'Full .loop file content including YAML front-matter and ## step sections.',
          },
        },
        required: ['filename', 'content'],
      },
    },
    {
      name: 'read_loop',
      description: 'Read the contents of a .loop file.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename of the .loop file to read.' },
        },
        required: ['filename'],
      },
    },
    {
      name: 'list_loops',
      description: 'List all .loop files available in the loop directory.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'validate_loop',
      description: 'Parse a .loop file and report any syntax or schema errors without running it.',
      inputSchema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename of the .loop file to validate.' },
        },
        required: ['filename'],
      },
    },
  ],
}))

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  const a = (args ?? {}) as Record<string, string>

  try {
    switch (name) {
      case 'write_loop': {
        const filePath = resolveLoop(a.filename)
        // Validate before writing
        parseLoopFile(a.content)
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, a.content, 'utf8')
        return text(`Written: ${filePath}\n\nParsed steps: ${parseLoopFile(a.content).steps.map(s => `  • ${s.name} (${s.action})`).join('\n')}`)
      }

      case 'read_loop': {
        const filePath = resolveLoop(a.filename)
        if (!fs.existsSync(filePath)) return text(`File not found: ${filePath}`)
        return text(fs.readFileSync(filePath, 'utf8'))
      }

      case 'list_loops': {
        if (!fs.existsSync(LOOP_DIR)) return text(`Loop directory does not exist: ${LOOP_DIR}`)
        const files = fs.readdirSync(LOOP_DIR).filter(f => f.endsWith('.loop'))
        if (files.length === 0) return text('No .loop files found.')
        const summaries = files.map(f => {
          try {
            const schema = parseLoopFile(fs.readFileSync(path.join(LOOP_DIR, f), 'utf8'))
            const steps = schema.steps.map(s => `${s.name}(${s.action})`).join(' → ')
            return `${f}  [${schema.meta.name}]  ${steps}`
          } catch {
            return `${f}  (parse error)`
          }
        })
        return text(summaries.join('\n'))
      }

      case 'validate_loop': {
        const filePath = resolveLoop(a.filename)
        if (!fs.existsSync(filePath)) return text(`File not found: ${filePath}`)
        const content = fs.readFileSync(filePath, 'utf8')
        try {
          const schema = parseLoopFile(content)
          const lines = [
            `✓ Valid — "${schema.meta.name}" (${schema.steps.length} steps)`,
            ...schema.steps.map((s, i) => `  ${i + 1}. ${s.name}  action=${s.action}${s.retries ? `  retries=${s.retries}` : ''}${s.skipOnError ? '  skipOnError' : ''}`)
          ]
          return text(lines.join('\n'))
        } catch (err) {
          return text(`✗ Invalid: ${(err as Error).message}`)
        }
      }

      default:
        return text(`Unknown tool: ${name}`)
    }
  } catch (err) {
    return text(`Error: ${(err as Error).message}`)
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveLoop(filename: string): string {
  const safe = path.basename(filename)  // prevent path traversal
  return path.resolve(LOOP_DIR, safe.endsWith('.loop') ? safe : `${safe}.loop`)
}

function text(content: string) {
  return { content: [{ type: 'text' as const, text: content }] }
}

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
