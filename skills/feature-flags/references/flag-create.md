---
name: flag-create
description: Create a new feature flag in GrowthBook via the REST API. Use when the user asks to "create a feature flag", "add a flag for X", "wrap this in a feature flag", "I need a flag to gate this", or "feature toggle for X". For adding rules to an existing flag, use flag-rules. For removing a flag, use flag-cleanup.
---

# flag-create

Create a new feature flag in GrowthBook. We always set `{enabled: false}` for every environment explicitly in the payload, so the flag ships disabled regardless of the org's default-state-for-new-environments setting — the user must enable it after creation. Feature keys are permanent; pick the name carefully.

## Workflow

1. **Confirm intent.** Restate what the flag will gate in one sentence. Stop if the user wants to run an A/B test (route to the appropriate experiment skill based on what's already in scope) or a rule on an existing flag (route to `references/flag-rules.md`).

2. **Check the key isn't taken.**
   ```bash
   gb-call GET /api/v2/feature-keys
   ```
   Verify the proposed key isn't already in the returned list. If it is, propose a variant; the API will reject the collision and the key cannot be renamed afterward.

3. **Pick a value type.** One of `string`, `number`, `boolean`, `json`. Default to `boolean` for an on/off gate. Use `string` or `json` only when the flag carries config (variant copy, threshold values, structured payload).

4. **Resolve the project (optional).** If the user mentions a project name, list projects and pick the ID:
   ```bash
   gb-call GET /api/v1/projects
   ```
   Flags scoped to a project are easier to govern than the default org-wide bucket. If unclear, ask the user.

5. **Resolve environments.** GrowthBook expects the create payload to include an `environments` map listing every environment. Get them:
   ```bash
   gb-call GET /api/v1/environments
   ```
   Build the map with each environment disabled.

6. **Confirm naming.** The v2 endpoint regex accepts `[a-zA-Z0-9_.:|-]` (the user-facing docs and error messages recommend the narrower `[a-zA-Z0-9_-]`). Default to **kebab-case** (`new-checkout-flow`, `dark-mode`, `pricing-experiment-2026-q2`) — it matches what the docs recommend, keeps keys consistent across teams, and avoids any future tightening of the regex. Show the proposed key to the user before creating.

7. **Build the payload and create the flag.** Construct a JSON object:
   ```json
   {
     "id": "<kebab-case-key>",
     "valueType": "boolean",
     "defaultValue": "false",
     "description": "<short description>",
     "environments": {
       "production": { "enabled": false },
       "staging":    { "enabled": false }
     },
     "project": "<project-id, omit if org-wide>"
   }
   ```
   Then POST it:
   ```bash
   echo '<payload-json>' | gb-call POST /api/v2/features -
   ```

8. **State what happens next.** Tell the user explicitly: the flag is **disabled in all environments** and has **no rules** yet. Offer two follow-ups:
   - To turn it on in an environment or attach a targeting rule, use `references/flag-targeting.md`.
   - To use this flag as the variation switch in an A/B test, use the **experiments** skill (`experiment-design` workflow) with the flag's ID.

## Guardrails

- **Feature keys are permanent.** GrowthBook does not let you rename a flag's `id` after creation. Confirm the proposed name with the user before calling the API.
- **`owner` defaults to the token's user.** Omit `owner` from the create payload — the API attributes the flag to the user the `GB_API_KEY` belongs to. Only set `owner` explicitly (an email or `u_...` userId) if the user wants to assign the flag to someone else.
- **ID character set: prefer kebab-case.** The v2 endpoint regex still accepts `[a-zA-Z0-9_.:|-]`, but the user-facing docs and error messages recommend `[a-zA-Z0-9_-]`. Don't propose IDs with `.`, `:`, or `|` — they may be tightened in a future version. Existing legacy keys with those characters can be left alone.
- **Always set `{enabled: false}` explicitly per environment.** Don't rely on the org's default-state-for-new-environments setting — it's configurable and may default to enabled. Tell the user the flag is disabled everywhere; silent zero evaluation (or worse, accidentally-enabled evaluation) is a top GrowthBook footgun.
- **`defaultValue` is always serialized as a string.** `"false"` for boolean off, `"0"` for numeric, JSON-encoded text for `json`. The API rejects non-string values.
- **v2 environments map is just `{enabled: bool}` per env.** Rules are no longer nested under each environment — they're a top-level array on the flag, added later via `references/flag-targeting.md` (or directly through the v2 revision endpoints). Do not include `rules: []` inside each env.
- **Stop before creating if the user wants an experiment.** Hand off to the **experiments** skill (`experiment-design` workflow). Creating a flag without the corresponding experiment is a common confusion that produces orphaned flags.
- **Ask, do not guess.** If `valueType`, `defaultValue`, or project are ambiguous, ask. The flag is permanent.

## Endpoints used

- `GET /api/v2/feature-keys` — list all feature flag keys (no pagination cap)
- `GET /api/v1/projects` — list projects, used to resolve a project name to an ID
- `GET /api/v1/environments` — list environments, used to construct the `environments` map
- `POST /api/v2/features` — create the flag

## After creation

The response contains the flag's full configuration. Show the user the flag ID, a reminder that it's disabled everywhere, and a link to the flag in the GrowthBook UI. Derive `<host>` from `GB_API_URL` by replacing `api.` → `app.` (cloud default: `https://app.growthbook.io`). Link: `<host>/features/<flag-id>`.

## Handoffs

- `references/flag-toggle.md` — to enable the flag in an environment
- `references/flag-rules.md` — to add rules (routes to the appropriate rule type skill)
- `references/flag-default-value.md` — to change the fallback value served when no rules match
- `references/flag-metadata.md` — to set project, tags, description, or owner after creation
- `references/flag-experiment.md` — to wire this flag to an A/B experiment
- the **experiments** skill (`experiment-design` workflow) — if the user actually wants a full A/B test (create experiment first, flag second)
