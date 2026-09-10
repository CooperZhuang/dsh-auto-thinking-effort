/**
 * Wiring tests: the plugin against a real cordis context, a real agent-scoped
 * selection listener, and the real waterfall dispatcher the agent loop uses.
 *
 * Two properties are load-bearing here:
 *
 * 1. The plugin registers `agent/request` with `prepend: true`, so it is the
 *    outermost listener and its returned configuration is final. This harness
 *    installs `installModelSelection` **first** — the adversarial order — so the
 *    gear tests fail if that ever regresses.
 * 2. A gear request must never reach the adapter. Every gear test asserts the
 *    returned effort is a real rung (or absent), never the gear id.
 */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmRuntime, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ConfigShape } from '../src/config.ts'
import { DEFAULT_LEVELS } from '../src/levels.ts'
import { apply, SETTINGS_NAMESPACE } from '../src/index.ts'

const GEAR = 'auto'

/**
 * A fake route. `classifierAnswer` makes the fake answer the optional model
 * classifier; `null` makes that call fail with a terminal error finish.
 */
function fakeLlm(efforts: readonly string[] | null, classifierAnswer?: string | null): LlmRuntime {
  const resolveModelInfo = async (provider: string, model: string) => ({
    provider,
    id: model,
    name: model,
    ...efforts === null ? {} : { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } },
  })
  const calls = { classifier: 0, lastSystem: '' }
  return {
    resolveModelInfo,
    calls,
    // The real service validates an explicit effort against the adapter's
    // declared rungs; the plugin's capability wrapper makes the gear acceptable.
    resolveCallConfig: async (config: LlmCallConfig) => {
      const requested = config.reasoningEffort === undefined ? undefined : String(config.reasoningEffort)
      if (requested !== undefined && requested !== GEAR && !(efforts ?? []).includes(requested)) {
        throw new Error(`does not support reasoning effort "${requested}"`)
      }
      return config
    },
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.classifier += 1
      calls.lastSystem = options.system ?? ''
      if (classifierAnswer === null) {
        yield { type: 'finish', reason: { kind: 'error' } } as unknown as StreamChunk
        return
      }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: classifierAnswer ?? '' } } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    },
  } as unknown as LlmRuntime
}

/** One message the human typed. */
function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A message some plugin injected — must never be classified. */
function pluginMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'other' } })
}

interface HarnessOptions {
  /** Declared effort ids; `null` means the route declares none. Defaults to all four. */
  efforts?: readonly string[] | null
  config?: Partial<ConfigShape>
  subagent?: boolean
  /** Whether the session has a model selection installed (default true). */
  selection?: boolean
  /** The effort the session's model selection carries. */
  selectedEffort?: string | undefined
  /** What the fake classifier model answers; `null` makes that call fail. */
  classifierAnswer?: string | null
  /** Mount a fake `ctx.settings` provider (default none). */
  settings?: boolean
    /** What that provider resolves to; defaults to the composition row. */
    settingsValue?: Partial<ConfigShape>
}

/** A fake settings provider recording one namespace registration. */
interface FakeSettings {
  readonly registry: unknown
  readonly registrations: { namespace: string; options: Record<string, unknown> }[]
  /** Commit a new resolved value, exactly as a settings write would. */
  push(next: ConfigShape): void
}

/**
 * Build a fake settings provider.
 * @param initial - the resolved value before any user layer exists.
 * @returns the registry, its registrations, and a way to commit a new value.
 */
function fakeSettings(initial: ConfigShape): FakeSettings {
  const registrations: { namespace: string; options: Record<string, unknown> }[] = []
  const watchers: ((next: ConfigShape, previous: ConfigShape) => void)[] = []
  let value = initial
  return {
    registrations,
    registry: {
      register(namespace: string, _schema: unknown, options: Record<string, unknown>) {
        registrations.push({ namespace, options })
        return {
          get: () => value,
          watch: (callback: (next: ConfigShape, previous: ConfigShape) => void) => {
            watchers.push(callback)
            return () => {}
          },
        }
      },
    },
    push(next: ConfigShape) {
      const previous = value
      value = next
      for (const watcher of watchers) watcher(next, previous)
    },
  }
}

interface Harness {
  request(turn: number, step?: number, seed?: LlmCallConfig): Promise<LlmCallConfig>
  preStep(turn: number, messages: readonly UserMessage[], step?: number): Promise<void>
  /** How many classifier calls the fake route served. */
  classifierCalls(): number
  /** The system prompt of the last classifier call. */
  classifierPrompt(): string
  /** The synthetic gear the fake route advertises right now, if any. */
  gear(): Promise<string | undefined>
  /**
   * Let the plugin's deferred work land. The settings namespace is registered
   * from an `inject` callback — a service is only readable once its providing
   * fiber is active — so it is not registered synchronously with `apply`.
   */
  settle(): Promise<void>
  /** The fake settings provider, when the harness mounted one. */
  settings: FakeSettings | undefined
}

/**
 * Build a harness in the adversarial order: selection listener first, plugin
 * second.
 * @param options - route capabilities, plugin config, and session shape.
 * @returns the harness.
 */
function harness(options: HarnessOptions = {}): Harness {
  const ctx = new Context()
  const llm = fakeLlm(
    options.efforts === undefined ? ['off', 'low', 'high', 'max'] : options.efforts,
    options.classifierAnswer === undefined ? 'high' : options.classifierAnswer,
  )
  ctx.provide('llm', llm)

  // A composition row plus, when asked for, a fake settings provider whose
  // resolved value starts at that same composition config (no user layer yet).
  const composition = resolveConfig(options.config)
  const resolved = resolveConfig({ ...composition, ...options.settingsValue })
  const settings = options.settings === true ? fakeSettings(resolved) : undefined
  if (settings !== undefined) ctx.provide('settings', settings.registry)

  const agent = {
    id: 'session-1',
    options: { provider: 'fake', model: 'fake-1' },
    session: {
      id: 'session-1',
      header: options.subagent === true ? { origin: 'subagent' } : {},
    },
  }
  const scope = createScope(ctx, agent)
  const agentCtx = scope.ctx.extend({ agent })

  const selection: ModelSelectionRef = {
    current: {
      provider: 'fake',
      model: 'fake-1',
      ...options.selectedEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(options.selectedEffort) },
    },
    assembled: undefined,
  }
  if (options.selection !== false) {
    installModelSelection(agentCtx, selection)
    // Prompt assembly snapshots the selection into `assembled` before the
    // request; simulate that snapshot rather than dispatching the prompt event.
    selection.assembled = selection.current
  }

  apply(ctx, composition)

  // One macrotask lets cordis finish loading the fiber that carries the
  // settings `inject` callback; every async entry point waits for it first.
  const settled = new Promise<void>((resolve) => { setTimeout(resolve, 0) })

  const target = agent as unknown as Agent
  const dispatch = agentEvents(ctx, target)
  const signal = new AbortController().signal

  return {
    settle: () => settled,
    async preStep(turn, messages, step = 1) {
      await settled
      await dispatch.waterfall('agent/pre-step', { messages: [...messages], turn, step, signal }, () => Promise.resolve({
        kind: 'enter' as const,
        messages: [...messages],
      }))
    },
    async request(turn, step = 1, seed = { provider: 'fake', model: 'fake-1', reasoningEffort: ReasoningEffortId(GEAR) }) {
      await settled
      return await dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seed))
    },
    classifierCalls: () => (llm as unknown as { calls: { classifier: number } }).calls.classifier,
    classifierPrompt: () => (llm as unknown as { calls: { lastSystem: string } }).calls.lastSystem,
    async gear() {
      await settled
      const info = await llm.resolveModelInfo('fake', 'fake-1')
      return info.reasoning?.efforts.map((effort) => String(effort.id)).find((id) => id === GEAR)
    },
    settings,
  }
}

describe('Auto gear', () => {
  it('turns a gear request into the classified level', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('think hard about the deadlock in the uploader')])
    expect((await h.request(1)).reasoningEffort).toBe('max')
  })

  it('turns a gear request into a real rung even with no observation', async () => {
    const h = harness({ selectedEffort: GEAR })
    const config = await h.request(1)
    expect(config.reasoningEffort).toBe('high')
  })

  it('drops a gear request when the route declares no efforts', async () => {
    const h = harness({ efforts: null, selectedEffort: GEAR })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBeUndefined()
  })

  it('drops a gear request when no rung matches the ladder', async () => {
    const h = harness({ efforts: ['tiny', 'huge'], selectedEffort: GEAR })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBeUndefined()
  })

  it('clamps a gear decision to the declared rungs', async () => {
    // `please do it` scores into the `low` band; this route has no `low`, and
    // with no floor the highest rung not exceeding the request is `off`.
    const h = harness({ efforts: ['off', 'high', 'max'], selectedEffort: GEAR })
    await h.preStep(1, [userMessage('please do it')])
    expect((await h.request(1)).reasoningEffort).toBe('off')
  })

  it('answers from the floor side once a floor excludes that rung', async () => {
    const h = harness({ efforts: ['off', 'high', 'max'], selectedEffort: GEAR, config: { autoFloorLevel: 'low' } })
    await h.preStep(1, [userMessage('please do it')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('lets the lowest band turn thinking off by default', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('git status')])
    expect((await h.request(1)).reasoningEffort).toBe('off')
  })

  it('holds the lowest band at `low` when the floor is raised', async () => {
    const h = harness({ selectedEffort: GEAR, config: { autoFloorLevel: 'low' } })
    await h.preStep(1, [userMessage('git status')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })

  it('keeps a heavy score-derived decision under the ceiling', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('Why does the whole codebase deadlock under concurrency? Analyze the regression, prove the invariant, and design a migration across all files.')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('lets an explicit pin reach the top rung', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('ultrathink about the deadlock')])
    expect((await h.request(1)).reasoningEffort).toBe('max')
  })

  it('substitutes the gear for a subagent too, even when subagents are skipped', async () => {
    const h = harness({ subagent: true, selectedEffort: GEAR })
    await h.preStep(1, [userMessage('think hard')])
    // `applyToSubagents: false` keeps the plugin from classifying, but the gear
    // must still be resolved: it can never reach the adapter.
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('sanitizes a stored gear when the plugin is disabled', async () => {
    const h = harness({ selectedEffort: GEAR, config: { enabled: false } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('decides without rewriting in dry-run mode', async () => {
    const h = harness({ selectedEffort: GEAR, config: { dryRun: true } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe(GEAR)
  })
})

describe('model classifier', () => {
  const MODEL = { classifier: 'model' as const }

  it('lets the model decide instead of the heuristics', async () => {
    // The heuristics would score `git status` into the lowest band; the model
    // says high, and the model wins.
    const h = harness({ selectedEffort: GEAR, config: MODEL, classifierAnswer: 'high' })
    await h.preStep(1, [userMessage('git status')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
    expect(h.classifierCalls()).toBe(1)
  })

  it('still keeps a pinned turn away from the classifier', async () => {
    const h = harness({ selectedEffort: GEAR, config: MODEL, classifierAnswer: 'low' })
    await h.preStep(1, [userMessage('ultrathink about the deadlock')])
    expect((await h.request(1)).reasoningEffort).toBe('max')
    expect(h.classifierCalls()).toBe(0)
  })

  it('keeps the heuristic level when the classifier call fails', async () => {
    const h = harness({ selectedEffort: GEAR, config: MODEL, classifierAnswer: null })
    await h.preStep(1, [userMessage('git status')])
    expect((await h.request(1)).reasoningEffort).toBe('off')
  })

  it('ignores an answer the parser cannot read', async () => {
    const h = harness({ selectedEffort: GEAR, config: MODEL, classifierAnswer: 'I cannot tell' })
    await h.preStep(1, [userMessage('git status')])
    expect((await h.request(1)).reasoningEffort).toBe('off')
  })

  it('offers the model only the levels inside the floor and ceiling', async () => {
    const h = harness({ selectedEffort: GEAR, config: MODEL, classifierAnswer: 'high' })
    await h.preStep(1, [userMessage('git status')])
    await h.request(1)
    // The default bounds are low..high, so `max` is never offered to the model.
    expect(h.classifierPrompt()).toContain('`low`')
    expect(h.classifierPrompt()).toContain('`high`')
    expect(h.classifierPrompt()).not.toContain('`max`')
  })

  it('answers a gear request from the model classification too', async () => {
    const h = harness({ selectedEffort: GEAR, config: MODEL, classifierAnswer: 'high' })
    await h.preStep(1, [userMessage('谢谢')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('does not call the classifier when the heuristics are selected', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('git status')])
    await h.request(1)
    expect(h.classifierCalls()).toBe(0)
  })
})

describe('manual gears', () => {
  it('leaves an explicit effort untouched', async () => {
    const h = harness({ selectedEffort: 'low' })
    await h.preStep(1, [userMessage('think hard about the deadlock')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })

  it('leaves an explicit effort untouched even for chit-chat', async () => {
    const h = harness({ selectedEffort: 'high' })
    await h.preStep(1, [userMessage('谢谢')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('leaves an explicit effort untouched on a subagent', async () => {
    const h = harness({ subagent: true, selectedEffort: 'max' })
    await h.preStep(1, [userMessage('谢谢')])
    expect((await h.request(1)).reasoningEffort).toBe('max')
  })
})

describe('autoWhenUnset', () => {
  it('classifies a request with no explicit effort by default', async () => {
    const h = harness({ selectedEffort: undefined })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('max')
  })

  it('leaves a request with no explicit effort alone when disabled', async () => {
    const h = harness({ selectedEffort: undefined, config: { autoWhenUnset: false } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBeUndefined()
  })
})

describe('turn state', () => {
  it('leaves the composed effort alone when the turn was never observed', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(2)).reasoningEffort).toBe('high')
  })

  it('ignores plugin-injected messages', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [pluginMessage('think hard about everything')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('returns the same object when nothing changes', async () => {
    const h = harness({ selection: false })
    await h.preStep(1, [userMessage('Add a retry to the upload helper')])
    const seed: LlmCallConfig = { provider: 'fake', model: 'fake-1', reasoningEffort: ReasoningEffortId('high') }
    expect(await h.request(1, 1, seed)).toBe(seed)
  })

  it('keeps a turn at its level across steps', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('谢谢')], 1)
    expect((await h.request(1, 1)).reasoningEffort).toBe('low')
    // A later step in the same turn carries only a plugin-injected tool result.
    await h.preStep(1, [pluginMessage('tool result')], 2)
    expect((await h.request(1, 2)).reasoningEffort).toBe('low')
  })

  it('raises, but never lowers, a turn on steering', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('Add a retry to the upload helper')], 1)
    await h.preStep(1, [userMessage('ok, go ahead')], 2)
    expect((await h.request(1, 2)).reasoningEffort).toBe('high')

    await h.preStep(1, [userMessage('actually think hard about the deadlock')], 3)
    expect((await h.request(1, 3)).reasoningEffort).toBe('max')
  })

  it('inherits the previous level for a bare continuation, capped by the ceiling', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('think hard about the deadlock')], 1)
    expect((await h.request(1, 1)).reasoningEffort).toBe('max')
    // The pin applied to turn 1 only; the continuation stays under the ceiling.
    await h.preStep(2, [userMessage('继续')], 1)
    expect((await h.request(2, 1)).reasoningEffort).toBe('high')
  })

  it('does nothing when the plugin is disabled and no gear is involved', async () => {
    const h = harness({ selectedEffort: 'low', config: { enabled: false } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })
})

describe('settings namespace', () => {
  it('registers the namespace on the composition row, applied live', async () => {
    const h = harness({ settings: true, config: { classifier: 'model' }, selectedEffort: GEAR })
    await h.settle()
    expect(h.settings?.registrations).toHaveLength(1)
    const [registration] = h.settings?.registrations ?? []
    expect(registration?.namespace).toBe(SETTINGS_NAMESPACE)
    expect(registration?.options.base).toMatchObject({ classifier: 'model' })
    expect(registration?.options.applies).toBe('live')
  })

  it('uses the composition row when no settings provider is mounted', async () => {
    const h = harness({ config: { classifier: 'model' }, selectedEffort: GEAR })
    expect(h.settings).toBeUndefined()
    await h.preStep(1, [userMessage('Add a retry to the upload helper')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('lets the resolved value override the composition row at load time', async () => {
    // The composition row ships `max → max`; the user layer renames that rung,
    // so a pin landing on `max` must ask the adapter for `maximum`.
    const h = harness({
      efforts: ['off', 'low', 'high', 'max', 'maximum'],
      selectedEffort: GEAR,
      settings: true,
      settingsValue: {
        levels: DEFAULT_LEVELS.map((level) => ({
          ...level,
          ...level.id === 'max' ? { effort: 'maximum' } : {},
        })),
      },
    })
    await h.preStep(1, [userMessage('think hard about the deadlock')])
    expect((await h.request(1)).reasoningEffort).toBe('maximum')
  })

  it('reconfigures the running plugin on a committed change', async () => {
    const h = harness({ settings: true, selectedEffort: GEAR })
    // Heavy, unpinned: the score reaches the top level, but ships capped at
    // the default ceiling.
    const heavy = 'why does the whole codebase deadlock? prove the invariant.'
    await h.preStep(1, [userMessage(heavy)])
    expect((await h.request(1)).reasoningEffort).toBe('high')

    // The same message, reclassified under a raised ceiling: the plugin must
    // read the new configuration without a reload or a restart.
    h.settings?.push(resolveConfig({ autoCeilingLevel: 'max' }))
    await h.preStep(2, [userMessage(heavy)])
    expect((await h.request(2)).reasoningEffort).toBe('max')
  })

  it('stops advertising the gear when a committed change disables the plugin', async () => {
    const h = harness({ settings: true, selectedEffort: GEAR })
    expect(await h.gear()).toBe(GEAR)

    h.settings?.push(resolveConfig({ enabled: false }))
    expect(await h.gear()).toBeUndefined()
    // The sanitizer stays registered: a session still holding the gear cannot
    // send that id to the provider.
    await h.preStep(1, [userMessage('think hard about the deadlock')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('keeps the running configuration when a committed change is invalid', async () => {
    const h = harness({ settings: true, selectedEffort: GEAR })
    h.settings?.push(resolveConfig({ autoFloorLevel: 'high', autoCeilingLevel: 'low' }))
    await h.preStep(1, [userMessage('think hard about the deadlock')])
    expect((await h.request(1)).reasoningEffort).toBe('max')
  })
})
