/**
 * The level ladder: a score band table that maps a classifier score to an
 * abstract level, and then to an adapter-owned reasoning-effort id.
 *
 * Two ideas are deliberately separate:
 *
 * - A **level** (`minimal` … `max`) is this plugin's own vocabulary. Rules pin
 *   a level; the score table selects one; logs and tests speak levels.
 * - An **effort** is the provider adapter's opaque id (`off`/`low`/`high`/`max`
 *   for `deepseek-official`). Only the adapter may judge which ids its route
 *   accepts, so the requested effort is resolved against the route's declared
 *   capabilities and clamped to the nearest supported rung.
 *
 * The default table has four levels because DeepSeek exposes exactly four
 * efforts; a provider with more or fewer rungs is supported by editing
 * `levels` (see README).
 *
 * @module dsh-auto-thinking-effort/levels
 */

/** One rung of the ladder. */
export interface LevelSpec {
  /** Stable level id used by rules, logs, and tests. */
  id: string
  /** Adapter-owned effort this level asks for, before clamping. */
  effort: string
  /**
   * Inclusive upper bound of this level's score band. Levels are ordered low to
   * high; the highest level omits `maxScore` and catches every remaining score.
   */
  maxScore?: number
}

/** The shipped ladder: DeepSeek's four efforts, low to high. */
export const DEFAULT_LEVELS: readonly LevelSpec[] = Object.freeze([
  Object.freeze({ id: 'minimal', effort: 'off', maxScore: -6 }),
  Object.freeze({ id: 'low', effort: 'low', maxScore: -2 }),
  Object.freeze({ id: 'high', effort: 'high', maxScore: 11 }),
  Object.freeze({ id: 'max', effort: 'max' }),
])

/** A resolved effort plus whether clamping changed the requested rung. */
export interface EffortResolution {
  /** The effort id to put on the request. */
  effort: string
  /** Whether {@link effort} differs from the level's own requested effort. */
  clamped: boolean
}

/** Constraints applied while resolving an effort. */
export interface ResolveEffortOptions {
  /**
   * Weakest rung auto may resolve to. Omit (or pass the ladder's weakest level)
   * for no floor. Modelled on oh-my-pi's `clampAutoThinkingEffort`: the pool is
   * the declared rungs at or above this rung, falling back to every declared
   * rung only when the route tops out below it.
   */
  floor?: LevelSpec | undefined
}

/**
 * Validate a ladder.
 * @param levels - the configured levels, low to high.
 * @throws when the ladder is empty, has duplicate or empty ids, or its score
 * bands are not strictly increasing with only the last level open-ended.
 */
export function assertLevels(levels: readonly LevelSpec[]): void {
  if (levels.length === 0) throw new TypeError('auto-thinking-effort: levels must not be empty')
  const ids = new Set<string>()
  let previousBound = Number.NEGATIVE_INFINITY
  levels.forEach((level, index) => {
    if (level.id.trim() === '') throw new TypeError(`auto-thinking-effort: levels[${index}].id must not be empty`)
    if (ids.has(level.id)) throw new TypeError(`auto-thinking-effort: duplicate level id ${JSON.stringify(level.id)}`)
    ids.add(level.id)
    if (level.effort.trim() === '') throw new TypeError(`auto-thinking-effort: levels[${index}].effort must not be empty`)
    const isLast = index === levels.length - 1
    if (level.maxScore === undefined) {
      if (!isLast) throw new TypeError(`auto-thinking-effort: only the last level may omit maxScore (levels[${index}] = ${JSON.stringify(level.id)})`)
      return
    }
    if (!Number.isFinite(level.maxScore)) throw new TypeError(`auto-thinking-effort: levels[${index}].maxScore must be a finite number`)
    if (level.maxScore <= previousBound) {
      throw new RangeError(`auto-thinking-effort: maxScore must strictly increase (levels[${index}] = ${String(level.maxScore)} after ${String(previousBound)})`)
    }
    previousBound = level.maxScore
  })
}

/**
 * Select the level owning one score.
 * @param levels - the validated ladder.
 * @param score - the classifier score.
 * @returns the first level whose band contains the score.
 */
export function levelForScore(levels: readonly LevelSpec[], score: number): LevelSpec {
  for (const level of levels) {
    if (level.maxScore === undefined || score <= level.maxScore) return level
  }
  /* c8 ignore next -- assertLevels guarantees an open-ended last level */
  return levels[levels.length - 1] as LevelSpec
}

/**
 * Read the ladder's distinct requested efforts, low to high. Duplicate efforts
 * (two levels asking for the same rung) collapse to their first position, which
 * is what clamping measures distance against.
 * @param levels - the validated ladder.
 * @returns the effort rungs in level order.
 */
export function effortLadder(levels: readonly LevelSpec[]): string[] {
  const ladder: string[] = []
  for (const level of levels) if (!ladder.includes(level.effort)) ladder.push(level.effort)
  return ladder
}

/**
 * Resolve a level's requested effort against a route's declared capabilities.
 *
 * The rung the adapter declares exactly wins when it is inside the allowed
 * pool. Otherwise the **highest declared rung that does not exceed the
 * request** is used, and a request below the whole pool snaps up to the pool's
 * weakest rung. That direction is deliberate (and mirrors oh-my-pi's
 * `clampAutoThinkingEffort`): a sparse ladder such as `["off","max"]` must not
 * answer a `low` request with `off`, because the floor — not the request — is
 * the hard constraint.
 *
 * A route declaring none of the ladder's rungs yields `undefined`: the caller
 * must then leave the request alone rather than guess.
 *
 * @param levels - the validated ladder.
 * @param level - the level to resolve.
 * @param supported - effort ids the exact route declares, in any order.
 * @param options - floor constraints; see {@link ResolveEffortOptions}.
 * @returns the effort to use, or `undefined` when the route supports none of
 * the ladder's rungs.
 */
export function resolveEffort(
  levels: readonly LevelSpec[],
  level: LevelSpec,
  supported: readonly string[],
  options: ResolveEffortOptions = {},
): EffortResolution | undefined {
  const ladder = effortLadder(levels)
  const requestPosition = ladder.indexOf(level.effort)
  if (requestPosition < 0) return undefined

  // Rank the declared rungs on the plugin's own ladder; an adapter effort the
  // ladder cannot order is not selectable by this plugin.
  const ranked = supported
    .map((effort) => ({ effort, position: ladder.indexOf(effort) }))
    .filter((candidate) => candidate.position >= 0)
    .sort((left, right) => left.position - right.position)
  if (ranked.length === 0) return undefined

  const floorPosition = options.floor === undefined ? -1 : ladder.indexOf(options.floor.effort)
  let pool = ranked
  if (floorPosition >= 0) {
    const atOrAboveFloor = ranked.filter((candidate) => candidate.position >= floorPosition)
    if (atOrAboveFloor.length > 0) pool = atOrAboveFloor
  }

  let chosen = pool[0] as { effort: string; position: number }
  for (const candidate of pool) {
    if (candidate.position > requestPosition) break
    chosen = candidate
  }
  return { effort: chosen.effort, clamped: chosen.effort !== level.effort }
}
