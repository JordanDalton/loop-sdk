/**
 * run-loopfile.js — load and execute a .loop file
 *
 * Usage:
 *   npm run build
 *   node examples/run-loopfile.js [path/to/file.loop]
 *
 * Defaults to examples/hello.loop if no path is given.
 */

import { runFile } from '../dist/index.js'
import { MockSession } from './mock-session.js'

const filePath = process.argv[2] ?? './examples/hello.loop'
const session = new MockSession('loopfile-run')

console.log(`Running: ${filePath}\n`)

await runFile(filePath, session)
