#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLoop, describeLoop, parseLoopFile, validateLoopSchema, NullSession } from './index.js'

const HELP = `loop-sdk — run .loop automation files

Usage:
  loop-sdk run <file.loop> [options]
  loop-sdk validate <file.loop>
  loop-sdk install skill  [--force]
  loop-sdk install schema [--force]

Options:
  --var key=value   Set a run-time variable (repeatable, run only)
  --json            Print the final run log as JSON to stdout (run only)
  --force           Overwrite an existing file (install only)
  -h, --help        Show this help
  -v, --version     Show version

Examples:
  loop-sdk run research.loop
  loop-sdk run reply.loop --var profile=work --var topic=AI
  loop-sdk validate research.loop   # lint a .loop file without running it
  loop-sdk install skill            # copy the bundled SKILL.md into ./.claude/skills
  loop-sdk install schema           # copy loop.schema.json into ./.loop-sdk (spec for editors/CI)

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
  if (cmd === 'validate') return validateCommand(argv)
  if (cmd === 'run') return runCommand(argv)
  fail(`unknown command "${cmd}". Try: loop-sdk run <file.loop>  |  loop-sdk validate <file.loop>  |  loop-sdk install skill|schema`)
}

/** `loop-sdk install skill|schema [--force]` — copy a bundled asset into the project. */
function installCommand(argv: string[]): void {
  const target = argv[1]
  const force = argv.includes('--force')

  if (target === 'skill') {
    return installAsset({
      label: 'skill',
      src: '../skills/loop-sdk/SKILL.md',
      destDir: '.claude/skills/loop-sdk',
      file: 'SKILL.md',
      force,
    })
  }
  if (target === 'schema') {
    installAsset({
      label: 'schema',
      src: '../schemas/loop.schema.json',
      destDir: '.loop-sdk',
      file: 'loop.schema.json',
      force,
    })
    process.stdout.write(
      `  This is the machine-readable spec for .loop files — consumed by CI, external\n` +
      `  tooling, and a future editor extension. Lint a file today with:\n` +
      `    loop-sdk validate <file.loop>\n` +
      `  Note: .loop files are front-matter + markdown step sections, not a single YAML\n` +
      `  document, so a plain \`yaml.schemas\` mapping won't validate them cleanly.\n`
    )
    return
  }
  fail(`unknown install target "${target ?? ''}". Usage: loop-sdk install skill|schema [--force]`)
}

function installAsset(opts: {
  label: string
  src: string
  destDir: string
  file: string
  force: boolean
}): void {
  const src = fileURLToPath(new URL(opts.src, import.meta.url))
  if (!existsSync(src)) fail(`bundled ${opts.label} not found at ${src}`)

  const destDir = resolve(process.cwd(), opts.destDir)
  const dest = join(destDir, opts.file)
  const rel = relative(process.cwd(), dest)

  if (existsSync(dest) && !opts.force) {
    process.stdout.write(`${opts.label} already installed at ${rel} — pass --force to overwrite.\n`)
    return
  }
  mkdirSync(destDir, { recursive: true })
  copyFileSync(src, dest)
  process.stdout.write(`✔ Installed loop-sdk ${opts.label} → ${rel}\n`)
}

/** `loop-sdk validate <file.loop>` — parse and lint a .loop file without running it. */
function validateCommand(argv: string[]): void {
  const file = argv[1]
  if (!file || file.startsWith('-')) fail('missing file. Usage: loop-sdk validate <file.loop>')

  const path = resolve(process.cwd(), file)
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    fail(`cannot read file: ${path}`)
  }

  const rel = relative(process.cwd(), path)

  // Parse errors (missing front-matter, no action, no steps) throw here.
  let schema
  try {
    schema = parseLoopFile(content)
  } catch (err) {
    fail(`invalid .loop file (${rel}): ${(err as Error).message}`)
  }

  // Schema problems (unknown actions, duplicate/non-referenceable names,
  // missing required fields) — the same fail-fast checks loadLoop() runs.
  const problems = validateLoopSchema(schema)
  if (problems.length) {
    process.stderr.write(`✗ ${rel} has ${problems.length} problem(s):\n`)
    for (const p of problems) process.stderr.write(`  • ${p}\n`)
    process.exit(1)
  }
  process.stdout.write(`✔ ${rel} is valid.\n`)
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
