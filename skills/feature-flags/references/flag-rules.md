---
name: flag-rules
description: Entry point for working with rules on a GrowthBook feature flag. Use when the user asks "what rules does flag X have", "show me the rules on this flag", "add a rule", "delete a rule", "reorder the rules", or describes a flag operation without specifying the rule type. Routes to specialized skills for creating and editing specific rule types. Also handles listing, reordering, and deleting rules directly. For specific rule types, use flag-targeting for force/rollout rules, flag-experiment for experiment-ref rules, flag-schedule for timed activation, flag-ramp for progressive rollouts, flag-monitoring for monitored rollouts, flag-prerequisites for feature-level prerequisite gates.
---

# flag-rules

Entry point for rule operations on a GrowthBook feature flag. Use this skill to inspect rules, delete a rule, or reorder rules. For creating or editing rules, this skill identifies the right rule type and routes to the specialized skill.

## Contents

- Rule types reference
- Workflow
  - Path A — List rules on a flag
  - Path B — Route to the right skill for creating/editing a rule
  - Path C — Delete a rule
  - Path D — Reorder rules
- Guardrails
- Endpoints used
- Handoffs

## Rule types reference

| Type | What it does | Skill |
| --- | --- | --- |
| `force` / `rollout` | Serve a specific value, optionally to a random % of users. `rollout` is the same type as `force` but with `coverage < 1` and a required `hashAttribute` — the server auto-flips between the two based on effective coverage. | `references/flag-targeting.md` |
| `experiment-ref` | Run an A/B test via a linked experiment | `references/flag-experiment.md` |

Rules evaluate **top-to-bottom, first match wins**. Order matters.

## Workflow

### Path A — List rules on a flag

```bash
gb-call GET /api/v2/features/<flag-id>
```

Present the `rules` array in evaluation order with a numbered list:

```
Rules on `<flag-id>` (top-to-bottom evaluation):
  1. [force]          all environments              value="true"    "Beta testers" (saved group)
  2. [rollout]        production                    coverage=10%    hash=id
  3. [experiment-ref] production, staging           → exp_abc123    "Checkout experiment"
  4. [force]          staging                       value="false"   "Kill switch"
```

For each rule show: number, type, scope (allEnvironments or specific envs), enabled state, a one-line summary of the rule's effect, and the rule ID (UUID) for reference.

### Path B — Route to the right skill for creating/editing a rule

Ask the user what they're trying to accomplish and route:

| User intent | Route to |
| --- | --- |
| "Serve X to users matching condition Y" | `references/flag-targeting.md` |
| "Roll out to N% of users" | `references/flag-targeting.md` |
| "Run an A/B test" (experiment already exists) | `references/flag-experiment.md` |
| "Run an A/B test" (starting from scratch) | the **experiments** skill — it creates the experiment AND reuses or creates the flag end-to-end |
| "Turn this on at 9am, off at 5pm" | `references/flag-schedule.md` |
| "Gradually increase traffic from 5% to 100%" | `references/flag-ramp.md` |
| "Gradually release with guardrail metric monitoring" | `references/flag-monitoring.md` |
| "Only if feature Y is enabled" (whole flag) | `references/flag-prerequisites.md` |
| "Only if feature Y is enabled" (one rule) | `references/flag-targeting.md` |

If the user describes something ambiguous, ask one clarifying question before routing.

### Path C — Delete a rule

Show the numbered list (Path A) so the user can pick by number. Confirm:

> "Delete rule `<N>` (`<type>`, `<scope>`, `<summary>`)? This goes into a draft and only takes effect after publishing."

```bash
gb-call DELETE /api/v2/features/<flag-id>/revisions/new/rules/<rule-id>
```

Capture the returned `version`. Hand off to `references/flag-publish.md`.

**safe-rollout removal:** The server cleans up the `SafeRollout` entity when the rule is still in draft and the rollout hasn't started. If the rollout has already started, the SafeRollout entity is preserved (no data loss) but the rule is removed from the flag.

**experiment-ref removal:** The linked experiment is not affected. Removing the rule on the flag doesn't stop or modify the experiment.

### Path D — Reorder rules

Show the current order (Path A). Ask the user for the new order (by number or by describing the desired sequence).

```bash
echo '{"ruleIds":["<id-1>","<id-2>","<id-3>"]}' \
  | gb-call POST /api/v2/features/<flag-id>/revisions/new/rules/reorder -
```

Supply the **complete ordered array** of all rule IDs — this replaces the full order, not a swap. Capture the returned `version`. Hand off to `references/flag-publish.md`.

Remind the user that evaluation is top-to-bottom, first match wins — rules higher in the list take priority.

## Guardrails

- **Rules evaluate in order; position matters.** A broad rule (e.g., 50% rollout with no condition) placed first will match before a more specific rule below it. Surface this when the user adds or reorders.
- **Rule ID is a string UUID (`fr_...`), not a position number.** Always resolve to the UUID from the `rules` array before calling edit/delete/reorder endpoints.
- **Reorder requires the complete array.** Missing a rule ID in the reorder payload will cause an error or lose rules. Fetch the current `rules` array, reorder in memory, then send all IDs.
- **Draft version threading.** If a version number is already in context from a previous write skill in this session, use it explicitly instead of `new`. Fall back to `new` when starting fresh.
- **`version=new` is the canonical draft pattern.** Don't manually POST `/revisions` first — the `new` magic creates or reuses a draft atomically.
- **experiment-ref rules can only be deleted here.** For editing an experiment-ref rule's targeting conditions or scope, use `references/flag-targeting.md`. For changing the linked experiment, warn the user and use `references/flag-experiment.md`.

## Endpoints used

- `GET /api/v2/features/:id` — list current rules and flag state
- `DELETE /api/v2/features/:id/revisions/new/rules/:ruleId` — delete a rule
- `POST /api/v2/features/:id/revisions/new/rules/reorder` (body: `{ "ruleIds": ["<id>", ...] }`)

## Handoffs

- `references/flag-targeting.md` — force/rollout rules with conditions, saved groups, rule-level prerequisites
- `references/flag-experiment.md` — experiment-ref and inline experiment rules
- `references/flag-schedule.md` — timed activation windows on rules
- `references/flag-ramp.md` — multi-step progressive rollout schedules
- `references/flag-monitoring.md` — monitored rollouts and safe-rollout rules
- `references/flag-prerequisites.md` — feature-level prerequisite gates (not rule-level)
- `references/flag-publish.md` — to publish the draft after a delete or reorder
