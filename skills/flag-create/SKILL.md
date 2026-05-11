---
name: flag-create
description: Create a new feature flag in GrowthBook via the REST API. Use when the user asks to "create a feature flag", "add a flag for X", "wrap this in a feature flag", "I need a flag to gate this", or "feature toggle for X". For adding rules to an existing flag, use flag-targeting. For running an A/B test, use experiment-design. For removing a flag, use flag-cleanup.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# flag-create

Create a new feature flag in GrowthBook. The flag ships **disabled in every environment** — the user must enable it after creation. Feature keys are permanent; pick the name carefully.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It expects `GB_API_KEY` in env; see the plugin README if it's missing.

## Workflow

1. **Confirm intent.** Restate what the flag will gate in one sentence. Stop if the user actually wants an experiment (route to `experiment-design`) or a rule on an existing flag (route to `flag-targeting`).

2. **Check the key isn't taken.** Run:
   ```bash
   gb-call GET /api/v1/feature-keys
   ```
   Verify the proposed key isn't already in the returned list. If it is, propose a variant; the API will error on collision and the key cannot be renamed afterward.

3. **Pick a value type.** One of `string`, `number`, `boolean`, `json`. Default to `boolean` for an on/off gate. Use `string` or `json` only when the flag carries config (variant copy, threshold values, structured payload).

4. **Resolve the project (optional).** If the user mentions a project name, list projects and pick the ID:
   ```bash
   gb-call GET /api/v1/projects
   ```
   Flags scoped to a project are easier to govern than the default org-wide bucket. If unclear, ask the user.

5. **Resolve environments.** GrowthBook expects the create payload to include an `environments` map with every environment listed. Get them:
   ```bash
   gb-call GET /api/v1/environments
   ```
   Build the map with each env disabled and no rules.

6. **Confirm naming.** Default to kebab-case (`new-checkout-flow`, `dark-mode`, `pricing-experiment-2026-q2`). The API accepts a broader regex, but kebab-case keeps keys consistent across teams. Show the proposed key to the user before creating.

7. **Build the payload and create the flag.** Construct a JSON object:
   ```json
   {
     "id": "<kebab-case-key>",
     "valueType": "boolean",
     "defaultValue": "false",
     "description": "<short description>",
     "environments": {
       "production": { "enabled": false, "rules": [] },
       "staging":    { "enabled": false, "rules": [] }
     },
     "project": "<project-id, omit if org-wide>"
   }
   ```
   Then POST it:
   ```bash
   echo '<payload-json>' | gb-call POST /api/v1/features -
   ```

8. **State what happens next.** Tell the user explicitly: the flag is **disabled in all environments** and has **no rules** yet. Offer two follow-ups:
   - To turn it on for everyone in an environment, use `flag-targeting`.
   - To use this flag as the variation switch in an A/B test, use `experiment-design` with the flag's ID.

## Guardrails

- **Feature keys are permanent.** GrowthBook does not let you rename a flag's `id` after creation. Confirm the proposed name with the user before calling the API.
- **Flags are created disabled.** The flag does nothing until the user enables it in at least one environment. Always say so in your reply — silent zero evaluation is a top GrowthBook footgun.
- **`defaultValue` is what the SDK returns until rules apply.** If the user wants the flag off by default, set `defaultValue` to `"false"` (boolean) or the empty/safe value (string/number/json). Note that defaultValue is always serialized as a string in the payload.
- **Stop before creating if the user wants an experiment.** Hand off to `experiment-design`. Creating a flag without the corresponding experiment is a common confusion that produces orphaned flags.
- **Ask, do not guess.** If `valueType`, `defaultValue`, or project are ambiguous, ask. The flag is permanent.

## Endpoints used

- `GET /api/v1/feature-keys` — list all feature flag keys (no pagination cap)
- `GET /api/v1/projects` — list projects, used to resolve a project name to an ID
- `GET /api/v1/environments` — list environments, used to construct the `environments` map
- `POST /api/v1/features` — create the flag

## After creation

The response contains the flag's full configuration. Show the user the flag ID, a reminder that it's disabled everywhere, and a link to the flag in the GrowthBook UI (`https://app.growthbook.io/features/{id}` for cloud, or the appropriate self-hosted origin).
