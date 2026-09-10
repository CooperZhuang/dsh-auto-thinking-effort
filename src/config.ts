/**
 * Plugin configuration.
 *
 * The knobs are grouped by the question they answer:
 *
 * - *What counts as how much thinking* — `levels`, `builtinRules`, `rules`.
 * - *How the gear is presented* — `autoEffortId`, `autoEffortName`,
 *   `autoEffortDescription`, `autoWhenUnset`.
 * - *What to do with the answer* — `enabled`, `dryRun`, `applyToSubagents`.
 * - *How loud to be* — `logDecisions`, `maxChars`.
 *
 * Validation is fail-loud at load time: a bad regex, an unknown level id, or a
 * non-monotone score ladder is a configuration bug that should stop the plugin
 * tree, not degrade silently at the first turn.
 *
 * @module dsh-auto-thinking-effort/config
 */
import z from '@deepseek-ai/schemastery'
import { assertLevels, DEFAULT_LEVELS } from './levels.ts'
import type { LevelSpec } from './levels.ts'
import { BUILTIN_RULES, compileRules, STRONGEST_LEVEL, WEAKEST_LEVEL } from './signals.ts'
import type { CompiledRule, RuleSpec } from './signals.ts'

/** Plugin configuration. */
export interface ConfigShape {
  /** Master switch; a disabled row registers nothing but the gear sanitizer. */
  enabled: boolean
  /** Decide and log, but never rewrite the request. */
  dryRun: boolean
  /** The score ladder, low to high. */
  levels: LevelSpec[]
  /** Whether the shipped signal rules are used. */
  builtinRules: boolean
  /** Extra signal rules, evaluated after the built-in ones. */
  rules: RuleSpec[]
  /** Synthetic effort id contributed to the model picker. */
  autoEffortId: string
  /** Label shown for the synthetic gear. */
  autoEffortName: string
  /** One-line explanation shown for the synthetic gear. */
  autoEffortDescription: string
  /** Treat a request with no explicit effort as auto too. */
  autoWhenUnset: boolean
  /**
   * Weakest level auto may resolve to. The default is the ladder's weakest rung,
   * i.e. **no floor**: auto may turn thinking off. Raise it (e.g. to `low`) to
   * keep auto from ever switching thinking off.
   */
  autoFloorLevel: string
  /** Highest level a score-derived auto decision may reach (pins bypass it). */
  autoCeilingLevel: string
  /** Which backend decides the level: the shipped heuristics, or a model call. */
  classifier: 'heuristic' | 'model'
  /**
   * `provider/model` the model classifier calls; empty reuses the request's own
   * route. Point it at a small, fast model.
   */
  classifierModel: string
  /** Hard deadline for one classifier call, in milliseconds. */
  classifierTimeoutMs: number
  /** Output cap for the classifier call. */
  classifierMaxTokens: number
  /** Whether subagent child sessions are classified too. */
  applyToSubagents: boolean
  /** Keep the previous level when a message only asks to continue. */
  inheritOnContinuation: boolean
  /** Log every decision at info level. */
  logDecisions: boolean
  /** Maximum characters of user text inspected per turn. */
  maxChars: number
}

/** Schemastery schema for {@link ConfigShape}. */
export const Config: z<ConfigShape> = z.object({
  enabled: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  levels: z.array(z.object({
    id: z.string(),
    effort: z.string(),
    maxScore: z.number().required(false),
    description: z.string().required(false),
  })).default([]),
  classifier: z.union(['heuristic', 'model'] as const).default('heuristic'),
  classifierModel: z.string().default(''),
  classifierTimeoutMs: z.number().default(8_000),
  classifierMaxTokens: z.number().default(64),
  builtinRules: z.boolean().default(true),
  rules: z.array(z.object({
    pattern: z.string(),
    weight: z.number(),
    level: z.string(),
    flags: z.string(),
    note: z.string(),
  })).default([]),
  autoEffortId: z.string().default('auto'),
  autoEffortName: z.string().default('Auto'),
  autoEffortDescription: z.string().default('Pick the effort per turn from your message'),
  autoWhenUnset: z.boolean().default(true),
  autoFloorLevel: z.string().default('minimal'),
  autoCeilingLevel: z.string().default('high'),
  applyToSubagents: z.boolean().default(false),
  inheritOnContinuation: z.boolean().default(true),
  logDecisions: z.boolean().default(true),
  maxChars: z.number().default(8_000),
})

/**
 * Normalize a raw configuration through the schema.
 *
 * The loader hands over the YAML row verbatim, so the input is partial: every
 * field has a default and an absent field means "shipped default". The schema's
 * call signature is declared over the output type, hence the one cast.
 *
 * @param raw - the composition row's config object.
 * @returns the normalized configuration.
 */
export function resolveConfig(raw: unknown = {}): ConfigShape {
  return Config(raw as ConfigShape)
}

/** Validated configuration plus the compiled rule list and resolved bounds. */
export interface PreparedConfig {
  /** The validated ladder. */
  levels: readonly LevelSpec[]
  /** Built-in and configured rules, compiled, in evaluation order. */
  rules: readonly CompiledRule[]
  /** Weakest level auto may resolve to. */
  floor: LevelSpec
  /** Highest level a score-derived decision may reach. */
  ceiling: LevelSpec
}

/**
 * Validate the configuration and compile its rules.
 * @param config - the normalized configuration.
 * @returns the validated ladder and compiled rules.
 * @throws when the ladder, a rule, or a bound is invalid.
 */
export function prepareConfig(config: ConfigShape): PreparedConfig {
  // An empty ladder means "the shipped default", not "no levels": a plugin row
  // that only turns the feature on must work without restating the ladder.
  const levels = config.levels.length === 0 ? [...DEFAULT_LEVELS] : config.levels
  assertLevels(levels)
  if (!Number.isInteger(config.maxChars) || config.maxChars < 32) {
    throw new RangeError(`auto-thinking-effort: maxChars must be an integer >= 32, got ${String(config.maxChars)}`)
  }
  if (config.autoEffortId.trim() === '') {
    throw new TypeError('auto-thinking-effort: autoEffortId must not be empty')
  }
  if (config.autoEffortName.trim() === '') {
    throw new TypeError('auto-thinking-effort: autoEffortName must not be empty')
  }
  if (config.classifier !== 'heuristic' && config.classifier !== 'model') {
    throw new TypeError(`auto-thinking-effort: classifier must be "heuristic" or "model", got ${JSON.stringify(config.classifier)}`)
  }
  if (config.classifierModel.trim() !== '' && !config.classifierModel.includes('/')) {
    throw new TypeError(`auto-thinking-effort: classifierModel must be "provider/model", got ${JSON.stringify(config.classifierModel)}`)
  }
  if (!Number.isInteger(config.classifierTimeoutMs) || config.classifierTimeoutMs < 250) {
    throw new RangeError(`auto-thinking-effort: classifierTimeoutMs must be an integer >= 250, got ${String(config.classifierTimeoutMs)}`)
  }
  if (!Number.isInteger(config.classifierMaxTokens) || config.classifierMaxTokens < 1) {
    throw new RangeError(`auto-thinking-effort: classifierMaxTokens must be a positive integer, got ${String(config.classifierMaxTokens)}`)
  }
  const known = new Set(levels.map((level) => level.id))
  const strongest = (levels[levels.length - 1] as LevelSpec).id
  const weakest = (levels[0] as LevelSpec).id
  const resolveBound = (value: string, field: string): LevelSpec => {
    const id = value === STRONGEST_LEVEL ? strongest : value === WEAKEST_LEVEL ? weakest : value
    const found = levels.find((level) => level.id === id)
    if (found === undefined) {
      throw new TypeError(`auto-thinking-effort: ${field} must name a configured level (or ${WEAKEST_LEVEL}/${STRONGEST_LEVEL}), got ${JSON.stringify(value)} (known: ${[...known].join(', ')})`)
    }
    return found
  }
  const floor = resolveBound(config.autoFloorLevel, 'autoFloorLevel')
  const ceiling = resolveBound(config.autoCeilingLevel, 'autoCeilingLevel')
  if (levels.indexOf(floor) > levels.indexOf(ceiling)) {
    throw new RangeError(`auto-thinking-effort: autoFloorLevel (${floor.id}) must not rank above autoCeilingLevel (${ceiling.id})`)
  }
  const specs: RuleSpec[] = (config.builtinRules ? [...BUILTIN_RULES, ...config.rules] : [...config.rules])
    .map((spec) => spec.level === STRONGEST_LEVEL
      ? { ...spec, level: strongest }
      : spec.level === WEAKEST_LEVEL
        ? { ...spec, level: weakest }
        : spec)
  for (const [index, spec] of specs.entries()) {
    if (spec.level !== undefined && !known.has(spec.level)) {
      throw new TypeError(`auto-thinking-effort: rules[${String(index)}] pins unknown level ${JSON.stringify(spec.level)} (known: ${[...known].join(', ')}, or ${STRONGEST_LEVEL}/${WEAKEST_LEVEL})`)
    }
  }
  return { levels, rules: compileRules(specs), floor, ceiling }
}
