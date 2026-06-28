import { generateText, experimental_createMCPClient } from 'ai'
import type { LanguageModel } from 'ai'
import type { Context } from './context.js'

export interface AgentOptions {
  model: LanguageModel
  system?: string
  maxSteps?: number
  /** Attach a screenshot of the current browser state before calling the model. */
  screenshot?: boolean
}

export interface AgentResult {
  ok: true
  text: string
  usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number }
  steps?: unknown[]
}

/**
 * agent — run any AI model as a loop step via the Vercel AI SDK.
 *
 * Pass any @ai-sdk/* model — provider switching is one argument change.
 * If ctx.session.mcpUrl is set, the model gets live browser tool access via MCP.
 *
 * @example
 * import { anthropic } from '@ai-sdk/anthropic'
 * await agent(ctx, 'Summarize the page.', { model: anthropic('claude-opus-4-8') })
 */
export async function agent(ctx: Context, prompt: string, opts: AgentOptions): Promise<AgentResult> {
  const { model, system, maxSteps = 50, screenshot = false } = opts

  type MessageContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; image: Buffer; mimeType: string }>
  let userContent: MessageContent = prompt

  if (screenshot && ctx.session?.screenshot) {
    const imgBytes = await ctx.session.screenshot()
    userContent = [
      { type: 'text', text: prompt },
      { type: 'image', image: imgBytes, mimeType: 'image/jpeg' },
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
      model,
      system,
      tools,
      maxSteps,
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
