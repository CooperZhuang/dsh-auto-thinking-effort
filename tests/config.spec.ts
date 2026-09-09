/**
 * Configuration tests: defaults, fail-loud validation, and rule compilation.
 */
import { describe, expect, it } from 'vitest'
import { prepareConfig, resolveConfig } from '../src/config.ts'
import type { ConfigShape } from '../src/config.ts'
import { compileRules, BUILTIN_RULES } from '../src/signals.ts'

/** Parse a raw configuration through the schema. */
function parsed(raw: Record<string, unknown> = {}): ConfigShape {
  return resolveConfig(raw)
}

describe('Config defaults', () => {
  it('ships enabled with the built-in ladder and rules', () => {
    const config = parsed()
    expect(config.enabled).toBe(true)
    expect(config.dryRun).toBe(false)
    expect(config.builtinRules).toBe(true)
    expect(config.inheritOnContinuation).toBe(true)
    expect(config.applyToSubagents).toBe(false)
    expect(config.autoEffortId).toBe('auto')
    expect(config.autoEffortName).toBe('Auto')
    expect(config.autoWhenUnset).toBe(true)
    expect(config.logDecisions).toBe(true)
    expect(config.maxChars).toBe(8_000)
    expect(config.rules).toEqual([])
    // An empty `levels` list means "the shipped ladder", resolved by prepareConfig.
    const prepared = prepareConfig(config)
    expect(prepared.levels.map((level) => level.id)).toEqual(['minimal', 'low', 'high', 'max'])
    expect(prepared.rules.length).toBe(BUILTIN_RULES.length)
  })

  it('compiles built-in plus configured rules in order', () => {
    const prepared = prepareConfig(parsed({ rules: [{ pattern: 'deploy', weight: 3 }] }))
    expect(prepared.rules.length).toBe(BUILTIN_RULES.length + 1)
    expect(prepared.rules.at(-1)?.weight).toBe(3)
  })

  it('drops the built-in rules when asked', () => {
    const prepared = prepareConfig(parsed({ builtinRules: false, rules: [{ pattern: 'x', weight: 1 }] }))
    expect(prepared.rules.length).toBe(1)
  })
})

describe('prepareConfig validation', () => {
  it('rejects a non-integer maxChars', () => {
    expect(() => prepareConfig(parsed({ maxChars: 12.5 }))).toThrow(/maxChars/)
  })

  it('rejects a rule pinning an unknown level', () => {
    expect(() => prepareConfig(parsed({ rules: [{ pattern: 'x', level: 'nope' }] }))).toThrow(/unknown level/)
  })

  it('rejects an empty gear id or name', () => {
    expect(() => prepareConfig(parsed({ autoEffortId: ' ' }))).toThrow(/autoEffortId/)
    expect(() => prepareConfig(parsed({ autoEffortName: '' }))).toThrow(/autoEffortName/)
  })

  it('accepts a rule pinning a configured custom level', () => {
    const prepared = prepareConfig(parsed({
      levels: [
        { id: 'calm', effort: 'off', maxScore: 0 },
        { id: 'storm', effort: 'max' },
      ],
      rules: [{ pattern: 'x', level: 'storm' }],
    }))
    expect(prepared.levels.map((level) => level.id)).toEqual(['calm', 'storm'])
  })
})

describe('compileRules', () => {
  it('rejects an empty pattern', () => {
    expect(() => compileRules([{ pattern: ' ' }])).toThrow(/must not be empty/)
  })

  it('rejects stateful flags', () => {
    expect(() => compileRules([{ pattern: 'a', flags: 'gi' }])).toThrow(/lastIndex/)
  })

  it('rejects a pattern that does not compile', () => {
    expect(() => compileRules([{ pattern: '(' }])).toThrow(/does not compile/)
  })

  it('rejects a non-finite weight', () => {
    expect(() => compileRules([{ pattern: 'a', weight: Number.NaN }])).toThrow(/finite/)
  })

  it('defaults the note to the pattern and bounds it', () => {
    const [rule] = compileRules([{ pattern: 'a'.repeat(400), weight: 1 }])
    expect(rule?.note.length).toBe(120)
  })

  it('compiles case-insensitively by default', () => {
    const [rule] = compileRules([{ pattern: 'DEPLOY' }])
    expect(rule?.regex.test('deploy now')).toBe(true)
  })
})
