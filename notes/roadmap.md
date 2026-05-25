# Roadmap — skills not yet built

Status snapshot as of 2026-05-25. The plugin ships **ten** skills (`gb-setup`, `flag-create`, `flag-discovery`, `flag-targeting`, `flag-cleanup`, `experiment-brainstorm`, `experiment-design`, `experiment-launch`, `experiment-analyze`, `experiment-stop`). This doc captures every skill that has been *referenced* by an existing skill but doesn't exist yet, with enough detail to scope and prioritize when we pick them up.

The flag-lifecycle skills are now complete (create / discover / targeting / cleanup). The remaining Phase 2 work is `metric-create`.

## Phase 2 — lifecycle gaps with the highest workflow impact

Building these closes the remaining workflow gaps where existing skills still route to "do this in the UI" prose.

### `flag-targeting` — **SHIPPED 2026-05-25**

Add/edit/remove targeting rules on an existing flag, plus env-level kill switch. See `skills/flag-targeting/SKILL.md`. The post-`experiment-stop` cleanup case is the headline use; the after-`flag-create` "turn it on" handoff is the second-most-used path. The plan that produced this skill is preserved in `notes/flag-targeting-plan.md` and `notes/flag-targeting-plan-review.md`.

---

### `flag-cleanup` — **SHIPPED 2026-05-25**

Archive or delete a stale flag, walking the user through inlining `defaultValue` at call sites first. Two-step safety gate (archive → verify → delete). See `skills/flag-cleanup/SKILL.md`. The plan that produced this skill is preserved in `notes/flag-cleanup-plan.md` and `notes/flag-cleanup-plan-review.md`.

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

The cost of not building the remaining Phase 2 skill:
- **`metric-create`:** new metrics require the UI before an experiment can be designed against them. Lower friction in practice since most orgs reuse a stable set of metrics — but the experiment-design and experiment-launch handoffs to "create the metric in the UI" stay in place until this ships.

Phase 3 represents wider scope (statistics knowledge, SDK code-gen) that's genuinely different from the lifecycle skills we have. Worth treating as separate projects rather than a continuation of the existing catalog.

## Suggested next move

Build `metric-create` next — it's the only remaining Phase 2 skill, and it closes the design-to-launch handoff currently routed to the UI. Scope is straightforward on the REST side; the heavier work is the SQL/event mapping and threshold UX for new metrics. Alternatively, defer Phase 2 entirely and weigh Phase 3 options (statistics, SDK) against current pain points.
