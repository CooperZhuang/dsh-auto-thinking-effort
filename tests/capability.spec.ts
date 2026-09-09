/**
 * Capability tests: the synthetic Auto gear must be advertised, selectable, and
 * removable without disturbing the adapter's own rungs.
 */
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { installAutoGear, requestsAutoGear, routeOffersEfforts, withAutoGear } from '../src/capability.ts'
import type { AutoGear } from '../src/capability.ts'

const GEAR: AutoGear = { id: 'auto', name: 'Auto', description: 'per-turn effort' }

/** Resolved metadata for a route declaring the given rungs. */
function info(efforts: readonly string[] | undefined): LlmResolvedModelInfo {
  return {
    provider: 'fake',
    id: 'fake-1',
    name: 'Fake',
    ...efforts === undefined ? {} : {
      reasoning: {
        efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('high'),
      },
    },
  } as LlmResolvedModelInfo
}

describe('routeOffersEfforts', () => {
  it('is false without reasoning metadata or with an empty list', () => {
    expect(routeOffersEfforts(info(undefined))).toBe(false)
    expect(routeOffersEfforts(info([]))).toBe(false)
    expect(routeOffersEfforts(info(['low']))).toBe(true)
  })
})

describe('withAutoGear', () => {
  it('prepends the gear and makes it the advertised default', () => {
    const patched = withAutoGear(info(['off', 'low', 'high', 'max']), GEAR)
    expect(patched.reasoning?.efforts.map((effort) => String(effort.id))).toEqual(['auto', 'off', 'low', 'high', 'max'])
    expect(patched.reasoning?.efforts[0]?.description).toBe('per-turn effort')
    expect(patched.reasoning?.defaultEffort).toBe('auto')
  })

  it('leaves a route without reasoning alone', () => {
    const original = info(undefined)
    expect(withAutoGear(original, GEAR)).toBe(original)
  })

  it('does not duplicate a gear the adapter already declares', () => {
    const original = info(['auto', 'high'])
    expect(withAutoGear(original, GEAR)).toBe(original)
  })

  it('keeps every real rung and its default', () => {
    const patched = withAutoGear(info(['off', 'high']), GEAR)
    expect(patched.reasoning?.efforts.slice(1).map((effort) => String(effort.id))).toEqual(['off', 'high'])
  })
})

describe('installAutoGear', () => {
  /** A fake service that records delegation. */
  function fakeService(efforts: readonly string[] | undefined) {
    const resolveModelInfo = vi.fn(async (provider: string, model: string) => ({ ...info(efforts), provider, id: model }))
    const resolveCallConfig = vi.fn(async (config: LlmCallConfig) => config)
    return { resolveModelInfo, resolveCallConfig } as unknown as LlmRuntime & {
      resolveModelInfo: typeof resolveModelInfo
      resolveCallConfig: typeof resolveCallConfig
    }
  }

  it('advertises the gear through resolveModelInfo', async () => {
    const ctx = new Context()
    const llm = fakeService(['off', 'high'])
    ctx.provide('llm', llm)
    const dispose = installAutoGear(ctx, GEAR)
    const resolved = await (ctx.llm as unknown as LlmRuntime).resolveModelInfo('fake', 'fake-1')
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id))).toEqual(['auto', 'off', 'high'])
    dispose()
  })

  it('accepts the gear in resolveCallConfig without delegating', async () => {
    const ctx = new Context()
    const llm = fakeService(['off', 'high'])
    ctx.provide('llm', llm)
    const original = llm.resolveCallConfig
    const dispose = installAutoGear(ctx, GEAR)
    const gearConfig: LlmCallConfig = { provider: 'fake', model: 'fake-1', reasoningEffort: ReasoningEffortId('auto') }
    expect(await (ctx.llm as unknown as LlmRuntime).resolveCallConfig(gearConfig)).toBe(gearConfig)
    expect(original).not.toHaveBeenCalled()

    const manual: LlmCallConfig = { provider: 'fake', model: 'fake-1', reasoningEffort: ReasoningEffortId('off') }
    await (ctx.llm as unknown as LlmRuntime).resolveCallConfig(manual)
    expect(original).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('restores the original methods on dispose', async () => {
    const ctx = new Context()
    const llm = fakeService(['off', 'high'])
    ctx.provide('llm', llm)
    const dispose = installAutoGear(ctx, GEAR)
    dispose()
    const resolved = await (ctx.llm as unknown as LlmRuntime).resolveModelInfo('fake', 'fake-1')
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id))).toEqual(['off', 'high'])
  })

  it('is idempotent: a second install does not double-wrap or uninstall the first', async () => {
    const ctx = new Context()
    const llm = fakeService(['off', 'high'])
    ctx.provide('llm', llm)
    const first = installAutoGear(ctx, GEAR)
    const second = installAutoGear(ctx, GEAR)
    second()
    const resolved = await (ctx.llm as unknown as LlmRuntime).resolveModelInfo('fake', 'fake-1')
    expect(resolved.reasoning?.efforts.map((effort) => String(effort.id))).toEqual(['auto', 'off', 'high'])
    first()
    const restored = await (ctx.llm as unknown as LlmRuntime).resolveModelInfo('fake', 'fake-1')
    expect(restored.reasoning?.efforts.map((effort) => String(effort.id))).toEqual(['off', 'high'])
  })

  it('is a no-op when no LLM runtime is mounted', () => {
    const ctx = new Context()
    expect(() => { installAutoGear(ctx, GEAR)() }).not.toThrow()
  })

  it('keeps the gear out of the persisted deployment default', async () => {
    const ctx = new Context()
    ctx.provide('llm', fakeService(['off', 'high']))
    const saved: { provider: string; model: string; reasoningEffort?: string }[] = []
    const defaults = { saveSelection: async (selection: typeof saved[number]) => { saved.push(selection) } }
    ctx.provide('agentDefaultModel', defaults as never)
    const dispose = installAutoGear(ctx, GEAR)

    await defaults.saveSelection({ provider: 'fake', model: 'fake-1', reasoningEffort: 'auto' })
    expect(saved[0]).toEqual({ provider: 'fake', model: 'fake-1' })

    await defaults.saveSelection({ provider: 'fake', model: 'fake-1', reasoningEffort: 'low' })
    expect(saved[1]?.reasoningEffort).toBe('low')

    dispose()
    await defaults.saveSelection({ provider: 'fake', model: 'fake-1', reasoningEffort: 'auto' })
    expect(saved[2]?.reasoningEffort).toBe('auto')
  })
})

describe('requestsAutoGear', () => {
  it('matches only the exact gear id', () => {
    expect(requestsAutoGear({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('auto') }, 'auto')).toBe(true)
    expect(requestsAutoGear({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') }, 'auto')).toBe(false)
    expect(requestsAutoGear({ provider: 'p', model: 'm' }, 'auto')).toBe(false)
  })
})
