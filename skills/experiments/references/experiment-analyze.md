---
name: experiment-analyze
description: Fetch results for a GrowthBook experiment, refresh the snapshot only when the cached data is over 24 hours old, then interpret. Use when the user asks "what are the results of X", "analyze this experiment", "is X winning", "did the test work", "show me the results", or "dig into the dimensions". Reads only — does not stop or modify the experiment. For stopping after you've seen results, use experiment-stop.
---

# experiment-analyze

Fetch results, refresh the snapshot only when the cached data is over 24 hours old or the user wants a different phase/dimension cut, then interpret. This skill is the heaviest in the catalog because of the conditional polling loop and the statistical interpretation — slow down and do each step deliberately.

## Contents

- Workflow
- Guardrails
- Endpoints used
- Handoffs

## Workflow

1. **Fetch results + experiment metadata in one call.** `/results` returns `{ experiment, result }` — the same payload that powers the GrowthBook UI's results view, so there's no need for a separate metadata call.

   If the user gave a name instead of an ID ("the checkout test"), resolve it first — `q` matches against name, tracking key, description, and hypothesis:

   ```bash
   gb-call GET '/api/v1/experiments?q=checkout&sortBy=dateUpdated&sortOrder=desc&limit=10'
   ```

   If more than one experiment plausibly matches, list the candidates and let the user pick — don't guess.

   ```bash
   gb-call GET /api/v1/experiments/<experiment-id>/results
   # or, when the user asks for a specific phase / dimension cut:
   gb-call GET '/api/v1/experiments/<experiment-id>/results?phase=1&dimension=exp:country'
   ```

   The `phase` and `dimension` query params filter to the latest snapshot taken with those settings; omit both for the default "how is it doing" view.

   From `experiment`, capture:

   - `status` — `running` or `stopped` both make sense for analysis. If `draft`, there are no results to interpret; tell the user.
   - `type` — if `"multi-armed-bandit"`, halt and tell the user this skill targets standard A/B tests. Bandits report differently (per-arm probabilities, dynamic traffic allocation) and shouldn't be read with the standard winner/loser framing.
   - `settings.statsEngine` — `"bayesian"` (default) or `"frequentist"`. Drives the metric-interpretation step below.
   - `regressionAdjustmentEnabled` (CUPED) and `sequentialTestingEnabled` — affect what to report.

   From `result`, capture:

   - `id` — the snapshot ID; used in step 3 if a refresh is needed.
   - `dateUpdated` — ISO timestamp of when this snapshot was created. Drives the staleness check in step 2.
   - The per-variation metric data itself (lift estimates, intervals, sample sizes) — what step 4 interprets.

   If the response errors with `"No results found for that experiment"`, the experiment has been started but no snapshot exists yet (the auto-refresh hasn't run, or you've filtered to a phase/dimension that's never been snapshotted). Skip step 2 and jump straight to step 3.

2. **Decide whether to refresh.** Branch on `result.dateUpdated`:

   - **Under 24 hours old, and the existing snapshot matches the user's requested phase/dimension** → skip step 3, jump to step 4.
   - **Over 24 hours old, or the user explicitly asked for a fresh snapshot** → step 3.

   The server auto-refreshes snapshots every 6 hours by default (`EXPERIMENT_REFRESH_FREQUENCY`), so anything under 24 hours has typically been refreshed at least once recently. The 24-hour bar is deliberately conservative — don't burn snapshot-compute budget on data that hasn't moved.

3. **Trigger a fresh snapshot, poll, then re-fetch results.**

   **3a. POST a snapshot.** Optional body fields shape what gets computed; pass the same `phase` / `dimension` the user asked for in step 1:

   - `phase` (integer, 0-indexed): pick a specific phase if the experiment has multiple — e.g., re-analyze the pre-ramp phase after the experiment has ramped up. Defaults to the latest phase.
   - `dimension` (string): break the results down. Built-in: `"pre:date"`, `"pre:activation"`. For a configured Unit Dimension, use its ID (e.g. `"dim_abc123"`). For an Experiment Dimension, prefix with `"exp:"` (e.g. `"exp:country"`).

   ```bash
   echo '{}' | gb-call POST /api/v1/experiments/<experiment-id>/snapshot -
   # or with phase + dimension:
   echo '{"phase": 1, "dimension": "exp:country"}' \
     | gb-call POST /api/v1/experiments/<experiment-id>/snapshot -
   ```

   The response is `{ snapshot: { id, experiment, status } }`. Capture `snapshot.id`.

   **3b. Poll for completion.** Snapshot creation is asynchronous:

   ```bash
   for i in $(seq 1 60); do
     gb-call GET /api/v1/snapshots/<snapshot-id>
     # Parse snapshot.status. Stop when it is "success" or "error".
     sleep 5
   done
   ```

   Cap the loop at 60 iterations (5 minutes). If it hasn't finished by then, stop polling and tell the user the snapshot is still in progress — they can retry the skill in a few minutes. Don't loop forever.

   **3c. Re-fetch results** with the same phase/dimension args used in 3a, then re-capture the fields listed in step 1:

   ```bash
   gb-call GET '/api/v1/experiments/<experiment-id>/results'
   # or, if 3a passed phase/dimension:
   gb-call GET '/api/v1/experiments/<experiment-id>/results?phase=1&dimension=exp:country'
   ```

4. **Run the data-quality checks first, then interpret.** GrowthBook surfaces six health checks; any failing one changes how the result should be read. Surface failures prominently — don't bury them.

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

5. **Present the result.** Use this shape (skip rows that don't apply):

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

6. **Link to the experiment, then suggest the next step.** Always surface the direct UI link so the user can review the live results, dimensional cuts, and historical snapshots beyond what `/results` returns:

   ```
   View in GrowthBook: <host>/experiment/<exp_id>
   ```

   Derive `<host>` from `GB_API_URL` by swapping `api.` → `app.` (matches `references/experiment-launch.md`'s convention; on the default cloud host this produces `https://app.growthbook.io`).

   Then suggest a next action based on `experiment.status` from step 1:

   - `running` and conclusive → suggest `references/experiment-stop.md` with the chosen variation.
   - `running` and inconclusive → suggest waiting or extending.
   - `stopped` → point at flag cleanup via the **feature-flags** skill (`flag-targeting` workflow) to update or remove the `experiment-ref` rule on the linked flag.

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
- **Snapshot timestamp matters.** Always surface `result.dateUpdated` when reporting results — it's both how step 2 decides whether to refresh and how the user judges whether a slow-traffic experiment has moved. Stale snapshots are common; don't hide them.
- **24h is a deliberate ceiling, not the auto-refresh cadence.** The server auto-refreshes every 6h by default, so a snapshot under 24h has almost always been refreshed at least once. The skill's 24h bar gives the user a useful conservative window without paying snapshot compute on data that hasn't moved. Don't drop it to "any data older than a minute" — that's how you pin a busy org against the 60 rpm limit.
- **Rate limit awareness.** Happy path is a single `/results` call. Worst case (no snapshot or stale + 60-iteration poll + re-fetch) is ~63 calls spread over 5 minutes (~13/min), well under 60 rpm. If multiple users invoke this concurrently in the same org the limit can still bite — surface clearly if `gb-call` returns a 429.
- **Read-only.** This skill never stops or modifies the experiment. Hand off to `references/experiment-stop.md` when the user wants to act.
- **`q` rejects negation and operators with a 400.** The list endpoint's `q` param takes the app's search syntax (`status:running tag:checkout` plus free text) but hard-rejects `!`, `~`, `^`, `>`, `<`, `=`. Send plain `field:value` tokens and free text only.
- **When resolving by name, filter bandits with `bandits`, not `type`.** The response's `type` field (`standard` / `multi-armed-bandit`) is not a list query param; sending `type=` returns a 400. Use `bandits=false` to exclude bandits from the candidates, since this skill halts on them anyway. (`implementationType` is a different axis — the linked-change kind.)

## Endpoints used

- `GET /api/v1/experiments?q=<text>` — resolve an experiment ID when the user only gave a name or keyword. `q` matches name, tracking key, description, and hypothesis; pair with `sortBy=dateUpdated&sortOrder=desc` so active experiments surface first.
- `GET /api/v1/experiments/<id>/results` — primary entry point; returns `{ experiment, result }` so step 1 grabs metadata, status, and the snapshot timestamp (`result.dateUpdated`) in a single call. Accepts `phase` / `dimension` query params.
- `POST /api/v1/experiments/<id>/snapshot` — trigger a fresh snapshot when results are over 24h old or the user wants a phase/dimension cut the cached snapshot doesn't cover. Body accepts `phase` (integer) and `dimension` (string).
- `GET /api/v1/snapshots/<snapshot-id>` — poll for snapshot completion (5s interval, 60 iteration cap). Returns `{ snapshot: { id, experiment, status } }`.

## Handoffs

- `references/experiment-stop.md` — when the user is ready to act on a conclusive result.
- the **feature-flags** skill (`flag-targeting` workflow) — after stopping with a winner, the linked flag (if any) needs its `experiment-ref` rule updated or removed.
- `references/experiment-brainstorm.md` — to ground ideas for the next test in results from past experiments.
- `experiment-statistics` (when shipped) — for deeper questions about CUPED, sequential testing, multiple comparisons, dimensional analysis.
