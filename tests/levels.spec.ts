/**
 * Ladder tests: band selection and the clamp against a route's declared rungs.
 */
import { describe, expect, it } from 'vitest'
import { assertLevels, DEFAULT_LEVELS, effortLadder, levelForScore, resolveEffort } from '../src/levels.ts'
import type { LevelSpec } from '../src/levels.ts'

describe('assertLevels', () => {
  it('accepts the shipped ladder', () => {
    expect(() => { assertLevels(DEFAULT_LEVELS) }).not.toThrow()
  })

  it('rejects an empty ladder', () => {
    expect(() => { assertLevels([]) }).toThrow(/must not be empty/)
  })

  it('rejects duplicate ids', () => {
    expect(() => { assertLevels([{ id: 'a', effort: 'low', maxScore: 1 }, { id: 'a', effort: 'high' }]) }).toThrow(/duplicate level id/)
  })

  it('rejects a non-monotone score ladder', () => {
    expect(() => { assertLevels([{ id: 'a', effort: 'low', maxScore: 5 }, { id: 'b', effort: 'high', maxScore: 5 }]) }).toThrow(/strictly increase/)
  })

  it('rejects an open-ended level before the last one', () => {
    expect(() => { assertLevels([{ id: 'a', effort: 'low' }, { id: 'b', effort: 'high', maxScore: 5 }]) }).toThrow(/only the last level may omit maxScore/)
  })

  it('rejects an empty effort', () => {
    expect(() => { assertLevels([{ id: 'a', effort: ' ' }]) }).toThrow(/effort must not be empty/)
  })
})

describe('levelForScore', () => {
  const levels: LevelSpec[] = [...DEFAULT_LEVELS]

  it('selects by band boundaries inclusively', () => {
    expect(levelForScore(levels, -100).id).toBe('minimal')
    expect(levelForScore(levels, -6).id).toBe('minimal')
    expect(levelForScore(levels, -5).id).toBe('low')
    expect(levelForScore(levels, -2).id).toBe('low')
    expect(levelForScore(levels, -1).id).toBe('high')
    expect(levelForScore(levels, 11).id).toBe('high')
    expect(levelForScore(levels, 12).id).toBe('max')
    expect(levelForScore(levels, 999).id).toBe('max')
  })
})

describe('effortLadder', () => {
  it('dedupes repeated efforts, keeping level order', () => {
    expect(effortLadder([
      { id: 'a', effort: 'off', maxScore: 0 },
      { id: 'b', effort: 'high', maxScore: 5 },
      { id: 'c', effort: 'high', maxScore: 9 },
      { id: 'd', effort: 'max' },
    ])).toEqual(['off', 'high', 'max'])
  })
})

describe('resolveEffort', () => {
  it('uses the exact requested rung when the route declares it', () => {
    expect(resolveEffort(DEFAULT_LEVELS, DEFAULT_LEVELS[3] as LevelSpec, ['off', 'low', 'high', 'max']))
      .toEqual({ effort: 'max', clamped: false })
  })

  it('clamps to the nearest declared rung', () => {
    const low = DEFAULT_LEVELS[1] as LevelSpec
    expect(resolveEffort(DEFAULT_LEVELS, low, ['off', 'high', 'max'])).toEqual({ effort: 'high', clamped: true })
  })

  it('prefers the stronger rung on a tie', () => {
    const ladder: LevelSpec[] = [
      { id: 'a', effort: 'one', maxScore: 0 },
      { id: 'b', effort: 'two', maxScore: 5 },
      { id: 'c', effort: 'three' },
    ]
    expect(resolveEffort(ladder, ladder[1] as LevelSpec, ['one', 'three'])).toEqual({ effort: 'three', clamped: true })
  })

  it('returns undefined when the route shares no rung with the ladder', () => {
    expect(resolveEffort(DEFAULT_LEVELS, DEFAULT_LEVELS[2] as LevelSpec, ['tiny', 'huge'])).toBeUndefined()
  })
})
