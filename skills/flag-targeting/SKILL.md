---
name: flag-targeting
description: Add, edit, or remove targeting rules on an existing GrowthBook feature flag — including percentage rollouts, forced-value rules, environment-level kill switches, and removing experiment-ref rules left behind by stopped experiments. Use when the user says "turn on flag X in prod", "add a rule to flag Y", "release this flag to 10% of users", "remove the experiment rule from this flag", "disable this rule", "edit the targeting condition on flag Z", or "clean up the experiment-ref rule after I stopped my test". For creating a new flag, use flag-create. For launching an experiment, use experiment-launch. For removing a flag entirely, no skill yet — direct the user to the GrowthBook UI.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# flag-targeting

Add, edit, or remove targeting rules on an existing feature flag, plus toggle the env-level kill switch. Every change goes through a v2 draft revision and only takes effect after the revision publishes. Handles approval-required and merge-conflict failure paths.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` — set in your shell, or written to `~/.config/growthbook/.env` by `/growthbook:setup`. If unset or invalid, gb-call's error message points back at `/growthbook:setup`.

## Required inputs

Collect from the user (or earlier skill output) before starting. Prompt for what's missing.

- **Flag ID** — kebab-case key. If the user gives a description ("the new checkout flag"), use `flag-discovery` first to resolve.
- **Action** — one of `add` | `edit` | `remove` | `env-toggle`. Inferred from the user's request; confirm before mutating.

## Per-action inputs

### `add` path

- **Rule type** — `force` (target specific users with a value) or `rollout` (percentage release). Inferred from wording: "X% of users" → rollout; "for users matching Y" → force.
- **Value** — what the rule serves when it matches. Must match the flag's `valueType` (boolean / string / number / json), serialized as a string.
- **Scope** — `allEnvironments: true` or `environments: [<env-ids>]`. Ask if not specified; don't assume.
- **Conditions** (optional) — saved-group reference, MongoDB-style attribute condition, or prerequisite on another flag. See the conditions decision tree in step 3a.
- **For rollout rules:** `coverage` (0–1) and `hashAttribute` (required when coverage < 1).
- **Description** (optional but recommended) — human-readable label so future you can identify the rule.
- **enabled** — defaults to `true`.

### `edit` path

- **Rule ID** — resolved by fetching the flag and showing a numbered list (step 3b). The user picks by number; the skill resolves to the UUID.
- **Patch fields** — only the fields the user wants to change. Don't echo unchanged fields back to the server.

### `remove` path

- **Rule ID** — resolved the same way as edit.

### `env-toggle` path

- **Environment ID** — pick from `/api/v1/environments`.
- **Enabled** — `true` or `false`.

## Workflow

Track progress with this checklist. Do not skip or reorder.

```
- [ ] 1. Resolve flag and current state
- [ ] 2. Confirm the action (add / edit / remove / env-toggle)
- [ ] 3. Branch — 3a (add), 3b (edit), 3c (remove), 3d (env-toggle)
- [ ] 4. Mutate against revision `new` (atomic draft + change)
- [ ] 5. Offer to publish; branch to 5a (approval-required) on 400, 5b (merge conflict) on 409
- [ ] 6. Report state, UI link, and any auto-flipped rule type
```

### 1. Resolve flag and current state

```bash
gb-call GET /api/v2/features/<flag-id>
```

Capture from the response:
- `valueType` — drives value validation in step 3a.
- `project` — used downstream when relevant.
- `environmentSettings` keys — the available environment IDs (for scope and env-toggle).
- `rules` array — the full list of current rules with their `id` (UUID), `type`, `enabled`, scope, and type-specific fields. Needed for edit/remove identification (step 3b/3c).
- `holdout` (if present) — informational only; this skill doesn't touch holdouts because it doesn't add experiment-ref rules.

If 404, halt: "no flag with id `<flag-id>`." Suggest `flag-discovery` to list flags.

### 2. Confirm the action

If the user's request is ambiguous, ask before mutating. This is a write skill — guessing wrong burns a draft revision and an audit-log entry.

### 3a. `add` path

**New rules append to the bottom of the rules array.** Rules evaluate top-to-bottom; first match wins. If the flag already has rules, surface this before posting:

> The flag has `<N>` existing rule(s); the new one will be evaluated last. If it needs to run earlier (e.g., to override an existing rule for a subset of users), reorder via the GrowthBook UI at `<host>/features/<flag-id>` after this completes. Reordering isn't supported by this skill.

**Pre-validate `value` against the flag's `valueType`.** The v2 rule-add handler doesn't validate value/type match at write time; mismatches surface later (publish or SDK eval). Catch obvious mismatches here:
- `boolean` flag → value must be `"true"` or `"false"` (string-serialized).
- `number` flag → value must parse as a number.
- `json` flag → value must parse as JSON.
- `string` flag → any non-empty string is acceptable.

If the user provides a value that doesn't match, halt and ask them to fix it — don't silently coerce.

**Resolve scope.** If the user said "in prod" or "everywhere," confirm against `environmentSettings` keys. Set either `allEnvironments: true` (everywhere) or `environments: ["<env-id>", ...]` (specific list). Never send both fields.

**For rollout rules, resolve `hashAttribute`.** When `coverage < 1`:

```bash
gb-call GET /api/v1/attributes
```

Prefer attributes flagged with `hashAttribute: true` and `archived !== true`. If the user said "by user" or "by id," `id` is the default; for "by company," pick the company-scoped attribute. If the filtered list is empty, halt — tell the user to mark at least one attribute as a hash attribute under **Settings → Attributes**.

**Conditions — decision tree.** Walk this top-down:

1. **Is the user describing a named group of people they manage elsewhere** ("beta testers", "internal users", "enterprise customers")? → Use **Saved Groups**:
   ```bash
   gb-call GET /api/v1/saved-groups
   ```
   Match the user's description to a returned group's `name` and use `savedGroups: [{ ids: ["<sg-id>"], match: "all" }]`.
2. **Is the user describing an attribute-based condition that can be expressed unambiguously** ("users in the US", "app version >= 2.0", "logged-in admins")? → Use a **hand-built MongoDB condition** (string-serialized JSON). Confirm the attribute exists in `/api/v1/attributes` first; refuse if not defined.
3. **Is the targeting conditional on another flag's value** ("only when feature-X is on")? → Use a **prerequisite**: `prerequisites: [{ id: "<other-flag-id>", condition: "{\"value\": true}" }]`.
4. **Could be any of the above?** ("VIP customers" — saved group? attribute on the user record? both?) → **Halt and ask.** Don't pick the most likely interpretation; ask the user to clarify which mechanism they want.

Concrete examples:

| User says | Mechanism | Why |
| --- | --- | --- |
| "Turn it on for our beta testers" | Saved Group `beta-testers` | Named group, exists across flags |
| "Users in the US" | Condition `{"country": "US"}` | Single attribute, unambiguous |
| "iOS users on version 5.2 or higher" | Condition `{"platform": "ios", "appVersion": {"$vgte": "5.2"}}` | Multiple attributes, semantic version |
| "Only when the new-checkout flag is on" | Prerequisite on `new-checkout` | Cross-flag dependency |
| "Enterprise users" | **Ask** | Could be saved group or `{"plan": "enterprise"}` |

**Build the payload.** For a force rule:

```json
{
  "rule": {
    "type": "force",
    "value": "<string>",
    "description": "<optional>",
    "enabled": true,
    "allEnvironments": false,
    "environments": ["production"],
    "condition": "<optional JSON string>",
    "savedGroups": [{ "ids": ["<sg-id>"], "match": "all" }],
    "prerequisites": [{ "id": "<other-flag-id>", "condition": "{\"value\": true}" }]
  }
}
```

For a rollout rule, swap `type: "rollout"` and add `coverage` + `hashAttribute`. Omit `savedGroups`, `condition`, `prerequisites`, `description` entirely if not used — don't send empty arrays/strings.

**POST** to add atomically via the `new` magic version:

```bash
echo '<payload>' | gb-call POST /api/v2/features/<flag-id>/revisions/new/rules -
```

Capture `revision.version` from the response — needed in step 5 for publish.

### 3b. `edit` path

Show the rules in a numbered list. Capture each rule's `id`, `type`, current scope, `enabled`, and a one-line summary so the user can pick:

```
Rules on `<flag-id>` (top-to-bottom evaluation order):
  1. [force]          enabled in production              value="true"     "Beta testers"
  2. [rollout]        enabled in production, coverage=25% hash=id          value="true"
  3. [experiment-ref] enabled everywhere                  experiment=exp_abc123
  4. [force]          disabled in staging                 value="false"    "Kill switch"

Which rule do you want to edit? Reply with a number.
```

Capture the chosen rule's `id`. Surface its current values and ask which fields to change. Build a patch with only the fields the user actually edits.

**Empty-patch guard.** If after the user's input no fields would actually change (proposed values match current values verbatim), halt with "no changes to apply — exiting." Don't POST a no-op patch; it consumes rate-limit budget, generates an audit-log entry, and can invalidate previously-granted review approvals via `resetReviewOnChange`.

**Rule-type behavior on edit.**

- **Explicit `type` changes are server-rejected.** If the user wants to convert (say) a force rule into an experiment-ref rule, halt: explain that the server returns `Rule type cannot be changed`, and direct them to remove and re-add (step 3c followed by step 3a).
- **`force` ↔ `rollout` auto-flips based on effective coverage.** This is implicit and supported — patching `coverage: 0.25` onto a force rule turns it into a rollout (requires `hashAttribute`); patching `coverage: 1` (or removing coverage) onto a rollout turns it back into a force rule. When this happens, **report the type transition in step 6** so the user isn't surprised.

**experiment-ref edit rules** (per the v2 patch handler):

- **Server-rejected** (don't even try): `value`, `coverage`, `controlValue`. The handler throws `value, coverage, and controlValue cannot be set on an experiment-ref rule`. If the user asks for any of these, halt early with the explanation.
- **Allowed but risky — warn-and-confirm**: `experimentId` and `variations`. The API permits these patches, but the experiment is the source of truth for both. Editing them on the flag rule alone causes silent drift between flag and experiment. Surface the risk:
  > Changing `<experimentId|variations>` on a flag rule directly is unusual — the experiment normally drives both. The flag rule will hold the new value, but the experiment won't be updated and the two can drift. Are you sure?
  Require explicit confirmation before posting.
- **Allowed and safe**: `enabled`, `condition`, `savedGroups`, `prerequisites`, scope (`allEnvironments` + `environments`), `description`.

**safe-rollout edit rules are out of scope for v1.** If the chosen rule's type is `safe-rollout`, halt: "Editing safe-rollout rules is out of scope for this skill — use the GrowthBook UI at `<host>/features/<flag-id>`. Removing a safe-rollout rule is supported by this skill (step 3c)."

**Scope-update subtlety.** If the patch sends `environments` without `allEnvironments`, the server infers `allEnvironments: false`. This means *widening* a single-env rule to all-envs requires `{"allEnvironments": true}` explicitly; sending only `{"environments": [...]}` narrows. Always send both fields together when changing scope.

**PATCH** the rule against `new`:

```bash
echo '<patch-payload>' | gb-call PUT /api/v2/features/<flag-id>/revisions/new/rules/<rule-id> -
```

Capture `revision.version` from the response.

### 3c. `remove` path

Show the same numbered list as step 3b. Capture the chosen rule's `id`. Confirm the intent in plain English:

> "Removing the rule '<description-or-type>' (`<rule-id>`, type `<type>`, env scope `<scope>`) from flag `<flag-id>`. This change goes into a draft revision and only takes effect after the revision publishes. Proceed?"

```bash
gb-call DELETE /api/v2/features/<flag-id>/revisions/new/rules/<rule-id>
```

Capture `revision.version` from the response.

**safe-rollout removal is supported.** The delete handler cleans up the SafeRollout entity server-side when the rule is still in draft and the rollout hasn't started. If the rollout has started, the SafeRollout entity is preserved (no data loss).

**experiment-ref removal is the headline use case.** This is what `experiment-stop` hands off to when the user wants to clean up the linked flag's rule. Mention this in the report: "the linked experiment isn't affected by removing this rule."

### 3d. `env-toggle` path

Toggle the env-wide kill switch. This is **distinct from rule-level `enabled`**: it controls whether the flag is evaluated at all in the chosen environment.

```bash
echo '{"environment":"<env-id>","enabled":<true|false>}' \
  | gb-call POST /api/v2/features/<flag-id>/revisions/new/toggle -
```

Capture `revision.version` from the response.

### 4. Mutate against revision `new`

The `new` literal in the path is a magic value: the server creates a draft revision branched off the live revision and applies the change in one atomic call. Behavior:

- **No existing draft** → server creates a fresh draft.
- **An existing draft already open by you or a teammate** → server reuses it (your change layers on top).
- **An existing draft in a non-draft status** (approved, published, etc.) → server throws `Cannot edit a revision with status "<X>"`. Surface clearly.

Don't manually `POST /revisions` first then mutate by version number; the `new` magic handles draft creation correctly.

### 5. Offer to publish

After the mutation, ask the user: "Publish this revision now, or leave it as a draft for review?"

**Defaults:**
- **env-toggle** and **removing an experiment-ref rule** — default to **publish** (low-risk, the user almost always wants it live).
- **add rule**, **edit rule**, **remove non-experiment-ref rule** — **ask explicitly** (these can affect production traffic in non-obvious ways).

**Auto-publish is best-effort.** Even "low-risk" operations can land in step 5a if the org requires approval on any flag-rule change. Frame the offer honestly:

> I'll try to publish now. If your org requires approval, we'll switch to the request-review flow.

If publishing:

```bash
echo '{"comment":"<optional summary of the change>"}' \
  | gb-call POST /api/v2/features/<flag-id>/revisions/<version>/publish -
```

Branch on response:
- **2xx** → step 6.
- **400 with "approval required" body** → step 5a.
- **409** → step 5b (merge conflict; another actor changed the flag).
- Other 4xx → halt and surface the body.

### 5a. Approval required

The change exists in a draft; only the publish is blocked. Halt and offer the user three concrete paths:

> Your org requires approval before this revision can publish. Revision `<version>` on `<flag-id>` is in draft. Pick one:
>
> **A. Standard review flow** (recommended) — I'll request review now. A teammate (not you, since you created the draft) approves it in the GrowthBook UI at `<host>/features/<flag-id>`, then you re-run me and I'll resume from publish.
>
> **B. Org-wide bypass** — an admin enables "REST API always bypasses approval requirements" in **Settings → General → Approvals**. After that, re-run me.
>
> **C. Per-token bypass** — use a Personal Access Token whose role grants `bypassApprovalChecks` on this project (Admin or custom role). Update `GB_API_KEY`, then re-run me.

If the user picks **A**, request review on the draft and stop:

```bash
echo '{"comment":"Auto-requested by flag-targeting"}' \
  | gb-call POST /api/v2/features/<flag-id>/revisions/<version>/request-review -
```

Do **not** attempt `submit-review` — the API rejects self-approval on a draft you created.

If the user picks **B** or **C**, stop with a one-line note. The existing draft will pick up the new permission and publish on retry.

Do **not** silently retry publish, ignore the error, or discard and recreate the draft to work around the policy.

### 5b. Merge conflict on publish

A 409 on publish means the draft's base revision is stale — someone else (or another agent invocation) published changes to the same flag while our draft was open. The skill **does not auto-rebase**. Halt with:

> Your draft of `<flag-id>` (revision `<version>`) can't be published because the flag has changed since the draft was created. To resolve:
>
> - Open `<host>/features/<flag-id>` in the GrowthBook UI.
> - Review the merge conflicts.
> - Either rebase (apply your draft on top of the new live revision) or discard your draft and re-run me.

Surface the conflict body verbatim. Don't auto-rebase — the right resolution is human judgment about which side wins on each conflicting field. The `POST /api/v2/features/<id>/revisions/<version>/rebase` endpoint exists and accepts `conflictResolutions: { <field>: "overwrite" | "discard" }`; a future, more aggressive version of this skill could offer auto-rebase as an opt-in. v1 stays conservative.

### 6. Report

Print a summary:

- Flag ID and action taken.
- Rule ID (for add/edit/remove paths) and scope.
- Revision version + status (`draft` if not published, `published` if published).
- **If a rule's type auto-flipped** (force ↔ rollout via coverage change), state both the old and new type explicitly so the user isn't surprised.
- For env-toggle: name the environment and the new state.
- For remove of an experiment-ref rule: note that the linked experiment isn't affected.
- UI link: `<host>/features/<flag-id>` — derive `<host>` from `GB_API_URL` by swapping `api.` → `app.` (matches `experiment-launch`'s convention; on the default cloud host this produces `https://app.growthbook.io`).

## Guardrails

- **Only drafts can be mutated.** The server enforces this — every add/edit/remove/toggle handler throws `Cannot edit a revision with status "<X>"` if the revision isn't a draft. Use `version: "new"` for atomic draft-create-or-reuse.
- **`version: "new"` is the canonical pattern.** Don't manually `POST /revisions` first and then mutate by version number — the magic version handles it via `resolveOrCreateRevision` server-side.
- **Rule ID is required for edit/remove.** Server identifies rules by their string UUID, not by position. Always fetch the flag and resolve interactively; never guess.
- **`force` vs `rollout` is mostly cosmetic.** Per the docs, a force rule with coverage < 1 is a rollout. Default to `force` unless the user explicitly says "rollout" or specifies a percentage; the server will auto-flip type based on effective coverage anyway.
- **Conditions are JSON strings.** The server validates them via `validateRuleConditions`. Prefer Saved Groups over hand-written conditions — the user describes "beta testers" once and the saved group does the work; hand-written conditions are an active rewrite risk. Don't fabricate a condition you don't understand.
- **`coverage < 1` requires `hashAttribute`.** Server-side validation; pre-empt by asking when coverage is specified.
- **Scope: exactly one of `allEnvironments: true` or `environments: [...]`.** Don't send both. When changing scope on edit, always send both fields together so the intent isn't ambiguous — sending only `environments` without `allEnvironments` causes the server to infer `allEnvironments: false`, silently narrowing scope.
- **experiment-ref edit boundaries** (mirror what the server actually does):
  - Server-rejected: `value`, `coverage`, `controlValue` on experiment-ref rules. Halt early.
  - Skill-gated (warn-and-confirm): `experimentId`, `variations`. API allows them but they cause silent flag/experiment drift; require explicit confirmation.
  - Safe to edit: `enabled`, `condition`, `savedGroups`, `prerequisites`, scope, `description`.
- **Rule-type changes are bimodal.**
  - Explicit `type` changes via PATCH are server-rejected. Halt and direct the user to remove-and-re-add.
  - `force` ↔ `rollout` auto-flips implicitly based on effective coverage after patch. Surface the transition in the post-edit report.
- **Refuse empty patches.** On the edit path, if the user's proposed changes match the existing values verbatim, halt before POSTing. A no-op revision update burns rate limit, generates an audit entry, and can invalidate previously-granted review approvals.
- **New rules append to the bottom of the rules array.** Rules evaluate top-to-bottom; first match wins. If a flag already has rules, the new one only matters when no earlier rule matches. Surface this *before* posting. Rule reordering is out of scope; route to the UI if the user needs to move a rule earlier.
- **Self-approval is blocked.** Server-side. Don't attempt `submit-review` after `request-review`.
- **Approval-required path: don't silently retry publish.** Same three-option branch as `experiment-launch` step 6a. Never default to bypassing. This branch can fire for any mutation — including env-toggle and rule removal — not just rule adds.
- **Don't auto-rebase on merge conflicts.** A 409 on publish means the draft's base revision is stale. Halt with the conflict info and direct the user to the UI. The `rebase` endpoint exists but resolution requires per-field human judgment we can't safely automate.
- **`valueType` mismatch is a footgun.** The v2 rule-add handler doesn't validate value-vs-valueType match at write time. Pre-validate client-side using the flag's `valueType` captured in step 1 — booleans must be `"true"`/`"false"`, numbers must parse, JSON must parse.
- **safe-rollout is out of scope for add/edit.** Halt with a UI link if the user asks. **Remove is supported** — the server cleans up the SafeRollout entity when the rule is still in draft and the rollout hasn't started.
- **Holdouts aren't a concern for non-experiment-ref rules.** The server's holdout logic is gated to experiment-ref; force/rollout rules bypass it entirely.
- **Permission distinction.** The rule endpoints check `canUpdateFeature AND canManageFeatureDrafts`. A 403 here may mean "your key can manage features but not drafts," not "your key is invalid." If gb-call surfaces a generic auth error and the user's key works elsewhere, this is the likely cause — direct them to a PAT with the right permissions.
- **Ramp schedules and rule reordering are out of scope for v1.** Don't accept `rampSchedule` or `schedule` fields from the user; manage in the UI for now.

## Endpoints used

- `GET /api/v2/features/<id>` — fetch flag state, current rules, env list, valueType, holdout
- `GET /api/v1/attributes` — pick `hashAttribute` for rollouts; confirm attribute names for conditions
- `GET /api/v1/saved-groups` — surface saved groups for targeting
- `POST /api/v2/features/<id>/revisions/new/rules` — add rule, atomic draft+mutate
- `PUT /api/v2/features/<id>/revisions/new/rules/<rule-id>` — edit rule, atomic
- `DELETE /api/v2/features/<id>/revisions/new/rules/<rule-id>` — remove rule, atomic
- `POST /api/v2/features/<id>/revisions/new/toggle` — env-toggle (body: `{environment, enabled}`)
- `POST /api/v2/features/<id>/revisions/<version>/publish` — publish; same approval-required + merge-conflict failure modes as `experiment-launch`
- `POST /api/v2/features/<id>/revisions/<version>/request-review` — used only in the 5a "request review" path

## Handoffs

- `flag-create` — for creating a new flag.
- `experiment-launch` — for adding an `experiment-ref` rule (that's a launch operation, not a targeting edit). The experiment is the source of truth.
- `experiment-stop` — natural caller of this skill when cleaning up an `experiment-ref` rule after a stopped test.
- `flag-discovery` — if the user only has a flag description, route there first to resolve the ID.
- Manual UI steps (no skills yet): rule reordering, safe-rollout add/edit, flag deletion — all at `<host>/features/<flag-id>`.
