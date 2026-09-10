# dsh-auto-thinking-effort

> A DSH (DeepSeek Harness) plugin that adds an **Auto** gear to the model picker. Select it and the plugin picks the reasoning-effort level **every turn** from your message; select `off`/`low`/`high`/`max` and it stays completely out of the way.
>
> "thanks" → thinking off. "why does this deadlock? analyze and prove it" → top rung.
>
> [中文 README →](./README.md)

---

## What it does (and does not)

### The gear

After installing, the effort menu becomes **Auto / Off / Low / High / Max** (`Auto` is the one this plugin adds; the other four are untouched):

| Session selection | Behaviour |
|---|---|
| **Auto** (the synthetic gear) | the plugin decides the effort **every turn** |
| no explicit effort (`autoWhenUnset`) | same — nothing selected means auto |
| `Off` / `Low` / `High` / `Max` | **untouched** — a manual gear always wins |

So "how do I specify it manually?" needs no extra mechanism: **pick a concrete gear**. The plugin only acts when the request carries Auto (or carries no effort at all).

### Two classifier backends

| `classifier` | How the level is decided | Latency / cost |
|---|---|---|
| `model` (default) | **one small-model call**: the allowed levels and their descriptions go into a system prompt, the model answers with a single word | +1 small request per turn (hard timeout, falls back) |
| `heuristic` | a pure function: weighted regex rules + structural features | zero |

`model` is the default because reading the question beats reading its shape; the call answers one word, has a hard deadline, and falls back to the heuristics on any failure. Set `classifier: heuristic` for a path that makes no call at all.

**The classifier itself does not think.** Its own effort is `classifierEffort`, defaulting to **`off`**: the classifier's job is to understand the sentence you already wrote, not to study it, so it stays the cheapest call in the turn. An empty `''` means "whatever the weakest rung of the classifier route is"; any other value names an effort that route declares. It is a dropdown on the settings page.

The model backend's contract:

- **Only called on turns without a pin.** If the user wrote `ultrathink` / `think hard` / `深入思考`, that call is skipped — a pin always wins.
- **Offered only the allowed levels**: the candidates are the ladder rungs between `autoFloorLevel` and `autoCeilingLevel`, so the policy ceiling cannot be talked around; fewer than two candidates means no call at all.
- **Started at `agent/pre-step`, awaited at `agent/request`**, so the latency overlaps prompt assembly; `classifierTimeoutMs` is a hard deadline on top.
- **Every failure falls back to the heuristic decision**: missing model, stream error, timeout, unparsable answer — the turn runs normally with the heuristic level.
- Answers are cached by text (same message, same route, same candidate set: no repeat call; 64 entries).
- A level's `description` is rendered into the prompt, so a custom ladder explains itself to the model; without one the id is used.

```yaml
- id: auto-thinking-effort
  config:
    classifier: model
    # point this at a small, fast model; empty uses the session's own route
    classifierModel: deepseek-official/deepseek-v4-flash
    classifierTimeoutMs: 8000
    classifierMaxTokens: 64
```

### Boundaries
- **Only `reasoningEffort` changes.** Provider, model, system prompt, and message list are never touched. The worst case is a turn that thinks more or less than it needed — never a different conversation.
- **The Auto id never reaches a provider.** It is a picker marker; `agent/request` turns it into a real rung before `prepareCall` runs. Even with `enabled: false` a fallback listener stays registered so a stored Auto cannot leak into a request.
- **Classification is one small-model call by default** (`classifier: model`): it reads the question rather than its shape, answers a single level word, runs under a hard deadline, and falls back to the pure-function heuristics on any failure. Set `classifier: heuristic` for zero latency and zero cost (see below). The default band stays the provider's normal effort rather than the cheapest one.
- **Auto never pollutes the global default**: the plugin intercepts `agent-default-model.saveSelection` and strips Auto, persisting "no explicit effort" instead. A profile without this plugin then reads the provider default instead of an id it cannot resolve.

---

## Install

```powershell
# local checkout (not published to npm yet — use this form)
dsh plugin --profile web add C:\CodeRepository\dsh-auto-thinking-effort

# once published, install by package name (the row is mounted by the bundle patch)
dsh plugin --profile web add dsh-auto-thinking-effort
```

`dsh --profile web --dump-config` should then show:

```yaml
- id: auto-thinking-effort
  name: dsh-auto-thinking-effort
  config:
    enabled: true
    dryRun: false
    applyToSubagents: false
    autoEffortId: auto
    autoEffortName: Auto
    autoEffortDescription: 每轮按提问自动选择档位
```

> **Installing a bundle does not hot-reload**: `patchReload: live` watches only the profile's `cordis.patch.yml` (`dsh-app-boot/lib/index.js:1075-1095`), while install/uninstall edits `package.json`'s bundle list — so **restart `dsh web`** for it to take effect. A running session is not disturbed.

To see what it **would** decide without changing the request, set `dryRun: true`; every turn logs its level, score, and reasons.

---

## The ladder

The shipped ladder matches DeepSeek's four efforts (`off` / `low` / `high` / `max`). `maxScore` is the **inclusive upper bound** of a band; the last level must omit it (catch-all).

| Level | Requested effort | Score band | Meaning |
|---|---|---|---|
| `minimal` | `off` | ≤ −6 | pleasantries, mechanical operations (**sends `off` by default**) |
| `low` | `low` | −5 … −2 | simple, but worth a real sentence |
| `high` | `high` | −1 … 11 | **default band**: ordinary questions, routine coding |
| `max` | `max` | ≥ 12, or an explicit ask | many strong signals (**only reachable via a pin by default**) |

A score of 0 (no signal at all) lands on `high`, deliberately: when guessing, thinking more is safer than thinking less.

### Floor and ceiling

One knob at each end:
- **Floor `autoFloorLevel: minimal` (= no floor)** — a `minimal` decision really sends `off`: pleasantries and mechanical work such as `git status` turn thinking off. Set it to `low` (or any rung above the ladder minimum) to forbid that.
- **Ceiling `autoCeilingLevel: high`** — a **score-derived** decision never exceeds `high`; only an **explicit pin** (`ultrathink` / `think hard` / `深入思考`) may reach `max`. A pin is the user speaking and is never capped.

Both are expressed as ladder rungs, and both accept the `$weakest` / `$strongest` tokens (handy with a custom ladder).

### What scores

**Pins (short-circuit, no scoring)**

| Trigger | Level |
|---|---|
| `ultrathink` / `think hard` / 深入思考 / 仔细分析 / `thoroughly analyze` | strongest |
| `quick` / 简单说 / 一句话 / 不用想 / 直接给 | weakest |

> - Pins use the `$strongest` / `$weakest` tokens, so they keep working when you replace the ladder with three or five rungs.
> - Pins match **prose only**: text inside fenced blocks, inline code, `<!-- comments -->`, or XML/HTML tags never triggers them (`// think hard` does not). Weighted rules still see the raw text, so pasted error output remains evidence.

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
| Pleasantries: 谢谢 / 好的 / `thanks` | −2 |

**Structural features (computed, not regex)**

| Feature | Weight |
|---|---|
| Body ≥ 600 characters | +1 |
| ≥ 2 code fences / 1 code fence | +3 / +2 |
| ≥ 3 question marks / 2 | +2 / +1 |
| ≥ 3 list items | +1 |
| ≤ 24 characters and no code block | −3 |

> **Length and politeness are deliberately weak evidence**: difficulty is not verbosity and not politeness. Both follow oh-my-pi's classifier prompt (*"judge inherent task difficulty, not phrasing politeness or verbosity"*).

**Two state-machine rules**

- **Bare continuations inherit** the previous turn's level: `继续` / `go on` does not fall to `low` just because it is short.
- **Steering within a turn may raise but never lower** the level; an explicit pin may still lower it.

---

## Configuration

The shortest path: **Settings → Plugins → Plugin configuration** holds an “Auto gear” card (this plugin's own browser half). Toggle, pick, and type there, then **save** — that writes `settings.yaml` and the running host reconfigures at once. The file forms below are the same configuration spelled out.

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
| `enabled` | `true` | Master switch. When off, no gear and no classification, but the fallback rewrite stays (a stored Auto still cannot leak). |
| `dryRun` | `false` | Decide and log, never rewrite the request. |
| `levels` | table above | Score → level → effort ladder; an empty list means the default. |
| `builtinRules` | `true` | Use the shipped rules; disable to keep only your own. |
| `rules` | `[]` | Extra rules; `level` pins, `weight` scores. |
| `autoEffortId` | `auto` | Id of the synthetic gear (appears in the selection and the picker). |
| `autoEffortName` | `Auto` | Label shown in the picker. |
| `autoEffortDescription` | see above | One-line explanation shown in the picker. |
| `autoWhenUnset` | `true` | Treat a request with no explicit effort as auto too. |
| `autoFloorLevel` | `minimal` | Weakest level `auto` may resolve to; the default is the ladder minimum (= thinking may be switched off). Set `low` to forbid that. |
| `autoCeilingLevel` | `high` | Highest **score-derived** level; pins bypass it. |
| `classifier` | `model` | Which backend decides: `model` (default, one small-model call) or `heuristic` (pure function, no call). |
| `classifierModel` | `''` | Route for that call, `provider/model`; empty follows the session's own route. The settings page renders this as a dropdown of your configured models. |
| `classifierEffort` | `off` | The **classifier's own** reasoning effort: `off` answers without thinking, `''` uses the route's weakest declared rung, any other value names an effort that route declares. |
| `classifierTimeoutMs` | `8000` | Hard deadline for one classifier call, in milliseconds. |
| `classifierMaxTokens` | `64` | Output cap for the classifier call (it answers with one word). |
| `applyToSubagents` | `false` | Also classify subagent children (their route is usually chosen by the caller). |
| `inheritOnContinuation` | `true` | Bare continuations keep the previous level. |
| `logDecisions` | `true` | One info line per turn: level, score, reasons. |
| `maxChars` | `8000` | Characters inspected per turn (long text keeps its head 60% + tail 40%). |

### Writing it in `settings.yaml`: takes effect live

Since v0.6 the plugin registers a settings namespace named `auto-thinking-effort`, so configuration has two layers:

| Layer | Where | Role |
|---|---|---|
| base | the profile's `cordis.patch.yml` (the `config:` block above) | mount point + fallback values |
| **user layer** | the `auto-thinking-effort:` section of `~/.dsh/settings.yaml` | **wins**, and applies immediately |

Resolution order is *schema defaults → base → user layer*. The namespace is registered with `applies: live` and a watcher: **edit the file and the running host reconfigures at once** — no `dsh web` restart and no reinstall.

```yaml
# ~/.dsh/settings.yaml
auto-thinking-effort:
  classifier: model
  classifierModel: deepseek-official/deepseek-v4-flash
  autoFloorLevel: minimal   # minimal = no floor (auto may switch thinking off)
  autoCeilingLevel: high    # score-derived levels stop here; a pin ignores it
```

Details:

- Each adoption logs one info line: `reconfigured from auto-thinking-effort — gear …, bounds …, classifier=…`.
- **An invalid edit cannot break a session**: a schema failure or a cross-field one (a floor ranking above the ceiling, an `autoFloorLevel` naming no level) is refused at the write site; the last good configuration keeps running and a warning is logged.
- The plugin does **not** depend on `@deepseek-ai/dsh-settings` (the interface is declared structurally, see `src/index.ts`): with no settings provider mounted it simply runs on the profile row.
- The namespace is registered through `ctx.inject(['settings'])` — a service is only readable once its providing fiber is active — so a provider that mounts after this plugin is still picked up.

### Configuration in the GUI: 自动思考强度

The package ships its own browser half (`src/client.js` → `lib/client.js`), which contributes exactly one surface: **Settings → 自动思考强度** — its own page in the settings navigation, right after 模型 and before 插件. It binds this plugin's settings-namespace scope, so the page, `settings.yaml`, and the composition row are always one resolved value.

> The Plugins section no longer shows a card for this plugin: once there is a page of its own, a second copy of the same form in the plugin list only creates doubt. The namespace itself stays registered — that is the half that decides where configuration lives and how it applies live.

Fields: `enabled`, `classifier`, `classifierModel`, `classifierEffort`, `autoFloorLevel`, `autoCeilingLevel`, `maxChars`, `classifierTimeoutMs`, `classifierMaxTokens`, `autoWhenUnset`, `applyToSubagents`, `inheritOnContinuation`, `dryRun`, `logDecisions`. Behaviour:

- `classifierModel` is a **dropdown** fed by the host's model catalog (`remote.session.modelCatalog` — the same list the composer's model picker shows), so "the models you already configured" means the same thing in both places; an extra entry means "follow the session's own route". When the catalog is unavailable the field degrades to free text and says why.
- Drafts stay in the form until **save**, which writes one atomic mutation fenced at the revision the draft started from — a concurrent editor is refused, never silently overwritten.
- A field present in the user layer is badged as overridden; **reset** stages a clear, so the field re-inherits the composition row on save.
- The structured knobs (`levels`, `rules`) are not in the form; edit those in `settings.yaml`.

### Rule shape

- `pattern`: regex source, case-insensitive by default (`flags: 'i'`). **`g` / `y` are rejected** — a stateful `lastIndex` makes the classifier's answer depend on call order.
- `level`: pin to a level id, or `$strongest` / `$weakest`.
- `weight`: score contribution, may be negative.
- `proseOnly`: match prose only (default: `true` for pins, `false` for weighted rules).
- `note`: the reason recorded in logs and decisions.

Everything fails loud at load time: an uncompilable regex, a pin to an unknown level, a non-increasing `maxScore`, an illegal `maxChars`, an empty `autoEffortId`, a floor/ceiling naming no configured level or ranking floor above ceiling — all throw immediately instead of silently doing nothing on the first turn.

---

## Clamp direction: answer from the floor side, not the request side

When a route's declared rungs and the ladder do not overlap exactly (another provider, a custom ladder), the plugin **filters the legal pool by the floor first, then takes the highest pooled rung that does not exceed the request**; a request below the whole pool snaps up to the pool minimum.

That direction is deliberate: on a sparse ladder `["off","max"]` a `low` request must **not** be answered with `off` — the floor is the hard constraint and the request is only a preference. This is oh-my-pi's `clampAutoThinkingEffort` semantics.

---

## Differences from oh-my-pi (`omp`)

References: [`auto-thinking/classifier.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/auto-thinking/classifier.ts), [`thinking.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/thinking.ts).

| Dimension | oh-my-pi | This plugin |
|---|---|---|
| Classification | **one small-model call** (`tiny`/`smol`, or a local on-device <2B model) asked to answer with a single word | **one small-model call by default too** (`classifier: model`, route selectable); `classifier: heuristic` is the zero-call pure-function path |
| Where `auto` lives | an agent-local selector that is **never an Effort**, resolved before provider mapping | a synthetic gear injected into the model's rung list (DSH has no contribution hook) |
| Floor | never below `low` (hard-coded) | **no floor by default** (may reach `off`); set `autoFloorLevel: low` to forbid it |
| Ceiling | default `xhigh` (one below top); only `ultrathink` reaches `max` | default `high`; only an explicit pin reaches `max` |
| Clamping | highest pooled rung not exceeding the request | aligned (see above) |
| Failure | throws → caller falls back to the provisional level and continues | no record → default band; never throws on the request path |

**Both sides have it**: the model-classifier backend. They only have that path; we ship it as an option that is **off by default** — `docs/design.md` D1 keeps zero latency, determinism, and reproducibility first. When enabled it follows D17's contract: never called on a pinned turn, started at `agent/pre-step` and awaited at `agent/request`, and any timeout or failure falls back to the heuristic level.

---

## Why a manual gear is never overridden

`agent/request` is a **waterfall**: the outermost listener's return value is the final request config. The Web entry point installs `installModelSelection` on every agent, which re-applies the session's stored effort.

This plugin registers with `prepend: true`, so it is always outermost — but it only acts in two cases: the request carries `autoEffortId`, or it carries no effort at all while `autoWhenUnset: true`. A request carrying `off`/`low`/`high`/`max` is returned verbatim, so a manual gear is never overridden.

With `autoWhenUnset: false`, "nothing selected" means the provider default and the plugin stays out too.

---

## How the Auto gear is added

The picker's list comes from `ctx.llm.resolveModelInfo(...).reasoning.efforts`, and a selection is validated through `resolveCallConfig`. DSH offers no extension point for contributing a level (`registerAdapter` throws `DUPLICATE_ADAPTER` for an already-registered provider), so the plugin wraps exactly three methods on the live services:

| Wrapped method | Effect |
|---|---|
| `resolveModelInfo` | Inserts `Auto` in front of the adapter's own rungs and makes it the advertised default (so the picker shows Auto until the user chooses). |
| `resolveCallConfig` | Passes the `Auto` id through (it is not an adapter effort, but selection-time validation must accept it). |
| `agentDefaultModel.saveSelection` | Strips `Auto` before the deployment default is persisted, storing "no explicit effort" instead. |

**`prepareCall` is deliberately not wrapped**: if a gear id ever reaches it (plugin uninstalled while a session still selects Auto), the adapter boundary rejects it with `UNSUPPORTED_REASONING_EFFORT` — a loud in-session error instead of a malformed provider request.

---

## Boundaries on the request path

- **Unsupported rungs are clamped**: the plugin asks `ctx.llm.resolveModelInfo(provider, model)` for the exact model's declared efforts (minus Auto) and takes the nearest rung on the ladder (ties prefer the stronger one).
- **Unknown capabilities change nothing**: a model that declares no reasoning support, a missing `ctx.llm`, or a failed lookup returns the request unchanged (a gear is dropped instead, falling back to the provider default) and warns once.
- **One level per turn**: every step of a turn — including steps that only carry tool results — uses that turn's level; a new turn re-decides.
- **Compaction and session-title calls are untouched**: they do not go through `agent/request` (they read the *logged* header, which already holds the substituted real effort).

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
| **GUI: the Auto gear appears** | a second `dsh --profile web --port 0` instance of the **real web profile** (dshmarket/dsh-memories included), opened in a browser | menu shows `Auto / Off / Low / High / Max`; the button reads "推理等级 Auto" | server `127.0.0.1:3745` |
| **GUI: Auto → per turn** | select Auto, send "谢谢" | session `model/selection` records `reasoningEffort: "auto"`; request header `"off"` | `session-11eeae50` |
| **GUI: manual gear not overridden** | same session, switch to `Low`, send "深入思考一下：…" (would classify as `max`) | header stays `"low"` — two different efforts in one live session | `session-11eeae50` |
| **GUI: Auto does not pollute the default** | after selecting Auto, read `settings.yaml` | `agent-default-model` has **no** `reasoningEffort` | `~/.dsh/settings.yaml` |
| Real run: no floor by default (v0.5) | `dsh --profile headless "git status"` (real settings, Auto) | `reasoningEffort: "off"` | `session-3af16e67` |
| Real run: the floor can be raised | the same prompt with `autoFloorLevel: low` | `reasoningEffort: "low"` | `session-4987185c` |
| Real run: pin crosses the ceiling | `dsh --profile headless "深入思考一下：…"` | `reasoningEffort: "max"` | `session-a82f0524` |
| Real run: ceiling holds a heavy score back | long no-pin text (why+codebase+deadlock+analyze+prove+design+migration…) | `reasoningEffort: "high"` (score qualifies for `max`, ceiling blocks it) | `session-771ee9b3` |
| Real run: the model backend decides | the same prompt (quote the first README paragraph) with `classifier: heuristic` vs `classifier: model` (`deepseek-v4-flash`) | heuristic `high` → model `low`: the model judged it trivial and overrode the heuristics | `session-81e78e99` / `session-7de3b60c` |
| Real run: a failing classifier cannot break the turn | `classifierModel` pointing at a nonexistent model | the request went out normally, effort fell back to the heuristic `high` | `session-718b1f73` |
| **Real run: the classifier does not think (v0.6.0)** | the real settings (`classifier: model`, `classifierModel: deepseek-flash`, `classifierEffort: off`) with `dsh --profile headless "git status"` | the request header reads `reasoningEffort: "off"` (the classifier call thought nothing) while the turn was still classified as `high` | `session-09d22183` |
| **Real run: the `settings.yaml` user layer is honoured (v0.6)** | `--patch` pointing `settings-file` at a scratch file holding only `auto-thinking-effort: { autoFloorLevel: low }` (the profile row still says `minimal`), then `dsh --profile headless "git status"` | `reasoningEffort: "low"` (the profile row alone gives `"off"` for that prompt) | `session-518c09e2` vs `session-3af16e67`; final build re-checked in `session-de9b7ee1` |
| **Real run: a running host reconfigures live (v0.6)** | one `dsh --profile web --port 0` process, never restarted: it booted with `autoCeilingLevel: max`, the file was changed to `high` and one turn sent, then changed back to `max` and the same turn sent again | `request/header` followed the file inside one process (`high` / `max`); the provider's own default is `high`, so `max` can only come from the plugin | `session-0f47f1c6` / `session-b7f7a469`; final build re-checked (booted at `high`, edited to `max`) in `session-ce7ffac5` |
| **Real run: its own page in Settings (v0.6)** | a fresh `dsh --profile web --port 0` process, Settings opened | the left navigation gains 自动思考强度 (right after 模型) and the page renders the whole form; `classifier` defaults to `model` | `docs/design.md` D19/D20 |
| **Real run: the `classifierModel` dropdown** | same process, field expanded | options are the host catalog's configured models (`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`) plus “follow the session model”; picking one and saving wrote `classifierModel: deepseek-official/deepseek-v4-flash` | the same scratch settings file |
| **Real run: a form save reaches the host** | in that same process the form set `autoFloorLevel: low` and saved; a new session then sent `git status` | `settings.yaml` gained the value and that turn's `request/header` was `"low"` (the profile row alone gives `"off"` for that prompt) | `session-b340648b` |
| **Real run: reset clears an override** | the field's “reset” was clicked and saved | the `autoFloorLevel` line disappeared from `settings.yaml` (the field re-inherited `minimal`) | the same scratch settings file |
| **Real run: no duplicate in the plugin list** | same process, Settings → Plugins → Plugin configuration opened | only the shipped cards remain (插件市场 / 终端 …); this plugin exists solely as its own page | the same process |

**Verified in-process only** (`tests/wiring.spec.ts` / `tests/capability.spec.ts` / `tests/model-classifier.spec.ts`, using a real cordis Context, the real `installModelSelection`, and the real waterfall dispatcher — with the selection listener deliberately registered first):

| Scenario | Note |
|---|---|
| Gear injection / selection validation / persistence stripping | `tests/capability.spec.ts` (dispose restore, idempotence, no-LLM degradation) |
| A gear always resolves to a real rung | `tests/wiring.spec.ts`: `reasoningEffort` is never `auto` |
| Floor / ceiling / clamp direction / prose-only pins | `tests/levels.spec.ts`, `tests/classify.spec.ts`, `tests/wiring.spec.ts` |
| Clamping / no capabilities / no shared rung | via a fake `llm` service |
| **The classifier call's own effort** | the `model classifier` group in `tests/wiring.spec.ts`: `off` by default, the configured value when one is set, the route's weakest rung when it is blank |
| Steering raises only, continuation inherits, no cross-turn leakage | see `tests/state.spec.ts`, `tests/wiring.spec.ts` |
| **The settings namespace** (registration options, no-provider fallback, user layer wins, reconfiguration on a committed change, gear dropped when disabled, an invalid commit keeps the running config) | the `settings namespace` group in `tests/wiring.spec.ts` (6 cases) against a fake provider implementing the `register`/`watch` contract |
| **The settings page's form logic** (draft → save → one atomic mutation; a rejected save must report and keep the draft; reset = `unset`; a settled write must not be reported as a failure) | `tests/client.spec.ts` (3 cases): a stub `window.__ModuleLoader__`, a fake React and a fake context running `src/client.js` for real. Rendering and layout are still covered by real-machine checks only |

**Not verified on a real machine** (known gaps — do not treat as verified):

- **A real subagent child** being skipped (`applyToSubagents: false`): in-process with a fake session header only.
- **Non-DeepSeek providers** on the clamping path: fake `resolveModelInfo` only.
- **Uninstalling the plugin while a session still selects Auto**: expected to fail loudly in-session with `UNSUPPORTED_REASONING_EFFORT` (`prepareCall` is deliberately unpatched), but never exercised for real.

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
- Layout: `src/config.ts` (schema + fail-loud validation), `src/levels.ts` (bands + clamping), `src/signals.ts` (rule table + compiler), `src/classify.ts` (pure classifier), `src/state.ts` (per-agent turn state), `src/capability.ts` (Auto gear injection), `src/index.ts` (wiring).
- Handoff notes: `docs/handoff.md`; design decisions: `docs/design.md`.

## License

MIT
