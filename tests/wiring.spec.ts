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
import type { LlmCallConfig, LlmRuntime, UserMessage } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { ConfigShape } from '../src/config.ts'
import { apply } from '../src/index.ts'

const GEAR = 'auto'

/** A fake route declaring `efforts`, or no reasoning capability at all when `null`. */
function fakeLlm(efforts: readonly string[] | null): LlmRuntime {
  const resolveModelInfo = async (provider: string, model: string) => ({
    provider,
    id: model,
    name: model,
    ...efforts === null ? {} : { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } },
  })
  return {
    resolveModelInfo,
    // The real service validates an explicit effort against the adapter's
    // declared rungs; the plugin's capability wrapper makes the gear acceptable.
    resolveCallConfig: async (config: LlmCallConfig) => {
      const requested = config.reasoningEffort === undefined ? undefined : String(config.reasoningEffort)
      if (requested !== undefined && requested !== GEAR && !(efforts ?? []).includes(requested)) {
        throw new Error(`does not support reasoning effort "${requested}"`)
      }
      return config
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
}

interface Harness {
  request(turn: number, step?: number, seed?: LlmCallConfig): Promise<LlmCallConfig>
  preStep(turn: number, messages: readonly UserMessage[], step?: number): Promise<void>
}

/**
 * Build a harness in the adversarial order: selection listener first, plugin
 * second.
 * @param options - route capabilities, plugin config, and session shape.
 * @returns the harness.
 */
function harness(options: HarnessOptions = {}): Harness {
  const ctx = new Context()
  ctx.provide('llm', fakeLlm(options.efforts === undefined ? ['off', 'low', 'high', 'max'] : options.efforts))

  const agent = {
    id: 'session-1',
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

  apply(ctx, resolveConfig(options.config))

  const target = agent as unknown as Agent
  const dispatch = agentEvents(ctx, target)
  const signal = new AbortController().signal

  return {
    async preStep(turn, messages, step = 1) {
      await dispatch.waterfall('agent/pre-step', { messages: [...messages], turn, step, signal }, () => Promise.resolve({
        kind: 'enter' as const,
        messages: [...messages],
      }))
    },
    async request(turn, step = 1, seed = { provider: 'fake', model: 'fake-1', reasoningEffort: ReasoningEffortId(GEAR) }) {
      return await dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seed))
    },
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

  it('clamps a gear decision to the nearest declared rung', async () => {
    // `please do it` scores into the `low` band; this route has no `low`.
    const h = harness({ efforts: ['off', 'high', 'max'], selectedEffort: GEAR })
    await h.preStep(1, [userMessage('please do it')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
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
    expect((await h.request(1, 1)).reasoningEffort).toBe('off')
    // A later step in the same turn carries only a plugin-injected tool result.
    await h.preStep(1, [pluginMessage('tool result')], 2)
    expect((await h.request(1, 2)).reasoningEffort).toBe('off')
  })

  it('raises, but never lowers, a turn on steering', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('Add a retry to the upload helper')], 1)
    await h.preStep(1, [userMessage('ok, go ahead')], 2)
    expect((await h.request(1, 2)).reasoningEffort).toBe('high')

    await h.preStep(1, [userMessage('actually think hard about the deadlock')], 3)
    expect((await h.request(1, 3)).reasoningEffort).toBe('max')
  })

  it('inherits the previous level for a bare continuation', async () => {
    const h = harness({ selectedEffort: GEAR })
    await h.preStep(1, [userMessage('think hard about the deadlock')], 1)
    expect((await h.request(1, 1)).reasoningEffort).toBe('max')
    await h.preStep(2, [userMessage('继续')], 1)
    expect((await h.request(2, 1)).reasoningEffort).toBe('max')
  })

  it('does nothing when the plugin is disabled and no gear is involved', async () => {
    const h = harness({ selectedEffort: 'low', config: { enabled: false } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })
})
