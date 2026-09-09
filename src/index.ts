/**
 * dsh-auto-thinking-effort — pick the reasoning-effort level per turn from the
 * user's question.
 *
 * The plugin owns exactly one piece of request state: `reasoningEffort`. It
 * never touches the provider, the model, the prompt, or the message list.
 *
 * ## How a user drives it
 *
 * The plugin contributes one extra gear — **Auto** — to every route that
 * advertises selectable efforts (`src/capability.ts`), so the model picker
 * shows `Auto, off, low, high, max`. Then:
 *
 * | Session selection | Behaviour |
 * |---|---|
 * | `Auto` (the synthetic gear) | this plugin decides every turn |
 * | no explicit effort (`autoWhenUnset`) | this plugin decides every turn |
 * | `off` / `low` / `high` / `max` | untouched — a manual choice always wins |
 *
 * The gear is *not* an adapter effort. It is substituted for a real one before
 * `prepareCall` runs, so it can never reach a provider request.
 *
 * ## Where it hooks, and why
 *
 * - `agent/pre-step` is the only seam that sees the user's own words before the
 *   request is composed. The claimed messages carry the turn's question; a
 *   message whose source is not `user` (plugin-injected context, tool results)
 *   is ignored, so the classifier never grades its own plumbing.
 * - `agent/request` is the seam the agent loop documents for replacing the
 *   frozen call configuration. It is registered with `prepend: true` so this
 *   listener stays the outermost one and therefore has the last word: an agent
 *   preset's `installModelSelection` listener would otherwise re-apply the
 *   session's stored effort over the plugin's decision.
 *
 * Every failure path returns the composed configuration unchanged — except when
 * the request carries the synthetic gear, which must never reach the adapter:
 * then the effort is replaced by the route's own default, or dropped.
 *
 * @module dsh-auto-thinking-effort
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmRuntime, UserMessage } from '@deepseek-ai/dsh-llm'
import { installAutoGear, requestsAutoGear } from './capability.ts'
import type { AutoGear } from './capability.ts'
import { classify } from './classify.ts'
import type { Decision } from './classify.ts'
import { Config, prepareConfig } from './config.ts'
import type { ConfigShape, PreparedConfig } from './config.ts'
import { levelForScore, resolveEffort } from './levels.ts'
import { AgentState } from './state.ts'

/** Plugin name, used by the composition row and every log line. */
export const name = 'auto-thinking-effort'

/**
 * No hard service dependency: `llm` is resolved lazily through `ctx.get`, so a
 * deployment without an LLM runtime still boots and reports the gap per turn
 * instead of failing the plugin tree.
 */
export const inject: string[] = []

export { Config }
export type { ConfigShape as AutoThinkingEffortConfig }
export { installAutoGear, withAutoGear } from './capability.ts'
export type { AutoGear } from './capability.ts'

/** Everything one request decision needs, bundled to keep the handler flat. */
interface RequestContext {
  readonly ctx: Context
  readonly config: ConfigShape
  readonly prepared: PreparedConfig
  readonly state: AgentState
  readonly capabilities: Map<string, Promise<string[] | undefined>>
  readonly warned: Set<string>
  readonly logger: ReturnType<Context['logger']>
  readonly turn: number
  readonly step: number
}

/**
 * Install the plugin's listeners and the synthetic gear.
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - validated plugin configuration.
 * @throws when the configuration is invalid (fail loud at load time).
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const prepared = prepareConfig(config)
  const logger = ctx.logger(name)
  const gear: AutoGear = {
    id: config.autoEffortId,
    name: config.autoEffortName,
    description: config.autoEffortDescription,
  }

  const states = new Map<string, AgentState>()
  const capabilities = new Map<string, Promise<string[] | undefined>>()
  const warned = new Set<string>()

  // The gear is advertised only while the plugin is on; the sanitizer below
  // stays registered either way so a session that still selects Auto after the
  // plugin was disabled cannot send that id to a provider.
  if (config.enabled) {
    ctx.effect(() => installAutoGear(ctx, gear), 'auto-thinking-effort: Auto gear')
    ctx.on('llm/adapters-updated', () => {
      // A late-mounting or hot-reloaded LLM service gets the gear too.
      installAutoGear(ctx, gear)
    })
  }

  const stateFor = (agent: Agent): AgentState => {
    const existing = states.get(agent.id)
    if (existing !== undefined) return existing
    const created = new AgentState(prepared.levels)
    states.set(agent.id, created)
    return created
  }

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
  })
  ctx.on('session/disposed', (session) => {
    states.delete(session.id)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!config.enabled) return decision
    // A subagent's route and effort belong to whoever spawned it: do not even
    // classify. Its gear (if one was inherited) is still resolved below.
    if (!config.applyToSubagents && payload.agent.session.header.origin === 'subagent') return decision
    try {
      observeTurn(config, prepared, stateFor(payload.agent), payload.turn, payload.messages)
    } catch (error) {
      logger.warn('turn %d: classification failed, keeping the composed effort: %s', payload.turn, String(error))
    }
    return decision
  })

  // `prepend` keeps this listener outermost, so its replacement config is the
  // one the loop builds the request from (see the module header).
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      const gearRequested = requestsAutoGear(resolved, config.autoEffortId)
      const subagent = payload.agent.session.header.origin === 'subagent'
      if (subagent && !config.applyToSubagents && !gearRequested) return resolved
      return await decideEffort({
        ctx,
        config,
        prepared,
        state: stateFor(payload.agent),
        capabilities,
        warned,
        logger,
        turn: payload.turn,
        step: payload.step,
      }, resolved)
    } catch (error) {
      logger.warn('turn %d: effort selection failed, keeping the composed effort: %s', payload.turn, String(error))
      return resolved
    }
  }, { prepend: true })

  if (config.enabled) {
    logger.info(
      'enabled — gear %s, %d level(s) [%s], %d rule(s), dryRun=%s, subagents=%s',
      config.autoEffortId,
      prepared.levels.length,
      prepared.levels.map((level) => `${level.id}→${level.effort}`).join(' '),
      prepared.rules.length,
      String(config.dryRun),
      config.applyToSubagents ? 'on' : 'off',
    )
  } else {
    logger.info('disabled — only the %s sanitizer is active', config.autoEffortId)
  }
}

/**
 * Classify one step's user text and record the turn's level.
 * @param config - validated configuration.
 * @param prepared - validated ladder and compiled rules.
 * @param state - the agent's rolling state.
 * @param turn - the turn proposing this step.
 * @param messages - the messages claimed for the step.
 */
function observeTurn(
  config: ConfigShape,
  prepared: PreparedConfig,
  state: AgentState,
  turn: number,
  messages: readonly UserMessage[],
): void {
  const text = extractUserText(messages)
  if (text === undefined) {
    state.observe(turn, undefined)
    return
  }
  const decision: Decision = classify(text, {
    levels: prepared.levels,
    rules: prepared.rules,
    maxChars: config.maxChars,
    inheritOnContinuation: config.inheritOnContinuation,
    previous: state.last,
  })
  state.observe(turn, decision)
}

/**
 * Join the text blocks of messages the human actually wrote.
 * @param messages - messages claimed for the step.
 * @returns the joined text, or `undefined` when the step carried no user text.
 */
function extractUserText(messages: readonly UserMessage[]): string | undefined {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  const joined = parts.join('\n').trim()
  return joined === '' ? undefined : joined
}

/**
 * Resolve the turn's level against the routed model and rewrite the effort.
 *
 * Three request shapes reach this function:
 *
 * - the synthetic gear (always substituted — it must not reach the adapter),
 * - no explicit effort with `autoWhenUnset` (classified like the gear, but left
 *   alone when the turn was never observed),
 * - a concrete effort (returned untouched: a manual choice wins).
 *
 * @param context - the per-request decision context.
 * @param resolved - the configuration the loop would use without this plugin.
 * @returns the configuration to use; `resolved` itself when nothing changes.
 */
async function decideEffort(context: RequestContext, resolved: LlmCallConfig): Promise<LlmCallConfig> {
  const { config, prepared, state, logger, turn, step } = context
  const gearRequested = requestsAutoGear(resolved, config.autoEffortId)

  if (!config.enabled) {
    // Only the sanitizer runs: a stored gear still must not reach the adapter.
    if (!gearRequested) return resolved
    const fallbackLevel = levelForScore(prepared.levels, 0)
    const rungs = await supportedEfforts(context, resolved.provider, resolved.model)
    const sanitized = rungs === undefined ? undefined : resolveEffort(prepared.levels, fallbackLevel, rungs)
    return sanitized === undefined ? withoutEffort(resolved) : { ...resolved, reasoningEffort: ReasoningEffortId(sanitized.effort) }
  }
  const auto = gearRequested || (resolved.reasoningEffort === undefined && config.autoWhenUnset)
  if (!auto) return resolved

  const record = state.forTurn(turn)
  if (record === undefined && !gearRequested) return resolved
  const level = record === undefined
    ? levelForScore(prepared.levels, 0)
    : prepared.levels.find((candidate) => candidate.id === record.level) ?? levelForScore(prepared.levels, 0)

  const supported = await supportedEfforts(context, resolved.provider, resolved.model)
  if (supported === undefined || supported.length === 0) {
    // No selectable rung on this route: a gear must still be removed.
    warnOnce(context, `no-efforts:${resolved.provider}/${resolved.model}`, 'warn',
      'turn %d: %s/%s declares no selectable reasoning efforts — %s',
      turn, resolved.provider, resolved.model,
      gearRequested ? 'the Auto gear is dropped from the request' : 'effort left at the composed value')
    return gearRequested ? withoutEffort(resolved) : resolved
  }

  const resolution = resolveEffort(prepared.levels, level, supported)
  if (resolution === undefined) {
    warnOnce(context, `ladder:${resolved.provider}/${resolved.model}`, 'warn',
      'turn %d: %s/%s supports [%s], which shares no rung with the configured ladder — %s',
      turn, resolved.provider, resolved.model, supported.join(' '),
      gearRequested ? 'the Auto gear is dropped from the request' : 'effort left unchanged')
    return gearRequested ? withoutEffort(resolved) : resolved
  }

  const changed = resolved.reasoningEffort !== resolution.effort
  if (config.logDecisions) {
    logger.info(
      'turn %d step %d: level %s → effort %s (%s%s%s; score %d%s)',
      turn,
      step,
      level.id,
      resolution.effort,
      record === undefined ? 'default' : record.pinned ? 'pinned' : record.origin,
      changed ? `, was ${String(resolved.reasoningEffort)}` : ', unchanged',
      resolution.clamped ? ', clamped to the nearest supported rung' : '',
      record?.score ?? 0,
      record === undefined || record.reasons.length === 0 ? '' : ` — ${record.reasons.join('; ')}`,
    )
  }
  if (config.dryRun || !changed) return resolved
  return { ...resolved, reasoningEffort: ReasoningEffortId(resolution.effort) }
}

/**
 * Drop the effort field, restoring the provider's own default.
 * @param config - the composed configuration.
 * @returns a copy without `reasoningEffort`.
 */
function withoutEffort(config: LlmCallConfig): LlmCallConfig {
  const { reasoningEffort: _dropped, ...rest } = config
  return rest
}

/**
 * Read the effort ids one exact route declares, cached per route.
 * @param context - the per-request decision context.
 * @param provider - provider route.
 * @param model - exact model id.
 * @returns the declared effort ids without the synthetic gear, or `undefined`
 * when the route declares none (or no LLM runtime is mounted, or the lookup
 * failed).
 */
async function supportedEfforts(context: RequestContext, provider: string, model: string): Promise<string[] | undefined> {
  const key = `${provider}\u0000${model}`
  const cached = context.capabilities.get(key)
  if (cached !== undefined) return await cached
  const pending = (async (): Promise<string[] | undefined> => {
    const llm = context.ctx.get('llm') as LlmRuntime | undefined
    if (llm === undefined) return undefined
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info.reasoning?.efforts
      if (efforts === undefined) return undefined
      // The gear is advertised through the same call this plugin patched; it is
      // not a rung and must not distort clamping.
      const ids = efforts.map((effort) => String(effort.id)).filter((id) => id !== context.config.autoEffortId)
      return ids.length === 0 ? undefined : ids
    } catch (error) {
      context.logger.warn('model capability lookup failed for %s/%s: %s', provider, model, String(error))
      return undefined
    }
  })()
  context.capabilities.set(key, pending)
  return await pending
}

/**
 * Log one message once per key.
 * @param context - the per-request decision context.
 * @param key - dedupe key.
 * @param level - logger method to use.
 * @param message - printf-style message.
 * @param args - message arguments.
 */
function warnOnce(context: RequestContext, key: string, level: 'warn' | 'debug', message: string, ...args: unknown[]): void {
  if (context.warned.has(key)) return
  context.warned.add(key)
  const log = level === 'warn' ? context.logger.warn : context.logger.debug
  log.call(context.logger, message, ...args)
}
