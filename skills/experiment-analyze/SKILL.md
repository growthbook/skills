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
   Confirm status — `running` or `stopped` both make sense for analysis. If `draft`, there are no results to interpret; tell the user.

2. **Trigger a fresh snapshot.**
   ```bash
   gb-call POST /api/v1/experiments/<experiment-id>/snapshot '{}'
   ```
   The response contains a `snapshot.id` (or similar — check the actual shape). Save it. Note: this endpoint always uses the experiment's last phase and no dimension — phase/dimension selection isn't exposed via the API today.

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

5. **Run the interpretation checklist.** In order:

   - **SRM check.** Sample ratio mismatch is the first thing to confirm. If observed traffic split deviates significantly from the configured split, the results are biased — say so prominently and stop interpreting until the user understands the bias risk.
   - **Power check.** Is the experiment at or near the expected sample size? If well under (e.g., <50% of planned), warn that conclusions are speculative.
   - **Primary metric.** Lift, 95% confidence interval, did CI cross zero? State whether the primary moved meaningfully.
   - **Guardrails.** For each: any regression? Even a non-significant regression on a guardrail is worth flagging.
   - **Secondary metrics.** Surface but caveat — these are exploratory; multiple-comparison risk applies.
   - **Dimensions (if user asks).** GrowthBook computes per-dimension splits in the UI; the REST results endpoint returns the dimensional cuts if they were configured in the experiment. Surface notable splits but don't fish.

6. **Present the result.** Use this shape:

   ```
   ## Experiment: <name> (<id>)
   - Status: <running|stopped>
   - Phase: <phase name>
   - Sample size: <total users> across N variations
   - Snapshot timestamp: <when this snapshot ran>

   ### SRM check
   <pass / fail with detail>

   ### Primary metric: <name>
   - Variation 0 (Control): <baseline value>
   - Variation 1 (Treatment): <value> (lift: <±X%>, 95% CI: [a, b])
   - Verdict: <won / lost / inconclusive>

   ### Guardrails
   - <metric>: <safe / regressed by Y%>

   ### Secondary metrics
   - <metric>: <lift / no movement>

   ### Recommendation
   <one paragraph: ship, kill, extend, or investigate>
   ```

7. **Suggest the next step.** If the experiment is `running` and conclusive, suggest `experiment-stop` with the chosen variation. If `running` and inconclusive, suggest waiting or extending. If `stopped`, point at flag cleanup via `flag-targeting`.

## Guardrails

- **SRM first.** A failing SRM check invalidates everything downstream. Surface the warning prominently and do not bury it.
- **Don't peek-and-decide.** If the experiment hasn't reached expected sample size, say so and resist drawing conclusions from interim numbers. Peeking inflates false-positive rates.
- **Confidence intervals, not p-values.** GrowthBook is CI-first; report CIs and whether they cross zero. Don't manufacture a p-value the API didn't return.
- **One primary, many guardrails, secondaries as exploratory.** Don't promote a secondary metric to "we won on X" if the primary didn't move.
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
