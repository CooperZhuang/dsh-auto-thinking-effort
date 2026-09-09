/**
 * Classifier tests: the shipped rules must put recognisable questions on the
 * expected rungs, must not move ordinary work off the default band, must keep
 * score-derived decisions under the ceiling, and must ignore keywords that live
 * inside code.
 */
import { describe, expect, it } from 'vitest'
import { classify, stripNonProse, truncateForClassification } from '../src/classify.ts'
import { prepareConfig, resolveConfig } from '../src/config.ts'
import type { ConfigShape } from '../src/config.ts'

/** A fully-defaulted configuration. */
function defaults(overrides: Partial<ConfigShape> = {}): ConfigShape {
  return { ...resolveConfig(), ...overrides }
}

/** Classify one message with the shipped configuration. */
function run(text: string, overrides: Partial<ConfigShape> = {}) {
  const config = defaults(overrides)
  const prepared = prepareConfig(config)
  return classify(text, {
    levels: prepared.levels,
    rules: prepared.rules,
    maxChars: config.maxChars,
    inheritOnContinuation: config.inheritOnContinuation,
    ceiling: prepared.ceiling,
  })
}

describe('stripNonProse', () => {
  it('blanks fenced blocks, inline code, comments, and tags', () => {
    const text = 'please `code` then ```\nfenced\n``` and <!-- note --> <tag> done'
    const stripped = stripNonProse(text)
    expect(stripped).not.toContain('code')
    expect(stripped).not.toContain('fenced')
    expect(stripped).not.toContain('note')
    expect(stripped).toContain('please')
    expect(stripped).toContain('done')
  })
})

describe('classify', () => {
  it('leaves a plain question on the default band', () => {
    const decision = run('Add a retry to the upload helper')
    expect(decision.level).toBe('high')
    expect(decision.pinned).toBe(false)
    expect(decision.score).toBe(0)
  })

  it('pins max when the user asks for hard thinking', () => {
    expect(run('ultrathink about this').level).toBe('max')
    expect(run('think hard about this one').level).toBe('max')
    expect(run('这个问题请深入分析一下').level).toBe('max')
    expect(run('think hard about this one').pinned).toBe(true)
  })

  it('pins minimal when the user asks for a fast answer', () => {
    expect(run('quick, what is the port?').level).toBe('minimal')
    expect(run('简单说一下就行').level).toBe('minimal')
    expect(run('quick, what is the port?').pinned).toBe(true)
  })

  it('ignores a pin keyword inside code', () => {
    const decision = run('fix this:\n\n```ts\n// think hard about it\n```\n')
    expect(decision.pinned).toBe(false)
    expect(decision.level).not.toBe('max')
  })

  it('lets a pin outrank strong positive evidence', () => {
    const decision = run('why does the whole codebase deadlock? quick answer please')
    expect(decision.level).toBe('minimal')
    expect(decision.pinned).toBe(true)
  })

  it('escalates a cause question with error evidence', () => {
    const decision = run('Why does this throw a TypeError after the migration?')
    expect(decision.score).toBeGreaterThanOrEqual(5)
    expect(decision.level).toBe('high')
    expect(decision.reasons.join(' ')).toContain('cause')
  })

  it('caps a heavy score-derived request at the ceiling', () => {
    const text = [
      'Why does the whole codebase deadlock under concurrency? Analyze the regression,',
      'prove the invariant still holds, and design a migration across all files.',
      '',
      '```ts',
      'await lock.acquire()',
      '```',
      '',
      '```ts',
      'await lock.acquire()',
      '```',
      'x'.repeat(2_100),
    ].join('\n')
    const decision = run(text)
    expect(decision.score).toBeGreaterThan(9)
    expect(decision.level).toBe('high')
    expect(decision.reasons).toContain('capped at high')
  })

  it('reaches max for the same text when the ceiling allows it', () => {
    const decision = run('why does the whole codebase deadlock? prove the invariant.', { autoCeilingLevel: 'max' })
    expect(decision.level).toBe('max')
  })

  it('keeps politeness and verbosity from deciding the turn', () => {
    // A long, substantive message that happens to open politely.
    const polite = `${'Implement the retry with jitter and document it. '.repeat(20)}\nThanks!`
    expect(run(polite).level).toBe('high')
    // Bare politeness is still recognised as such.
    expect(run('谢谢').level).toBe('low')
    expect(run('thanks!').level).toBe('low')
  })

  it('treats a mechanical request as the lowest band', () => {
    const decision = run('git status')
    expect(decision.score).toBeLessThanOrEqual(-6)
    expect(decision.level).toBe('minimal')
  })

  it('keeps the previous level for a bare continuation, under the ceiling', () => {
    const prepared = prepareConfig(defaults())
    const options = {
      levels: prepared.levels,
      rules: prepared.rules,
      maxChars: 8_000,
      inheritOnContinuation: true,
      ceiling: prepared.ceiling,
    }
    const bare = classify('继续', options)
    expect(bare.continuation).toBe(true)
    expect(bare.level).toBe('low')

    const inherited = classify('继续', { ...options, previous: { level: 'max' } })
    expect(inherited.reasons[0]).toContain('kept level max')
    // A pin on the previous turn does not leak the top rung into this one.
    expect(inherited.level).toBe('high')

    const disabled = classify('继续', { ...options, inheritOnContinuation: false, previous: { level: 'max' } })
    expect(disabled.level).toBe('low')
  })

  it('does not inherit when the continuation also carries new work', () => {
    const prepared = prepareConfig(defaults())
    const decision = classify('继续，另外把整个项目的架构也重构一下', {
      levels: prepared.levels,
      rules: prepared.rules,
      maxChars: 8_000,
      inheritOnContinuation: true,
      previous: { level: 'minimal' },
      ceiling: prepared.ceiling,
    })
    expect(decision.level).not.toBe('minimal')
  })

  it('honours custom rules and custom ladders', () => {
    const decision = run('deploy the thing', {
      rules: [{ pattern: 'deploy', level: 'max', note: 'release work' }],
    })
    expect(decision.level).toBe('max')
    expect(decision.reasons).toEqual(['release work'])
  })

  it('truncates long text keeping both ends', () => {
    const text = `${'a'.repeat(100)}${'b'.repeat(100)}`
    const truncated = truncateForClassification(text, 40)
    expect(truncated.length).toBeLessThanOrEqual(40)
    expect(truncated.startsWith('a')).toBe(true)
    expect(truncated.endsWith('b')).toBe(true)
  })
})
