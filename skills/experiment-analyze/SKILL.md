---
name: experiment-analyze
description: Trigger a fresh snapshot of a GrowthBook experiment, wait for it to complete, then interpret the results. Use when the user asks "what are the results of X", "analyze this experiment", "is X winning", "did the test work", "show me the results", or "dig into the dimensions". Reads only — does not stop or modify the experiment. For stopping after you've seen results, use experiment-stop.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *) Bash(sleep *)
---

# experiment-analyze

Trigger a fresh snapshot, poll for completion, then interpret the results. This skill is the heaviest in the catalog because it involves a polling loop and statistical interpretation — slow down and do each step deliberately.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It expects `GB_API_KEY` in env. The skill also uses `sleep` between poll calls.

## Workflow

1. **Fetch the experiment metadata.**
   ```bash
   gb-call GET /api/v1/experiments/<experiment-id>
   ```
   Confirm `status` — `running` or `stopped` both make sense for analysis. If `draft`, there are no results to interpret; tell the user.

   Also capture these fields — they change how you interpret the results downstream:
   - `type` — if `"multi-armed-bandit"`, halt and tell the user this skill targets standard A/B tests. Bandits report differently (per-arm probabilities, dynamic traffic allocation) and shouldn't be read with the standard winner/loser framing.
   - `settings.statsEngine` — `"bayesian"` (default) or `"frequentist"`. Drives the metric-interpretation step below.
   - `regressionAdjustmentEnabled` (CUPED) and `sequentialTestingEnabled` — affect what to report.

2. **Trigger a fresh snapshot.** The snapshot endpoint accepts optional `phase` and `dimension`:

   - **Default (no inputs):** uses the experiment's latest phase and no dimension. Use this for the standard "how is it doing" check.
   - **`phase`** (integer, 0-indexed): pick a specific phase if the experiment has multiple — e.g., re-analyze the pre-ramp phase after the experiment has ramped up.
   - **`dimension`** (string): break the results down. Built-in values are `"pre:date"` and (when configured) `"pre:activation"`. For a configured Unit Dimension, use its ID (e.g. `"dim_abc123"`). For an Experiment Dimension, prefix with `"exp:"` (e.g. `"exp:country"`).

   If the user asks for a dimensional cut ("how did this do in the UK", "how does it look day-by-day"), use the corresponding dimension.

   ```bash
   echo '{}' | gb-call POST /api/v1/experiments/<experiment-id>/snapshot -
   # or with phase + dimension:
   echo '{"phase": 1, "dimension": "exp:country"}' \
     | gb-call POST /api/v1/experiments/<experiment-id>/snapshot -
   ```

   The response contains a `snapshot.id` (or similar — check the actual shape). Save it.

3. **Poll for completion.** Snapshot creation is asynchronous. Loop with backoff:
   ```bash
   for i in $(seq 1 60); do
     status=$(gb-call GET /api/v1/experiment-snapshots/<snapshot-id>/status)
     echo "$status"
     # Parse the status field. Stop when status is "success" or "error".
     # Sleep 5 seconds between calls.
     sleep 5
   done
   ```
   Cap the loop at 60 iterations (5 minutes). If it hasn't finished by then, stop polling and tell the user the snapshot is still in progress — they can retry the skill in a few minutes. Don't loop forever.

4. **Fetch the full results.**
   ```bash
   gb-call GET /api/v1/experiments/<experiment-id>/results
   ```
   Returns per-variation results for every metric: lift estimate, confidence interval, sample size, conversion/mean.

5. **Run the data-quality checks first, then interpret.** GrowthBook surfaces six health checks; any failing one changes how the result should be read. Surface failures prominently — don't bury them.

   **Data-quality checks (in order):**

   - **SRM (Sample Ratio Mismatch).** Observed traffic split vs. configured split. Failure invalidates downstream results — say so prominently and stop interpreting until the user understands the bias risk. Common causes: bot traffic, ad-blockers blocking client-side tracking, mid-experiment targeting changes, activation-metric bias.
   - **Multiple Exposures.** Users assigned to more than one variation. A small rate (<1%) is usually fine; a high rate suggests sticky bucketing isn't configured or the hash attribute isn't stable.
   - **Minimum Data Thresholds.** Per-metric minimums (configured per metric). If a metric is below its threshold, results for that metric are not trustworthy yet.
   - **Variation ID Mismatch.** Variation IDs reported by exposures don't match the experiment's configured variations. Indicates a tracking/configuration bug.
   - **Suspicious Uplift.** Per-metric lift exceeds configured suspicious thresholds. Doesn't mean the result is wrong, but real lifts that large are rare — usually a tracking or metric-definition issue.
   - **Guardrails.** Listed under data-quality in the docs because a failing guardrail is a hard stop on shipping. For each: any regression? Even a non-significant regression on a guardrail is worth flagging. Note: multiple-comparison correction is **not** applied to guardrails by design.

   **Power check.** Is the experiment at or near the expected sample size? If well under (e.g., <50% of planned), warn that conclusions are speculative — especially on the frequentist engine, where peeking inflates false-positive rates more aggressively. Bayesian results are more robust to peeking but still benefit from the planned sample size.

   **Primary metric — branch on stats engine:**

   - **Bayesian (`settings.statsEngine === "bayesian"`, the default):** Report **Chance to Win** (the probability the treatment beats the control given the data and prior) and the relative-uplift distribution (point estimate + Credible Interval). GrowthBook treats >95% Chance to Win as a strong positive signal; <5% as a strong negative; the rest is inconclusive. Don't fabricate a p-value.
   - **Frequentist (`settings.statsEngine === "frequentist"`):** Report the lift point estimate, 95% confidence interval, and whether the CI crosses zero. If `regressionAdjustmentEnabled` is true (CUPED), point-estimates may differ from raw means; CIs are typically narrower. If `sequentialTestingEnabled` is true, CIs are intentionally wider to make peeking safe — call this out so the user doesn't compare them to non-sequential CIs.

   **Secondary metrics.** Surface but caveat — these are exploratory; multiple-comparison risk applies on the frequentist engine (GrowthBook only applies the correction there; on Bayesian, the implicit correction comes from the prior). Don't promote a secondary to "we won on X" if the primary didn't move.

   **Dimensions (if user asks).** If the snapshot was taken with a `dimension`, the results endpoint returns the per-dimension cuts. Surface notable splits but don't fish — dimensional analysis multiplies the comparison count.

6. **Present the result.** Use this shape (skip rows that don't apply):

   ```
   ## Experiment: <name> (<id>)
   - Status: <running|stopped>
   - Type: <standard|multi-armed-bandit>
   - Stats engine: <bayesian|frequentist>
   - Adjustments: <CUPED on/off, sequential testing on/off>
   - Phase: <phase name or index>
   - Dimension: <none | dimension id used>
   - Sample size: <total users> across N variations
   - Snapshot timestamp: <when this snapshot ran>

   ### Data-quality checks
   - SRM: <pass / fail with detail>
   - Multiple Exposures: <pass / rate>
   - Minimum Data Thresholds: <met / not met, per metric>
   - Variation ID Mismatch: <pass / fail>
   - Suspicious Uplift: <none / per-metric flags>

   ### Primary metric: <name>
   - Variation 0 (Control): <baseline value>
   - Variation 1 (Treatment): <value>
   - **Bayesian:** Chance to Win <X%>, relative lift <±Y%>, 95% CrI [a, b]
   - **Frequentist:** lift <±Y%>, 95% CI [a, b]<note if CIs are sequential>
   - Verdict: <won / lost / inconclusive>

   ### Guardrails
   - <metric>: <safe / regressed by Y%>

   ### Secondary metrics
   - <metric>: <lift / no movement> <multiple-comparison caveat if frequentist>

   ### Recommendation
   <one paragraph: ship, kill, extend, or investigate>
   ```

7. **Suggest the next step.** If the experiment is `running` and conclusive, suggest `experiment-stop` with the chosen variation. If `running` and inconclusive, suggest waiting or extending. If `stopped`, point at flag cleanup via `flag-targeting`.

## Guardrails

- **All six data-quality checks come before interpretation.** SRM, Multiple Exposures, Minimum Data Thresholds, Variation ID Mismatch, Suspicious Uplift, and Guardrails. A failure in any of them changes how (or whether) to interpret the result. Don't bury them under the primary-metric heading.
- **Branch interpretation on `settings.statsEngine`.** Bayesian (default) reports Chance to Win + Credible Intervals; frequentist reports lift + Confidence Intervals. Don't manufacture a p-value the API didn't return, and don't claim "95% CI" on a Bayesian result (it's a Credible Interval, not a Confidence Interval).
- **Multiple-comparison correction is frequentist-only and excludes guardrails.** When reporting secondaries, note the correction status. On Bayesian, the prior provides implicit shrinkage; no correction is applied.
- **CUPED and sequential testing change how to read CIs.** If `regressionAdjustmentEnabled` is true, point estimates may differ from raw means and CIs are typically narrower. If `sequentialTestingEnabled` is true, CIs are intentionally wider — say so, so the user doesn't compare them apples-to-oranges with non-sequential results.
- **Don't peek-and-decide.** Under-powered experiments mean interim numbers are noisy. Frequentist peeking inflates false-positive rates; Bayesian is more robust but still benefits from hitting the planned sample size.
- **Bandits are out of scope.** `type === "multi-armed-bandit"` reports per-arm probabilities and dynamically reallocates traffic. Halt and tell the user to read bandit results in the UI.
- **Activation-metric bias hides as "passing SRM."** If the experiment uses an activation metric that is downstream of variation differences (e.g., "completed signup" when variations affect signup completion), the overall split can look fine while the activated cohort is biased. The dashboard surfaces this; flag it when you spot the pattern in metadata.
- **Don't promote a secondary to a primary.** If the primary didn't move, the experiment didn't move — secondaries are exploratory.
- **Polling has a ceiling.** 60 iterations × 5s = 5 minutes. If the snapshot isn't done by then, stop and report. Don't run for hours.
- **Snapshot timestamp matters.** Always surface when the snapshot ran. Stale snapshots in slow-traffic experiments are common.
- **Rate limit awareness.** A poll loop + results fetch is ~13 calls in the worst case; well under 60 rpm. But if multiple users invoke this concurrently in the same org, the limit can bite — surface clearly if `gb-call` returns a 429.
- **Read-only.** This skill never stops or modifies the experiment. Hand off to `experiment-stop` when the user wants to act.

## Endpoints used

- `GET /api/v1/experiments/<id>` — metadata + status
- `POST /api/v1/experiments/<id>/snapshot` — trigger a fresh snapshot
- `GET /api/v1/experiment-snapshots/<snapshot-id>/status` — poll for completion (5s interval, 60 iteration cap)
- `GET /api/v1/experiments/<id>/results` — full results once the snapshot succeeds

## Handoffs

- `experiment-stop` — when the user is ready to act on a conclusive result.
- `flag-targeting` — after stopping with a winner, the linked flag (if any) needs its rule updated or removed.
- `experiment-statistics` (when shipped) — for deeper questions about CUPED, sequential testing, multiple comparisons, dimensional analysis.
