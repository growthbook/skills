---
name: flag-ramp
description: Create or manage a multi-step ramp schedule for a GrowthBook feature flag rule — progressively increasing traffic exposure over time with defined intervals between steps. Use when the user says "gradually roll this out", "increase traffic from 5% to 100% over a week", "set up a ramp schedule", "advance to the next ramp step", "pause the rollout", "roll back the ramp", or "set a cutoff date on this rollout". For rollouts that also need guardrail metric monitoring and automatic signals, use flag-monitoring — it builds on this skill with monitoring configuration. For simple on/off time windows, use flag-schedule.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# flag-ramp

Create and manage multi-step ramp schedules for a GrowthBook feature flag rule. A ramp schedule progressively increases (or decreases) a rule's traffic coverage over time, with defined hold intervals between steps. Steps can be manual (operator advances them) or time-gated (auto-advance after an interval).

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` and `GB_EMAIL` set in env or written to `~/.config/growthbook/.env` by `/growthbook:setup`.

## How ramp schedules work

A ramp schedule is attached to a specific rule on a feature flag. When published, the ramp begins running immediately — there is no automatic delay unless you explicitly set a `startDate` (uncommon; most teams prefer to trigger the ramp manually after publish via the GrowthBook UI).

At each step, the schedule applies **actions** — patches to the rule, typically changing `coverage`. After a step:
- If the step has an `interval` (seconds), it auto-advances after that duration.
- If `interval` is `null`, it holds until a team member manually advances it in the UI.

When all steps complete, `endActions` are applied (typically setting coverage to 1.0). If the ramp is rolled back at any point, `startActions` are applied (restoring the pre-ramp state).

Ramp schedules are staged on a draft revision as `rampActions` and executed atomically at publish time.

## Workflow

### Path A — Create a ramp schedule on an existing rule

**1. Identify the rule:**
```bash
gb-call GET /api/v2/features/<flag-id>
```
Show the rules list. Get the ID of the `force` or `rollout` rule the user wants to ramp. Note current `coverage`.

**2. Design the ramp steps with the user:**

Confirm:
- Starting coverage (e.g., `0.05` = 5%)
- Step progression (e.g., 5% → 25% → 50% → 100%)
- Hold time at each step: a number in seconds (e.g., `86400` = 1 day) to auto-advance, or `null` to hold until manually advanced in the UI

`startActions` should match the rule's **current coverage** (captured in step 1) — this is the state the ramp restores to on rollback.

**3. Build the ramp schedule payload:**

```json
{
  "steps": [
    {
      "interval": 86400,
      "actions": [{ "targetType": "feature-rule", "targetId": "<rule-id>", "patch": { "coverage": 0.05 } }]
    },
    {
      "interval": 86400,
      "actions": [{ "targetType": "feature-rule", "targetId": "<rule-id>", "patch": { "coverage": 0.25 } }]
    },
    {
      "interval": 86400,
      "actions": [{ "targetType": "feature-rule", "targetId": "<rule-id>", "patch": { "coverage": 0.50 } }]
    },
    {
      "interval": 86400,
      "actions": [{ "targetType": "feature-rule", "targetId": "<rule-id>", "patch": { "coverage": 1.0 } }]
    }
  ],
  "endActions": [{ "targetType": "feature-rule", "targetId": "<rule-id>", "patch": { "coverage": 1.0 } }],
  "startActions": [{ "targetType": "feature-rule", "targetId": "<rule-id>", "patch": { "coverage": <current-coverage> } }]
}
```

`endActions` = final state after all steps complete (typically 100% coverage).
`startActions` = rollback state (the rule's coverage before the ramp started).

Omit `startDate` and `cutoffDate` unless the user explicitly requests them — see Guardrails.

**4. Attach the ramp schedule to the rule via draft:**
```bash
echo '<payload>' \
  | gb-call PUT /api/v2/features/<flag-id>/revisions/new/rules/<rule-id>/ramp-schedule -
```

Capture the returned `version`. The ramp schedule is staged as a `rampAction` on the draft — it becomes live when the draft is published.

**5. Hand off to feature-publish.**

### Path B — Create a new rule with a ramp schedule in one step

When creating the rule and ramp together, fetch available `hashAttribute` candidates first (required for rollout rules):

```bash
gb-call GET '/api/v1/attributes?projectId=<flag-project-id>'
```

Validate the rule's `value` against the flag's `valueType` (captured from the flag fetch). Then post:

```bash
echo '{
  "rule": {
    "type": "rollout",
    "value": "<on-value>",
    "coverage": 0.05,
    "hashAttribute": "<hash-attr-id>",
    "enabled": true,
    "allEnvironments": false,
    "environments": ["<env-id>"]
  },
  "rampSchedule": {
    "steps": [
      {
        "interval": 86400,
        "actions": [{ "targetType": "feature-rule", "targetId": "new", "patch": { "coverage": 0.05 } }]
      },
      {
        "interval": 86400,
        "actions": [{ "targetType": "feature-rule", "targetId": "new", "patch": { "coverage": 0.25 } }]
      },
      {
        "interval": 86400,
        "actions": [{ "targetType": "feature-rule", "targetId": "new", "patch": { "coverage": 1.0 } }]
      }
    ],
    "endActions": [{ "targetType": "feature-rule", "targetId": "new", "patch": { "coverage": 1.0 } }],
    "startActions": [{ "targetType": "feature-rule", "targetId": "new", "patch": { "coverage": 0.0 } }]
  }
}' | gb-call POST /api/v2/features/<flag-id>/revisions/new/rules -
```

Use `"targetId": "new"` as a placeholder in the ramp actions — the server replaces it with the actual rule ID on creation.

### Path C — Remove a ramp schedule from a rule

```bash
gb-call DELETE /api/v2/features/<flag-id>/revisions/new/rules/<rule-id>/ramp-schedule
```

This stages a `detach` ramp action on the draft. The live schedule is removed when the draft publishes. The rule's coverage is left at whatever the schedule last set it to.

### Path D — Manage a live ramp (post-publish)

After a ramp is published, the `RampSchedule` entity is live and has its own status. The GrowthBook UI provides controls for advancing steps, pausing, and rolling back. For API-based management of a live ramp schedule, contact GrowthBook documentation — live ramp management endpoints are outside the scope of this skill's current coverage.

If the user needs to roll back a live ramp immediately: the fastest path is disabling the flag via flag-toggle (kills the whole environment), or editing the rule's `coverage` directly via a new draft and feature-publish.

## Guardrails

- **Draft version threading.** If a version number is already in context from a previous write skill in this session, use it explicitly instead of `new`. Fall back to `new` when starting fresh.
- **Ramp schedules apply only to `force` and `rollout` rules.** They don't work on `experiment-ref` or `safe-rollout` rules.
- **`startActions` must match the rule's pre-ramp coverage.** Capture it in step 1 and use it as the rollback state. Don't default to 0 unless the rule was at 0 before the ramp.
- **Steps with `null` interval hold until manually advanced in the UI.** Useful for human-gated checkpoints. Steps with an interval auto-advance.
- **`startDate` is optional** — the ramp starts immediately on publish if omitted. Only ask for it if the user specifically wants a delayed start; most teams prefer to trigger manually after verifying the publish succeeded.
- **`cutoffDate` is a niche safety net.** Only mention it if the user asks — it's a deadline that auto-rolls the ramp back if reached. Don't include it by default.
- **Coverage patches on steps must be within 0–1.** The server validates this at publish time.
- **Check the target environment is enabled.** If the flag is disabled in the target env, the ramp will do nothing — warn and route to flag-toggle first.
- **For monitored ramps (guardrail metrics, auto-rollback signals), use flag-monitoring.**
- **Ramp actions are staged on the draft.** Nothing changes until published. If the draft is discarded, the ramp is never created.
- **One ramp schedule per rule.** Adding a new one replaces any existing schedule.

## Endpoints used

- `GET /api/v2/features/:id` — fetch flag and current rules
- `PUT /api/v2/features/:id/revisions/new/rules/:ruleId/ramp-schedule` — stage ramp schedule on a draft
- `DELETE /api/v2/features/:id/revisions/new/rules/:ruleId/ramp-schedule` — stage ramp detach on a draft
- `POST /api/v2/features/:id/revisions/new/rules` — create new rule with inline `rampSchedule` field

## Handoffs

- `flag-monitoring` — to add guardrail metrics and automated monitoring signals to the ramp
- `flag-targeting` — to set up the rule's targeting conditions before attaching a ramp
- `flag-toggle` — for an emergency kill-switch if the ramp needs to be stopped immediately
- `feature-publish` — to publish the draft and activate the ramp
