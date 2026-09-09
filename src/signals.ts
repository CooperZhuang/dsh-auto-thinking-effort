/**
 * The built-in signal rules: what in a user's question predicts how much
 * thinking the turn deserves.
 *
 * Two rule shapes exist and they are not interchangeable:
 *
 * - A **pin** (`level`) short-circuits scoring entirely. It encodes the user
 *   saying what they want — "think hard about this" / "just give me the
 *   one-liner" — and outranks every heuristic, because a stated preference is
 *   evidence and a guess is not.
 * - A **weight** rule adds evidence to a running score. Weights are tuned so a
 *   bare question lands on the default band, an ordinary "why is this failing"
 *   reaches the top of that band, and only genuinely heavy work crosses into
 *   `max`.
 *
 * Patterns are plain strings so config-provided rules and built-ins share one
 * type; they are compiled case-insensitively (see {@link compileRules}).
 *
 * @module dsh-auto-thinking-effort/signals
 */

/**
 * Pin tokens resolved against the configured ladder at load time. They let a
 * shipped rule mean "the strongest rung" rather than a hard-coded id, so a
 * deployment that replaces the ladder keeps a working "think hard" pin.
 */
export const STRONGEST_LEVEL = '$strongest'

/** Pin token for the weakest configured level. */
export const WEAKEST_LEVEL = '$weakest'

/** One configured signal rule. */
export interface RuleSpec {
  /** Regular-expression source, compiled by {@link compileRules}. */
  pattern: string
  /** Score contribution when the pattern matches and no `level` is set. */
  weight?: number
  /**
   * Level to pin when the pattern matches; overrides `weight`. A configured
   * level id, or {@link STRONGEST_LEVEL} / {@link WEAKEST_LEVEL}.
   */
  level?: string
  /** `RegExp` flags; default `i`. `g` and `y` are rejected. */
  flags?: string
  /**
   * Match against prose only — fenced blocks, inline code, and XML/HTML tags
   * are stripped first. Pin rules default to `true` (a keyword inside a code
   * block or a path must not change behaviour); score rules default to `false`
   * so pasted error text still counts as evidence.
   */
  proseOnly?: boolean
  /** Human-readable reason recorded in logs and decisions. */
  note?: string
}

/** A rule with its pattern compiled. */
export interface CompiledRule {
  /** The compiled pattern. */
  readonly regex: RegExp
  /** Score contribution; `0` for a pin rule. */
  readonly weight: number
  /** Level id to pin, when this rule pins. */
  readonly level: string | undefined
  /** Whether the pattern is matched against prose-stripped text. */
  readonly proseOnly: boolean
  /** Reason recorded when the rule fires. */
  readonly note: string
}

/** The shipped rules, in evaluation order. Pins come first. */
export const BUILTIN_RULES: readonly RuleSpec[] = Object.freeze([
  {
    pattern: '\\bultrathink\\b|\\bthink (?:hard|harder|deeply|carefully|really hard)\\b|深入(?:思考|分析|研究)|仔细(?:想|分析|研究|推敲)|认真(?:想|分析)|想清楚|好好(?:想|分析)|(?:用|要)(?:最高|最大|最强)(?:的)?(?:思考|推理|档位)|thorough(?:ly)? (?:analy[sz]e|review|investigate)|max(?:imum)? (?:thinking|reasoning|effort)',
    level: STRONGEST_LEVEL,
    note: 'user asked for maximum thinking',
  },
  {
    pattern: '\\b(?:quick(?:ly)?|asap|short answer|one[- ]liner|tldr|tl;?dr|no need to think|don\'?t overthink)\\b|简单(?:说|回答|讲)|一句话|别(?:多想|想太多|分析)|不用(?:想|思考|分析)|直接(?:说|回答|给我|给个)',
    level: WEAKEST_LEVEL,
    note: 'user asked for a fast, shallow answer',
  },
  {
    pattern: '\\bwhy\\b|root cause|为什么|为何|原因(?:是什么|在哪)|根因|怎么会',
    weight: 5,
    note: 'asks for a cause or mechanism',
  },
  {
    pattern: '\\b(?:prove|proof|lemma|theorem|derive|integral|derivative|probabilit|combinator|algorithm|complexity|big[- ]o)\\b|证明|推导|公式|算法|复杂度|数学',
    weight: 4,
    note: 'mathematical or algorithmic reasoning',
  },
  {
    pattern: '\\b(?:design(?:s|ed|ing)?|architect(?:ure|ural)?|plan(?:s|ned|ning)?|refactor\\w*|migrat(?:e|ion|ing)|restructur\\w*|rewrit(?:e|ing|ten))\\b|设计|架构|方案|重构|迁移|规划|改造',
    weight: 4,
    note: 'design or restructuring work',
  },
  {
    pattern: '\\b(?:analy[sz]e|debug|diagnose|investigat|review|audit|compare|evaluat|assess|trade[- ]?off|optimi[sz]e|benchmark|profil)\\w*|分析|排查|调试|诊断|审查|复盘|评估|对比|权衡|优化|调研',
    weight: 3,
    note: 'analysis or investigation work',
  },
  {
    pattern: '\\b(?:race condition|deadlock|memory leak|security|vulnerab|concurren|thread[- ]safe|regression|flaky)\\w*|并发|死锁|内存泄漏|安全|漏洞|回归|偶发',
    weight: 3,
    note: 'concurrency, security, or regression risk',
  },
  {
    pattern: '\\b(?:still (?:fails?|broken|not working|wrong)|doesn\'?t work|not working|keep(?:s)? failing|same error)\\b|还是不行|不对|又(?:报错|失败|崩)|依然|再次失败|重复出现|仍然',
    weight: 3,
    note: 'a previous attempt failed',
  },
  {
    pattern: '\\b(?:traceback|exception|stack trace|panic|segmentation fault|fatal|assertion (?:failed|error)|\\w+Error|npm ERR)\\b|报错|异常|堆栈|崩溃',
    weight: 2,
    note: 'carries error evidence',
  },
  {
    pattern: '\\bstep by step\\b|一步一步|一步步|逐步|详细(?:说明|解释|分析)|讲清楚',
    weight: 2,
    note: 'asks for a step-by-step explanation',
  },
  {
    pattern: '\\b(?:codebase|entire|whole (?:repo|project|file|code)|across (?:all|the) files?|all files?)\\b|整个|全部|全仓|所有文件|代码库|全项目',
    weight: 2,
    note: 'spans many files or a whole project',
  },
  {
    pattern: '\\b(?:and also|as well as|additionally|moreover|plus the)\\b|另外|同时|以及|并且|还有',
    weight: 2,
    note: 'several requirements in one message',
  },
  {
    pattern: '\\b(?:git (?:status|log|diff|add|commit|push|pull)|list (?:the )?files?|show me the file|open the file|rename|move the file|delete the file|format the code)\\b|列(?:一下|出)|查一下|看一下|打开(?:文件)?|重命名|删掉|格式化|跑一下测试',
    weight: -3,
    note: 'mechanical, tool-driven request',
  },
  {
    pattern: '\\b(?:thanks|thank you|nice|cool|great|got it|sounds good|sure|perfect)\\b|谢谢|好的|收到|明白|可以|不错|辛苦了',
    weight: -2,
    note: 'acknowledgement or chit-chat',
  },
])

/** Flags this plugin refuses: both make `RegExp.test` stateful across calls. */
const REJECTED_FLAGS = /[gy]/

/**
 * Compile configured rules once, at load time.
 *
 * `g` and `y` are rejected rather than tolerated: a stateful `lastIndex` turns
 * a pure classifier into one whose answer depends on call order. Pin rules
 * default to prose-only matching; see {@link RuleSpec.proseOnly}.
 *
 * @param specs - built-in and configured rules, in evaluation order.
 * @returns the compiled rules.
 * @throws when a pattern is empty, a flag is rejected, a weight is not finite,
 * or a pattern does not compile.
 */
export function compileRules(specs: readonly RuleSpec[]): CompiledRule[] {
  return specs.map((spec, index) => {
    const label = `rules[${String(index)}]`
    if (spec.pattern.trim() === '') throw new TypeError(`auto-thinking-effort: ${label}.pattern must not be empty`)
    const flags = spec.flags ?? 'i'
    if (REJECTED_FLAGS.test(flags)) {
      throw new TypeError(`auto-thinking-effort: ${label}.flags must not contain "g" or "y" (stateful lastIndex), got ${JSON.stringify(flags)}`)
    }
    const weight = spec.weight ?? 0
    if (!Number.isFinite(weight)) throw new TypeError(`auto-thinking-effort: ${label}.weight must be a finite number, got ${String(spec.weight)}`)
    let regex: RegExp
    try {
      regex = new RegExp(spec.pattern, flags)
    } catch (error) {
      throw new SyntaxError(`auto-thinking-effort: ${label}.pattern does not compile: ${String(error)}`, { cause: error })
    }
    const note = spec.note ?? `matched /${spec.pattern}/`
    return {
      regex,
      weight,
      level: spec.level,
      proseOnly: spec.proseOnly ?? spec.level !== undefined,
      note: note.slice(0, 120),
    }
  })
}
