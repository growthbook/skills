---
name: experiment-launch
description: Launch a GrowthBook A/B test end-to-end via the REST API — create the experiment, wire the delivery (a feature-flag experiment-ref rule, or a Visual Editor changeset described in plain English), and start the experiment. Use when the user says "launch this experiment", "create the experiment", "wire up the A/B test", "kick off the test", "set up X as an experiment in GrowthBook", "start the experiment for flag Y", "I already have a flag and want to run an experiment on it", "A/B test this page", "test a shorter headline on our pricing page", or "try a green CTA". Works experiment-first (creates the flag), flag-first (detects the existing flag via the reuse path), and draft-first (adopts an existing draft, including one made in the Visual Editor extension). For designing the spec first, use experiment-design. For stopping a running experiment, use experiment-stop. For interpreting results, use experiment-analyze.
---

# experiment-launch

Launch a GrowthBook A/B test end-to-end: create the experiment in draft (or adopt an existing draft), wire the delivery — either a feature-flag `experiment-ref` rule on a fresh draft revision, or a Visual Editor changeset whose variations you describe in plain English — then check the pre-launch checklist and call `/start`. Handles the approval-required and checklist failure paths.

## Contents

- Required inputs
- Optional inputs
- Workflow
  - 1. Pick a template (or skip)
  - 2. Resolve hash attribute → datasource → assignment query → metrics
  - 3. Create the experiment in draft (or adopt an existing draft)
  - 4. Delivery — 4A feature flag, or 4B Visual Editor
  - 5. Check the pre-launch checklist and pause for QA
  - 6. Start the experiment
  - 7. Report
- Guardrails
- Endpoints used
- Handoffs

## Required inputs

Collect from the user (or earlier skill output) before starting. Prompt for what's missing.

- **Delivery** — `flag` or `visual`. **Infer it; don't ask unless neither signal is present.** If the app's source code is in the working tree, or the user names a flag, it's `flag`. If the user names a page URL on a site whose code they don't control (Webflow, a marketing CMS, a third-party storefront), it's `visual`. Prefer `flag` whenever the change can live in code — it renders without flicker, survives redesigns, and is analyzable like any other flag.
- **Experiment name** — human-readable
- **Variations** — length ≥ 2. The first entry is the **control**.
  - `flag`: array of `{name, value}`. Values are serialized as strings on the rule (booleans → `"false"`/`"true"`, numbers → `"42"`, JSON → JSON-encoded string).
  - `visual`: array of `{name, change}` where `change` is a plain-English description of *what* and *where* ("shorter, more urgent hero headline", "swap the primary CTA to green") — not how. Control has no change. You do NOT need CSS selectors, JavaScript, or generated images; GrowthBook produces all of that from the description.
- **Feature flag name** (`flag` only) — kebab-case key, regex `[a-zA-Z0-9_-]`
- **Page URL** (`visual` only) — a single publicly accessible page, no wildcards. GrowthBook fetches it to ground the DOM changes.
- **Project ID** (optional) — pins the experiment (and flag) to a specific project

## Optional inputs

- **Hypothesis** — falsifiable; if/then/because format
- **Template description** — English description matched against `templateMetadata.name`/`description` returned by `/v1/experiment-templates`. If omitted and templates exist, ask the user to pick one or skip.
- **Existing draft experiment ID** — if the user already has a draft (e.g. one created from the Visual Editor extension, or a previous run of this workflow that stopped early), pass it and step 3 adopts it instead of creating a new one.

If no template is used, also collect (or resolve interactively in step 2):

- **Datasource** — id or English name
- **Hash attribute** — the unit of randomization (`id`, `device_id`, etc.). Must equal the `identifierType` of the assignment query selected on the datasource.
- **Assignment query** — id or English name; lives inside the chosen datasource's `assignmentQueries`
- **Goal metric ID** — exactly one (the primary KPI you'd ship or kill on)
- **Secondary metric IDs** — supporting metrics
- **Guardrail metric IDs** — defensive metrics that should not regress

## Workflow

Track progress with this checklist. Do not skip or reorder.

```
- [ ] 1. Pick a template (or skip)
- [ ] 2. Resolve hash attribute → datasource → assignment query → metrics (no-template path only)
- [ ] 3. Create the experiment in draft (or adopt an existing draft)
- [ ] 4. Delivery: 4A create/reuse the flag + add the experiment-ref rule, or 4B create the visual changeset + describe each variation
- [ ] 5. GET the start checklist; prompt user to QA the experiment and its delivery
- [ ] 6. POST /start; branch to 6a (approval) or 6b (checklist) on 400
- [ ] 7. Report links and state
```

### 1. Pick a template (or skip)

```bash
gb-call GET /api/v1/experiment-templates
```

- **Zero templates** → continue without one; go to step 2.
- **One or more** → list as `name — description` plus a final "Skip" option. If a template description was provided, pre-select the best match by `templateMetadata.name`/`description` and confirm. Never invent a template.

If chosen, capture: `id` (becomes `templateId`), `datasource`, `exposureQueryId`, `hashAttribute`, `goalMetrics`, `statsEngine`, `targeting`. Templates inject all of these; skip step 2 entirely — **unless you are adopting an existing draft** (step 3-alt), where the update endpoint has no `templateId` and you must send the template's fields explicitly.

If the template's `type` is `"multi-armed-bandit"`, halt and confirm with the user. Bandits behave very differently from standard A/B tests (dynamic traffic allocation, per-arm probabilities instead of winner/loser, different analysis), and this skill's launch and analysis assumptions are written for `type: "standard"`. Recommend they configure bandits in the UI for now.

### 2. Resolve hash attribute → datasource → assignment query → metrics

No-template path only. Order matters — pick hash attribute first so you don't trap yourself on a datasource that can't randomize on it.

**2a. Pick the hash attribute.** Filter to attributes flagged as hashAttribute:

```bash
gb-call GET /api/v1/attributes
```

Surface attributes where `hashAttribute === true` and `archived !== true`. Ask the user to pick. If the filtered list is empty, halt — tell the user to mark at least one attribute as a hash attribute under **Settings → Attributes** in GrowthBook.

**2b. Pick the datasource.**

```bash
gb-call GET /api/v1/data-sources
```

Resolve English name or ID against `dataSources[].name` / `id`. Capture `DATASOURCE_ID` and keep the full object — 2c reads its `assignmentQueries`.

**2c. Pick the assignment query.** Filter `dataSources[].assignmentQueries` to entries where `identifierType === HASH_ATTRIBUTE`:

- **Exactly one match** → auto-select it; print one line stating the choice.
- **Zero matches** → halt and offer three fixes: pick a different datasource (rerun 2b), change the hash attribute (rerun 2a), or add an assignment query for `<HASH_ATTRIBUTE>` in GrowthBook.
- **Two or more** → list each as `name (identifierType=<value>) — <description>` and let the user pick.

If `assignmentQueries` is empty entirely, halt and tell the user to configure one in GrowthBook before re-running.

**2d. Pick metrics, filtered by datasource.** The API rejects metrics from a different datasource than the experiment's:

```bash
gb-call GET '/api/v1/fact-metrics?datasourceId=<DATASOURCE_ID>&limit=100'
gb-call GET '/api/v1/metrics?datasourceId=<DATASOURCE_ID>&limit=100'
```

Help the user pick:

- **Goal metric(s)** (`GOAL_METRIC_IDS`). Ideally one, two max — push back at three or more and demote the rest to secondary or guardrail.
- **Secondary metrics** (`SECONDARY_METRIC_IDS`) — supporting context.
- **Guardrail metrics** (`GUARDRAIL_METRIC_IDS`) — defensive. Push back if they name none; every experiment needs at least one. Guardrails are excluded from multiple-comparison correction by design.

### 3. Create the experiment in draft (or adopt an existing draft)

**If an existing draft experiment ID is in context, skip to 3-alt.**

Set `trackingKey` to the feature flag name (`flag`) so the SDK ties exposures to the flag, or to a kebab-case slug of the experiment name (`visual`). Each variation needs a stable string `key` (`"0"`, `"1"`, ...) and `name`. Variation values (`flag`) or changes (`visual`) live on the delivery in step 4, not on the experiment payload.

**Template path** — do NOT also send `datasourceId` / `assignmentQueryId`; the template provides them and the API rejects the combination.

```json
{
  "templateId": "<from step 1>",
  "trackingKey": "<flag-name or kebab-experiment-name>",
  "name": "<experiment name>",
  "hypothesis": "<hypothesis>",
  "variations": [
    { "key": "0", "name": "Control" },
    { "key": "1", "name": "Treatment" }
  ],
  "project": "<project id, omit if org-wide>"
}
```

**No-template path** — send everything from step 2 explicitly:

```json
{
  "datasourceId": "<DATASOURCE_ID>",
  "assignmentQueryId": "<ASSIGNMENT_QUERY_ID>",
  "hashAttribute": "<HASH_ATTRIBUTE>",
  "trackingKey": "<flag-name or kebab-experiment-name>",
  "name": "<experiment name>",
  "hypothesis": "<hypothesis>",
  "variations": [
    {"key": "0", "name": "Control"},
    {"key": "1", "name": "Treatment"}
  ],
  "metrics": ["<GOAL_METRIC_ID>"],
  "secondaryMetrics": [<SECONDARY_METRIC_IDS as JSON array>],
  "guardrailMetrics": [<GUARDRAIL_METRIC_IDS as JSON array>],
  "project": "<project id, omit if org-wide>"
}
```

Notes:

- `metrics` is the goal-metric array; with the one-goal rule it should always be length 1.
- Omit `secondaryMetrics` / `guardrailMetrics` entirely if the user picked none. Don't send empty arrays.
- A duplicate `trackingKey` returns a 400 naming the clash; pick another key rather than sending `bypassDuplicateKeyCheck`.

Then POST:

```bash
echo '<payload-json>' | gb-call POST /api/v1/experiments -
```

Capture from the response:

- `experiment.id` — used in steps 4 and 6.
- `experiment.variations[].variationId` — the **string ID** for each variation (e.g. `var_abc123`). Step 4 needs these: they are required on the `experiment-ref` rule and are how `ai/edit` addresses a variation.

#### 3-alt. Adopt an existing draft

```bash
gb-call GET /api/v1/experiments/<exp_id>
```

- `status` must be `draft`; otherwise halt (running/stopped experiments are `experiment-analyze` / `experiment-stop` territory).
- Capture `variations[].variationId`, `hashAttribute`, `hasVisualChangesets`, and `linkedFeatures`.
- **If `datasource` is empty** — the usual state for a draft made in the Visual Editor extension — fill it in. The update endpoint takes no `templateId`, so run step 2 (or read the chosen template's `datasource`, `exposureQueryId`, `goalMetrics` from step 1) and send the fields explicitly:

```bash
echo '{
  "datasourceId": "<DATASOURCE_ID>",
  "assignmentQueryId": "<ASSIGNMENT_QUERY_ID>",
  "hashAttribute": "<HASH_ATTRIBUTE>",
  "metrics": ["<GOAL_METRIC_ID>"],
  "secondaryMetrics": [...],
  "guardrailMetrics": [...]
}' | gb-call POST /api/v1/experiments/<exp_id> -
```

`datasourceId` can only be set while the experiment has none; once set it cannot be changed via the API. Metrics can also be added or changed later with the same call, including after the experiment is running.

- **If `datasource` is already set**, only send the metrics fields that are missing or that the user wants changed.

### 4. Delivery

Branch on **Delivery**.

#### 4A. Feature flag

**Try create first** unless the user said the flag already exists. The flag must default to the **control** value (variation 0's value), serialized as a string. Default all environments to off as well.

```json
{
  "id": "<flag-name>",
  "valueType": "<boolean|string|number|json>",
  "defaultValue": "<control value as string>",
  "description": "Drives experiment: <experiment name> (<exp_id>)",
  "project": "<project id, omit if org-wide>"
}
```

```bash
echo '<payload-json>' | gb-call POST /api/v2/features -
```

- **Success** → add the rule below.
- **409 Conflict** (flag exists) → fall through to the reuse compatibility checks.

**Reuse path — fetch and validate:**

```bash
gb-call GET /api/v2/features/<flag-name>
```

Run these compatibility checks against the response. Each row says what to do on failure:

| Check                                                                                              | Action on failure                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archived === false`                                                                               | **Halt.** Tell the user to un-archive the flag in the UI before re-running.                                                                              |
| `valueType` matches the experiment's `<boolean\|string\|number\|json>`                             | **Halt.** Surface both values; do not silently change types.                                                                                             |
| `project` matches the experiment's project (when set)                                              | **Halt.** Reusing a flag from another project misroutes the experiment.                                                                                  |
| `defaultValue` equals the control value (string-compared)                                          | **Warn**, do not halt. The experiment rule supplies the variation values; the existing default applies only when the rule doesn't match. Ask "continue?" |
| No existing rule with `type === "experiment-ref"` AND `experimentId === <exp_id>` already attached | If one exists → this experiment is already wired up. Skip the rule step and jump to step 5.                                                              |
| No conflicting `experiment-ref` rule for another _running_ experiment in the same environments     | **Warn**, do not halt. Ask "this flag is currently driving experiment `<other_id>`; add another rule alongside it?"                                      |

When all checks pass, capture the flag's identity and continue. Do **not** mutate the existing flag here — all mutations go through the draft revision below.

**Add the experiment-ref rule on a fresh draft revision.** Use the literal version `new` to create a draft and add the rule in one call. The path segment `new` is a magic value that creates a draft branched off the live revision atomically. If the feature has multiple environments, prompt the user for which environments to go live in, and ensure this rule turns on the feature flag for those environments in addition to adding the rule to those environments.

```json
{
  "rule": {
    "type": "experiment-ref",
    "experimentId": "<exp_id from step 3>",
    "enabled": true,
    "allEnvironments": true,
    "variations": [
      {
        "value": "<variation 0 value as string>",
        "variationId": "<var_id from step 3, position 0>"
      },
      {
        "value": "<variation 1 value as string>",
        "variationId": "<var_id from step 3, position 1>"
      }
    ],
    "description": "Experiment: <experiment name>"
  }
}
```

```bash
echo '<payload-json>' | gb-call POST /api/v2/features/<flag-name>/revisions/new/rules -
```

`variations[]` must have one entry per experiment variation, in the same order as step 3. Each entry needs **both** `value` (serialized as a string) and `variationId` (the string ID captured in step 3) — `variationId` is required by the v2 features validator and omitting it returns a `400`. Capture the returned `version` for the draft revision.

Do **not** publish the revision here. Step 6's `/start` call auto-publishes the draft when it flips the experiment to running.

#### 4B. Visual Editor

These `/visual-editor/*` endpoints need a **Personal Access Token**; an org Secret Key is rejected with a message about attribution. Route to **gb-setup** rather than treating it as a permissions problem. `ai/edit` requires the organization to opt-in to AI features on **Settings → AI** before use.

**4B-i. Check for a collision on the same page.**

```bash
gb-call GET /api/v1/visual-editor/bootstrap
```

If a `recentExperiments[]` entry has a `primaryUrl` matching the page URL and a `status` of `draft` or `running`, **warn** (don't halt): two visual experiments on one page interfere with each other. Continue only if the user confirms.

**4B-ii. Create the changeset** (skip if the draft already has `hasVisualChangesets: true` — then `GET /api/v1/experiments/<exp_id>/visual-changesets`, reuse it, and ask which one if there are several):

```bash
echo '{
  "editorUrl": "https://example.com/pricing",
  "urlPatterns": [
    { "type": "simple", "pattern": "https://example.com/pricing", "include": true }
  ]
}' | gb-call POST /api/v1/experiments/<exp_id>/visual-changesets -
```

`editorUrl` is the single page GrowthBook fetches to construct DOM mutations. `urlPatterns` decides which pages are *in* the experiment: default to the page URL with query string and hash stripped — if you include them, only users with those exact parameters are bucketed. Host matching is exact (`example.com` does not match `www.example.com`). A `simple` pattern supports `*` wildcards (e.g. `https://example.com/blog/*`) when the same change should run on many pages.

The response seeds one empty visual change per variation. Capture `visualChangeset.id`.

**4B-iii. Describe each variation.** One call per non-control variation — it generates *and* saves. Leave Control alone.

```bash
echo '{
  "prompt": "<the variation'"'"'s change description>",
  "variationId": "<variationId from step 3>",
  "visualChangesetId": "<visualChangeset.id>",
  "persist": true
}' | gb-call POST /api/v1/visual-editor/ai/edit -
```

The field is **`variationId`** (the `var_...` string from step 3), not the variation `key`; anything else returns `variationId does not belong to the given changeset`.

From the response: show `explanation`; confirm `saved: true` and a `visualChangeId`, whose absence means nothing was written; summarise `mutations`/`css`/`js` rather than dumping them; surface `warnings` (capped or failed image generation — the text edits still applied).

- **Images need no extra call.** "Replace the hero image with a photo of a team collaborating" is generated, stored, and referenced inside this one request.
- **To refine**, prompt again with the same `variationId` — mutations accumulate, `css`/`js` are rewritten whole. Pass `conversationHistory` (max 12 `{"role": "user"|"assistant", "text": "..."}` turns) so "less neon" resolves against the previous turn.
- **A third variation**: `POST /api/v1/visual-editor/add-variant` with `{"visualChangesetId": "<id>"}`, then prompt its `newVariationId`.
- **Grounding is best-effort and silent.** If GrowthBook can't fetch or parse the page (login wall, client-rendered app, redirect), it still attempts changes blind (e.g. assuming an `h1` exists). The user must preview before starting.

Preview link for the user: `<page URL>?gb-visual-editor-v2=<visualChangeset.id>` (requires the Visual Editor Chrome extension).

### 5. Check the pre-launch checklist and pause for QA

Everything so far is reversible; step 6's `/start` publishes the flag rule (`flag`) or makes the visual changes live (`visual`) and flips the experiment to running.

```bash
gb-call GET /api/v1/experiments/<exp_id>/start-checklist
```

- `status: "ready"` → proceed to QA below.
- `status: "notReady"` → list every `checklistItems[]` entry with `required: true` and `status: "incomplete"`, with its `reason`. Items with `manual: true` are custom checklist tasks the org defined; once the user confirms each is genuinely done, mark them:

```bash
echo '{"keys": ["<task key>", ...]}' | gb-call POST /api/v1/experiments/<exp_id>/start-checklist/manual/complete -
```

Anything else (a linked-feature merge conflict, a pending approval, unrelated draft changes) has to be fixed in the GrowthBook UI; items with `hardBlock: true` can't be bypassed even with `skipChecklist`. Re-run the GET after fixes.

If the user seems to want you to also embed the feature flag in the codebase (`flag`), now is a good time to do that.

Stop and surface the UI links so the user can QA:

- Experiment (targeting, metrics): `/experiment/<exp_id>`
- `flag`: the flag default and the rule's variation values at `/features/<flag-name>?v=<version>`
- `visual`: the preview link from 4B-iii, and remind them that **visual changes render on the live site only if an SDK Connection has "Include Visual Experiments" enabled** — the checklist checks that a connection exists, not that this box is ticked, and it's the most common reason a visual test appears to do nothing.

Wait for the user's explicit go-ahead before proceeding to step 6.

### 6. Start the experiment

```bash
gb-call POST /api/v1/experiments/<exp_id>/start '{}'
```

The `/start` endpoint does two things server-side:

1. Publishes any pending draft feature revision from step 4A (`publishPendingFeatureDraftsForExperiment`). No-op for `visual`.
2. Enforces the org's pre-launch checklist.

Either can fail with a `400`. Branch:

- Body starts with **"This revision requires approval before publishing"** → step 6a.
- Body lists incomplete checklist items → step 6b.
- `2xx` → step 7.

#### 6a. Approval required

The experiment and flag exist; only the rule revision is stuck in draft. Halt and offer the user three concrete paths:

> Your org requires approval before this feature flag rule can go live, and `/start` will not flip the experiment to running until the rule is published. Revision `<version>` on `<flag-name>` is in draft state. Pick one:
>
> **A. Standard review flow** (recommended) — I'll request a review now. A teammate (not you, since you created the draft) approves it in the GrowthBook UI at `/features/<flag-name>?v=<version>`, then you re-run me and I'll resume from `/start`.
>
> **B. Org-wide bypass** — an admin enables "REST API always bypasses approval requirements" in **Settings → General → Approvals**. After that, re-run me.
>
> **C. Per-token bypass** — use a Personal Access Token whose role grants `bypassApprovalChecks` on this project (Admin or custom role). Update `GB_API_KEY`, then re-run me.

If the user picks **A**, request review on the draft and stop:

```bash
echo '{"comment":"Auto-requested by experiment-launch for <exp_id>"}' \
  | gb-call POST /api/v2/features/<flag-name>/revisions/<version>/request-review -
```

Do **not** attempt `submit-review` yourself — the API rejects self-approval on a draft you created. Stop and tell the user to re-run after approval.

If the user picks **B** or **C**, stop with a one-line note. The existing draft will pick up the new permission and publish on retry.

Do **not** silently retry `/start`, ignore the error, or discard and recreate the draft to work around the policy.

#### 6b. Checklist incomplete

Something changed since step 5 (or step 5 was skipped). Re-run the checklist GET and surface the incomplete items verbatim:

> The pre-launch checklist isn't complete:
>
> `<each incomplete required item: key — reason>`
>
> Fix the listed items in the GrowthBook UI at `/experiment/<exp_id>`, then re-run me — I'll jump straight back to `/start`.

Only retry `/start` with `{"skipChecklist": true}` in the body if the user **explicitly** asks to bypass. Never default to bypassing; the checklist is intentional friction. `hardBlock` items are not bypassable at all.

### 7. Report

Print a summary:

- Experiment name and `id`
- Delivery:
  - `flag`: feature flag ID and published revision version
  - `visual`: visual changeset ID and the URL pattern(s) it runs on
- Template used (name + id) if any
- Unit of randomization (`hashAttribute`)
- Variations and their values (`flag`) or change descriptions (`visual`)
- Pre-launch checklist status (should be `ready`)
- Experiment status (should be `running` after a clean `/start`)
- Direct UI paths:
  - Experiment: `/experiment/<exp_id>`
  - Feature (`flag`): `/features/<flag-name>`

## Guardrails

- **Ideally one goal metric, two max.** GrowthBook's decision framework treats goal metrics as plural by design and the power calculator supports up to five, but each additional goal dilutes power and complicates the ship/kill decision. Push back at three or more; demote the rest to secondary.
- **At least one guardrail.** Push back if the user skips guardrails.
- **`hashAttribute` and `assignmentQuery.identifierType` must match.** Mismatch is a real and recoverable error; surface the fix paths in step 2c.
- **Metrics must live on the experiment's datasource.** Filter `/v1/metrics` and `/v1/fact-metrics` by `datasourceId` in step 2d.
- **Do NOT mix `templateId` with `datasourceId`/`assignmentQueryId`.** The template path supplies those; the no-template path supplies them explicitly. Mixing yields a `400`.
- **`templateId` is create-only.** The update endpoint (`POST /experiments/<id>`) has no `templateId`; when adopting a draft, send the template's datasource, assignment query, and metrics as explicit fields. `datasourceId` is settable only while the draft has none.
- **Prefer a flag when you control the code.** The Visual Editor is for pages you can't ship code to. A change that could live in source belongs behind a flag — no flicker, no dependence on the page's DOM staying put.
- **Flag default = control value.** Variation values for flag-linked experiments are strings on the rule — `"false"`/`"true"` for booleans, `"42"` for numbers, JSON-encoded text for `json`.
- **Reuse with care.** Always run the 4A compatibility checks before reusing an existing flag. Silently attaching to a flag with the wrong `valueType`, wrong `project`, or a conflicting rule will break the experiment or step on a teammate's in-flight test.
- **No manual revision publish.** The 4A draft is published by `/start` in step 6. Do not call publish endpoints separately.
- **Approval failures: do not self-approve.** The API blocks approval on drafts you created. Walk the user through 6a instead.
- **Checklist failures: do not bypass by default.** Only set `skipChecklist: true` after the user explicitly opts in, and it never clears `hardBlock` items.
- **`/visual-editor/*` needs a PAT.** An org Secret Key works everywhere else in this domain and is rejected here — route to **gb-setup**.
- **Only drafts accept visual changes.** `ai/edit` with `persist` rejects running or stopped experiments; the user returns the experiment to draft in GrowthBook to edit.
- **Visual grounding is best-effort and silent.** If the page can't be fetched or parsed, GrowthBook still writes DOM changes blind. The user previews before `/start`, every time.
- **Visual caps:** 8000 characters per `prompt`, 3 images per prompt, 60 requests/minute, plus a daily AI cap on Cloud.

## Endpoints used

- `GET /api/v1/experiment-templates` — list templates
- `GET /api/v1/attributes` — filter to `hashAttribute=true`
- `GET /api/v1/data-sources` — pick datasource and assignment query
- `GET /api/v1/fact-metrics?datasourceId=…`, `GET /api/v1/metrics?datasourceId=…` — pick goal / secondary / guardrail
- `POST /api/v1/experiments` — create the draft experiment
- `GET /api/v1/experiments/<id>` — read an existing draft (3-alt)
- `POST /api/v1/experiments/<id>` — fill in datasource / assignment query / metrics on an adopted draft (3-alt)
- `POST /api/v2/features` — create the linked feature flag (4A, when not reusing)
- `GET /api/v2/features/<id>` — fetch the flag for the reuse compatibility checks (4A)
- `POST /api/v2/features/<id>/revisions/new/rules` — atomic draft + add experiment-ref rule (4A)
- `GET /api/v1/visual-editor/bootstrap` — recent visual experiments for the same-page collision check (4B, PAT)
- `POST /api/v1/experiments/<id>/visual-changesets` — create the changeset for the page (4B)
- `GET /api/v1/experiments/<id>/visual-changesets` — reuse an existing changeset on an adopted draft (4B)
- `POST /api/v1/visual-editor/ai/edit` — plain-English prompt to saved visual change, with `persist: true` (4B, PAT)
- `POST /api/v1/visual-editor/add-variant` — a third or later variation (4B, PAT)
- `GET /api/v1/experiments/<id>/start-checklist` — pre-flight before `/start`; items carry `required`, `manual`, `hardBlock`
- `POST /api/v1/experiments/<id>/start-checklist/manual/complete` — mark manual custom checklist items done, body `{"keys": [...]}`
- `POST /api/v2/features/<id>/revisions/<version>/request-review` — used only in the 6a "request review" path
- `POST /api/v1/experiments/<id>/start` — publish the pending draft revision (if any) and start the experiment. Body accepts `{"skipChecklist": true}` to bypass non-`hardBlock` checklist items when the user explicitly opts in.

## Handoffs

- `references/experiment-design.md` — if no spec exists, route back here first.
- the **feature-flags** skill (`flag-search` workflow) — to find an existing flag ID when you only have a name or description.
- `references/experiment-analyze.md` — after the experiment is running and traffic accumulates.
- `references/experiment-stop.md` — when results are settled.
- Manual metric creation — if a metric you need doesn't exist yet, the user must create it in the GrowthBook UI at `/metrics` (or `/fact-tables` for fact metrics) before re-running this skill. No skill for that yet.
