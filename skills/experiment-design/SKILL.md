---
name: experiment-design
description: Help the user design a well-formed GrowthBook experiment before it's launched. Use when the user asks to "design an A/B test", "set up an experiment", "test X vs Y", "configure an experiment", or "what should we measure". Produces a complete spec — hypothesis, variations, primary metric, guardrails, sample size — ready to hand off. Does not create the experiment in GrowthBook. For launching, use experiment-launch. For ideas grounded in past results, use experiment-brainstorm first.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# experiment-design

Help the user produce an experiment spec that's actually launchable. Walk them through hypothesis, variations, metrics, and sample-size sanity. This skill does **not** write to GrowthBook — it ends with a ready-to-launch spec that `experiment-launch` consumes.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It expects `GB_API_KEY` in env.

## Workflow

1. **Frame the hypothesis.** Ask the user for an if/then/because:
   > If we change X, then Y will improve, because Z.

   Reject vague hypotheses. "We think users will like it" is not a hypothesis. "If we move the CTA above the fold, then click-through will increase, because users decide whether to engage before they scroll" is.

2. **Define variations.** Default to two: control (current state) and treatment (the change). Three or more variations are valid but cost statistical power; ask the user whether they really need a third. Number variations from 0 (control) to N.

3. **Pick the primary metric.** Exactly one. List available metrics:
   ```bash
   gb-call GET /api/v1/metrics
   gb-call GET /api/v1/fact-metrics
   ```
   Help the user choose based on what the hypothesis predicts will move. Note the metric type (proportion, mean, ratio, quantile) — affects sample-size math.

4. **Pick guardrails (1–3).** Metrics that *shouldn't* regress. Common examples: signup rate, revenue per user, page error rate, latency. If the user names zero guardrails, push back — every experiment needs at least one.

5. **Estimate sample size.** Need three inputs from the user:
   - Baseline rate (or mean) of the primary metric — fetch the metric's current value if available:
     ```bash
     gb-call GET /api/v1/metrics/<metric-id>
     ```
   - Minimum detectable effect (MDE) the user cares about, in relative terms ("a 2% lift in conversion").
   - Daily traffic on the affected surface.

   For a proportion metric: roughly `n ≈ 16 × p × (1 - p) / (p × MDE)^2` per variation for 80% power. For other metric types, point the user at GrowthBook's power calculator in the UI; don't fake precision the back-of-envelope can't give.

   Compute the expected experiment duration: `2 × n / daily_traffic`. If it's longer than 4 weeks, flag it — the test may be underpowered for practical use.

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

- **One primary metric, full stop.** Five-metric experiments produce false positives via multiple comparisons. Other metrics go in `guardrails` or `secondaryMetrics`, not `primary`.
- **No guardrails = no design.** Push back if the user skips them. Even a single "don't crash the site" metric counts.
- **Hypothesis must be falsifiable.** "Users will engage more" isn't — engagement could mean five different things. Force a specific metric prediction.
- **Sample-size math is approximate.** Don't quote three significant figures on a back-of-envelope estimate. Round up and surface the inputs you used so the user can check.
- **Don't launch from this skill.** Final spec → user confirms → hand off to `experiment-launch`. Resist scope creep.
- **Tracking-key naming is permanent.** Suggest kebab-case derived from the experiment name. The launch step will use this as `trackingKey`; it lands in event data and can't be cleanly changed later.

## Endpoints used

- `GET /api/v1/metrics` and `/api/v1/fact-metrics` — list candidate primary + guardrail metrics
- `GET /api/v1/metrics/<id>` — fetch baseline value for sample-size estimation
- `GET /api/v1/projects` — resolve project name to ID
- `GET /api/v1/data-sources` — list available datasources (used by launch)

## Handoffs

- `experiment-launch` — consumes the spec and creates the draft experiment in GrowthBook.
- `metric-create` — if the primary metric doesn't exist yet, the user needs to create it before launching.
- `experiment-brainstorm` — if the user came in without a specific hypothesis, route back here to ground a new idea in past results.
