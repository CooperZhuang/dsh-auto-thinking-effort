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
import { levelForScore, resolveEffort, weakestRung } from './levels.ts'
import type { LevelSpec } from './levels.ts'
import { runModelClassifier } from './model-classifier.ts'
import type { ClassifierAnswer, ClassifierRoute } from './model-classifier.ts'
import { AgentState } from './state.ts'
import type { TurnRecord } from './state.ts'

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
  readonly agent: Agent
  readonly pending: Map<string, PendingClassification>
  readonly cache: Map<string, string>
  readonly capabilities: Map<string, Promise<string[] | undefined>>
  readonly warned: Set<string>
  readonly logger: ReturnType<Context['logger']>
  readonly turn: number
  readonly step: number
  readonly signal: AbortSignal
}

/**
 * One turn's model classification, keyed by agent. The text is kept so the call
 * can still be started at request time when no classifier route was known
 * during `agent/pre-step`.
 */
interface PendingClassification {
  readonly turn: number
  readonly text: string
  promise?: Promise<ClassifierAnswer | undefined>
}
/** Context `supportedEfforts` needs; a full {@link RequestContext} satisfies it. */
type CapabilityContext = Pick<RequestContext, 'ctx' | 'config' | 'capabilities' | 'logger'>

/**
 * Settings namespace this plugin owns. The composition row in `cordis.patch.yml`
 * is the **base** layer; the user layer lives in `settings.yaml` under this key,
 * so programmatic writes and hand edits land in the same documented place.
 */
export const SETTINGS_NAMESPACE = 'auto-thinking-effort'

/**
 * The slice of `ctx.settings` this plugin uses, declared structurally on
 * purpose: the plugin works without a settings provider (it then runs on the
 * composition row alone), so `@deepseek-ai/dsh-settings` is not a peer.
 * Mirrors `SettingsProvider.register` and `SettingsScope` — see
 * `dsh-settings/lib/types/index.d.ts:206` and `:84-113`.
 */
interface SettingsScope {
  /** Resolved value: schema defaults, then the composition base, then the user layer. */
  get(): ConfigShape
  /** Observe committed changes to the resolved value. */
  watch(callback: (next: ConfigShape, previous: ConfigShape) => void | Promise<void>): () => void
}
interface SettingsRegistry {
  register(namespace: string, schema: unknown, options: {
    base?: Partial<ConfigShape>
    applies?: 'live' | 'restart'
    validate?: (value: ConfigShape) => void
  }): SettingsScope
}

/** One resolved configuration plus everything derived from it. */
interface Runtime {
  readonly config: ConfigShape
  readonly prepared: PreparedConfig
  readonly gear: AutoGear
}

/**
 * Install the plugin's listeners and the synthetic gear.
 *
 * The configuration is resolved through a settings namespace when the
 * deployment mounts one: the composition row is the base layer and
 * `settings.yaml` the user layer, so a change there reconfigures the running
 * host without reloading the plugin row.
 *
 * @param ctx - plugin context; every registration is disposed with it.
 * @param config - the composition row's configuration (the settings base layer).
 * @throws when the configuration is invalid (fail loud at load time).
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const logger = ctx.logger(name)
  // The composition row alone must already be valid: a mount that cannot run is
  // a configuration bug, and stopping the plugin tree is the loud answer.
  let runtime = buildRuntime(config)

  const states = new Map<string, AgentState>()
  const classifications = new Map<string, PendingClassification>()
  const classifierCache = new Map<string, string>()
  const capabilities = new Map<string, Promise<string[] | undefined>>()
  let warned = new Set<string>()

  // The gear is advertised only while the plugin is on; the listeners below
  // stay registered either way so a session that still selects Auto after the
  // plugin was disabled cannot send that id to a provider.
  let disposeGear: (() => void) | undefined
  const syncGear = (): void => {
    disposeGear?.()
    disposeGear = undefined
    if (!runtime.config.enabled) return
    disposeGear = installAutoGear(ctx, runtime.gear)
  }
  ctx.effect(() => () => { disposeGear?.() }, 'auto-thinking-effort: Auto gear')
  ctx.on('llm/adapters-updated', () => {
    // A late-mounting or hot-reloaded LLM service gets the gear too.
    syncGear()
  })
  syncGear()

  // The namespace is registered through `ctx.inject` rather than a plain
  // `ctx.get`: a service is only readable once its providing fiber is active,
  // and the settings provider loads its document asynchronously. The callback
  // runs when the service appears, is torn down and re-run when it is replaced,
  // and never fires in a deployment that mounts no provider — where the plugin
  // then runs on the composition row alone.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.get('settings') as unknown as SettingsRegistry | undefined
    if (settings === undefined) return
    const scope = settings.register(SETTINGS_NAMESPACE, Config, {
      base: config,
      applies: 'live',
      // Cross-field rules the schema cannot express (bounds must name levels,
      // the floor must not rank above the ceiling) are refused at the write
      // site, so a hand edit fails loud instead of stranding the session.
      validate: (value) => { prepareConfig(value) },
    })
    /** Whether a configuration from this namespace is already in effect. */
    let configured = false

    const adopt = (next: ConfigShape, origin: string): void => {
      let built: Runtime
      try {
        built = buildRuntime(next)
      } catch (error) {
        logger.warn('configuration rejected, keeping the running one: %s', String(error))
        return
      }
      const gearChanged = built.gear.id !== runtime.gear.id
        || built.gear.name !== runtime.gear.name
        || built.gear.description !== runtime.gear.description
      const wasEnabled = runtime.config.enabled
      runtime = built
      // Everything derived from the previous configuration is now stale.
      warned = new Set<string>()
      capabilities.clear()
      classifierCache.clear()
      if (gearChanged || wasEnabled !== built.config.enabled) syncGear()
      // The first adoption is the namespace coming into effect; every later one
      // replaces a configuration that was already running.
      logger.info(configured ? 'reconfigured from %s — %s' : 'configured from %s — %s', origin, describeRuntime(runtime))
      configured = true
    }

    // The resolved value already includes the composition base, so the first
    // adoption and every later edit share one path.
    adopt(scope.get(), SETTINGS_NAMESPACE)
    scope.watch((next) => { adopt(next, SETTINGS_NAMESPACE) })
  })

  const stateFor = (agent: Agent): AgentState => {
    const existing = states.get(agent.id)
    if (existing !== undefined) return existing
    const created = new AgentState(runtime.prepared.levels)
    states.set(agent.id, created)
    return created
  }

  ctx.on('agent/disposed', ({ agent }) => {
    states.delete(agent.id)
    classifications.delete(agent.id)
  })
  ctx.on('session/disposed', (session) => {
    states.delete(session.id)
    classifications.delete(session.id)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (!runtime.config.enabled) return decision
    // A subagent's route and effort belong to whoever spawned it: do not even
    // classify. Its gear (if one was inherited) is still resolved below.
    if (!runtime.config.applyToSubagents && payload.agent.session.header.origin === 'subagent') return decision
    try {
      const agent = payload.agent
      const state = stateFor(agent)
      const text = observeTurn(runtime.config, runtime.prepared, state, payload.turn, payload.messages)
      // Start the model classifier now so its latency overlaps prompt assembly;
      // `agent/request` awaits the very same promise. A pinned turn is the user
      // speaking and needs no second opinion.
      if (text !== undefined && runtime.config.classifier === 'model' && state.forTurn(payload.turn)?.pinned !== true) {
        const pending: PendingClassification = { turn: payload.turn, text }
        pending.promise = startClassification({
          ctx,
          config: runtime.config,
          prepared: runtime.prepared,
          logger,
          agent,
          cache: classifierCache,
          capabilities,
          warned,
          turn: payload.turn,
          text,
          signal: payload.signal,
          route: configuredClassifierRoute(runtime.config, agent),
        })
        classifications.set(agent.id, pending)
      }
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
      const gearRequested = requestsAutoGear(resolved, runtime.config.autoEffortId)
      const subagent = payload.agent.session.header.origin === 'subagent'
      if (subagent && !runtime.config.applyToSubagents && !gearRequested) return resolved
      return await decideEffort({
        ctx,
        config: runtime.config,
        prepared: runtime.prepared,
        state: stateFor(payload.agent),
        agent: payload.agent,
        pending: classifications,
        cache: classifierCache,
        capabilities,
        warned,
        logger,
        turn: payload.turn,
        step: payload.step,
        signal: payload.signal,
      }, resolved)
    } catch (error) {
      logger.warn('turn %d: effort selection failed, keeping the composed effort: %s', payload.turn, String(error))
      return resolved
    }
  }, { prepend: true })

  logger.info(
    runtime.config.enabled ? 'enabled — %s' : 'disabled — only the %s sanitizer is active',
    runtime.config.enabled ? describeRuntime(runtime) : runtime.config.autoEffortId,
  )
}

/**
 * Validate one configuration and derive everything the plugin needs from it.
 * @param config - a resolved configuration (composition base plus user layer).
 * @returns the runtime state.
 * @throws when the configuration is invalid; callers on the settings path keep
 * the previous runtime instead of failing the turn.
 */
function buildRuntime(config: ConfigShape): Runtime {
  return {
    config,
    prepared: prepareConfig(config),
    gear: { id: config.autoEffortId, name: config.autoEffortName, description: config.autoEffortDescription },
  }
}

/**
 * Render one configuration for the startup and reconfigure log lines.
 * @param runtime - the runtime state to describe.
 * @returns a one-line summary.
 */
function describeRuntime(runtime: Runtime): string {
  const { config, prepared } = runtime
  const classifier = config.classifier === 'model'
    ? `model${config.classifierModel.trim() === '' ? '' : ` (${config.classifierModel})`}`
    : 'heuristic'
  return `gear ${config.autoEffortId}, levels [${prepared.levels.map((level) => `${level.id}→${level.effort}`).join(' ')}], `
    + `${String(prepared.rules.length)} rule(s), bounds ${prepared.floor.id}..${prepared.ceiling.id}, `
    + `classifier=${classifier}, dryRun=${String(config.dryRun)}, subagents=${config.applyToSubagents ? 'on' : 'off'}`
}

/**
 * Classify one step's user text and record the turn's level.
 * @param config - validated configuration.
 * @param prepared - validated ladder and compiled rules.
 * @param state - the agent's rolling state.
 * @param turn - the turn proposing this step.
 * @param messages - the messages claimed for the step.
 * @returns the joined user text, or `undefined` when the step carried none.
 */
function observeTurn(
  config: ConfigShape,
  prepared: PreparedConfig,
  state: AgentState,
  turn: number,
  messages: readonly UserMessage[],
): string | undefined {
  const text = extractUserText(messages)
  if (text === undefined) {
    state.observe(turn, undefined)
    return undefined
  }
  const decision: Decision = classify(text, {
    levels: prepared.levels,
    rules: prepared.rules,
    maxChars: config.maxChars,
    inheritOnContinuation: config.inheritOnContinuation,
    previous: state.last,
    ceiling: prepared.ceiling,
  })
  state.observe(turn, decision)
  return text
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
    const sanitized = rungs === undefined ? undefined : resolveEffort(prepared.levels, fallbackLevel, rungs, { floor: prepared.floor })
    return sanitized === undefined ? withoutEffort(resolved) : { ...resolved, reasoningEffort: ReasoningEffortId(sanitized.effort) }
  }
  const auto = gearRequested || (resolved.reasoningEffort === undefined && config.autoWhenUnset)
  if (!auto) return resolved

  const record = state.forTurn(turn)
  if (record === undefined && !gearRequested) return resolved

  // The model classifier refines a heuristic decision; it never overrides an
  // explicit pin, and any failure leaves the heuristic level in place.
  const refined = await refineLevel(context, resolved, record)
  const level = refined
    ?? (record === undefined
      ? levelForScore(prepared.levels, 0)
      : prepared.levels.find((candidate) => candidate.id === record.level) ?? levelForScore(prepared.levels, 0))
  const supported = await supportedEfforts(context, resolved.provider, resolved.model)
  if (supported === undefined || supported.length === 0) {
    // No selectable rung on this route: a gear must still be removed.
    warnOnce(context, `no-efforts:${resolved.provider}/${resolved.model}`, 'warn',
      'turn %d: %s/%s declares no selectable reasoning efforts — %s',
      turn, resolved.provider, resolved.model,
      gearRequested ? 'the Auto gear is dropped from the request' : 'effort left at the composed value')
    return gearRequested ? withoutEffort(resolved) : resolved
  }

  const resolution = resolveEffort(prepared.levels, level, supported, { floor: prepared.floor })
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
      refined === undefined ? (record === undefined ? 'default' : record.pinned ? 'pinned' : record.origin) : 'model',
      changed ? `, was ${String(resolved.reasoningEffort)}` : ', unchanged',
      resolution.clamped ? `, clamped to the allowed rungs (floor ${prepared.floor.id})` : '',
      record?.score ?? 0,
      refined !== undefined
        ? ` — model picked ${level.id}`
        : record === undefined || record.reasons.length === 0 ? '' : ` — ${record.reasons.join('; ')}`,
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
async function supportedEfforts(context: CapabilityContext, provider: string, model: string): Promise<string[] | undefined> {
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
function warnOnce(context: CapabilityContext & Pick<RequestContext, 'warned'>, key: string, level: 'warn' | 'debug', message: string, ...args: unknown[]): void {
  if (context.warned.has(key)) return
  context.warned.add(key)
  const log = level === 'warn' ? context.logger.warn : context.logger.debug
  log.call(context.logger, message, ...args)
}

/**
 * The levels one decision may land on, bounded by the configured floor and
 * ceiling. The model classifier is offered exactly this set, so a policy bound
 * survives into its prompt instead of being corrected afterwards.
 * @param prepared - validated ladder and bounds.
 * @returns the allowed levels, low to high.
 */
function allowedLevels(prepared: PreparedConfig): LevelSpec[] {
  const from = prepared.levels.indexOf(prepared.floor)
  const to = prepared.levels.indexOf(prepared.ceiling)
  return prepared.levels.slice(Math.max(from, 0), to + 1)
}

/**
 * Parse a `provider/model` classifier route.
 * @param value - the configured value.
 * @returns the route, or `undefined` when unset or malformed.
 */
function parseClassifierRoute(value: string): ClassifierRoute | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
}

/**
 * Resolve the route to classify with: the configured `classifierModel`, else the
 * route the agent was created with when both halves are known.
 * @param config - validated configuration.
 * @param agent - the agent whose turn is being classified.
 * @returns the route, or `undefined` when the request's own route must be used.
 */
function configuredClassifierRoute(config: ConfigShape, agent: Agent): ClassifierRoute | undefined {
  const explicit = parseClassifierRoute(config.classifierModel)
  if (explicit !== undefined) return explicit
  const { provider, model } = agent.options
  return provider === undefined || model === undefined ? undefined : { provider, model }
}

/** How many classifier answers one process remembers. */
const CLASSIFIER_CACHE_LIMIT = 64

/** Inputs for {@link startClassification}. */
interface StartClassificationArgs {
  readonly ctx: Context
  readonly config: ConfigShape
  readonly prepared: PreparedConfig
  readonly logger: ReturnType<Context['logger']>
  readonly agent: Agent
  readonly cache: Map<string, string>
  readonly capabilities: Map<string, Promise<string[] | undefined>>
  readonly warned: Set<string>
  readonly turn: number
  readonly text: string
  readonly signal: AbortSignal
  readonly route: ClassifierRoute | undefined
}

/**
 * Start one model classification.
 *
 * Returns `undefined` whenever the model backend cannot be used — disabled, no
 * route, nothing to choose between, or a cached answer — in which case the
 * caller keeps its heuristic decision. Failures inside the call never reject:
 * the promised value is `undefined`.
 *
 * @param args - the turn, route, and shared caches.
 * @returns the in-flight classification, or `undefined` when none is started.
 */
function startClassification(args: StartClassificationArgs): Promise<ClassifierAnswer | undefined> | undefined {
  const { config, prepared, cache } = args
  if (config.classifier !== 'model') return undefined
  const levels = allowedLevels(prepared)
  if (levels.length < 2) return undefined
  const route = args.route
  if (route === undefined) {
    warnOnce(args, 'classifier:no-route', 'debug',
      'turn %d: no classifier route (set classifierModel, or give the agent a provider and model) — using the heuristic decision',
      args.turn)
    return undefined
  }
  const routeLabel = `${route.provider}/${route.model}`
  const key = `${routeLabel}\u0000${levels.map((level) => level.id).join(',')}\u0000${args.text}`
  const cached = cache.get(key)
  if (cached !== undefined) return Promise.resolve({ level: cached, route: routeLabel })

  return (async (): Promise<ClassifierAnswer | undefined> => {
    const rungs = await supportedEfforts(args, route.provider, route.model)
    const answer = await runModelClassifier({
      ctx: args.ctx,
      route,
      sessionId: args.agent.session.id,
      text: args.text,
      levels,
      effort: rungs === undefined ? undefined : weakestRung(prepared.levels, rungs),
      maxChars: config.maxChars,
      maxTokens: config.classifierMaxTokens,
      timeoutMs: config.classifierTimeoutMs,
      signal: args.signal,
    })
    if (answer === undefined) {
      warnOnce(args, `classifier:failed:${routeLabel}`, 'warn',
        'turn %d: the model classifier produced no usable answer from %s — keeping the heuristic level',
        args.turn, routeLabel)
      return undefined
    }
    if (cache.size >= CLASSIFIER_CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, answer.level)
    return answer
  })()
}

/**
 * Await (or start) the model classification for the current turn.
 * @param context - the per-request decision context.
 * @param resolved - the configuration the loop would use.
 * @param record - the heuristic decision for this turn, when one exists.
 * @returns the model's level, or `undefined` to keep the heuristic level.
 */
async function refineLevel(
  context: RequestContext,
  resolved: LlmCallConfig,
  record: TurnRecord | undefined,
): Promise<LevelSpec | undefined> {
  const { config, prepared, agent, turn, logger } = context
  if (config.classifier !== 'model' || record?.pinned === true) return undefined
  const pending = context.pending.get(agent.id)
  if (pending === undefined || pending.turn !== turn) return undefined

  // The pre-step had no route to start with (no classifierModel and no agent
  // options): start now, where the resolved request names the route.
  pending.promise ??= startClassification({
    ctx: context.ctx,
    config,
    prepared,
    logger,
    agent,
    cache: context.cache,
    capabilities: context.capabilities,
    warned: context.warned,
    turn,
    text: pending.text,
    signal: context.signal,
    route: { provider: resolved.provider, model: resolved.model },
  })
  const answer = await pending.promise
  if (answer === undefined) return undefined

  const level = prepared.levels.find((candidate) => candidate.id === answer.level)
  if (level === undefined) return undefined
  if (config.logDecisions) {
    logger.info('turn %d: classifier %s chose %s', turn, answer.route, level.id)
  }
  return level
}
