/**
 * The classifier: turn one user message into a level decision.
 *
 * Everything here is pure and synchronous on purpose. Classification sits on
 * the critical path of every turn, so it may not cost a model call, a network
 * round trip, or a measurable delay — and a deterministic function is the only
 * kind a reviewer can argue with. The tradeoff is honest: this reads *shape* and
 * *vocabulary*, not meaning. It can be wrong about a subtle question, which is
 * why the ladder's default band is the provider's normal effort rather than the
 * cheapest one.
 *
 * @module dsh-auto-thinking-effort/classify
 */
import { levelForScore } from './levels.ts'
import type { LevelSpec } from './levels.ts'
import type { CompiledRule } from './signals.ts'

/** A classification decision. */
export interface Decision {
  /** Level id chosen for the turn. */
  level: string
  /** Accumulated score before band selection. */
  score: number
  /** Human-readable evidence, in the order it was found. */
  reasons: string[]
  /** Whether an explicit pin rule decided the level. */
  pinned: boolean
  /** Whether the message was a bare continuation of the previous turn. */
  continuation: boolean
  /** Whether the classifier found any evidence at all. */
  signal: boolean
}

/** Inputs the classifier needs from the plugin's configuration. */
export interface ClassifyOptions {
  /** The validated ladder. */
  levels: readonly LevelSpec[]
  /** Compiled signal rules, in evaluation order. */
  rules: readonly CompiledRule[]
  /** Maximum characters of user text inspected per turn. */
  maxChars: number
  /** Whether a bare continuation keeps the previous turn's level. */
  inheritOnContinuation: boolean
  /** The previous turn's decision, when one exists in this session. */
  previous?: { level: string } | undefined
}

/** Messages that only ask the agent to carry on. */
const CONTINUATION_PATTERN = /^(?:继续|接着|往下|下一步|go on|continue|keep going|proceed|carry on|next)[\s!。,.~、]*$/i

/** A message at or below this length is treated as a throwaway unless it is code. */
const SHORT_TEXT_CHARS = 24

/** Length thresholds, in characters, and the score each contributes. */
const LENGTH_BANDS: readonly { atLeast: number; weight: number; note: string }[] = Object.freeze([
  { atLeast: 2_000, weight: 4, note: 'very long message' },
  { atLeast: 600, weight: 2, note: 'long message' },
  { atLeast: 200, weight: 1, note: 'substantial message' },
])

/** Count fenced code blocks. */
const FENCE_PATTERN = /^\s*(?:```|~~~)/gm

/**
 * Truncate long text for classification, keeping both ends.
 *
 * A long prompt's opening states the context and its closing states the ask;
 * cutting only the tail throws away the request. The marker keeps the joined
 * text honest about the gap.
 *
 * @param text - the raw user text.
 * @param maxChars - maximum characters to inspect.
 * @returns text of at most `maxChars` characters.
 */
export function truncateForClassification(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = '\n…\n'
  if (maxChars <= marker.length) return text.slice(0, maxChars)
  const budget = maxChars - marker.length
  const head = Math.floor(budget * 0.6)
  const tail = budget - head
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`
}

/**
 * Classify one user message.
 * @param text - the joined user text for the turn.
 * @param options - ladder, rules, and continuation policy.
 * @returns the decision; `level` is always a configured level id.
 */
export function classify(text: string, options: ClassifyOptions): Decision {
  const inspected = truncateForClassification(text.trim(), options.maxChars)
  const continuation = CONTINUATION_PATTERN.test(inspected)

  for (const rule of options.rules) {
    if (rule.level === undefined) continue
    if (!rule.regex.test(inspected)) continue
    if (!options.levels.some((level) => level.id === rule.level)) continue
    return { level: rule.level, score: 0, reasons: [rule.note], pinned: true, continuation, signal: true }
  }

  const reasons: string[] = []
  let score = 0
  const add = (weight: number, note: string): void => {
    score += weight
    reasons.push(`${note} ${weight > 0 ? '+' : ''}${String(weight)}`)
  }

  for (const rule of options.rules) {
    if (rule.level !== undefined || rule.weight === 0) continue
    if (rule.regex.test(inspected)) add(rule.weight, rule.note)
  }

  const fences = inspected.match(FENCE_PATTERN)?.length ?? 0
  if (fences >= 2) add(3, 'multiple code blocks')
  else if (fences === 1) add(2, 'contains a code block')

  for (const band of LENGTH_BANDS) {
    if (inspected.length >= band.atLeast) {
      add(band.weight, band.note)
      break
    }
  }
  if (inspected.length <= SHORT_TEXT_CHARS && fences === 0) add(-3, 'very short message')

  const questions = (inspected.match(/[?？]/g) ?? []).length
  if (questions >= 3) add(2, 'several questions')
  else if (questions === 2) add(1, 'two questions')

  const listLines = (inspected.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gm) ?? []).length
  if (listLines >= 3) add(1, 'enumerated requirements')

  let level = levelForScore(options.levels, score)
  if (continuation && options.inheritOnContinuation && score <= 0 && options.previous !== undefined) {
    level = options.levels.find((candidate) => candidate.id === options.previous?.level) ?? level
    reasons.unshift(`bare continuation — kept level ${level.id}`)
  }

  return { level: level.id, score, reasons, pinned: false, continuation, signal: score !== 0 || continuation }
}
