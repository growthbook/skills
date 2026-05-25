# Roadmap — skills not yet built

Status snapshot as of 2026-05-25. The plugin ships **nine** skills (`gb-setup`, `flag-create`, `flag-discovery`, `flag-targeting`, `experiment-brainstorm`, `experiment-design`, `experiment-launch`, `experiment-analyze`, `experiment-stop`). This doc captures every skill that has been *referenced* by an existing skill but doesn't exist yet, with enough detail to scope and prioritize when we pick them up.

After the 2026-05-25 implementation of `flag-targeting`, the post-`experiment-stop` cleanup workflow and the post-`flag-create` "turn it on" workflow are agent-driven. The remaining Phase 2 work is `flag-cleanup` (delete + inline) and `metric-create`.

## Phase 2 — lifecycle gaps with the highest workflow impact

Building these closes the remaining workflow gaps where existing skills still route to "do this in the UI" prose.

### `flag-targeting` — **SHIPPED 2026-05-25**

Add/edit/remove targeting rules on an existing flag, plus env-level kill switch. See `skills/flag-targeting/SKILL.md`. The post-`experiment-stop` cleanup case is the headline use; the after-`flag-create` "turn it on" handoff is the second-most-used path. The plan that produced this skill is preserved in `notes/flag-targeting-plan.md` and `notes/flag-targeting-plan-review.md`.

---

### `flag-cleanup`

**What it does:** remove a stale flag and inline its value in the codebase. Takes a flag ID, surfaces what value it would resolve to today, and walks the user through (a) confirming the value is right for all environments, (b) replacing call sites in the codebase, and (c) deleting the flag.

**Why it's worth building:** `flag-discovery` Path C audits for stale flags but explicitly refuses to delete anything ("audits; cleanup is a separate skill"). The follow-through has no agent path today.

**Likely endpoints:**
- `GET /api/v2/features/<id>` — fetch current state and resolve effective default
- `GET /api/v2/stale-features?ids=<id>` — confirm staleness before deleting
- `DELETE /api/v2/features/<id>` — actually delete (or whatever the API offers; may need to verify the exact path)
- Codebase search via the agent's normal tooling — not a REST call

**Composition with existing skills:**
- Called from `flag-discovery` Path C after the user opts in
- Called from `experiment-analyze` after a stopped experiment when no temporary rollout was enabled and the user is ready to retire the flag

**Estimated effort:** 4-6 hours. The API side is small but the "find and inline call sites in the codebase" part needs careful guardrails (no auto-delete of code; surface call sites for human review).

---

### `metric-create`

**What it does:** create a fact metric or a legacy metric on a chosen datasource, with the SQL/event mapping, metric type (proportion / mean / ratio / quantile), and thresholds (`minSampleSize`, `riskThreshold`, etc.).

**Why it's worth building:** `experiment-design` and `experiment-launch` both have "if the metric you need doesn't exist yet, create it" handoffs. Today that handoff is a UI link; the skill would let the agent finish the design-to-launch flow without leaving.

**Likely endpoints:**
- `POST /api/v1/fact-metrics` — preferred for new metrics
- `POST /api/v1/metrics` — legacy metric format (still used in some orgs)
- `GET /api/v1/data-sources` — pick a datasource (already used by `experiment-design` / `experiment-launch`)

**Composition with existing skills:**
- Called from `experiment-design` step 3 when the user picks a goal metric that doesn't exist
- Called from `experiment-launch` step 2d when the no-template path needs a metric

**Estimated effort:** 5-7 hours. The SQL/event mapping and threshold configuration are more involved than the flag skills.

---

## Phase 3 — wider scope, lower priority

### `experiment-statistics`

**What it does:** deeper statistical questions beyond `experiment-analyze`'s reporting — CUPED interpretation, sequential-testing CI behavior, multiple-comparison corrections, dimensional analysis methodology. Probably a knowledge skill rather than an action skill (no writes to GrowthBook).

**Why it's lower priority:** the existing `experiment-analyze` surfaces enough for the common case (Bayesian vs frequentist, six data-quality checks, CUPED/sequential detection). The deeper-dive scenarios are rarer.

**Composition:** referenced once in `experiment-analyze`'s Handoffs, already gated with "(when shipped)" — honest forward-reference.

**Estimated effort:** 4-6 hours if knowledge-only; more if it adds dimensional snapshot orchestration on top of what `experiment-analyze` already does.

---

### `sdk-install` and `sdk-developer`

**What they do:** SDK installation (`sdk-install`) and SDK code-generation / integration (`sdk-developer`). Distinct from every other skill in the catalog — these are knowledge/code-gen skills, not GrowthBook REST API workflows.

**Why they're separate from Phase 2:** they would compose with the rest of the catalog only loosely (e.g. "we created this flag, now wire it up in your React app"). Different mental model, different success criteria, and the GrowthBook SDK docs are good enough that a thin wrapper isn't obviously valuable.

**Composition with existing skills:** none today; would be loosely related to `flag-create` for the "now use the flag in code" follow-up.

**Estimated effort:** unclear; depends on whether they target a single SDK (e.g. JavaScript) or the full matrix. Probably a multi-day project per SDK.

---

## What we'd lose by not building these

The reword pass on 2026-05-22 made the existing skills honest about the gaps — every "use `flag-targeting`" was replaced with "do this in the GrowthBook UI at `<host>/features/<id>`." So the workflow still completes; the user just has to switch contexts.

The cost of not building the remaining Phase 2 skills:
- **`flag-cleanup`:** stale flags accumulate without an agent-driven removal path.
- **`metric-create`:** new metrics require the UI before an experiment can be designed against them. Lower friction in practice since most orgs reuse a stable set of metrics.

Phase 3 represents wider scope (statistics knowledge, SDK code-gen) that's genuinely different from the lifecycle skills we have. Worth treating as separate projects rather than a continuation of the existing catalog.

## Suggested next move

Build `flag-cleanup` next. It's the natural follow-on to `flag-discovery`'s audit (which today refuses to delete anything), and it composes with `experiment-analyze`'s "stopped → retire the flag" recommendation. The scope is well-defined; the implementation complexity is mostly on the "find and inline call sites in the codebase" side rather than the REST surface.

`metric-create` is third — useful but lower-friction in practice, since most orgs reuse a stable set of metrics rather than creating new ones per experiment.
