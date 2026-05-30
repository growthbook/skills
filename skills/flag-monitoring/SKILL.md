---
name: flag-monitoring
description: Set up a monitored progressive rollout for a GrowthBook feature flag — combining a ramp schedule with guardrail metric monitoring, automated signals, and optional auto-rollback. Also handles safe-rollout rules (enterprise). Use when the user says "roll this out safely", "monitor the rollout with guardrail metrics", "set up a safe rollout", "I want to ramp this with automatic rollback if metrics regress", "configure monitoring on the ramp", "check the monitoring status of this rollout", "approve the next monitored step", or "roll back because guardrails are failing". For unmonitored ramps (just progressive coverage, no metrics), use flag-ramp directly. For simple on/off time windows, use flag-schedule.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# flag-monitoring

Set up and manage a monitored progressive rollout for a GrowthBook feature flag. This skill orchestrates flag-ramp's structural ramp schedule with a monitoring configuration that watches guardrail metrics at each step and can signal (or automatically trigger) a rollback if regressions are detected.

Two mechanisms are available:

- **Monitored ramp schedule** — a standard ramp schedule (from flag-ramp) with `monitoringConfig` attached. Works with any `force` or `rollout` rule. Monitoring signals are advisory unless `autoUpdate: true` is set.
- **Safe-rollout rule** (enterprise) — a dedicated rule type that bundles a fixed ramp-up (10% → 25% → 50% → 75% → 100% over the first 25% of a configured monitoring duration) with automated guardrail monitoring and optional auto-rollback. Simpler to configure but less flexible than a custom ramp.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` and `GB_EMAIL` set in env or written to `~/.config/growthbook/.env` by `/growthbook:setup`.

## Required inputs for monitoring configuration

Before configuring, collect:
- **Datasource ID** — the datasource that tracks exposure and metric events
- **Exposure query ID** — which assignment query identifies users in the rollout
- **Guardrail metric IDs** — at least one metric that must not regress (e.g., error rate, crash rate, conversion rate)
- **Signal metric IDs** (optional) — metrics to watch as leading indicators, not hard gates
- **Monitoring mode** — `"auto"` (system monitors and signals) or `"manual"` (system monitors, human decides)
- **SRM action** — what to do on a Sample Ratio Mismatch: `"rollback"`, `"hold"` (pause), or `"warn"`
- **No-traffic action** — what to do if no traffic is seen after the grace period: `"rollback"`, `"hold"`, or `"warn"` (default grace period: 24 hours)
- **Auto-rollback** — `true` to automatically roll back when a guardrail fails, `false` to hold for human review

```bash
# Resolve datasource and exposure query IDs:
gb-call GET /api/v1/datasources

# Resolve metric IDs:
gb-call GET '/api/v1/metrics?datasourceId=<ds-id>'
```

## Workflow

### Path A — Add monitoring to an existing ramp schedule

Use this when the user has already set up (or wants to set up) a custom ramp via flag-ramp, and now wants monitoring attached.

**1. Set up the ramp structure first (if not done):**
   Hand off to flag-ramp to create the ramp schedule steps and intervals. Come back here to attach monitoring.

**2. Collect monitoring config** (see Required inputs above).

**3. Add monitoring config to the ramp schedule patch:**

The `monitoringConfig` is included in the ramp schedule payload sent to:
```bash
echo '{
  "startDate": null,
  "cutoffDate": null,
  "steps": [ ... ],
  "endActions": [ ... ],
  "startActions": [ ... ],
  "monitoringConfig": {
    "datasourceId": "<ds-id>",
    "exposureQueryId": "<query-id>",
    "guardrailMetricIds": ["<metric-id>"],
    "signalMetricIds": ["<metric-id>"],
    "monitoringMode": "auto",
    "autoUpdate": false,
    "srmAction": "hold",
    "noTrafficAction": "warn",
    "noTrafficGracePeriodHours": 24,
    "multipleExposureAction": "warn"
  }
}' | gb-call PUT /api/v2/features/<flag-id>/revisions/new/rules/<rule-id>/ramp-schedule -
```

**4. Hand off to feature-publish.**

### Path B — Create a safe-rollout rule (enterprise)

Safe-rollout rules are a self-contained rule type that bundles a fixed ramp-up progression with automated monitoring. No separate ramp schedule entity is needed.

**1. Fetch the flag:**
```bash
gb-call GET /api/v2/features/<flag-id>
```

**2. Collect safe-rollout configuration:**
- `controlValue` — the baseline value (what users currently get)
- `variationValue` — the new value being rolled out
- `hashAttribute` — the attribute to split traffic on (e.g., `id`)
- `trackingKey` — optional; defaults to flag ID
- `datasourceId`, `exposureQueryId`, `guardrailMetricIds` — monitoring setup (see above)
- `maxDuration` — how long the full rollout should take: `{ "amount": 4, "unit": "weeks" }`
- `autoRollback` — `true` to automatically roll back on guardrail failure
- Custom `rampUpSchedule` (optional) — override the default 10/25/50/75/100% steps

**3. Build the payload and add the rule:**
```json
{
  "rule": {
    "type": "safe-rollout",
    "controlValue": "<string>",
    "variationValue": "<string>",
    "hashAttribute": "id",
    "trackingKey": "<optional>",
    "enabled": true,
    "allEnvironments": false,
    "environments": ["production"],
    "description": "<optional>"
  },
  "safeRolloutFields": {
    "datasourceId": "<ds-id>",
    "exposureQueryId": "<query-id>",
    "guardrailMetricIds": ["<metric-id>"],
    "maxDuration": { "amount": 4, "unit": "weeks" },
    "autoRollback": true,
    "rampUpSchedule": {
      "enabled": false
    }
  }
}
```

```bash
echo '<payload>' | gb-call POST /api/v2/features/<flag-id>/revisions/new/rules -
```

**4. Hand off to feature-publish.**

### Path C — Check monitoring status of a live rollout

After a monitored ramp or safe-rollout is live, monitoring status is visible in the GrowthBook UI at `<host>/features/<flag-id>`. For API-based status checks on the live ramp entity, consult the GrowthBook documentation — live RampSchedule and SafeRollout status endpoints are outside this skill's current scope.

For immediate signals: check if the flag has any active alerts in the GrowthBook UI. If guardrails are failing, the fastest response is:
- **Manual rollback**: disable the flag via flag-toggle (kills all rules immediately)
- **Coverage reduction**: edit the rule's coverage downward via a new draft and feature-publish

## Guardrails

- **Safe-rollout is enterprise-only.** If the org doesn't have the feature, the API returns an error. Fall back to a monitored ramp schedule (Path A) which is available on all plans.
- **At least one guardrail metric is required.** Monitoring without a guardrail is just observation — if the user can't provide a guardrail metric, recommend using an unmonitored ramp (flag-ramp) instead.
- **Metrics must be on the same datasource.** The `datasourceId` in `monitoringConfig` must match the datasource where the guardrail metrics are defined. If they're on different datasources, the API will reject the configuration.
- **`autoRollback: true` means the system rolls back without human approval.** Confirm the user understands this — an unexpected regression detection can disable a feature in production automatically. Recommend starting with `autoRollback: false` (hold for human review) until the team trusts the metric.
- **For monitored steps with `holdConditions.requiresApproval`:** each step pause requires explicit human sign-off before the ramp advances. This is the highest-safety configuration but requires someone watching the rollout.
- **Default safe-rollout ramp is 10% → 25% → 50% → 75% → 100%.** This progression covers the first 25% of `maxDuration`. If the user wants custom steps, provide `rampUpSchedule.enabled: true` with a `steps` array.
- **SRM action defaults matter.** `"rollback"` on SRM is aggressive — a brief traffic imbalance triggers a full rollback. `"hold"` is safer: the ramp pauses for human inspection. Recommend `"hold"` for SRM unless the user explicitly wants aggressive protection.
- **Monitored ramp and safe-rollout are mutually exclusive on a rule.** A rule can only have one monitoring approach. Don't try to attach a monitored ramp schedule to a rule that's already a `safe-rollout` type.

## Cross-links

This skill orchestrates:
- **flag-ramp** — for the structural ramp schedule (steps, intervals, start/cutoff dates). Consult flag-ramp for building custom step sequences.
- **flag-schedule** — for time-gating the start of the ramp (setting `startDate` on the ramp schedule).
- **flag-targeting** — for setting targeting conditions on the rule that's being ramped.
- **flag-toggle** — for emergency kill-switch if monitoring signals a critical issue.

## Endpoints used

- `GET /api/v2/features/:id` — fetch flag and current rules
- `GET /api/v1/datasources` — resolve datasource IDs
- `GET /api/v1/metrics` — resolve guardrail and signal metric IDs
- `PUT /api/v2/features/:id/revisions/new/rules/:ruleId/ramp-schedule` — create/update ramp schedule with monitoringConfig
- `POST /api/v2/features/:id/revisions/new/rules` — add safe-rollout rule

## Handoffs

- `flag-ramp` — for managing ramp step structure without monitoring
- `flag-toggle` — for emergency kill-switch during a live monitored rollout
- `flag-targeting` — to configure rule conditions before setting up monitoring
- `feature-publish` — to publish the draft and activate the monitored rollout
