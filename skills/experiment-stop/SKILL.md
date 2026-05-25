---
name: experiment-stop
description: Stop a running GrowthBook experiment via the REST API, optionally declaring a winning variation and rolling it out to 100% of eligible traffic. Use when the user says "stop this experiment", "end the A/B test", "declare a winner for X", "ship the winning variation", "roll back the test", or "we're done with this experiment". For interpreting results before deciding, use experiment-analyze first.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# experiment-stop

Stop a running experiment, optionally declaring a winning variation and ramping it to all eligible traffic via a temporary rollout. The endpoint is `POST /api/v1/experiments/<id>/stop` (a dedicated endpoint, not the generic update). All variation references are **variation ID strings** like `var_abc123`, not 0-based integer indexes.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` — set in your shell, or written to `~/.config/growthbook/.env` by `/growthbook:setup`. If unset or invalid, gb-call's error message points back at `/growthbook:setup`.

## Workflow

1. **Fetch the current experiment.**
   ```bash
   gb-call GET /api/v1/experiments/<experiment-id>
   ```
   Check the `status` field. Only `running` experiments should be stopped via this skill. If `status === "draft"`, the experiment hasn't started — the user wants to delete it, not stop it (different operation). If `status === "stopped"`, it's already done.

   Also capture the `type` field. If `type === "multi-armed-bandit"`, halt and tell the user this skill targets standard A/B tests; bandits have their own lifecycle (stop is similar but interpretation and rollout differ — recommend they review in the UI before scripting).

2. **Show the user the variations table.** Surface the variations as the API records them — capture each one's `variationId` (the string ID, e.g. `var_treatment_a`) and `name`. The user picks **by the variation ID string**, not by index:

   ```
   The experiment has these variations:
     var_control      0: Control       — <description>  (lift: baseline, users: N)
     var_treatment_a  1: Treatment A   — <description>  (lift: +2.3%, users: N)
     var_treatment_b  2: Treatment B   — <description>  (lift: -0.8%, users: N)

   Which variation should ship? Reply with the variation ID (e.g. var_treatment_a),
   or say "no winner" to stop without declaring.
   ```

   If the user has not already run `experiment-analyze`, suggest doing that first so the decision is informed.

3. **Decide on temporary rollout.** If the user has a winner and wants to ship now, offer the temporary-rollout path:

   > "Want me to also enable a temporary rollout? That keeps this experiment in the SDK payload and forces 100% of eligible traffic to `<winnerVariationId>`. It's the cleanest 'ship the winner' option — the linked feature flag's rule stays in place but routes everyone to the winner. You can toggle it off later with `modify-temporary-rollout` or clean up the rule via `flag-targeting`."

   If yes, set `enableTemporaryRollout: true` and `releasedVariationId: <winner ID>` in the payload. If no, the experiment stops but you leave the flag alone — surface that the user will need to clean up the `experiment-ref` rule manually.

4. **Confirm intent.** Restate the action in plain English:
   > "Stopping experiment '<name>', declaring variation `var_treatment_a` (Treatment A) as the winner, and enabling temporary rollout to ship it to 100% of eligible traffic."

   Get explicit confirmation before posting. Stopping itself is reversible (you can restart), but declaring a winner and enabling a rollout produces downstream signals — don't do it on a hunch.

5. **Build the payload.** The body is **flat**; there is no nested `resultSummary`.

   Stop without a declared winner:
   ```json
   { "results": "inconclusive" }
   ```

   Stop with a declared winner, no rollout:
   ```json
   {
     "results": "won",
     "winnerVariationId": "<winner variation ID>",
     "analysis": "<one-paragraph markdown summary of the decision>"
   }
   ```

   Stop with a declared winner and ship via temporary rollout:
   ```json
   {
     "results": "won",
     "winnerVariationId": "<winner variation ID>",
     "releasedVariationId": "<winner variation ID>",
     "enableTemporaryRollout": true,
     "analysis": "<one-paragraph markdown summary of the decision>"
   }
   ```

   Field reference:
   - `results` — required. One of `"won"`, `"lost"`, `"inconclusive"`, `"dnf"` (did not finish).
   - `winnerVariationId` — string variation ID (e.g. `var_abc123`). Required when `results === "won"` and the experiment has multiple test variations.
   - `releasedVariationId` — string variation ID. Required when `enableTemporaryRollout: true`. Usually equals `winnerVariationId`.
   - `enableTemporaryRollout` — boolean. Keeps the stopped experiment in the SDK payload and forces traffic to the `releasedVariationId`.
   - `analysis` — markdown summary shown on the experiment results page.
   - `reason` — optional reason text stored on the latest phase metadata.
   - `dateEnded` — optional ISO datetime; defaults to now.

6. **Post the update.**
   ```bash
   echo '<payload-json>' | gb-call POST /api/v1/experiments/<experiment-id>/stop -
   ```

7. **State what happens next, and link to the experiment.** Tell the user:
   - The experiment is now stopped; no more traffic accumulates against the experiment.
   - If a winner was declared, the variation ID that "won."
   - **Direct UI link** so they can verify the stopped state, the recorded `analysis`, and the rollout status:
     ```
     <host>/experiment/<experiment-id>
     ```
     Derive `<host>` from `GB_API_URL` by swapping `api.` → `app.` (matches `experiment-launch`'s convention; on the default cloud host this produces `https://app.growthbook.io`).
   - **If `enableTemporaryRollout: true` was sent**, eligible traffic is now routed to the released variation through the experiment's existing flag rule. The user can toggle this off later by:
     ```bash
     echo '{"enableTemporaryRollout": false}' \
       | gb-call POST /api/v1/experiments/<experiment-id>/modify-temporary-rollout -
     ```
     and then clean up the `experiment-ref` rule on the linked flag via `flag-targeting`.
   - **If no rollout was enabled**, the linked feature's `experiment-ref` rule is still in place — the user should either (a) update the flag's default value to match the winning variation and remove the rule, or (b) clean up the rule via `flag-targeting`. Surface this every time, because the flag keeps routing to a stopped experiment until cleaned up.

## Guardrails

- **`winnerVariationId` is a variation ID *string* (e.g. `var_abc123`), not an integer index, not a name, not the variation's `key`.** Get this wrong and the request 400s or the wrong variation is recorded as the winner.
- **The endpoint is `POST /api/v1/experiments/<id>/stop`, not `POST /api/v1/experiments/<id>`.** The body shape is flat — there is no `resultSummary` wrapper. The generic update endpoint exists but takes different fields; use the dedicated stop endpoint here.
- **Never declare a winner the user didn't pick.** Even if the results look obvious, force the user to choose the variation ID. Surface results, but don't pre-fill.
- **Don't stop drafts.** A `draft` experiment isn't running — what the user wants there is `DELETE /api/v1/experiments/<id>` (separate skill, not covered here). Surface the confusion if they ask to stop a draft.
- **Don't stop already-stopped experiments.** The API may accept the call but it's effectively a no-op; tell the user it's already done. To change the results metadata on an already-stopped experiment, post again with the new `results` / `winnerVariationId` / `analysis`.
- **Bandits are out of scope.** `type === "multi-armed-bandit"` experiments need different handling — halt and tell the user.
- **`releasedVariationId` is required when `enableTemporaryRollout: true`.** The API rejects the combination otherwise. They're usually the same as `winnerVariationId` but don't have to be — e.g., a "lost" result that rolls everyone back to control would set `releasedVariationId: <control variation ID>` with `results: "lost"`.
- **Always remind about the linked flag.** Stopping the experiment does not remove the `experiment-ref` rule from the linked flag. Without a temporary rollout, the flag keeps routing to a stale experiment until the user cleans the rule up.
- **`analysis` should explain the decision in plain English (markdown).** Future readers (including future-self) will want context. Don't leave it blank when declaring a winner.
- **Run `experiment-analyze` first if the user hasn't.** Stopping based on a glance at the dashboard is a common mistake — interim numbers can flip, and the data-quality checks in `experiment-analyze` (SRM, suspicious uplift, minimum data thresholds) can flag results that look conclusive but aren't.

## Endpoints used

- `GET /api/v1/experiments/<id>` — fetch state, variations, and `type`
- `POST /api/v1/experiments/<id>/stop` — stop and optionally declare a winner + temporary rollout
- `POST /api/v1/experiments/<id>/modify-temporary-rollout` — toggle the temporary rollout off (or on) after stopping, without re-running this skill

## Handoffs

- `experiment-analyze` — run first if the user wants to interpret results before deciding.
- `flag-targeting` — after stopping with a declared winner (with or without temporary rollout), the linked flag's `experiment-ref` rule needs to be updated or removed.
- `experiment-design` and `experiment-launch` — for the next test if this one informed a follow-up.
