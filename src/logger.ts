import fs from 'node:fs'
import path from 'node:path'

export type StepStatus = 'ok' | 'error' | 'running'
export type RunStatus = 'completed' | 'failed' | 'running' | 'cancelled'

export interface StepRecord {
  name: string
  status: StepStatus
  result?: unknown
  error?: string
  startedAt: string
  finishedAt?: string
}

export interface RunDoc {
  loop: string
  session: string
  startedAt: string
  finishedAt: string
  status: RunStatus
  steps: StepRecord[]
}

export class Logger {
  readonly logFile: string | null
  private readonly loopName: string
  private readonly sessionId: string
  private readonly startedAt: string
  private readonly steps: StepRecord[] = []
  private currentStep: StepRecord | null = null

  constructor(logDir: string | null, loopName: string, sessionId: string) {
    this.loopName = loopName
    this.sessionId = sessionId
    this.startedAt = new Date().toISOString()
    this.logFile = null

    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true })
      const ts = this.startedAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
      this.logFile = path.join(logDir, `${ts}_${loopName}.json`)
    }
  }

  write(_: { msg: string; data?: unknown }): void {
    // No-op: stdout output is handled by ctx.log(); structured data is captured in step records
  }

  stepStart(name: string): void {
    this.currentStep = { name, status: 'running', startedAt: new Date().toISOString() }
    this.steps.push(this.currentStep)
  }

  stepDone(result?: unknown): void {
    if (!this.currentStep) return
    this.currentStep.status = 'ok'
    this.currentStep.result = result ?? null
    this.currentStep.finishedAt = new Date().toISOString()
    this.flush('running')
  }

  stepError(err: Error): void {
    if (!this.currentStep) return
    this.currentStep.status = 'error'
    this.currentStep.error = err.message
    this.currentStep.finishedAt = new Date().toISOString()
    this.flush('failed')
  }

  finish(status: RunStatus): void {
    this.flush(status)
  }

  private flush(status: RunStatus): void {
    if (!this.logFile) return
    const doc: RunDoc = {
      loop: this.loopName,
      session: this.sessionId,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      status,
      steps: this.steps,
    }
    try { fs.writeFileSync(this.logFile, JSON.stringify(doc, null, 2)) } catch {}
  }
}
