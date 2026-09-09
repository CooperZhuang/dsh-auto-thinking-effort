/**
 * Plugin configuration.
 *
 * The knobs are grouped by the question they answer:
 *
 * - *What counts as how much thinking* — `levels`, `builtinRules`, `rules`.
 * - *What to do with the answer* — `enabled`, `dryRun`, `applyToSubagents`,
 *   `respectExplicitEffort`.
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
  /** Master switch; a disabled row registers nothing. */
  enabled: boolean
  /** Decide and log, but never rewrite the request. */
  dryRun: boolean
  /** The score ladder, low to high. */
  levels: LevelSpec[]
  /** Whether the shipped signal rules are used. */
  builtinRules: boolean
  /** Extra signal rules, evaluated after the built-in ones. */
  rules: RuleSpec[]
  /** Whether subagent child sessions are classified too. */
  applyToSubagents: boolean
  /** Keep the previous level when a message only asks to continue. */
  inheritOnContinuation: boolean
  /** Leave a request that already carries an explicit effort untouched. */
  respectExplicitEffort: boolean
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
  })).default([]),
  builtinRules: z.boolean().default(true),
  rules: z.array(z.object({
    pattern: z.string(),
    weight: z.number(),
    level: z.string(),
    flags: z.string(),
    note: z.string(),
  })).default([]),
  inheritOnContinuation: z.boolean().default(true),
  applyToSubagents: z.boolean().default(false),
  respectExplicitEffort: z.boolean().default(false),
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

/** Validated configuration plus the compiled rule list. */
export interface PreparedConfig {
  /** The validated ladder. */
  levels: readonly LevelSpec[]
  /** Built-in and configured rules, compiled, in evaluation order. */
  rules: readonly CompiledRule[]
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
  const known = new Set(levels.map((level) => level.id))
  const strongest = (levels[levels.length - 1] as LevelSpec).id
  const weakest = (levels[0] as LevelSpec).id
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
  return { levels, rules: compileRules(specs) }
}
