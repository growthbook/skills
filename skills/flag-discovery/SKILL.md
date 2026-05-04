---
name: flag-discovery
description: List, inspect, or audit GrowthBook feature flags via the MCP server. Use when the user asks "what flags do we have", "list our feature flags", "find stale flags", "audit our flags", "which flags can we remove", or "tell me about flag X". Read-only — for actually removing a flag, use flag-cleanup. For adding rules, use flag-targeting.
allowed-tools: mcp__growthbook__list_feature_keys mcp__growthbook__get_feature_flags mcp__growthbook__get_stale_feature_flags
---

# flag-discovery

Inventory and audit GrowthBook feature flags. Three jobs share this skill: listing the inventory, inspecting one flag's configuration, and finding stale flags that are candidates for cleanup.

## Workflow

Pick the right path based on what the user asked for.

### Path A — "What flags do we have?" / general inventory

1. Call `mcp__growthbook__list_feature_keys` first. This returns every flag ID in the org with no pagination cap and is the cheapest way to get the full surface.
2. If the user wants details on a subset, call `mcp__growthbook__get_feature_flags` (capped at 100 per page; paginate with `offset` if the org has more).
3. Group the output by project if the org uses projects. Flag any keys that look like one-off test/debug flags (`test-`, `temp-`, `delete-me`, etc.) for the user's attention.

### Path B — "Tell me about flag X"

1. Call `mcp__growthbook__get_feature_flags` with `featureFlagId` set to the specific ID.
2. Surface: default value, environments enabled, current rules, owner, tags, last modified.

### Path C — "Find stale flags" / "what can we remove?"

1. **Gather the flag IDs to check.** `get_stale_feature_flags` will not find stale flags on its own — you must give it a list. Use one of:
   - The user names specific flags.
   - Read flag IDs from the user's open file or codebase.
   - Call `mcp__growthbook__list_feature_keys` to get all IDs, then optionally narrow by codebase grep.
2. Pass the list to `mcp__growthbook__get_stale_feature_flags` as `featureIds`.
3. Present the staleness report grouped by recommendation: launched (safe to remove), unused, in-use but old. Quote the replacement values the API surfaces — they tell the user what to inline when removing.
4. Do **not** delete anything. This skill audits; cleanup is a separate skill (`flag-cleanup`) that the user must opt into.

## Guardrails

- **`get_stale_feature_flags` requires explicit IDs.** Calling it without `featureIds` returns a guidance message, not stale data. If you don't have IDs, fetch them from `list_feature_keys` first or ask the user.
- **`list_feature_keys` is unpaginated; `get_feature_flags` is.** Use `list_feature_keys` for full inventory and `get_feature_flags` for details. Don't loop `get_feature_flags` to enumerate the whole org when `list_feature_keys` does it in one call.
- **Read-only.** This skill never writes. If the user asks to remove a flag, hand off to `flag-cleanup`.
- **Pagination defaults to oldest-first.** Pass `mostRecent: true` on `get_feature_flags` when the user wants newest activity first.
- **Don't infer "stale" yourself.** Use `get_stale_feature_flags` for the canonical determination — the API encodes GrowthBook's own staleness rules and surfaces replacement values you can't compute locally.

## MCP tools used

- `mcp__growthbook__list_feature_keys` — full ID list, no pagination cap. Cheapest call.
- `mcp__growthbook__get_feature_flags` — full configuration for one flag, or paginated list with details.
- `mcp__growthbook__get_stale_feature_flags` — staleness audit. Requires explicit `featureIds`.

## Output expectations

Always tell the user the count first, then group output meaningfully (by project, by status, by staleness). Avoid dumping a 200-flag list as a wall of text — group, summarize, and offer to drill in.
