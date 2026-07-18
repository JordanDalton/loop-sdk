export { Loop, run } from './loop.js'
export type { Plugin, StepOptions, RunOptions, RunLog, RunHandle, HandleStatus, StepFn, StepResult } from './loop.js'

export { RetryPlugin } from './plugins/retry.js'
export type { RetryPluginOptions } from './plugins/retry.js'

export { Session, NullSession } from './session.js'
export type { ClickOptions, ScrollOptions } from './session.js'

export { Context } from './context.js'
export type { ContextOptions } from './context.js'

export { Logger } from './logger.js'
export type { RunStatus, StepStatus, RunDoc, StepRecord } from './logger.js'

export { each, sub, subloop } from './flow.js'
export type { Item, EachOptions } from './flow.js'

export { agent } from './agent.js'
export type { AgentOptions, AgentResult } from './agent.js'

export { resolveModel, registerProvider, knownProviders, DEFAULT_PROVIDER } from './registry.js'
export type { ModelFactory, ResolveModelOptions } from './registry.js'

export { claudeCli, buildPermissionArgs, STRICT_DEFAULT_TOOLS } from './claude-cli.js'
export type { ClaudeCliOptions, ClaudeCliResult } from './claude-cli.js'

export { codexCli, codexMcpArgs } from './codex-cli.js'
export type { CodexCliOptions, CodexCliResult } from './codex-cli.js'

export { checkpointExists, deleteCheckpoint } from './checkpoint.js'
export type { Checkpoint, EffectRecord, WaitRecord } from './checkpoint.js'

export { effect } from './effect.js'
export type { EffectFn, EffectOptions, EffectCompensation } from './effect.js'

export { waitFor, SuspendSignal, WaitTimeoutError } from './suspend.js'
export type { SuspendOptions, DispatchFn } from './suspend.js'

export { loadLoop, loadLoopFile, parseLoopFile, runFile, runFileBackground, resolveMode, validateOutput, MAX_SUBLOOP_DEPTH } from './loopfile.js'
export type { LoopFileMeta, LoopFileStep, LoopFileSchema, ActionRegistry, LoadOptions, ExpectContract } from './loopfile.js'

export { describeLoop, describeSchema } from './describe.js'
export type { LoopDescription } from './describe.js'

export { validateLoopSchema, BUILTIN_ACTIONS } from './validate.js'

export { ensureWorktree, WORKTREE_STATE_KEY } from './worktree.js'

export { loadMcpRegistry, resolveMcpServers, MCP_REGISTRY_PATH } from './mcp-registry.js'
export type { McpSpec, McpServerDef } from './mcp-registry.js'

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
  LoopSuspendEvent,
  UsageEvent,
  AgentActivityEvent,
  WorktreeCreatedEvent,
} from './events.js'

export { PlaywrightSession } from './providers/playwright.js'

export { notify, notifyOn } from './notify.js'
export type { NotifyOptions, NotifyOnOptions } from './notify.js'
