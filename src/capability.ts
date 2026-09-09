/**
 * The synthetic **Auto** gear: a reasoning-effort level this plugin contributes
 * to a model's advertised list so a user can pick "Auto" next to `off`/`low`/
 * `high`/`max` in the model picker.
 *
 * Why this needs a seam at all: the picker is built from
 * `ctx.llm.resolveModelInfo(provider, model).reasoning.efforts`
 * (`dsh-api-session-controller/lib/types/catalog.js:14-26`) and a selection is
 * validated through `resolveCallConfig`
 * (`dsh-api-session-controller/lib/types/commands.js:126-132`, which rejects any
 * effort the adapter does not declare). There is no contribution hook for
 * either — `registerAdapter` refuses a provider that already has an adapter
 * (`dsh-llm/lib/index.js:1272`, `DUPLICATE_ADAPTER`), so an adapter cannot be
 * wrapped from outside either.
 *
 * So this module wraps exactly two methods on the live `llm` service instance:
 *
 * - `resolveModelInfo` gains the gear in front of the adapter's own rungs, and
 *   makes it the advertised default so the picker shows "Auto" until the user
 *   chooses something else.
 * - `resolveCallConfig` accepts the gear id unchanged. The gear is not an
 *   adapter effort; `src/index.ts` turns it into a real one per turn, before
 *   `prepareCall` ever sees it.
 * - `agentDefaultModel.saveSelection` drops the gear before the deployment
 *   default is persisted, so a profile without this plugin never inherits it.
 *
 * `prepareCall` is deliberately **not** patched. If a gear id ever reaches it
 * (plugin unmounted while a session still selects Auto), the adapter boundary
 * rejects it with `UNSUPPORTED_REASONING_EFFORT` — a loud, in-session error
 * instead of a malformed provider request.
 *
 * @module dsh-auto-thinking-effort/capability
 */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  LlmCallConfig,
  LlmReasoningEffortInfo,
  LlmResolvedModelInfo,
  LlmRuntime,
} from '@deepseek-ai/dsh-llm'

/** The gear this plugin contributes. */
export interface AutoGear {
  /** Synthetic effort id stored in a session's model selection. */
  readonly id: string
  /** Label shown by effort pickers. */
  readonly name: string
  /** Optional one-line explanation shown next to the label. */
  readonly description?: string | undefined
}

/** Original methods, kept per patched service instance. */
interface Restore {
  readonly resolveModelInfo: LlmRuntime['resolveModelInfo']
  readonly resolveCallConfig: LlmRuntime['resolveCallConfig']
}

/** The subset of `agentDefaultModel` this plugin wraps. */
interface DefaultModel {
  saveSelection(selection: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
}

/** Services this plugin has already wrapped, so a second mount cannot double-wrap. */
const PATCHED = new WeakMap<object, Restore>()

/** Default-model services already wrapped, keyed by instance. */
const PATCHED_DEFAULTS = new WeakMap<object, DefaultModel['saveSelection']>()

/**
 * Whether a route advertises selectable efforts at all.
 * @param info - resolved exact-model metadata.
 * @returns whether the gear is meaningful for this route.
 */
export function routeOffersEfforts(info: LlmResolvedModelInfo): boolean {
  return info.reasoning !== undefined && info.reasoning.efforts.length > 0
}

/**
 * Add the gear to one resolved model, leaving every real rung untouched.
 * @param info - the adapter's resolved metadata.
 * @param gear - the synthetic gear.
 * @returns the metadata to expose, or `info` itself when nothing changes.
 */
export function withAutoGear(info: LlmResolvedModelInfo, gear: AutoGear): LlmResolvedModelInfo {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.efforts.length === 0) return info
  if (reasoning.efforts.some((effort) => String(effort.id) === gear.id)) return info
  const entry: LlmReasoningEffortInfo = {
    id: ReasoningEffortId(gear.id),
    name: gear.name,
    ...gear.description === undefined ? {} : { description: gear.description },
  }
  return {
    ...info,
    reasoning: {
      ...reasoning,
      efforts: [entry, ...reasoning.efforts],
      // Advertised as the default so a picker shows "Auto" until the user
      // chooses a concrete rung; the request path treats an absent effort the
      // same way (see `autoWhenUnset`).
      defaultEffort: ReasoningEffortId(gear.id),
    },
  }
}

/**
 * Install the gear on the live LLM service.
 *
 * Idempotent per service instance, and a no-op when no LLM runtime is mounted
 * yet — call it again after `llm/adapters-updated` to cover late mounting.
 *
 * @param ctx - plugin context.
 * @param gear - the gear to contribute.
 * @returns a disposer restoring the original methods (also returned for an
 * already-patched or unavailable service, where it does nothing).
 */
export function installAutoGear(ctx: Context, gear: AutoGear): () => void {
  const llm = ctx.get('llm') as LlmRuntime | undefined
  const restoreDefaults = installDefaultSelectionGuard(ctx, gear)
  if (llm === undefined) return restoreDefaults
  if (PATCHED.has(llm)) return restoreDefaults

  const restore: Restore = {
    resolveModelInfo: llm.resolveModelInfo,
    resolveCallConfig: llm.resolveCallConfig,
  }
  PATCHED.set(llm, restore)

  llm.resolveModelInfo = async function autoGearResolveModelInfo(provider, model, signal) {
    const info = await restore.resolveModelInfo.call(llm, provider, model, signal)
    return withAutoGear(info, gear)
  }

  llm.resolveCallConfig = async function autoGearResolveCallConfig(config, signal) {
    // The gear is resolved per turn by the request listener, never by the
    // adapter, so selection-time validation must accept it verbatim.
    if (config.reasoningEffort === gear.id) return config
    return await restore.resolveCallConfig.call(llm, config, signal)
  }

  return () => {
    restoreDefaults()
    if (PATCHED.get(llm) !== restore) return
    PATCHED.delete(llm)
    llm.resolveModelInfo = restore.resolveModelInfo
    llm.resolveCallConfig = restore.resolveCallConfig
  }
}

/**
 * Keep the gear out of the durable deployment default.
 *
 * Picking the gear in the model picker saves the selection as
 * `agent-default-model` in `settings.yaml`
 * (`dsh-api-session-controller/lib/types/commands.js:142`), which every profile
 * reads. A profile without this plugin would then send the gear id to its
 * adapter and fail every turn. Stripping it stores "no explicit effort"
 * instead: the plugin's own profile still reads that as auto
 * (`autoWhenUnset`), and every other profile gets the provider default.
 *
 * @param ctx - plugin context.
 * @param gear - the gear whose id must not be persisted.
 * @returns a disposer restoring the original method.
 */
function installDefaultSelectionGuard(ctx: Context, gear: AutoGear): () => void {
  const defaults = ctx.get('agentDefaultModel') as DefaultModel | undefined
  if (defaults === undefined || typeof defaults.saveSelection !== 'function') return () => {}
  if (PATCHED_DEFAULTS.has(defaults)) return () => {}
  const original = defaults.saveSelection
  PATCHED_DEFAULTS.set(defaults, original)
  defaults.saveSelection = async function autoGearSaveSelection(selection) {
    if (selection.reasoningEffort !== undefined && String(selection.reasoningEffort) === gear.id) {
      const { reasoningEffort: _gear, ...withoutGear } = selection
      return await original.call(defaults, withoutGear)
    }
    return await original.call(defaults, selection)
  }
  return () => {
    if (PATCHED_DEFAULTS.get(defaults) !== original) return
    PATCHED_DEFAULTS.delete(defaults)
    defaults.saveSelection = original
  }
}

/**
 * Test whether one request carries the synthetic gear.
 * @param config - the composed call configuration.
 * @param gear - the gear id.
 * @returns whether the request asks for the gear.
 */
export function requestsAutoGear(config: LlmCallConfig, gear: string): boolean {
  return config.reasoningEffort !== undefined && String(config.reasoningEffort) === gear
}
