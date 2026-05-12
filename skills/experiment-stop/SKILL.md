---
name: experiment-stop
description: Stop a running GrowthBook experiment via the REST API, optionally declaring a winning variation. Use when the user says "stop this experiment", "end the A/B test", "declare a winner for X", "ship the winning variation", "roll back the test", or "we're done with this experiment". For interpreting results before deciding, use experiment-analyze first.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# experiment-stop

Stop a running experiment, optionally declaring a winning variation. The most important detail: the `winner` field is a **0-based integer index**, not a variation name or ID. Get it wrong and the wrong variation ships.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It expects `GB_API_KEY` in env.

## Workflow

1. **Fetch the current experiment.**
   ```bash
   gb-call GET /api/v1/experiments/<experiment-id>
   ```
   Check the `status` field. Only `running` experiments should be stopped via this skill. If `status === "draft"`, the experiment hasn't started — the user wants to delete it, not stop it (different operation). If `status === "stopped"`, it's already done.

2. **Show the user the variations table.** Before they pick a winner, surface the variations as the API records them — number, name, current results if available. The user picks **by number** (0-based), not by name:

   ```
   The experiment has these variations:
     0: Control       — <description>  (lift: baseline, users: N)
     1: Treatment A   — <description>  (lift: +2.3%, users: N)
     2: Treatment B   — <description>  (lift: -0.8%, users: N)

   Which variation should ship? Enter the index (0, 1, or 2), or say "no winner" to stop without declaring.
   ```

   If the user has not already run `experiment-analyze`, suggest doing that first so the decision is informed.

3. **Confirm intent.** Restate the action in plain English:
   > "Stopping experiment '<name>', declaring variation 1 (Treatment A) as the winner."

   Get explicit confirmation before posting. Stopping is reversible (you can restart), but declaring a winner triggers downstream signals; don't do it on a hunch.

4. **Build the update payload.**

   Without a declared winner:
   ```json
   { "status": "stopped" }
   ```

   With a declared winner (note the field shape):
   ```json
   {
     "status": "stopped",
     "resultSummary": {
       "status": "won",
       "winner": 1,
       "conclusions": "<one-paragraph summary of the decision>"
     }
   }
   ```

   The `winner` value is the **variation index as an integer** (0 = control, 1 = first treatment, etc.). Not a variation key, not the variation's name. This is the documented footgun.

   Other `resultSummary.status` values: `"lost"` (control wins), `"inconclusive"` (no clear winner), `"dnf"` (did not finish — e.g., experiment cancelled).

5. **Post the update.**
   ```bash
   echo '<payload-json>' | gb-call POST /api/v1/experiments/<experiment-id> -
   ```

6. **State what happens next.** Tell the user:
   - The experiment is now stopped; no more traffic accumulates.
   - If a winner was declared, the variation index that shipped.
   - **If the experiment was linked to a feature flag**, the flag's `experiment-ref` rule is still in place — the user should either (a) update the flag's default value to match the winning variation and remove the rule, or (b) use `flag-targeting` to clean it up. Surface this every time.

## Guardrails

- **`winner` is a 0-based integer index.** Not a variation name, not the variation `key` (which is a string version of the same index), not the variation's `id`. Use the number from `variations[N]`. Get this wrong and the wrong variation ships.
- **Never declare a winner the user didn't pick.** Even if the results look obvious, force the user to choose the index. Surface results, but don't pre-fill.
- **Don't stop drafts.** A `draft` experiment isn't running — what the user wants there is `DELETE /api/v1/experiments/<id>` (separate skill, not covered here). Surface the confusion if they ask to stop a draft.
- **Don't stop already-stopped experiments.** The API will accept the call but it's a no-op; tell the user it's already done.
- **Always remind about the linked flag.** Stopping the experiment does not clean up the `experiment-ref` rule in the linked flag's environments. Users routinely forget this and the flag keeps routing to a stale experiment.
- **`resultSummary.conclusions` should explain the decision in plain English.** Future readers (including future-self) will want context. Don't leave it blank when declaring a winner.
- **Run `experiment-analyze` first if the user hasn't.** Stopping based on a glance at the dashboard is a common mistake — interim numbers can flip.

## Endpoints used

- `GET /api/v1/experiments/<id>` — fetch state and variations
- `POST /api/v1/experiments/<id>` — update status and optionally declare a winner

## Handoffs

- `experiment-analyze` — run first if the user wants to interpret results before deciding.
- `flag-targeting` — after stopping with a declared winner, the linked flag (if any) needs its rule updated or removed.
- `experiment-design` and `experiment-launch` — for the next test if this one informed a follow-up.
