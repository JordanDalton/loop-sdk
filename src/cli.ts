#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLoop, describeLoop, NullSession } from './index.js'

const HELP = `loop-sdk — run .loop automation files

Usage:
  loop-sdk run <file.loop> [options]
  loop-sdk install skill [--force]

Options:
  --var key=value   Set a run-time variable (repeatable, run only)
  --json            Print the final run log as JSON to stdout (run only)
  --force           Overwrite an existing skill (install only)
  -h, --help        Show this help
  -v, --version     Show version

Examples:
  loop-sdk run research.loop
  loop-sdk run reply.loop --var profile=work --var topic=AI
  loop-sdk install skill        # copy the bundled SKILL.md into ./.claude/skills

Notes:
  The CLI runs browserless loops (claudeCli / codexCli / verify / data steps)
  with a built-in no-op session. claudeCli steps require the \`claude\` CLI on
  PATH. Loops that declare \`session: browser\` need a browser provider — run
  those via the JS API (runFile) with your own Session.
`

function fail(msg: string): never {
  process.stderr.write(`✗ ${msg}\n`)
  process.exit(1)
}

function parseVars(rest: string[]): Record<string, string> {
  const vars: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--json') continue
    const kv = a === '--var' ? rest[++i] : a.startsWith('--var=') ? a.slice(6) : null
    if (kv == null) fail(`unknown option "${a}"`)
    const eq = kv.indexOf('=')
    if (eq === -1) fail(`--var expects key=value, got "${kv}"`)
    vars[kv.slice(0, eq)] = kv.slice(eq + 1)
  }
  return vars
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]

  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(HELP)
    return
  }
  if (cmd === '-v' || cmd === '--version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    process.stdout.write(`${pkg.version}\n`)
    return
  }
  if (cmd === 'install') return installCommand(argv)
  if (cmd === 'run') return runCommand(argv)
  fail(`unknown command "${cmd}". Try: loop-sdk run <file.loop>  |  loop-sdk install skill`)
}

/** `loop-sdk install skill [--force]` — copy the bundled SKILL.md into the project. */
function installCommand(argv: string[]): void {
  const target = argv[1]
  if (target !== 'skill') {
    fail(`unknown install target "${target ?? ''}". Usage: loop-sdk install skill [--force]`)
  }
  const force = argv.includes('--force')
  const src = fileURLToPath(new URL('../skills/loop-sdk/SKILL.md', import.meta.url))
  if (!existsSync(src)) fail(`bundled skill not found at ${src}`)

  const destDir = resolve(process.cwd(), '.claude/skills/loop-sdk')
  const dest = join(destDir, 'SKILL.md')
  const rel = relative(process.cwd(), dest)

  if (existsSync(dest) && !force) {
    process.stdout.write(`Skill already installed at ${rel} — pass --force to overwrite.\n`)
    return
  }
  mkdirSync(destDir, { recursive: true })
  copyFileSync(src, dest)
  process.stdout.write(`✔ Installed loop-sdk skill → ${rel}\n`)
}

async function runCommand(argv: string[]): Promise<void> {
  const file = argv[1]
  if (!file || file.startsWith('-')) fail('missing file. Usage: loop-sdk run <file.loop>')

  const asJson = argv.includes('--json')
  const vars = parseVars(argv.slice(2))

  const path = resolve(process.cwd(), file)
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    fail(`cannot read file: ${path}`)
  }

  let desc
  try {
    desc = describeLoop(content)
  } catch (err) {
    fail(`invalid .loop file: ${(err as Error).message}`)
  }

  // Browser loops need a provider the CLI deliberately does not bundle.
  if (desc.needsBrowser) {
    fail(
      `"${desc.name}" declares session: browser — the CLI runs browserless loops only.\n` +
        `  Run it via the JS API with your Session provider:\n` +
        `    import { runFile } from 'loop-sdk'\n` +
        `    await runFile('${file}', session)`
    )
  }

  // Fail fast on refs the loop needs but nothing supplies.
  const missing = desc.referencedVars.filter((v) => !(v in vars))
  if (missing.length) {
    fail(
      `loop needs vars with no source: ${missing.join(', ')}\n` +
        `  supply them, e.g. --var ${missing[0]}=<value>`
    )
  }

  const loop = loadLoop(path)
  const session = new NullSession('cli')

  // The loop prints its own progress to stdout. In --json mode we suppress that
  // so stdout carries only the JSON run log (pipeable); progress notes go nowhere.
  const origWrite = process.stdout.write.bind(process.stdout)
  if (asJson) process.stdout.write = (() => true) as typeof process.stdout.write

  const log = await loop.run({ session, vars, logDir: null })
  await session.destroy().catch(() => {})

  if (asJson) {
    process.stdout.write = origWrite
    origWrite(`${JSON.stringify(log, null, 2)}\n`)
  }
  process.exit(log.status === 'completed' ? 0 : 1)
}

main().catch((err) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
