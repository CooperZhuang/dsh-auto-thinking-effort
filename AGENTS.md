# dsh-auto-thinking-effort — AGENTS.md

> **Picking this up cold? Read `docs/handoff.md` first** — it is self-contained:
> current state, environment facts, the API map with evidence locations, the trap
> list, the verification table, and the prioritized next steps.
>
> User-facing docs: `README.md` (zh) / `README_EN.md`. Design rationale:
> `docs/design.md`.

## What this repository is

A DSH (DeepSeek Harness) plugin package that adds a synthetic **Auto** gear to
every route's reasoning-effort list and, while that gear (or no explicit effort)
is selected, chooses the **reasoning-effort level per turn** from the user's own
message: a pure heuristic classifier (`src/classify.ts`) maps text to a score,
the score selects a **level** on a configurable ladder (`src/levels.ts`), and the
level's requested **effort** is clamped to the rungs the exact model route
declares before being written onto the composed request. A concrete gear
(`off`/`low`/`high`/`max`) is always returned verbatim.

It is a **bundle**: `package.json` declares `dsh.bundle.patch` →
`cordis.patch.yml`, the layer DSH merges when the package is installed through
`dsh plugin --profile <name> add dsh-auto-thinking-effort`. It also ships a
**browser half** (`dsh.client` → `lib/client.js`, hand-written in the client
module system's bundle format) that contributes its own settings page
(Settings → 自动思考强度), and it registers a **settings namespace**, so that
page, a hand edit of `~/.dsh/settings.yaml`, and the composition row all
configure the same resolved value.

## Hard constraints (do not "fix" these away)

- **The Auto gear must never reach a provider.** It is not an adapter effort.
  `agent/request` substitutes it before `prepareCall`, the sanitizer stays
  registered even when `enabled: false`, and `prepareCall` is deliberately left
  unpatched so a leaked gear fails loudly in-session instead of becoming a
  malformed provider request. Any new call path that can carry an effort must be
  checked against `src/capability.ts`.
- **`prepend: true` on `agent/request` is load-bearing.** Cordis waterfall
  semantics: *"Listeners run outermost-first … returns the outermost listener's
  return value"* (`cordis/src/events.ts:225-243`). The Web entry point installs
  `installModelSelection` on every agent-scoped context, which re-applies the
  session's stored effort (`dsh-agent/lib/types/model-selection.js:33-47`).
  Without `prepend`, that inner listener silently wins and the gear is never
  resolved. `tests/wiring.spec.ts` registers the selection listener **first** on
  purpose; the gear tests fail if this regresses.
- **A concrete effort is returned verbatim.** That is the whole "manual wins"
  contract; do not add a config that overrides a manual gear without a very good
  reason.
- **Only `reasoningEffort` may be rewritten.** The loop deep-freezes the request
  and logs a `request/header` change for any config difference
  (`dsh-agent-loop/lib/index.js:700-756`). Changing provider/model/prompt from
  here would break routing and cache expectations; it is out of scope by design.
- **Never mutate the composed config.** Return a new object only when the effort
  actually changes; otherwise return the same object the loop handed us.
- **`classifier: model` is the shipped default; `heuristic` must stay a
  first-class path.** The default is the one sanctioned model call (D20): it
  runs through `src/model-classifier.ts`, never through `agent/request`, always
  under a timeout, and **any** failure resolves to `undefined` so the turn
  continues on the heuristic level (D17). A pinned turn is never sent to it
  either — a pin is the user speaking, and a model must not be able to outvote
  an explicit `ultrathink`. The heuristic path (D1) stays pure, synchronous,
  deterministic and dependency-free: `classifier: heuristic` must keep working
  as the zero-call option, and the wiring tests keep it as their baseline.
- **The classifier's own call must not think.** `classifierEffort` defaults to
  `off` (D21): the call reads the request and answers one word, so it can never
  be the most expensive thing in a turn. `''` means "the classifier route's
  weakest declared rung"; a pinned value the route does not declare fails the
  call, which is exactly D17's fallback. Do not "improve" this by letting the
  classifier reason about its answer — that is what the classified turn is for.
- **Never throw on the request path.** Every failure path returns the composed
  config unchanged — except a gear, which must be replaced or dropped.
- **`g` / `y` regex flags are rejected** (`src/signals.ts`): a stateful
  `lastIndex` makes the classifier's answer depend on call order.
- **The default band must stay the provider's normal effort**, not the cheapest.
  Classification reads shape, not meaning; the asymmetric cost of a wrong guess
  is the reason (`docs/design.md` D3).
- **`auto` may turn thinking off by default; score-derived decisions still
  never reach the top rung.** `autoFloorLevel` defaults to the ladder's weakest
  rung (no floor) and `autoCeilingLevel` to `high`; only an explicit pin bypasses
  the ceiling. Both are policy knobs, not accidents — do not "simplify" them
  away (`docs/design.md` D13/D14).
- **Pins match prose only.** `stripNonProse` removes fenced blocks, inline code,
  comments, and tags before pin matching; weighted rules keep the raw text so
  pasted error output still counts (D15). A pin firing from inside code is a
  bug, not a feature.
- **Clamping answers from the floor side.** The pool is filtered by the floor
  first and the request only picks within it; nearest-rung matching was removed
  because it violates the floor on sparse ladders (D16).
- **Settings are reached through `ctx.inject(['settings'], …)`, never a plain
  `ctx.get('settings')`.** Cordis only hands out a service whose providing fiber
  is already active, and the settings provider loads its document
  asynchronously, so `ctx.get` silently returns `undefined` here — the plugin
  then runs on the composition row and the user layer is ignored (measured on
  real hardware, `docs/design.md` D18). The inject callback is also the correct
  "optional dependency" shape: it never fires in a deployment with no provider.
- **The composition row is the settings *base* layer, the user layer wins.**
  `adopt()` re-validates every change and keeps the running runtime when one is
  rejected; `validate` refuses the bad *write* in the first place. Do not turn
  either guard into an unconditional adoption (`docs/design.md` D18).
- **The browser half is a hand-written client bundle, and its id must equal the
  package name.** `src/client.js` is a classic script calling
  `window.__ModuleLoader__.load({ id, factory })`; `scripts/build-client.mjs`
  copies it to `lib/client.js` and fails the build when the id or the shape is
  wrong. It is the one source file `tsc` does not check (eslint still does), so
  it stays dependency-free: React and the slot service come from the shell's
  platform table, and the surfaces bind nothing but `ctx.slots`,
  `ctx.settingsScope`, and the model catalog read through
  `ctx.inject(['remote', 'remote.session'], …)` (`docs/design.md` D19/D20).
  **Nothing may throw between the write settling and the drafts clearing**: the
  save's `catch` reports whatever it catches as a failed save, so a stray call
  after a successful `mutate` turns a stored write into a red banner (that is
  exactly what shipped once: `onSaved is not a function`, with the document
  already written). `tests/client.spec.ts` guards the path.
- **The plugin owns one settings page and no Plugins card.** `settings.section`
  is keyed by this plugin's own id (`auto-thinking-effort`, `order: 12`, label
  「自动思考强度」); the `settings.plugin.item` registration was deliberately
  removed once the page existed, because a second copy of the same form in the
  plugin list only creates doubt (`docs/design.md` D19/D20). Registering a card
  again is a product decision, not a fix.

## Conventions

- TypeScript, ESM, `verbatimModuleSyntax` — type-only imports use `import type`,
  and intra-repo imports carry the `.ts` extension.
- Comments explain *why*, not *what*; the DSH packages in `node_modules` are the
  style reference.
- `pnpm check` runs the same gates as CI: typecheck → lint → build → test.
- `lib/` is generated and gitignored; never commit it.
- Every model-visible string and every weight lives in `src/signals.ts` so the
  whole signal set can be reviewed in one place.
- Session-log inspection goes through `scripts/inspect-session.mjs` — the `.zstd`
  artifact is multi-frame, so `zstdDecompressSync` on the whole file silently
  returns only the first frame.

## Where the design decisions live

`docs/design.md` records each decision with its evidence location. If you change
a behaviour a decision describes, update that file in the same commit.
