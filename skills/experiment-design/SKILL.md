---
name: experiment-design
description: Help the user design a well-formed GrowthBook experiment before it's launched. Use when the user asks to "design an A/B test", "set up an experiment", "test X vs Y", "configure an experiment", or "what should we measure". Produces a complete spec — hypothesis, variations, primary metric, guardrails, sample size — ready to hand off. Does not create the experiment in GrowthBook. For launching, use experiment-launch. For ideas grounded in past results, use experiment-brainstorm first.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# experiment-design

Help the user produce an experiment spec that's actually launchable. Walk them through hypothesis, variations, metrics, and sample-size sanity. This skill does **not** write to GrowthBook — it ends with a ready-to-launch spec that `experiment-launch` consumes.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` — set in your shell, or written to `~/.config/growthbook/.env` by `/growthbook:setup`. If unset or invalid, gb-call's error message points back at `/growthbook:setup`.

## Workflow

1. **Frame the hypothesis.** Ask the user for an if/then/because:
   > If we change X, then Y will improve, because Z.

   Reject vague hypotheses. "We think users will like it" is not a hypothesis. "If we move the CTA above the fold, then click-through will increase, because users decide whether to engage before they scroll" is.

2. **Define variations.** Default to two: control (current state) and treatment (the change). Three or more variations are valid but cost statistical power; ask the user whether they really need a third. Number variations from 0 (control) to N.

3. **Pick goal metrics (ideally one, two max).** List available metrics:
   ```bash
   gb-call GET /api/v1/metrics
   gb-call GET /api/v1/fact-metrics
   ```
   Help the user choose based on what the hypothesis predicts will move. Note the metric type (proportion, mean, ratio, quantile) — affects sample-size math. Push back hard on three or more goal metrics: the GrowthBook decision framework treats goal metrics as plural by design, but each additional goal dilutes power and complicates the ship/kill decision. Demote the rest to secondary.

   **Watch for activation-metric bias.** If a candidate goal/activation metric is downstream of variation differences (e.g., "completed signup" when the variations themselves affect signup completion), the activated cohort is biased — and the bias hides as a passing SRM check. If the user picks one, flag it and suggest analyzing the un-activated cohort as a sanity check.

4. **Pick guardrails (1–3).** Metrics that *shouldn't* regress. Common examples: signup rate, revenue per user, page error rate, latency. If the user names zero guardrails, push back — every experiment needs at least one. Guardrails are excluded from multiple-comparison correction by design, so don't over-stack them.

5. **Estimate sample size.** Need three inputs from the user:
   - Baseline rate (or mean) of the primary metric — fetch the metric's current value if available:
     ```bash
     gb-call GET /api/v1/metrics/<metric-id>
     ```
   - Minimum detectable effect (MDE) the user cares about, in relative terms ("a 2% lift in conversion").
   - Daily traffic on the affected surface.

   Use a back-of-envelope estimate to gut-check, then point the user at GrowthBook's in-app Power Calculator for the real number. A common rule-of-thumb GrowthBook documents is **≥ 200 conversions per variation** for proportion metrics; the formula `n ≈ 16 × p × (1 - p) / (p × MDE)^2` per variation lands in roughly the same place for 80% power. Don't quote three significant figures from either — they're estimates. Round up and surface the inputs.

   Compute the expected experiment duration: `2 × n / daily_traffic`. Flag the duration on both ends:
   - **> 4 weeks** — likely underpowered for practical use; consider a larger MDE, a more sensitive metric, or higher-traffic surface.
   - **< 1 week** — risks day-of-week and weekend effects skewing the result. Recommend at least one full weekly cycle.

6. **Resolve project + datasource.** If the user mentions a specific project, get its ID:
   ```bash
   gb-call GET /api/v1/projects
   ```
   List datasources for context (the launch step will pick one, but worth showing the user what's available):
   ```bash
   gb-call GET /api/v1/data-sources
   ```

7. **Produce the spec.** Output a structured block the user can review and feed into `experiment-launch`:

   ```
   ## Experiment spec — <short name>

   **Hypothesis:** If <change>, then <outcome>, because <mechanism>.

   **Variations:**
   - 0: Control — <description>
   - 1: Treatment — <description>

   **Primary metric:** <name> (<type>) — baseline <value>
   **Guardrails:** <metric a>, <metric b>
   **MDE:** <X%>
   **Estimated sample size:** <N> per variation
   **Estimated duration:** <D> days at <T> visitors/day on the affected surface
   **Project:** <project id>
   **Tracking key suggestion:** <kebab-case-name>
   ```

   Ask the user to confirm before handing off to `experiment-launch`.

## Guardrails

- **Ideally one goal metric, two max.** GrowthBook's decision framework supports up to two goal metrics, and the power calculator allows up to five, but each additional goal dilutes power and complicates the ship/kill decision. Push back at three; refuse to design for five.
- **No guardrails = no design.** Push back if the user skips them. Even a single "don't crash the site" metric counts. Multiple-comparison correction does **not** apply to guardrails (intentionally — a guardrail signal is meant to block shipping), so don't over-stack them either; 1–3 is the sweet spot.
- **Hypothesis must be falsifiable.** "Users will engage more" isn't — engagement could mean five different things. Force a specific metric prediction.
- **Sample-size math is approximate.** Use it as a gut check; route the user to the in-app Power Calculator for the real number. Round up and surface the inputs you used so the user can check.
- **Watch out for activation-metric bias.** Activation metrics downstream of variation differences silently bias results without tripping SRM. If the user picks one, name the risk explicitly.
- **Suggest an A/A test for first-time experimenters.** If the org has no stopped experiments (check via `flag-discovery` or `experiment-brainstorm`), GrowthBook recommends an A/A test first to validate the implementation before running a real one.
- **Day-of-week effects matter.** Push back on experiment durations under one full week. Weekend traffic and behavior differ from weekday traffic.
- **Don't launch from this skill.** Final spec → user confirms → hand off to `experiment-launch`. Resist scope creep.
- **Tracking-key naming is permanent.** Suggest kebab-case derived from the experiment name. The launch step will use this as `trackingKey`; it lands in event data and can't be cleanly changed later.

## Endpoints used

- `GET /api/v1/metrics` and `/api/v1/fact-metrics` — list candidate primary + guardrail metrics
- `GET /api/v1/metrics/<id>` — fetch baseline value for sample-size estimation
- `GET /api/v1/projects` — resolve project name to ID
- `GET /api/v1/data-sources` — list available datasources (used by launch)

## Handoffs

- `experiment-launch` — consumes the spec and creates the draft experiment in GrowthBook.
- Manual metric creation — if the primary metric doesn't exist yet, the user needs to create it in the GrowthBook UI at `<host>/metrics` (or `<host>/fact-tables` for fact metrics) before launching. No skill for that yet; derive `<host>` from `GB_API_URL` by swapping `api.` → `app.`.
- `experiment-brainstorm` — if the user came in without a specific hypothesis, route back here to ground a new idea in past results.
