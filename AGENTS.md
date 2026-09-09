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
`dsh plugin --profile <name> add dsh-auto-thinking-effort`.

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
- **No model call in classification.** The classifier runs on the turn's critical
  path. Determinism and zero latency are the whole point (see `docs/design.md`
  D1). A model-assisted classifier is an open question, not an invitation.
- **Never throw on the request path.** Every failure path returns the composed
  config unchanged — except a gear, which must be replaced or dropped.
- **`g` / `y` regex flags are rejected** (`src/signals.ts`): a stateful
  `lastIndex` makes the classifier's answer depend on call order.
- **The default band must stay the provider's normal effort**, not the cheapest.
  Classification reads shape, not meaning; the asymmetric cost of a wrong guess
  is the reason (`docs/design.md` D3).
- **`auto` never turns thinking off by default, and score-derived decisions
  never reach the top rung.** `autoFloorLevel` (default `low`) and
  `autoCeilingLevel` (default `high`) encode oh-my-pi's policy; only an explicit
  pin bypasses the ceiling. Do not "simplify" these away (`docs/design.md`
  D13/D14).
- **Pins match prose only.** `stripNonProse` removes fenced blocks, inline code,
  comments, and tags before pin matching; weighted rules keep the raw text so
  pasted error output still counts (D15). A pin firing from inside code is a
  bug, not a feature.
- **Clamping answers from the floor side.** The pool is filtered by the floor
  first and the request only picks within it; nearest-rung matching was removed
  because it violates the floor on sparse ladders (D16).

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
