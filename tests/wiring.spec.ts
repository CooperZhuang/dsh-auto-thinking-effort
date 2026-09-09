/**
 * Wiring tests: the plugin against a real cordis context, a real agent-scoped
 * selection listener, and the real waterfall dispatcher the agent loop uses.
 *
 * The load-bearing case is the first one. `installModelSelection` re-applies the
 * session's stored effort from an agent-scoped listener, and this harness
 * installs it *before* the plugin — exactly the adversarial order. The plugin
 * only wins because it registers `agent/request` with `prepend: true`, making
 * it the outermost listener whose return value is final. If that regresses,
 * the first test fails.
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

/** A fake route declaring `efforts`, or no reasoning capability at all when `null`. */
function fakeLlm(efforts: readonly string[] | null): LlmRuntime {
  return {
    resolveModelInfo: async (provider: string, model: string) => ({
      provider,
      id: model,
      name: model,
      ...efforts === null ? {} : { reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } },
    }),
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
    async request(turn, step = 1, seed = { provider: 'fake', model: 'fake-1' }) {
      return await dispatch.waterfall('agent/request', { turn, step, signal }, () => Promise.resolve(seed))
    },
  }
}

describe('agent/request wiring', () => {
  it('overrides a stored selection effort with the classified level', async () => {
    const h = harness({ selectedEffort: 'low' })
    await h.preStep(1, [userMessage('think hard about the deadlock in the uploader')])
    expect((await h.request(1)).reasoningEffort).toBe('max')
  })

  it('raises a stored selection on a cause question', async () => {
    const h = harness({ selectedEffort: 'low' })
    await h.preStep(1, [userMessage('Why does the migration throw a TypeError?')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('lowers a stored selection for chit-chat', async () => {
    const h = harness({ selectedEffort: 'high' })
    await h.preStep(1, [userMessage('谢谢')])
    expect((await h.request(1)).reasoningEffort).toBe('off')
  })

  it('leaves the composed effort alone when the turn was never observed', async () => {
    const h = harness({ selectedEffort: 'low' })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(2)).reasoningEffort).toBe('low')
  })

  it('ignores plugin-injected messages', async () => {
    const h = harness({ selectedEffort: 'low' })
    await h.preStep(1, [pluginMessage('think hard about everything')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })

  it('leaves a matching effort untouched, returning the composed object', async () => {
    const h = harness({ selection: false })
    await h.preStep(1, [userMessage('Add a retry to the upload helper')])
    const seed: LlmCallConfig = { provider: 'fake', model: 'fake-1', reasoningEffort: ReasoningEffortId('high') }
    expect(await h.request(1, 1, seed)).toBe(seed)
  })

  it('replaces the effort with a new object only when it changes', async () => {
    const h = harness({ selection: false })
    await h.preStep(1, [userMessage('think hard')])
    const seed: LlmCallConfig = { provider: 'fake', model: 'fake-1', reasoningEffort: ReasoningEffortId('high') }
    const config = await h.request(1, 1, seed)
    expect(config).not.toBe(seed)
    expect(config.reasoningEffort).toBe('max')
  })

  it('clamps a level whose rung the route does not declare', async () => {
    // `please do it` scores into the `low` band; this route has no `low`, so
    // the nearest declared rung (`high`) is used.
    const h = harness({ efforts: ['off', 'high', 'max'], selectedEffort: 'high' })
    await h.preStep(1, [userMessage('please do it')])
    expect((await h.request(1)).reasoningEffort).toBe('high')
  })

  it('yields to an explicit effort when respectExplicitEffort is set', async () => {
    const h = harness({ selectedEffort: 'low', config: { respectExplicitEffort: true } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })

  it('leaves a subagent child alone by default', async () => {
    const h = harness({ subagent: true, selectedEffort: 'low' })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })

  it('classifies a subagent child when asked', async () => {
    const h = harness({ subagent: true, selectedEffort: 'low', config: { applyToSubagents: true } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('max')
  })

  it('decides without rewriting in dry-run mode', async () => {
    const h = harness({ selectedEffort: 'low', config: { dryRun: true } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })

  it('leaves the effort alone when the route declares none', async () => {
    const h = harness({ efforts: null, selectedEffort: 'low' })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })

  it('leaves the effort alone when the route shares no rung with the ladder', async () => {
    const h = harness({ efforts: ['tiny', 'huge'] })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBeUndefined()
  })

  it('keeps a turn at its level across steps', async () => {
    const h = harness({ selectedEffort: 'low' })
    await h.preStep(1, [userMessage('谢谢')], 1)
    expect((await h.request(1, 1)).reasoningEffort).toBe('off')
    // A later step in the same turn carries only a plugin-injected tool result.
    await h.preStep(1, [pluginMessage('tool result')], 2)
    expect((await h.request(1, 2)).reasoningEffort).toBe('off')
  })

  it('raises, but never lowers, a turn on steering', async () => {
    const h = harness({ selectedEffort: 'low' })
    await h.preStep(1, [userMessage('Add a retry to the upload helper')], 1)
    await h.preStep(1, [userMessage('ok, go ahead')], 2)
    expect((await h.request(1, 2)).reasoningEffort).toBe('high')

    await h.preStep(1, [userMessage('actually think hard about the deadlock')], 3)
    expect((await h.request(1, 3)).reasoningEffort).toBe('max')
  })

  it('inherits the previous level for a bare continuation', async () => {
    const h = harness({ selectedEffort: 'low' })
    await h.preStep(1, [userMessage('think hard about the deadlock')], 1)
    expect((await h.request(1, 1)).reasoningEffort).toBe('max')
    await h.preStep(2, [userMessage('继续')], 1)
    expect((await h.request(2, 1)).reasoningEffort).toBe('max')
  })

  it('does nothing when the plugin is disabled', async () => {
    const h = harness({ selectedEffort: 'low', config: { enabled: false } })
    await h.preStep(1, [userMessage('think hard')])
    expect((await h.request(1)).reasoningEffort).toBe('low')
  })
})
