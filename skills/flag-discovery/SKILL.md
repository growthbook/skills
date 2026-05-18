---
name: flag-discovery
description: List, inspect, or audit GrowthBook feature flags via the REST API. Use when the user asks "what flags do we have", "list our feature flags", "find stale flags", "audit our flags", "which flags can we remove", or "tell me about flag X". Read-only — for actually removing a flag, use flag-cleanup. For adding rules, use flag-targeting.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# flag-discovery

Inventory and audit GrowthBook feature flags. Three jobs share this skill: listing the inventory, inspecting one flag's configuration, and finding stale flags that are candidates for cleanup.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It expects `GB_API_KEY` in env.

## Workflow

Pick the path that matches what the user asked for.

### Path A — "What flags do we have?" / general inventory

1. Start with the lightweight list:
   ```bash
   gb-call GET /api/v2/feature-keys
   ```
   Returns every flag ID in the org as a string array — no pagination cap, cheapest way to get the full surface.

2. If the user wants details on a subset, fetch them paginated:
   ```bash
   gb-call GET '/api/v2/features?limit=100'
   gb-call GET '/api/v2/features?limit=100&offset=100'    # next page
   ```
   100 per page is the cap; loop with `offset` if the org has more.

3. Group output by project if the org uses projects. Flag any keys that look like one-off test/debug flags (`test-`, `temp-`, `delete-me`, etc.) for the user's attention.

### Path B — "Tell me about flag X"

```bash
gb-call GET /api/v2/features/<flag-id>
```

Surface: default value, environments enabled, rules array (top-level in v2, each rule scoped via `allEnvironments` or `environments`), owner, tags, last modified.

### Path C — "Find stale flags" / "what can we remove?"

1. **Gather the flag IDs to check.** The stale-features endpoint requires an explicit list. Source them from:
   - The user names specific flags.
   - Read flag IDs from the user's open file or codebase.
   - Or pull the full list:
     ```bash
     gb-call GET /api/v2/feature-keys
     ```
     and optionally narrow by codebase grep.

2. Call the staleness audit with the IDs as a comma-separated query param:
   ```bash
   gb-call GET '/api/v2/stale-features?ids=flag-a,flag-b,flag-c'
   ```

   What "stale" means here, per the GrowthBook docs: a flag flagged as stale meets **both** (a) no updates for two weeks **and** (b) either no active environments **or** one-sided rules routing 100% of traffic to a single variation. The endpoint encodes these rules — don't reimplement them.

3. **Honor the `neverStale` flag.** If a feature has `neverStale: true` set in GrowthBook, the response returns `staleReason: "never-stale"`. Surface these separately and do **not** include them in cleanup recommendations — they're deliberately permanent (kill switches, ops toggles, license gates).

4. Present the report grouped by recommendation: launched (safe to remove), unused, in-use but old, never-stale (excluded). Quote the replacement values the API surfaces — they tell the user what to inline when removing.

5. Do **not** delete anything. This skill audits; cleanup is a separate skill (`flag-cleanup`) that the user must opt into.

## Guardrails

- **`/stale-features` needs explicit IDs.** No "find all stale flags" endpoint exists; you must pass `ids=...`. If you don't have IDs, fetch them from `/feature-keys` first.
- **`/feature-keys` is unpaginated; `/features` is.** Use `/feature-keys` for full inventory and `/features` for details. Don't loop `/features` to enumerate the whole org when one call to `/feature-keys` does it.
- **v2 rule shape is flat.** Under v2, rules live in a single top-level `rules` array with `allEnvironments` / `environments` scope per rule — not nested under each environment as in v1. Read the response shape accordingly when inspecting a flag.
- **Read-only.** This skill never writes. If the user asks to remove a flag, hand off to `flag-cleanup`.
- **Don't infer "stale" yourself.** Use `/stale-features` for the canonical determination — it encodes GrowthBook's own staleness rules (no updates 2w AND (no active envs OR one-sided rules)) and surfaces replacement values you can't compute locally.
- **`neverStale: true` flags are excluded from cleanup recommendations.** The endpoint returns `staleReason: "never-stale"` for them; surface separately and don't propose deleting them.
- **Rate limit is 60 rpm.** If listing a huge org with `/features` pagination, pace yourself.

## Endpoints used

- `GET /api/v2/feature-keys` — full ID list, no pagination cap. Cheapest call.
- `GET /api/v2/features` — paginated list with full configuration. `limit` up to 100, `offset` for paging.
- `GET /api/v2/features/{id}` — full configuration for one flag.
- `GET /api/v2/stale-features?ids=a,b,c` — staleness audit. Requires explicit `ids`.

## Output expectations

Always tell the user the count first, then group output meaningfully (by project, by status, by staleness). Avoid dumping a 200-flag list as a wall of text — group, summarize, and offer to drill in.
