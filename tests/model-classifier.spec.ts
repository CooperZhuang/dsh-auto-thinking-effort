/**
 * Model-classifier tests: the prompt must describe the allowed levels, the
 * parser must read a one-word answer defensively, and every failure mode must
 * resolve to `undefined` so the caller can keep its heuristic decision.
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_LEVELS } from '../src/levels.ts'
import type { LevelSpec } from '../src/levels.ts'
import { buildClassifierPrompt, parseClassifierAnswer, runModelClassifier } from '../src/model-classifier.ts'

const LEVELS: LevelSpec[] = [...DEFAULT_LEVELS]

/** A fake LLM service whose stream is supplied per test. */
function fakeLlm(stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  return { stream, resolveModelInfo: async () => ({ provider: 'fake', id: 'fake-1', name: 'Fake' }) } as unknown as LlmRuntime
}

/** A stream that answers with `text`. */
function answering(text: string) {
  return async function* (): AsyncIterable<StreamChunk> {
    yield { type: 'block-end', index: 0, block: { type: 'text', text } } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }
}

/** Minimal call description for {@link runModelClassifier}. */
function call(ctx: Context, overrides: Partial<Parameters<typeof runModelClassifier>[0]> = {}) {
  return {
    ctx,
    route: { provider: 'fake', model: 'fake-1' },
    sessionId: 'session-1' as never,
    text: 'why does this deadlock?',
    levels: LEVELS,
    effort: 'off',
    maxChars: 8_000,
    maxTokens: 64,
    timeoutMs: 5_000,
    ...overrides,
  }
}

describe('buildClassifierPrompt', () => {
  it('offers exactly the allowed levels, with their descriptions', () => {
    const prompt = buildClassifierPrompt(LEVELS.slice(1, 3))
    expect(prompt).toContain('`low`')
    expect(prompt).toContain('`high`')
    expect(prompt).not.toContain('`max`')
    expect(prompt).toContain('light —')
    expect(prompt).toContain('choose the lower one')
  })

  it('falls back to the id when a custom level has no description', () => {
    const prompt = buildClassifierPrompt([{ id: 'calm', effort: 'off' }])
    expect(prompt).toContain('- `calm`: calm')
  })
})

describe('parseClassifierAnswer', () => {
  it('reads a bare word and tolerates punctuation or emphasis', () => {
    expect(parseClassifierAnswer('high', LEVELS)).toBe('high')
    expect(parseClassifierAnswer('low.', LEVELS)).toBe('low')
    expect(parseClassifierAnswer('**max**', LEVELS)).toBe('max')
    expect(parseClassifierAnswer('HIGH', LEVELS)).toBe('high')
  })

  it('takes the earliest mentioned level', () => {
    expect(parseClassifierAnswer('high, not max', LEVELS)).toBe('high')
    expect(parseClassifierAnswer('max rather than high', LEVELS)).toBe('max')
  })

  it('ignores an answer that names no offered level', () => {
    expect(parseClassifierAnswer('maybe', LEVELS)).toBeUndefined()
    expect(parseClassifierAnswer('', LEVELS)).toBeUndefined()
  })

  it('does not match a level inside a longer word', () => {
    expect(parseClassifierAnswer('lowest', LEVELS)).toBeUndefined()
    expect(parseClassifierAnswer('maximum', LEVELS)).toBeUndefined()
  })
})

describe('runModelClassifier', () => {
  it('returns the parsed level and the route', async () => {
    const ctx = new Context()
    ctx.provide('llm', fakeLlm(answering('high')))
    const answer = await runModelClassifier(call(ctx))
    expect(answer?.level).toBe('high')
    expect(answer?.route).toBe('fake/fake-1')
  })

  it('sends the classifier prompt, the text, and the cheap effort', async () => {
    const seen: GenerateOptions[] = []
    const ctx = new Context()
    ctx.provide('llm', fakeLlm((options) => {
      seen.push(options)
      return answering('low')()
    }))
    await runModelClassifier(call(ctx, { text: 'rename the field' }))
    expect(seen[0]?.system).toContain('difficulty classifier')
    expect(seen[0]?.reasoningEffort).toBe('off')
    expect(seen[0]?.maxTokens).toBe(64)
    expect(seen[0]?.messages[0]?.content[0]).toMatchObject({ text: 'rename the field' })
  })

  it('returns undefined when no LLM runtime is mounted', async () => {
    const ctx = new Context()
    expect(await runModelClassifier(call(ctx))).toBeUndefined()
  })

  it('returns undefined when the answer names no level', async () => {
    const ctx = new Context()
    ctx.provide('llm', fakeLlm(answering('I am not sure')))
    expect(await runModelClassifier(call(ctx))).toBeUndefined()
  })

  it('returns undefined when the stream throws', async () => {
    const ctx = new Context()
    ctx.provide('llm', fakeLlm(async function* () {
      throw new Error('boom')
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    }))
    expect(await runModelClassifier(call(ctx))).toBeUndefined()
  })

  it('returns undefined on a terminal error finish', async () => {
    const ctx = new Context()
    ctx.provide('llm', fakeLlm(async function* () {
      yield { type: 'finish', reason: { kind: 'error' } } as unknown as StreamChunk
    }))
    expect(await runModelClassifier(call(ctx))).toBeUndefined()
  })

  it('returns undefined when the call times out', async () => {
    const ctx = new Context()
    ctx.provide('llm', fakeLlm(async function* (options) {
      // Never finishes on its own: the classifier's deadline must end it.
      await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      })
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    }))
    expect(await runModelClassifier(call(ctx, { timeoutMs: 250 }))).toBeUndefined()
  }, 10_000)

  it('lists every offered level in the request, never a level outside the bound', async () => {
    const seen: GenerateOptions[] = []
    const ctx = new Context()
    ctx.provide('llm', fakeLlm((options) => {
      seen.push(options)
      return answering('high')()
    }))
    await runModelClassifier(call(ctx, { levels: LEVELS.slice(1, 3) }))
    expect(seen[0]?.system).not.toContain('`max`')
  })

  it('passes the weakest rung when the route declares none', async () => {
    const seen: GenerateOptions[] = []
    const ctx = new Context()
    const spies = vi.fn((options: GenerateOptions) => {
      seen.push(options)
      return answering('low')()
    })
    ctx.provide('llm', fakeLlm(spies))
    await runModelClassifier(call(ctx, { effort: undefined }))
    expect(seen[0]?.reasoningEffort).toBeUndefined()
  })
})
