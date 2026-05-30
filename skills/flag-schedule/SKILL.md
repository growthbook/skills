---
name: flag-schedule
description: Add a timed activation window to a GrowthBook feature flag rule — automatically enable it at a start time and/or disable it at an end time. Use when the user says "turn this on at 9am", "schedule the flag to go live Friday at noon", "disable the rule after the sale ends", "set an end date on this rule", "run this rule during the promotion window", or "time-gate this rule". Applies to force and rollout rules. For multi-step progressive rollouts with intervals between steps, use flag-ramp. For the broader campaign of rules around this schedule, use flag-targeting first.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# flag-schedule

Add a timed activation window to a GrowthBook feature flag rule. A scheduled rule activates automatically at a start time and/or deactivates automatically at an end time, without requiring a manual publish each time.

Scheduling applies to `force` and `rollout` rule types. It does not apply to `experiment-ref` or `safe-rollout` rules.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` and `GB_EMAIL` set in env or written to `~/.config/growthbook/.env` by `/growthbook:setup`.

## How scheduling works

GrowthBook supports two scheduling mechanisms on rules:

**Simple schedule** (`schedule` field on rule creation) — the preferred approach. Specify `startDate` and/or `endDate` as ISO 8601 timestamps. The server sets up the underlying `scheduleRules` automatically.

**Legacy `scheduleRules`** — a 2-element array `[start, end]` where each element is `{ timestamp: "<ISO 8601 or null>", enabled: <bool> }`. Still accepted by the API; the simple `schedule` field is cleaner for new rules.

## Workflow

### Path A — Create a new rule with a schedule

1. **Fetch the flag:**
   ```bash
   gb-call GET /api/v2/features/<flag-id>
   ```
   Capture `valueType` and current rules. New rules append to the bottom; warn the user if existing rules may match before this one.

2. **Collect the schedule:**
   - Start time (ISO 8601, e.g., `"2026-06-01T09:00:00Z"`) — the rule activates at this time
   - End time (ISO 8601) — the rule deactivates at this time
   - At least one of start or end is required

   Confirm the timezone. GrowthBook stores times in UTC — if the user gives a local time, convert before sending.

3. **Build the payload and post:**
   ```bash
   echo '{
     "rule": {
       "type": "force",
       "value": "<string>",
       "description": "<optional>",
       "enabled": true,
       "allEnvironments": false,
       "environments": ["<env-id>"]
     },
     "schedule": {
       "startDate": "2026-06-01T09:00:00Z",
       "endDate": "2026-06-07T23:59:59Z"
     }
   }' | gb-call POST /api/v2/features/<flag-id>/revisions/new/rules -
   ```

   For a rollout rule, swap `type: "rollout"` and add `coverage` and `hashAttribute`.

4. Capture the returned `version`. Hand off to feature-publish.

### Path B — Add a schedule to an existing rule

1. **Fetch the flag and identify the rule:**
   ```bash
   gb-call GET /api/v2/features/<flag-id>
   ```
   Show the rules list. Get the rule `id` (UUID) the user wants to schedule.

2. **Build the scheduleRules patch:**
   ```json
   {
     "scheduleRules": [
       { "timestamp": "2026-06-01T09:00:00Z", "enabled": true },
       { "timestamp": "2026-06-07T23:59:59Z", "enabled": false }
     ],
     "scheduleType": "schedule"
   }
   ```
   - Element 0: the start event (`enabled: true` means "turn the rule on at this time")
   - Element 1: the end event (`enabled: false` means "turn the rule off at this time")
   - Use `null` for a timestamp to omit that event (start-only or end-only)
   - `scheduleType` must be `"schedule"` when using scheduleRules

3. **Apply the patch:**
   ```bash
   echo '<patch>' | gb-call PUT /api/v2/features/<flag-id>/revisions/new/rules/<rule-id> -
   ```

4. Capture the returned `version`. Hand off to feature-publish.

### Path C — Remove a schedule from a rule

```bash
echo '{
  "scheduleRules": [
    { "timestamp": null, "enabled": true },
    { "timestamp": null, "enabled": false }
  ],
  "scheduleType": "none"
}' | gb-call PUT /api/v2/features/<flag-id>/revisions/new/rules/<rule-id> -
```

Setting all timestamps to `null` and `scheduleType: "none"` clears the schedule. The rule becomes always-active (subject to its `enabled` field and conditions).

## Guardrails

- **Times are stored in UTC.** Always confirm the user's intended timezone and convert before sending. `"2026-06-01T09:00:00-05:00"` and `"2026-06-01T14:00:00Z"` are the same moment — use UTC form in the API.
- **`scheduleRules` is a 2-element array, not a list of arbitrary events.** Element 0 = start event, element 1 = end event. The server enforces this shape.
- **Use `schedule` field for new rules, `scheduleRules` for patching existing ones.** The `schedule` helper on rule creation is cleaner. When patching an existing rule, use `scheduleRules` directly.
- **Scheduled rules still need to be enabled.** The schedule controls when the rule is active, but `enabled: false` on the rule overrides the schedule. Don't schedule a disabled rule.
- **Publishing creates the schedule.** The schedule becomes live only after the draft is published. If publish is delayed by approvals, the schedule's start time may pass before it goes live.
- **For multi-step progressive rollouts, use flag-ramp.** This skill handles on/off windows only. If the user wants "start at 5%, increase to 25% after a day, 100% after a week," that's flag-ramp.
- **Evaluation order still applies.** A scheduled rule that's currently inactive (before start time or after end time) is skipped in evaluation; the next rule in order is checked.

## Endpoints used

- `GET /api/v2/features/:id` — fetch flag and current rules
- `POST /api/v2/features/:id/revisions/new/rules` — create rule with `schedule` field (body includes `rule` + `schedule`)
- `PUT /api/v2/features/:id/revisions/new/rules/:ruleId` — patch existing rule's `scheduleRules` and `scheduleType`

## Handoffs

- `flag-targeting` — to build the rule's targeting conditions alongside the schedule
- `flag-ramp` — for multi-step progressive rollouts with intervals between coverage increases
- `flag-rules` — to reorder rules after adding a scheduled rule
- `feature-publish` — to publish the draft
