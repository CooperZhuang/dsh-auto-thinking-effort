/**
 * Turn-state tests: steering may raise but never lower a turn, and a stale
 * record is never applied to another turn.
 */
import { describe, expect, it } from 'vitest'
import type { Decision } from '../src/classify.ts'
import { DEFAULT_LEVELS } from '../src/levels.ts'
import { AgentState } from '../src/state.ts'

/** Build a decision with the fields the state machine reads. */
function decision(level: string, overrides: Partial<Decision> = {}): Decision {
  return { level, score: 0, reasons: [], pinned: false, continuation: false, signal: true, ...overrides }
}

describe('AgentState', () => {
  it('records a fresh decision', () => {
    const state = new AgentState(DEFAULT_LEVELS)
    const record = state.observe(1, decision('high'))
    expect(record).toMatchObject({ turn: 1, level: 'high', origin: 'fresh' })
    expect(state.forTurn(1)).toBe(record)
  })

  it('returns the turn record when a step carries no user message', () => {
    const state = new AgentState(DEFAULT_LEVELS)
    const record = state.observe(2, decision('max'))
    expect(state.observe(2, undefined)).toBe(record)
  })

  it('never applies a stale record to another turn', () => {
    const state = new AgentState(DEFAULT_LEVELS)
    state.observe(1, decision('max'))
    expect(state.forTurn(2)).toBeUndefined()
    expect(state.observe(2, undefined)).toBeUndefined()
  })

  it('lets steering raise the level but not lower it', () => {
    const state = new AgentState(DEFAULT_LEVELS)
    state.observe(1, decision('high'))
    expect(state.observe(1, decision('max', { score: 12 }))).toMatchObject({ level: 'max', origin: 'steered' })
    expect(state.observe(1, decision('minimal', { score: -8 }))).toMatchObject({ level: 'max', origin: 'steered' })
  })

  it('lets an explicit pin lower the level mid-turn', () => {
    const state = new AgentState(DEFAULT_LEVELS)
    state.observe(1, decision('max'))
    expect(state.observe(1, decision('minimal', { pinned: true }))).toMatchObject({ level: 'minimal', origin: 'fresh' })
  })

  it('marks an inherited continuation', () => {
    const state = new AgentState(DEFAULT_LEVELS)
    state.observe(1, decision('max'))
    expect(state.observe(2, decision('max', { continuation: true, score: -3 }))).toMatchObject({ origin: 'inherited' })
  })

  it('treats an unknown level as weaker than any known one', () => {
    const state = new AgentState(DEFAULT_LEVELS)
    state.observe(1, decision('nope'))
    expect(state.observe(1, decision('low'))).toMatchObject({ level: 'low' })
  })

  it('clears its record', () => {
    const state = new AgentState(DEFAULT_LEVELS)
    state.observe(1, decision('high'))
    state.clear()
    expect(state.last).toBeUndefined()
  })
})
