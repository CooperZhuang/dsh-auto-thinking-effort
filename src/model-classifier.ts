/**
 * Optional **model-backed** classifier for the Auto gear.
 *
 * The plugin's default classifier is a pure function (`src/classify.ts`). This
 * module adds the other backend the user can select with `classifier: model`: a
 * second, cheap model call that reads the user's request and answers with one
 * level id. It is deliberately modelled on oh-my-pi's
 * `auto-thinking/classifier.ts` — a one-word answer, an earliest-match parser, a
 * strict prompt that ignores politeness and verbosity, and *no* failure path
 * that can break the turn.
 *
 * Three properties make the call safe to put on the turn's critical path:
 *
 * - It is started at `agent/pre-step` and awaited at `agent/request`, so the
 *   latency overlaps prompt assembly instead of adding to it.
 * - It always runs with a **timeout** and the turn's own abort signal.
 * - Any failure — no model, error chunk, unparsable answer, timeout, abort —
 *   resolves to `undefined`, and the caller falls back to the heuristic
 *   decision it already made. The classifier may never fail a turn.
 *
 * The call goes straight to `ctx.llm.stream`, so it never passes through
 * `agent/request` and can never be confused with the conversation request it is
 * deciding for.
 *
 * @module dsh-auto-thinking-effort/model-classifier
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { truncateForClassification } from './classify.ts'
import type { LevelSpec } from './levels.ts'

/** Plugin label carried by the classifier request's message source. */
const PLUGIN = 'auto-thinking-effort'

/** One model route to classify with. */
export interface ClassifierRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** A usable classification. */
export interface ClassifierAnswer {
  /** Level id the model chose; always one of the offered levels. */
  readonly level: string
  /** `provider/model` that answered, for logs. */
  readonly route: string
  /** Uncached input tokens of the classifier call, when reported. */
  readonly inputTokens?: number | undefined
  /** Output tokens of the classifier call, when reported. */
  readonly outputTokens?: number | undefined
}

/** Everything one classifier call needs. */
export interface ClassifierCall {
  /** Plugin context; `llm` is resolved lazily from it. */
  readonly ctx: Context
  /** Route to call. */
  readonly route: ClassifierRoute
  /** Session the call is attributed to. */
  readonly sessionId: SessionId
  /** The user's request text. */
  readonly text: string
  /** Levels the answer must be one of (already bounded by floor and ceiling). */
  readonly levels: readonly LevelSpec[]
  /** Weakest rung of the route, used to keep the classifier cheap. */
  readonly effort: string | undefined
  /** Maximum characters of request text sent. */
  readonly maxChars: number
  /** Output cap for the classifier call. */
  readonly maxTokens: number
  /** Hard deadline for the whole call, in milliseconds. */
  readonly timeoutMs: number
  /** The turn's abort signal, when one is available. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Render the classifier prompt for one allowed level set.
 *
 * The level list comes from the user's own ladder (ids plus optional
 * `description`), so a custom ladder describes itself to the model instead of
 * relying on the shipped four names. The closing lines are oh-my-pi's, verbatim
 * in spirit: judge difficulty, not phrasing, and prefer the lower level when
 * torn.
 *
 * @param levels - the levels the model may answer with.
 * @returns the system prompt.
 */
export function buildClassifierPrompt(levels: readonly LevelSpec[]): string {
  const list = levels.map((level) => `- \`${level.id}\`: ${level.description ?? level.id}`).join('\n')
  return [
    "Coding-agent request difficulty classifier: read the user's request, then choose this turn's reasoning effort.",
    `Reply with exactly one word: ${levels.map((level) => `\`${level.id}\``).join(', ')}. No punctuation, explanation, or other text.`,
    'Levels:',
    list,
    'Judge inherent task difficulty, not phrasing politeness or verbosity.',
    'If torn between two levels, choose the lower one.',
  ].join('\n')
}

/**
 * Read one level id out of a classifier answer.
 *
 * Earliest match wins, matching oh-my-pi's parser: a model that answers
 * "low." or "**high**" is understood, and an answer naming two levels resolves
 * to whichever it mentioned first.
 *
 * @param text - the model's answer.
 * @param levels - the levels that were offered.
 * @returns the chosen level id, or `undefined` when the answer names none.
 */
export function parseClassifierAnswer(text: string, levels: readonly LevelSpec[]): string | undefined {
  const lower = text.toLowerCase()
  let best: { position: number; id: string } | undefined
  for (const level of levels) {
    const id = level.id.toLowerCase()
    const position = lower.search(new RegExp(`(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`))
    if (position < 0) continue
    if (best === undefined || position < best.position) best = { position, id: level.id }
  }
  return best?.id
}

/**
 * Ask a model to classify one request.
 * @param call - the call description.
 * @returns the classification, or `undefined` on any failure (the caller keeps
 * its heuristic decision).
 */
export async function runModelClassifier(call: ClassifierCall): Promise<ClassifierAnswer | undefined> {
  const llm = call.ctx.get('llm') as LlmRuntime | undefined
  if (llm === undefined || call.levels.length === 0) return undefined

  const timeout = AbortSignal.timeout(call.timeoutMs)
  const signal = call.signal === undefined ? timeout : AbortSignal.any([call.signal, timeout])
  const request: GenerateOptions = {
    provider: call.route.provider,
    model: call.route.model,
    ...call.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(call.effort) },
    messages: [createUserMessage({
      content: [{ type: 'text', text: truncateForClassification(call.text, call.maxChars) }],
      source: { kind: 'plugin', plugin: PLUGIN, form: 'recall' },
    })],
    system: buildClassifierPrompt(call.levels),
    maxTokens: call.maxTokens,
    sessionId: call.sessionId,
    signal,
  }

  const assembler = new BlockAssembler()
  try {
    for await (const chunk of llm.stream(request)) assembler.push(chunk)
  } catch {
    // Adapters normalize stream failures to terminal chunks; a throw here means
    // the call itself failed. Either way the caller keeps its heuristic answer.
    return undefined
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') return undefined

  const text = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join(' ')
    .trim()
  const level = parseClassifierAnswer(text, call.levels)
  if (level === undefined) return undefined

  return {
    level,
    route: `${call.route.provider}/${call.route.model}`,
    inputTokens: assembler.usage?.inputTokens,
    outputTokens: assembler.usage?.outputTokens,
  }
}

/**
 * Escape a level id for embedding in a regular expression.
 * @param value - the raw id.
 * @returns the escaped id.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
