---
name: flag-ramp
description: Create or manage a multi-step ramp schedule for a GrowthBook feature flag rule — progressively increasing traffic exposure over time with defined intervals between steps. Use when the user says "gradually roll this out", "increase traffic from 5% to 100% over a week", "set up a ramp schedule", "advance to the next ramp step", "pause the rollout", "roll back the ramp", or "set a cutoff date on this rollout". For rollouts that also need guardrail metric monitoring and automatic signals, use flag-monitoring — it builds on this skill with monitoring configuration. For simple on/off time windows, use flag-schedule.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# flag-ramp

Create and manage multi-step ramp schedules for a GrowthBook feature flag rule. A ramp schedule progressively increases (or decreases) a rule's traffic coverage over time, with defined hold intervals between steps. Steps can be manual (operator advances them) or time-gated (auto-advance after an interval).

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` and `GB_EMAIL` set in env or written to `~/.config/growthbook/.env` by `/growthbook:setup`.

## How ramp schedules work

A ramp schedule is attached to a specific rule on a feature flag. When published:
1. The schedule begins in `pending` status, advancing to `running` when the `startDate` is reached (or immediately if no startDate).
2. At each step, the schedule applies a set of **actions** — patches to the rule (typically changing `coverage`).
3. After each step, the schedule waits for the step's `interval` (in seconds) before advancing to the next step.
4. A step with `null` interval holds indefinitely until manually advanced.
5. At the final step, `endActions` are applied (the rule reaches full rollout coverage).
6. A `cutoffDate` can kill-switch the entire ramp — if reached, the ramp rolls back to `startActions` state.

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
- Step progression (e.g., 5% → 10% → 25% → 50% → 100%)
- Hold time at each step — `null` means "wait for manual advance", a number is seconds (e.g., `86400` = 1 day)
- Optional `startDate` (ISO 8601 UTC) — delay ramp activation
- Optional `cutoffDate` (ISO 8601 UTC) — kill-switch deadline; ramp rolls back if reached

**3. Build the ramp schedule payload:**

```json
{
  "startDate": null,
  "cutoffDate": null,
  "steps": [
    {
      "interval": null,
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
  "startActions": [{ "targetType": "feature-rule", "targetId": "<rule-id>", "patch": { "coverage": 0.0 } }]
}
```

`startActions` = the rollback state (applied if cutoffDate is hit or ramp is rolled back manually).
`endActions` = the final state after all steps complete.

**4. Attach the ramp schedule to the rule via draft:**
```bash
echo '<payload>' \
  | gb-call PUT /api/v2/features/<flag-id>/revisions/new/rules/<rule-id>/ramp-schedule -
```

Capture the returned `version`. The ramp schedule is staged as a `rampAction` on the draft — it becomes live when the draft is published.

**5. Hand off to feature-publish.**

### Path B — Create a new rule with a ramp schedule in one step

When creating the rule and ramp together:

```bash
echo '{
  "rule": {
    "type": "rollout",
    "value": "true",
    "coverage": 0.05,
    "hashAttribute": "id",
    "enabled": true,
    "allEnvironments": false,
    "environments": ["production"]
  },
  "rampSchedule": { ... }
}' | gb-call POST /api/v2/features/<flag-id>/revisions/new/rules -
```

The `rampSchedule` field is accepted on rule creation and wires the schedule atomically.

### Path C — Remove a ramp schedule from a rule

```bash
gb-call DELETE /api/v2/features/<flag-id>/revisions/new/rules/<rule-id>/ramp-schedule
```

This stages a `detach` ramp action on the draft. The live schedule is removed when the draft publishes. The rule's coverage is left at whatever the schedule last set it to.

### Path D — Manage a live ramp (post-publish)

After a ramp is published, the `RampSchedule` entity is live and has its own status. The GrowthBook UI provides controls for advancing steps, pausing, and rolling back. For API-based management of a live ramp schedule, contact GrowthBook documentation — live ramp management endpoints are outside the scope of this skill's current coverage.

If the user needs to roll back a live ramp immediately: the fastest path is disabling the flag via flag-toggle (kills the whole environment), or editing the rule's `coverage` directly via a new draft and feature-publish.

## Guardrails

- **Ramp schedules apply only to `force` and `rollout` rules.** They don't work on `experiment-ref` or `safe-rollout` rules.
- **`startActions` is the rollback state.** Set it to the coverage the rule should have if the ramp is rolled back (usually `0` or the pre-ramp coverage). If not set, rollback is undefined.
- **Steps with `null` interval hold until manually advanced.** These are good for human-approved gates ("I'll advance this manually after checking metrics"). Steps with an interval auto-advance after the duration.
- **`cutoffDate` is an automatic kill-switch.** If this date is reached, the ramp rolls back to `startActions` state. Use it to bound the blast radius of a ramp that might get stuck.
- **Coverage patches on steps must be within 0–1.** The server validates this at publish time.
- **For monitored ramps (guardrail metrics, auto-rollback signals), use flag-monitoring.** This skill handles unmonitored structural ramps. flag-monitoring builds on this skill's ramp schedule with `monitoringConfig`.
- **Ramp actions are staged on the draft.** Nothing changes until the draft publishes. If the draft is discarded, the ramp is never created.
- **One ramp schedule per rule.** A rule can only have one active ramp schedule. Adding a new one replaces any existing schedule.

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
