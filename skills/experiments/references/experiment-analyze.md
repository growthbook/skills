---
name: experiment-analyze
description: Fetch results for a GrowthBook experiment, refresh the snapshot only when the cached data is over 24 hours old, then interpret. Use when the user asks "what are the results of X", "analyze this experiment", "is X winning", "did the test work", "show me the results", or "dig into the dimensions". Reads only — does not stop or modify the experiment. For stopping after you've seen results, use experiment-stop.
---

# experiment-analyze

Report where an experiment stands and what its results show. One call returns both GrowthBook's own status and decision for the experiment and the metric results behind them. Lead with the status and decision, then give as much metric detail as the question asks for. Read-only: this workflow may refresh a stale snapshot, but it never stops or modifies the experiment.

## Contents

- Workflow
  - 1. Fetch the experiment and its results
  - 2. Refresh only when needed
  - 3. Answer the question that was asked (status questions, results questions)
  - 4. Suggest the next step (from the decision, or your own read when there is none)
- Guardrails
- Endpoints used
- Handoffs

## Workflow

1. **Fetch the experiment and its results.**

   If the user gave a name instead of an ID, resolve it first. `q` matches name, tracking key, description, and hypothesis:

   ```bash
   gb-call GET '/api/v1/experiments?q=checkout&sortBy=dateUpdated&sortOrder=desc&limit=10'
   ```

   If more than one experiment plausibly matches, list the candidates and let the user pick.

   ```bash
   gb-call GET /api/v1/experiments/<experiment-id>/results
   # a specific phase or dimension cut:
   gb-call GET '/api/v1/experiments/<experiment-id>/results?phase=1&dimension=exp:country'
   ```

   The response is `{ experiment, result }`. The rest of the workflow reads three things from it:

   - `experiment.enhancedStatus` — GrowthBook's own read of the experiment: `status`, `detailedStatus`, `needsAttention`, and `decision` (`category`, `status`, `reason`, and where they apply `variations`, `daysLeft`, `healthIssues`, `erroredMetricIds`). The whole object is omitted for holdouts, when `phase` is not the latest phase, and on self-hosted versions that predate it. `decision` alone is omitted for stopped experiments and whenever GrowthBook has no verdict, which is the normal state of a healthy running experiment in an organization that doesn't use the Experiment Decision Framework.
   - `experiment.settings` — `statsEngine`, plus `goals`, `secondaryMetrics`, and `guardrails`, each a list of `{ metricId }` that tells you a metric's role.
   - `result` — `dateUpdated` (when the snapshot was taken), `health` (data-quality checks such as `srm` and `multipleExposures`, already judged against the organization's thresholds), and `results[]`, with one entry per dimension value or a single entry when there is no dimension. Each metric's numbers are in `metrics[].variations[].analyses[0]`: `percentChange` (relative lift as a fraction, so `0.05` is +5%), `ciLow`, `ciHigh`, and `chanceToBeatControl` on Bayesian or `pValue` on frequentist. The field for the other engine comes back as `0`; ignore it. An `errorMessage` means the metric could not be computed and its numbers are placeholders. Older self-hosted versions return no `health`; the only health signal there is the SRM p-value in `results[].checks.srm`.

   Stop here in two cases. If `experiment.status` is `draft`, there are no results; say so. If `experiment.type` is `multi-armed-bandit`, say this workflow covers standard experiments and point the user to the GrowthBook UI.

   If the call fails with `"No results found for that experiment"`, no snapshot exists yet for that phase or dimension. Go to step 2 and create one.

2. **Refresh only when needed.** Skip this step unless `result.dateUpdated` is more than 24 hours old, the user asked for fresh data, or step 1 found no snapshot. The server refreshes on its own schedule (every 6 hours by default) and each refresh runs warehouse queries, so don't spend one on data that hasn't moved.

   ```bash
   echo '{}' | gb-call POST /api/v1/experiments/<experiment-id>/snapshot -
   # with a phase (0-indexed) and a dimension:
   echo '{"phase": 1, "dimension": "exp:country"}' \
     | gb-call POST /api/v1/experiments/<experiment-id>/snapshot -
   ```

   `dimension` takes `pre:date`, `pre:activation`, a Unit Dimension id (`dim_abc123`), or an Experiment Dimension as `exp:<name>`. The response is `{ snapshot: { id, experiment, status } }`. Poll it, at most 60 times:

   ```bash
   for i in $(seq 1 60); do
     gb-call GET /api/v1/snapshots/<snapshot-id>
     # stop when snapshot.status is "success" or "error"
     sleep 5
   done
   ```

   On `success`, repeat the step 1 `/results` call with the same `phase` and `dimension`. On `error`, or if the snapshot is still running after 60 polls, tell the user and report whatever step 1 returned, with its `dateUpdated`.

   If the POST returns `422` with a `warnings` array, the experiment is stopped and the organization has frozen results for stopped experiments. Do not retry with `ignoreWarnings`. Report the step 1 result if there was one. Otherwise say that no saved result exists for that phase or dimension and the setting prevents creating one.

3. **Answer the question that was asked.** Every answer opens with the status and decision, because they are GrowthBook's own conclusion, reached with the organization's thresholds and decision criteria. Quote `detailedStatus` and `decision.reason` rather than re-deriving them from the metrics.

   **Status questions** ask where the experiment stands: its state, progress, health, or whether it is ready to stop or ship. Keep the answer short:

   ```
   <name>: <enhancedStatus.status>, <detailedStatus><, needs attention — when needsAttention is true>
   <decision.reason>
   Metrics (snapshot <dateUpdated>):
   - <metric>, <variation>: <lift>, <interval>, <chance to win | p-value>
   View in GrowthBook: /experiment/<id>
   ```

   Which metrics to show is your call. Start from the goal metrics and add anything notable among the secondary and guardrail metrics, such as a guardrail moving the wrong way or a large secondary effect. Bring in `result.health` only when `decision.category` is `has-issue`, and then give the numbers for the checks named in `decision.healthIssues`.

   **Results questions** ask for the numbers themselves: overall results, a named metric, secondary or guardrail metrics, a dimension, or an earlier phase. Open with the same status and decision lines, then:

   - Report every metric asked about, grouped by role (goal, secondary, guardrail), one line per variation in the format above.
   - Read the metrics against the decision. If they seem to disagree (a goal metric looks significant while the decision is `collecting-data`, or looks flat under `ship-now`), say the decision stands and quote its `reason`. Don't guess which metric drove it.
   - For a dimension, give one block per dimension value. The decision describes the whole experiment, so present it as context and don't apply it to a slice.
   - Say when `settings.sequentialTestingEnabled` is on. Sequential testing widens the intervals on purpose but allows early stopping without inflating false positive rates.

   **In either answer:**

   - When there is no `enhancedStatus` or no `decision` (a holdout, an earlier phase, a stopped experiment, or an organization without the Decision Framework), say that GrowthBook returned no decision. Report the metrics on their own, with the `result.health` checks in place of the decision.
   - If you single out a finding from many metrics, variations, or dimension values, say that it is more likely to be chance. Nothing the API returns is adjusted for multiple comparisons.

4. **Suggest the next step.** This is the only place the workflow recommends an action. When GrowthBook returned a `decision`, the recommendation follows `decision.category` and not a metric that looks significant:

   - `ready-for-action` — on `ship-now` or `rollback-now`, offer `references/experiment-stop.md`. For `ship-now`, `decision.variations` lists the variations to ship; pass that `variationId`, and let the user pick if there are several. On `ready-for-review` or `scheduled-end-review`, lay out the tradeoff and ask the user what they want to do.
   - `has-issue` — don't recommend shipping. Quote `reason`.
   - `collecting-data` — GrowthBook says to wait. Keep it running and don't propose a stop. If the user wants to stop anyway, hand off to `references/experiment-stop.md` and say GrowthBook isn't recommending it.

   A stopped experiment has no `decision` and needs no recommendation. If its `detailedStatus` is `Awaiting decision`, say that it stopped without a recorded result.

   **A running experiment with no `decision`** means GrowthBook has no verdict, which is different from telling you to wait. Give your own read, and say plainly that it is yours and not GrowthBook's. Base it on the overall results of the latest phase; a dimension cut or an earlier phase can't support one.

   - **Health first.** Use the `result.health` statuses. Where `health` is missing, use the SRM p-value in `results[].checks.srm`, which GrowthBook flags below 0.001 by default. If a check is failing, stop there: the read is to fix that first.
   - **Evidence.** Summarize the goal metrics by direction and by whether the interval excludes zero. Name any guardrail moving the wrong way.
   - **Reasons to wait.** `result.health.power` reporting `isLowPowered` or a positive `additionalDaysNeeded`, less than a full week since `result.dateStart`, or frequentist results without sequential testing, where looking early inflates false positives.
   - **Leaning.** Close with one of ship, roll back, keep running, or unclear, and the reasons for it. The call is the user's. Hand off to `references/experiment-stop.md` only if they choose to stop.

## Guardrails

- **Read-only.** This workflow may POST a snapshot. It never stops or modifies the experiment; hand off to `references/experiment-stop.md` for that.
- **The next action comes from `needsAttention` and `decision`.** A metric that looks significant is a readout, not a recommendation. `ship-now`, `rollback-now`, and `ready-for-review` appear only when the Experiment Decision Framework is enabled. When a running experiment has no `decision`, give your own read and label it as yours. Never present it as GrowthBook's recommendation, and never name a `decision.status` the API didn't return.
- **A failing SRM check means the results can't be trusted.** When `result.health.srm.status` is `unhealthy`, say so before any metric.
- **Match the vocabulary to the engine.** Bayesian (the default) reports Chance to Win and a credible interval. Frequentist reports a p-value and a confidence interval. Don't report a p-value on a Bayesian result.
- **Nothing the API returns is adjusted for multiple comparisons.** An organization's correction is frequentist-only, covers goal metrics only, and is applied in the UI and CSV exports.
- **Bandits are out of scope.** `type === "multi-armed-bandit"` reallocates traffic and reports per-arm probabilities. Halt and point the user to the UI.
- **Never send `ignoreWarnings` on the snapshot request unless the user explicitly asks.** It overrides the organization's setting that freezes results for stopped experiments.
- **`q` rejects `!`, `~`, `^`, `>`, `<`, `=` with a 400.** Send plain `field:value` tokens and free text. To exclude bandits from the list use `bandits=false`; `type` is not a list param.
- **Call budget.** The common path is one `/results` call. A refresh adds up to 62 more over five minutes, which stays under the 60 rpm limit. If `gb-call` returns a 429, tell the user.

## Endpoints used

- `GET /api/v1/experiments?q=<text>` — resolve an experiment ID from a name or keyword.
- `GET /api/v1/experiments/<id>/results` — returns `{ experiment, result }`: status and decision (`experiment.enhancedStatus`), metric roles (`experiment.settings`), and the snapshot (`result`). Accepts `phase` and `dimension`.
- `POST /api/v1/experiments/<id>/snapshot` — start a fresh snapshot. Body accepts `phase` (integer) and `dimension` (string).
- `GET /api/v1/snapshots/<snapshot-id>` — poll snapshot status (`running`, `success`, `error`).

## Handoffs

- `references/experiment-stop.md` — when the decision is `ship-now` or `rollback-now`, or the user chooses to stop.
- `references/learnings.md` — when a result generalizes beyond one test and has corroborating evidence, offer to record or update a Learning.
- the **feature-flags** skill (`flag-targeting` workflow) — after stopping with a winner, the linked flag's `experiment-ref` rule needs updating or removing.
- `references/experiment-brainstorm.md` — to ground ideas for the next test in past results.
