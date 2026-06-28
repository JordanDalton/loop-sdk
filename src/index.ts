export { Loop, run } from './loop.js'
export type { Plugin, StepOptions, RunOptions, RunLog, RunHandle, HandleStatus, StepFn, StepResult } from './loop.js'

export { RetryPlugin } from './plugins/retry.js'
export type { RetryPluginOptions } from './plugins/retry.js'

export { Session } from './session.js'
export type { ClickOptions, ScrollOptions } from './session.js'

export { Context } from './context.js'
export type { ContextOptions } from './context.js'

export { Logger } from './logger.js'
export type { RunStatus, StepStatus, RunDoc, StepRecord } from './logger.js'

export { each, sub } from './flow.js'
export type { Item, EachOptions } from './flow.js'

export { agent } from './agent.js'
export type { AgentOptions, AgentResult } from './agent.js'

export { claudeCli } from './claude-cli.js'
export type { ClaudeCliOptions, ClaudeCliResult } from './claude-cli.js'

export { checkpointExists, deleteCheckpoint } from './checkpoint.js'
export type { Checkpoint } from './checkpoint.js'

export { loadLoop, loadLoopFile, parseLoopFile, runFile, runFileBackground } from './loopfile.js'
export type { LoopFileMeta, LoopFileStep, LoopFileSchema, ActionRegistry } from './loopfile.js'

export { Emitter } from './events.js'
export type {
  LoopEvents,
  LoopStartEvent,
  LoopCompleteEvent,
  StepStartEvent,
  StepCompleteEvent,
  StepErrorEvent,
  StepSkipEvent,
  StepRetryEvent,
  CheckpointSavedEvent,
} from './events.js'

export { PlaywrightSession } from './providers/playwright.js'

export { notify, notifyOn } from './notify.js'
export type { NotifyOptions, NotifyOnOptions } from './notify.js'
