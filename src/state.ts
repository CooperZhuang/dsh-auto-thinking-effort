/**
 * Per-agent turn state.
 *
 * A turn is the unit of decision. The classifier reads the user message that
 * opened the turn; every step of that turn — including the steps that only
 * carry tool results — then runs at that turn's level. Two rules make the state
 * machine worth having:
 *
 * - **Steering never weakens a turn.** A mid-turn message can raise the level
 *   (the user is escalating), but it cannot lower it, because a one-word
 *   "ok, go ahead" is not evidence that the earlier analysis became trivial.
 *   An explicit pin still wins in both directions — that is the user speaking.
 * - **A stale record is never applied.** {@link AgentState.forTurn} answers only
 *   for the exact turn it observed, so a resumed or out-of-order request falls
 *   back to the composed request configuration instead of a leftover level.
 *
 * @module dsh-auto-thinking-effort/state
 */
import type { Decision } from './classify.ts'
import type { LevelSpec } from './levels.ts'

/** How one turn's level came to be. */
export type TurnOrigin = 'fresh' | 'inherited' | 'steered'

/** The decided level for one turn. */
export interface TurnRecord {
  /** Turn number this record belongs to. */
  readonly turn: number
  /** Chosen level id. */
  readonly level: string
  /** Classifier score for the deciding message. */
  readonly score: number
  /** Evidence recorded when the decision was made. */
  readonly reasons: readonly string[]
  /** Whether an explicit pin rule decided it. */
  readonly pinned: boolean
  /** Whether the level was classified fresh, inherited, or raised by steering. */
  readonly origin: TurnOrigin
}

/** One agent's rolling decision state. */
export class AgentState {
  private record: TurnRecord | undefined

  /**
   * @param levels - the ladder, used to compare levels by strength.
   */
  constructor(private readonly levels: readonly LevelSpec[]) {}

  /** The most recent record, whatever turn it belongs to (used for inheritance). */
  get last(): TurnRecord | undefined {
    return this.record
  }

  /**
   * Record one pre-step observation.
   * @param turn - the turn proposing the step.
   * @param decision - the classification of this step's user text, or
   * `undefined` when the step carried no user message.
   * @returns the record in force for the turn, or `undefined` when the turn has
   * no observed user message.
   */
  observe(turn: number, decision: Decision | undefined): TurnRecord | undefined {
    if (decision === undefined) return this.forTurn(turn)
    const previous = this.record
    if (previous !== undefined && previous.turn === turn && !decision.pinned) {
      const raised = this.rank(decision.level) >= this.rank(previous.level)
      this.record = {
        turn,
        level: raised ? decision.level : previous.level,
        score: decision.score,
        reasons: decision.reasons,
        pinned: false,
        origin: 'steered',
      }
      return this.record
    }
    const inherited = previous !== undefined && !decision.pinned && decision.continuation && previous.level === decision.level
    this.record = {
      turn,
      level: decision.level,
      score: decision.score,
      reasons: decision.reasons,
      pinned: decision.pinned,
      origin: inherited ? 'inherited' : 'fresh',
    }
    return this.record
  }

  /**
   * Read the record for one exact turn.
   * @param turn - the turn asking.
   * @returns the record, or `undefined` when it belongs to another turn.
   */
  forTurn(turn: number): TurnRecord | undefined {
    return this.record?.turn === turn ? this.record : undefined
  }

  /** Drop the record (agent disposal). */
  clear(): void {
    this.record = undefined
  }

  /**
   * Rank one level on the ladder.
   * @param level - a level id.
   * @returns its index, or `-1` for an unknown id.
   */
  private rank(level: string): number {
    return this.levels.findIndex((candidate) => candidate.id === level)
  }
}
