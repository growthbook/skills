---
name: flag-create
description: Creates a new GrowthBook feature flag through the GrowthBook MCP server. Use when the user asks to add, create, or wrap something in a feature flag — phrases like "add a feature flag", "wrap this in a flag", "create a flag for", "I need a flag to gate this". Handles the empty-project case (first flag in a fresh GrowthBook org). Does not run experiments — for A/B tests, use experiment-design after the flag exists.
when_to_use: User wants a new feature flag. Trigger phrases include "create a feature flag", "add a flag", "wrap this in a flag", "gate this behind a flag", "feature toggle for X". Skip if the user is asking to add a rule to an existing flag (use flag-targeting), to run an experiment (use experiment-design), or to remove a flag (use flag-cleanup).
allowed-tools: mcp__growthbook__create_feature_flag mcp__growthbook__list_feature_keys mcp__growthbook__get_projects
---

# flag-create

Create a new feature flag in GrowthBook. The flag ships **disabled in every environment** — you must enable it after creation. Feature keys are permanent; pick the name carefully.

## Workflow

1. **Confirm intent.** Restate what the flag will gate, in one sentence. Stop if the user actually wants an experiment (route them to `experiment-design`) or a rule on an existing flag (route to `flag-targeting`).

2. **Check the key isn't taken.** Call `mcp__growthbook__list_feature_keys` and verify the proposed key isn't already in use. If it is, propose a variant; do not silently overwrite — `create_feature_flag` will error on collision and the key cannot be renamed afterward.

3. **Pick a value type.** One of `string`, `number`, `boolean`, `json`. Default to `boolean` for an on/off gate. Use `string` or `json` only when the flag carries config (variant copy, threshold values, structured payload).

4. **Determine the project.** If the user mentions a project, resolve its ID with `mcp__growthbook__get_projects`. If unclear, ask — flags scoped to a project are easier to govern than the default org-wide bucket.

5. **Confirm naming.** Default to kebab-case (`new-checkout-flow`, `dark-mode`, `pricing-experiment-2026-q2`). The MCP accepts a broader regex (`[a-zA-Z0-9_.:|_-]+`), but kebab-case keeps keys consistent across teams and matches the public docs. Show the proposed key to the user before creating.

6. **Create the flag.** Call `mcp__growthbook__create_feature_flag` with `id`, `valueType`, `defaultValue`, `description`, `fileExtension`, and `project` (if scoped). Pass `fileExtension` based on the active file — ask the user if it isn't obvious.

7. **State what happens next.** Tell the user explicitly: the flag is **disabled in all environments** and has **no rules** yet. Offer two follow-ups:
   - To turn it on for everyone in an environment, use `flag-targeting`.
   - To use this flag as the variation switch in an A/B test, use `experiment-design` with the flag's ID.

## Guardrails

- **Feature keys are permanent.** GrowthBook does not let you rename a flag's `id` after creation. Confirm the proposed name with the user before calling the tool.
- **Flags are created disabled.** The flag does nothing until the user enables it in at least one environment. Always say so in your reply — silent zero evaluation is a top GrowthBook footgun.
- **Tag policy.** `create_feature_flag` automatically tags the flag with `mcp`. Do not promise the user any other tags will be applied — they aren't.
- **Default value is what the SDK returns until rules apply.** If the user wants the flag off by default, set `defaultValue` to `false` (boolean) or the empty/safe value (string/number/json).
- **Stop before creating.** If the user is describing an A/B test, hand off to `experiment-design`. Creating a flag without the corresponding experiment is a common confusion that produces orphaned flags.
- **Ask, do not guess.** If `valueType`, `defaultValue`, file extension, or project are ambiguous, ask. The flag is permanent.

## MCP tools used

- `mcp__growthbook__list_feature_keys` — list existing flag IDs to check for collisions.
- `mcp__growthbook__get_projects` — resolve a project name to its ID.
- `mcp__growthbook__create_feature_flag` — create the flag.

## After creation

The MCP returns a link to the flag in the GrowthBook UI plus an SDK snippet for the file extension you passed. Show both to the user. Offer to run `generate-flag-types` if their project is TypeScript.
