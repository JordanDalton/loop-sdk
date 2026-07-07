import type { LanguageModel } from 'ai'

/**
 * Model registry — turn a friendly "provider:model" string into a live AI SDK
 * LanguageModel, so the SAME identifier works in JS and in a .loop file.
 *
 *   "claude-code:sonnet"        → ai-sdk-provider-claude-code
 *   "codex:gpt-5.2-codex"       → ai-sdk-provider-codex-cli
 *   "anthropic:claude-opus-4-8" → @ai-sdk/anthropic
 *   "openai:gpt-5"              → @ai-sdk/openai
 *   "sonnet"                    → default provider (claude-code)
 *
 * The string grammar is the Vercel AI SDK's own registry convention
 * (`provider:model`). Providers are resolved lazily and NONE is a hard
 * dependency of loop-sdk — a model string only needs the one package that
 * backs it installed, and a missing package fails with a `npm i …` hint.
 */

/** Given a model id (and optional provider-specific settings), build a LanguageModel. */
export type ModelFactory = (
  modelId: string,
  settings?: Record<string, unknown>,
) => LanguageModel | Promise<LanguageModel>

interface ProviderEntry {
  /** npm package that backs this provider — shown in the "not installed" hint. */
  pkg: string
  /** Resolve (and cache) the provider's factory the first time it's needed. */
  load: () => Promise<ModelFactory>
}

/** The provider used for a bare model string with no "provider:" prefix. */
export const DEFAULT_PROVIDER = 'claude-code'

/** The AI SDK model-spec version loop-sdk speaks. AI SDK 6 → LanguageModelV3. */
const EXPECTED_SPEC = 'v3'
const SDK_MAJOR = 6
const OLDER_SPECS: Record<string, string> = { v1: 'AI SDK 3/4', v2: 'AI SDK 5' }

/**
 * Turn the raw "Unsupported model version" failure into an actionable one: a
 * provider built for a different AI SDK major (older spec = older SDK, newer
 * spec = a newer SDK) can't drive loop-sdk's generateText. Fail with the fix,
 * not the symptom.
 */
function assertModelVersion(model: LanguageModel): void {
  const spec = (model as { specificationVersion?: string }).specificationVersion
  if (spec && spec !== EXPECTED_SPEC) {
    const targets = OLDER_SPECS[spec] ?? 'a newer AI SDK'
    throw new Error(
      `This model implements AI SDK model spec "${spec}" (${targets}), but loop-sdk uses ` +
      `AI SDK ${SDK_MAJOR} (spec "${EXPECTED_SPEC}"). Install a v${SDK_MAJOR}-compatible build of ` +
      `the provider package, or align your @ai-sdk/* versions with loop-sdk's.`,
    )
  }
}

const providers = new Map<string, ProviderEntry>()

/**
 * Register a lazily-imported provider: the package is only `import()`ed the
 * first time a model string names it, and its factory is cached thereafter.
 */
function lazy(pkg: string, pick: (mod: any) => ModelFactory): ProviderEntry {
  let cached: ModelFactory | null = null
  return {
    pkg,
    load: async () => {
      if (cached) return cached
      let mod: unknown
      try {
        mod = await import(pkg)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new Error(
          `Model provider "${pkg}" is not installed — run: npm i ${pkg}\n(import failed: ${reason})`,
        )
      }
      cached = pick(mod)
      return cached
    },
  }
}

// CLI-backed providers first (subscription auth, no API key), then the API
// providers. Each factory normalizes to (modelId, settings?) => LanguageModel.
providers.set('claude-code', lazy('ai-sdk-provider-claude-code', (m: any) => {
  const provider = m.claudeCode ?? m.default
  // Per-call settings (mcpServers, allowedTools, cwd, …) are the model
  // factory's SECOND argument (ClaudeCodeSettings). createClaudeCode() is only
  // for provider-level DEFAULTS and takes a different shape — routing settings
  // through it silently drops mcpServers.
  return (id, settings) => provider(id, settings)
}))
providers.set('codex', lazy('ai-sdk-provider-codex-cli', (m: any) => {
  const provider = m.codexCli ?? m.default
  // Codex takes per-model settings as the second arg (reasoningEffort, sandboxMode, …).
  return (id, settings) => provider(id, settings)
}))
providers.set('anthropic', lazy('@ai-sdk/anthropic', (m: any) => (id, settings) => m.anthropic(id, settings)))
providers.set('openai', lazy('@ai-sdk/openai', (m: any) => (id, settings) => m.openai(id, settings)))

// Friendly alias — "claude:opus" reads the same as "claude-code:opus".
providers.set('claude', providers.get('claude-code')!)

export interface ResolveModelOptions {
  /** Provider-specific settings passed to the factory when `model` is a string. */
  settings?: Record<string, unknown>
  /** Provider to use when the string has no "provider:" prefix. Default: DEFAULT_PROVIDER. */
  defaultProvider?: string
}

/**
 * Resolve a model spec into a LanguageModel. A LanguageModel object passes
 * through untouched; a "provider:model" (or bare "model") string is looked up
 * in the registry. Async because the backing provider package is imported on
 * demand.
 *
 * @example
 * const model = await resolveModel('claude-code:sonnet')
 * const same  = await resolveModel(anthropic('claude-opus-4-8')) // pass-through
 */
export async function resolveModel(
  model: LanguageModel | string,
  opts: ResolveModelOptions = {},
): Promise<LanguageModel> {
  if (typeof model !== 'string') {
    assertModelVersion(model)
    return model
  }

  const sep = model.indexOf(':')
  // A leading "provider:" prefix — but not a bare id that happens to contain a
  // colon (e.g. an org/model path). The provider segment is a plain token.
  const hasPrefix = sep > 0 && /^[\w-]+$/.test(model.slice(0, sep))
  const providerId = hasPrefix ? model.slice(0, sep) : (opts.defaultProvider ?? DEFAULT_PROVIDER)
  const modelId = hasPrefix ? model.slice(sep + 1) : model

  const entry = providers.get(providerId)
  if (!entry) {
    throw new Error(
      `Unknown model provider "${providerId}" in "${model}". ` +
      `Known providers: ${knownProviders().join(', ')}. ` +
      `Register a new one with registerProvider("${providerId}", …).`,
    )
  }

  const factory = await entry.load()
  const built = await factory(modelId, opts.settings)
  assertModelVersion(built)
  return built
}

/**
 * Register a custom provider (or override a built-in) under an id usable as a
 * "id:model" prefix. The factory is called with the model id and any settings.
 *
 * @example
 * import { createOpenAI } from '@ai-sdk/openai'
 * const grok = createOpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: process.env.XAI_KEY })
 * registerProvider('grok', (id) => grok(id))
 * await agent(ctx, prompt, { model: 'grok:grok-2' })
 */
export function registerProvider(id: string, factory: ModelFactory): void {
  providers.set(id, { pkg: id, load: async () => factory })
}

/** The provider ids currently registered (built-ins plus any custom ones). */
export function knownProviders(): string[] {
  return [...providers.keys()]
}
