---
name: flag-prerequisites
description: Add, remove, or inspect feature-level prerequisites on a GrowthBook feature flag. Use when the user says "gate flag X on flag Y being enabled", "add a prerequisite", "flag X should only evaluate if flag Y is on", "remove the prerequisite on flag X", "what does this flag depend on", "this flag should require the new-checkout flag to be true first", or "set up a prerequisite gate". Feature-level prerequisites gate the entire flag — when a prerequisite isn't met, the flag returns its default value for that user. For prerequisites scoped to a single rule, use flag-targeting. For tracing the full dependency graph, use flag-graph.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# flag-prerequisites

Add, remove, or inspect feature-level prerequisites on a GrowthBook feature flag. A feature-level prerequisite gates the entire flag: if the prerequisite condition isn't met for a user, the flag skips all its rules and returns its `defaultValue` for that user.

This is distinct from rule-level prerequisites (which gate a single rule) — feature-level prerequisites apply to every rule on the flag simultaneously.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` and `GB_EMAIL` set in env or written to `~/.config/growthbook/.env` by `/growthbook:setup`.

## Prerequisites concept

A prerequisite has two parts:
- **`id`**: the feature flag that must be evaluated first
- **`condition`**: a condition checked against `{ "value": <evaluated_result> }` — the prerequisite flag's evaluated value for the current user

If the condition passes, the current flag evaluates normally. If it fails, the current flag returns `defaultValue`.

### Condition examples

| Goal | Condition |
| --- | --- |
| Prerequisite boolean flag must be `true` | `{"value": true}` |
| Prerequisite boolean flag must be `false` | `{"value": false}` |
| Prerequisite string flag must equal `"v2"` | `{"value": {"$eq": "v2"}}` |
| Prerequisite number flag must be >= 3 | `{"value": {"$gte": 3}}` |
| Prerequisite must evaluate to any truthy value | `{"value": {"$exists": true}}` |

The condition object is always serialized as a JSON string when sent to the API.

## Workflow

### Path A — Add a prerequisite

1. **Fetch the flag's current prerequisites:**
   ```bash
   gb-call GET /api/v2/features/<flag-id>
   ```
   Capture the existing `prerequisites` array. The PUT below replaces the full array, so you need the current contents to avoid overwriting existing prerequisites.

2. **Confirm the prerequisite flag exists:**
   ```bash
   gb-call GET /api/v2/features/<prerequisite-flag-id>
   ```
   Also confirm its `valueType` so you can build a sensible condition.

3. **Build the new prerequisites array.** Append to any existing entries:
   ```json
   [
     { "id": "<existing-prereq-id>", "condition": "<existing-condition>" },
     { "id": "<new-prereq-id>", "condition": "{\"value\": true}" }
   ]
   ```

4. **Apply via draft:**
   ```bash
   echo '{"prerequisites":[...]}' \
     | gb-call PUT /api/v2/features/<flag-id>/revisions/new/prerequisites -
   ```

5. Hand off to feature-publish.

### Path B — Remove a prerequisite

1. Fetch current prerequisites (step A-1 above).
2. Show the list and ask which to remove.
3. Build the updated array without the removed entry.
4. Apply via draft (step A-4 above) with the filtered array. An empty array `[]` removes all prerequisites.
5. Hand off to feature-publish.

### Path C — Inspect current prerequisites

```bash
gb-call GET /api/v2/features/<flag-id>
```

Surface the `prerequisites` array. For each entry, fetch the prerequisite flag to show its current evaluated state and value type. Use flag-graph to trace the full dependency chain if needed.

## Guardrails

- **Draft version threading.** If a version number is already in context from a previous write skill in this session, use it explicitly (e.g. `.../revisions/42/prerequisites`) instead of `new`. This keeps all changes in the same draft. Fall back to `new` when starting fresh — it auto-creates or reuses the most recently updated open draft.
- **`PUT /prerequisites` replaces the full array.** It's not additive. Always fetch the current array first and include all existing entries when adding or modifying — otherwise you'll silently delete prerequisites the user didn't intend to touch.
- **Condition keys must be `"value"` or logical operators (`$and`, `$or`, `$nor`, `$not`).** Any other top-level key in the condition silently never matches — the prerequisite gate always fails for those users. Don't fabricate conditions with keys like `"enabled"` or `"id"`.
- **Conditions evaluate against `{ "value": <flag_result> }`.** The prerequisite flag is fully evaluated (including its own rules and prerequisites) for the current user, and the result is placed under the `value` key. Write conditions that check `value`, not the flag's `id` or any other field.
- **Feature-level vs rule-level prerequisites.** This skill sets prerequisites on the whole flag. If the user wants a prerequisite on a single rule only, route to flag-targeting.
- **Circular dependencies must be avoided.** If flag A requires flag B and flag B requires flag A, neither will ever evaluate. Check the existing dependency chain via flag-graph before adding a prerequisite.
- **Prerequisite flags must be in the same GrowthBook project (or org-wide).** Cross-project prerequisites may not resolve correctly depending on SDK configuration.
- **Deleting a prerequisite flag breaks any flag that depends on it.** The dependent flag's prerequisite condition will silently always fail. Surface this when the user is reviewing dependencies via flag-graph before cleanup.

## Endpoints used

- `GET /api/v2/features/:id` — fetch flag state including current `prerequisites` array
- `PUT /api/v2/features/:id/revisions/new/prerequisites` (body: `{ "prerequisites": [...] }`)

## Handoffs

- `flag-search` — to find the prerequisite flag's ID if the user gives a name
- `flag-graph` — to trace the full dependency chain and detect circular dependencies
- `flag-targeting` — to add rule-level prerequisites (scoped to a single rule rather than the whole flag)
- `feature-publish` — to publish the draft, handle approval-required (400) and merge conflicts (409)
