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
  const ladder: LevelSpec[] = [...DEFAULT_LEVELS]
  const minimal = ladder[0] as LevelSpec
  const low = ladder[1] as LevelSpec
  const high = ladder[2] as LevelSpec
  const max = ladder[3] as LevelSpec

  it('uses the exact requested rung when the route declares it', () => {
    expect(resolveEffort(ladder, max, ['off', 'low', 'high', 'max'])).toEqual({ effort: 'max', clamped: false })
    expect(resolveEffort(ladder, high, ['off', 'low', 'high', 'max'])).toEqual({ effort: 'high', clamped: false })
  })

  it('lifts a request below the floor up to the floor', () => {
    // `minimal` asks for off; the low floor removes it from the pool.
    expect(resolveEffort(ladder, minimal, ['off', 'low', 'high', 'max'], { floor: low }))
      .toEqual({ effort: 'low', clamped: true })
  })

  it('answers a sparse ladder from the floor side, never from the request side', () => {
    // ['off','max'] with a low floor: off is excluded, so the pool is ['max'].
    expect(resolveEffort(ladder, low, ['off', 'max'], { floor: low })).toEqual({ effort: 'max', clamped: true })
  })

  it('falls back to the whole declared set when the route tops out below the floor', () => {
    expect(resolveEffort(ladder, low, ['off'], { floor: low })).toEqual({ effort: 'off', clamped: true })
  })

  it('drops the floor when it is set to the ladder minimum', () => {
    expect(resolveEffort(ladder, minimal, ['off', 'low', 'high'], { floor: minimal }))
      .toEqual({ effort: 'off', clamped: false })
  })

  it('takes the highest rung not exceeding an unsupported request', () => {
    // `high` is not declared; the pool keeps everything at or below it.
    expect(resolveEffort(ladder, high, ['off', 'low', 'max'], { floor: low })).toEqual({ effort: 'low', clamped: true })
  })

  it('returns undefined when the route shares no rung with the ladder', () => {
    expect(resolveEffort(ladder, high, ['tiny', 'huge'])).toBeUndefined()
  })

  it('returns undefined when the level effort is not on the ladder', () => {
    expect(resolveEffort(ladder, { id: 'x', effort: 'nope' }, ['off', 'low'])).toBeUndefined()
  })
})
