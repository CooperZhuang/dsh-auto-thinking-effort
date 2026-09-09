# dsh-auto-thinking-effort

> A DSH (DeepSeek Harness) plugin that **picks the model's reasoning-effort level per turn from the user's question**.
>
> "thanks" → thinking off. "why does this deadlock? analyze and prove it" → top rung.
>
> [中文 README →](./README.md)

---

## What it does (and does not)

Before each turn the plugin reads the message **the human wrote**, scores it, maps the score onto a **level ladder**, and rewrites exactly one field when the request is composed: `reasoningEffort`.

- **Only `reasoningEffort` changes.** Provider, model, system prompt, and message list are never touched. The worst case is a turn that thinks more or less than it needed — never a different conversation.
- **No classifier model call.** Classification is a pure function (regex + structural features): zero latency, zero cost, unit-testable, reproducible. The tradeoff is honest — it reads *shape and vocabulary*, not meaning — so the default band is the provider's normal effort rather than the cheapest one.
- **Does it override a manual choice?** Yes, by default. See [Precedence](#precedence-it-overrides-the-gui-effort-picker).

---

## Install

```powershell
# local checkout (not published to npm yet — use this form)
dsh plugin --profile headless add C:\CodeRepository\dsh-auto-thinking-effort

# once published, install by package name (the row is mounted by the bundle patch)
dsh plugin --profile headless add dsh-auto-thinking-effort
```

`dsh --profile headless --dump-config` should then show:

```yaml
- id: auto-thinking-effort
  name: dsh-auto-thinking-effort
  config:
    enabled: true
    dryRun: false
    applyToSubagents: false
    respectExplicitEffort: false
```

To see what it **would** decide without changing the request, set `dryRun: true`; every turn logs its level, score, and reasons.

---

## The ladder

The shipped ladder matches DeepSeek's four efforts (`off` / `low` / `high` / `max`). `maxScore` is the **inclusive upper bound** of a band; the last level must omit it (catch-all).

| Level | Requested effort | Score band | Meaning |
|---|---|---|---|
| `minimal` | `off` | ≤ −6 | pleasantries, mechanical operations |
| `low` | `low` | −5 … −2 | simple, but worth a real sentence |
| `high` | `high` | −1 … 11 | **default band**: ordinary questions, routine coding |
| `max` | `max` | ≥ 12, or an explicit ask | many strong signals at once |

A score of 0 (no signal at all) lands on `high`, deliberately: when guessing, thinking more is safer than thinking less.

### What scores

**Pins (short-circuit, no scoring)**

| Trigger | Level |
|---|---|
| `think hard` / 深入思考 / 仔细分析 / `thoroughly analyze` / `max thinking` | strongest |
| `quick` / 简单说 / 一句话 / 不用想 / 直接给 | weakest |

> Pins use the `$strongest` / `$weakest` tokens, so they keep working when you replace the ladder with three or five rungs.

**Weighted signals (excerpt; the full list is `src/signals.ts`)**

| Signal | Weight |
|---|---|
| Cause questions: `why` / 为什么 / 根因 / 怎么会 | +5 |
| Math/algorithms: `prove` / 证明 / 推导 / 算法 / 复杂度 | +4 |
| Design/restructuring: `design` / 架构 / 重构 / `migration` | +4 |
| Analysis: `analyze` / 排查 / 调试 / `review` | +3 |
| Concurrency/security/regression: `deadlock` / 死锁 / `memory leak` / 安全 | +3 |
| A previous attempt failed: `still fails` / 还是不行 / 不对 | +3 |
| Error evidence: `TypeError` / `Traceback` / 报错 | +2 |
| `step by step` / 一步步 / 详细解释 | +2 |
| Whole-project scope: `codebase` / 整个项目 / 所有文件 | +2 |
| Multiple requirements: 另外 / 同时 / `and also` | +2 |
| Mechanical: `git status` / 列一下 / 跑一下测试 | −3 |
| Pleasantries: 谢谢 / 好的 / `thanks` | −4 |

**Structural features (computed, not regex)**

| Feature | Weight |
|---|---|
| Body ≥ 2000 / 600 / 200 characters | +4 / +2 / +1 |
| ≥ 2 code fences / 1 code fence | +3 / +2 |
| ≥ 3 question marks / 2 | +2 / +1 |
| ≥ 3 list items | +1 |
| ≤ 24 characters and no code block | −3 |

**Two state-machine rules**

- **Bare continuations inherit** the previous turn's level: `继续` / `go on` does not fall to `low` just because it is short.
- **Steering within a turn may raise but never lower** the level; an explicit pin may still lower it.

---

## Configuration

```yaml
- insert:
    - id: auto-thinking-effort
      name: 'dsh-auto-thinking-effort'
      config:
        enabled: true
        dryRun: false
        applyToSubagents: false
        respectExplicitEffort: false
        logDecisions: true
        inheritOnContinuation: true
        builtinRules: true
        maxChars: 8000
        levels:
          - { id: minimal, effort: off, maxScore: -6 }
          - { id: low, effort: low, maxScore: -2 }
          - { id: high, effort: high, maxScore: 11 }
          - { id: max, effort: max }          # the last level omits maxScore
        rules:
          - { pattern: 'deploy|上线', level: max, note: 'release work' }
          - { pattern: '写个?周报', weight: -2 }
```

| Field | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch; a disabled row registers nothing. |
| `dryRun` | `false` | Decide and log, never rewrite the request. |
| `levels` | table above | Score → level → effort ladder; an empty list means the default. |
| `builtinRules` | `true` | Use the shipped rules; disable to keep only your own. |
| `rules` | `[]` | Extra rules; `level` pins, `weight` scores. |
| `inheritOnContinuation` | `true` | Bare continuations keep the previous level. |
| `applyToSubagents` | `false` | Also classify subagent children (their route is usually chosen by the caller). |
| `respectExplicitEffort` | `false` | Yield when the request already carries an explicit effort. |
| `logDecisions` | `true` | One info line per turn: level, score, reasons. |
| `maxChars` | `8000` | Characters inspected per turn (long text keeps its head 60% + tail 40%). |

### Rule shape

- `pattern`: regex source, case-insensitive by default (`flags: 'i'`). **`g` / `y` are rejected** — a stateful `lastIndex` makes the classifier's answer depend on call order.
- `level`: pin to a level id, or `$strongest` / `$weakest`.
- `weight`: score contribution, may be negative.
- `note`: the reason recorded in logs and decisions.

Everything fails loud at load time: an uncompilable regex, a pin to an unknown level, a non-increasing `maxScore`, an illegal `maxChars` — all throw immediately instead of silently doing nothing on the first turn.

---

## Precedence: it overrides the GUI effort picker

`agent/request` is a **waterfall**: the outermost listener's return value is the final request config. The Web entry point installs `installModelSelection` on every agent, which re-applies the session's stored effort (from `settings.yaml` → `agent-default-model.reasoningEffort`, or the GUI model picker).

This plugin registers with `prepend: true`, so it is always outermost and its decision wins.

- To let the GUI / settings selection decide: set `respectExplicitEffort: true` (the request is then left completely alone whenever it already carries an effort).
- To disable the plugin entirely: `enabled: false`, or `dryRun: true` to observe only.

---

## Boundaries on the request path

- **Unsupported rungs are clamped**: the plugin asks `ctx.llm.resolveModelInfo(provider, model)` for the exact model's declared efforts and takes the nearest rung on the ladder (ties prefer the stronger one).
- **Unknown capabilities change nothing**: a model that declares no reasoning support, a missing `ctx.llm`, or a failed lookup returns the request unchanged and warns once.
- **One level per turn**: every step of a turn — including steps that only carry tool results — uses that turn's level; a new turn re-decides.
- **Compaction and session-title calls are untouched**: they do not go through `agent/request`.

---

## Verification status (honest version)

**Verified on a real machine** (Node v24.16.0 / DSH 0.1.2-rc.1 / `deepseek-official`, logs under `~/.dsh/sessions`):

| Scenario | How | Result | Evidence |
|---|---|---|---|
| Mount + config merge | `dsh plugin --profile headless add <path>` → `--dump-config` | row and config present | `dsh --profile headless --dump-config` |
| Real turn (pleasantry) | `dsh --profile headless "谢谢"` | `request/header` carries `reasoningEffort: "off"` | `session-8ad972fc` |
| **Control** (plugin off) | same prompt + `--patch` setting `enabled: false` | `reasoningEffort: "high"` (= settings default) | `session-5d10f7f5` |
| Real turn (explicit deep thinking) | `dsh --profile headless "深入思考一下：…"` | `reasoningEffort: "max"` | `session-779daed0` |
| Real turn (cause analysis, no pin) | `dsh --profile headless "Why does the upload helper return undefined after the migration?"` | `reasoningEffort: "high"` (why +5, migration +4 = 9, still inside the `high` band) | `session-30b39b2a` |
| **Real GUI turn** | temporary `web-verify` profile (`dsh-base` + `dsh-web-app` + this plugin) on `127.0.0.1:5227`, message sent from a browser | `reasoningEffort: "off"` — even though settings default to `high` and that profile installs `installModelSelection` | `session-76a1f832` |

**Verified in-process only** (`tests/wiring.spec.ts`, using a real cordis Context, the real `installModelSelection`, and the real waterfall dispatcher — with the selection listener deliberately registered first):

| Scenario | Note |
|---|---|
| Overriding the stored effort | the first test fails if `prepend` ever regresses |
| Clamping / no capabilities / no shared rung | via a fake `llm` service |
| Steering raises only, continuation inherits, no cross-turn leakage | see `tests/state.spec.ts`, `tests/wiring.spec.ts` |

**Not verified on a real machine** (known gaps — do not treat as verified):

- **Cross-turn switching inside one live session** (turn 1 `max` → turn 2 `off`, producing a `request/header` with reason `change`): the headless app answers one task and exits, so there is no multi-turn entry point; covered in-process only.
- **A real subagent child** being skipped (`applyToSubagents: false`): in-process with a fake session header only.
- **Non-DeepSeek providers** on the clamping path: fake `resolveModelInfo` only.

Reproduce a real result:

```powershell
node scripts/inspect-session.mjs "C:\Users\Cooper\.dsh\sessions\--C-...--\session-<id>"
node scripts/inspect-session.mjs <session-dir> --grep "request/header"
```

> `session.jsonl.zstd` is a **multi-frame** zstd stream (one frame per flush); `zstdDecompressSync` on the whole file decodes only the first frame. `scripts/inspect-session.mjs` walks every frame.

---

## Development

```powershell
pnpm install
pnpm check     # typecheck → lint → build → test (the CI gate)
```

- `lib/` is generated and gitignored.
- Layout: `src/config.ts` (schema + fail-loud validation), `src/levels.ts` (bands + clamping), `src/signals.ts` (rule table + compiler), `src/classify.ts` (pure classifier), `src/state.ts` (per-agent turn state), `src/index.ts` (wiring).
- Handoff notes: `docs/handoff.md`; design decisions: `docs/design.md`.

## License

MIT
