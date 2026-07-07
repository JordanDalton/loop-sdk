import { generateText, stepCountIs } from 'ai'
import { experimental_createMCPClient } from '@ai-sdk/mcp'
import type { LanguageModel } from 'ai'
import type { Context } from './context.js'
import { resolveModel } from './registry.js'

export interface AgentOptions {
  /**
   * The model to run. Either a LanguageModel object (any `@ai-sdk/*` model) or
   * a friendly "provider:model" string resolved via the registry — e.g.
   * "claude-code:sonnet", "codex:gpt-5.2-codex", "anthropic:claude-opus-4-8".
   * A bare id (no "provider:") uses the default provider.
   */
  model: LanguageModel | string
  system?: string
  maxSteps?: number
  /** Attach a screenshot of the current browser state before calling the model. */
  screenshot?: boolean
  /** Provider-specific settings applied when `model` is a string (e.g. { allowedTools }). */
  modelSettings?: Record<string, unknown>
}

export interface AgentResult {
  ok: true
  text: string
  /** AI SDK 5 token usage — input/output/total (v4's prompt/completion were renamed). */
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number }
  steps?: unknown[]
}

/**
 * agent — run any AI model as a loop step via the Vercel AI SDK.
 *
 * Pass any @ai-sdk/* model — provider switching is one argument change — or a
 * "provider:model" string resolved by the registry. If ctx.session.mcpUrl is
 * set, the model gets live browser tool access via MCP (note: the CLI-backed
 * providers claude-code/codex run their own tool loop and ignore AI SDK tools —
 * use a claudeCli step for browser work with those).
 *
 * @example
 * import { anthropic } from '@ai-sdk/anthropic'
 * await agent(ctx, 'Summarize the page.', { model: anthropic('claude-opus-4-8') })
 * await agent(ctx, 'Summarize the page.', { model: 'claude-code:sonnet' })
 */
export async function agent(ctx: Context, prompt: string, opts: AgentOptions): Promise<AgentResult> {
  const { model, system, maxSteps = 50, screenshot = false, modelSettings } = opts
  const resolvedModel = await resolveModel(model, { settings: modelSettings })

  type MessageContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer; mediaType: string }>
  let userContent: MessageContent = prompt

  if (screenshot && ctx.session?.screenshot) {
    const imgBytes = await ctx.session.screenshot()
    userContent = [
      { type: 'text', text: prompt },
      { type: 'image', image: imgBytes, mediaType: 'image/jpeg' },
    ]
  }

  let tools: Awaited<ReturnType<Awaited<ReturnType<typeof experimental_createMCPClient>>['tools']>> | undefined
  let mcpClient: Awaited<ReturnType<typeof experimental_createMCPClient>> | null = null

  if (ctx.session?.mcpUrl) {
    mcpClient = await experimental_createMCPClient({
      transport: { type: 'sse', url: ctx.session.mcpUrl },
    })
    tools = await mcpClient.tools()
  }

  try {
    const result = await generateText({
      model: resolvedModel,
      system,
      tools,
      // AI SDK 5 replaced `maxSteps` with a stop condition.
      stopWhen: stepCountIs(maxSteps),
      messages: [{ role: 'user', content: userContent }],
    })

    ctx.log(`agent: ${result.usage?.totalTokens ?? '?'} tokens`, {
      steps: result.steps?.length,
      finishReason: result.finishReason,
    })

    return { ok: true, text: result.text, usage: result.usage, steps: result.steps }
  } finally {
    await mcpClient?.close().catch(() => {})
  }
}
