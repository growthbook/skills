---
name: dashboard-edit
description: Change a GrowthBook Analytics dashboard that already exists — add or remove a chart, swap a metric, change the timeframe, rename it, or re-scope it. Use when the user asks to "add a chart to this dashboard", "remove that block", "change the dashboard to last 90 days", "rename this dashboard", or refers to a dashboard they are already looking at. For building one from scratch, use dashboard-create.
---

# dashboard-edit

Changes go into the dashboard's **draft**, one block at a time. Viewers keep seeing the published dashboard until the draft is published, so an edit is safe to make and easy for the user to check first.

Each call changes one thing. There is no block list to send back, so a tile you do not touch cannot be lost.

## Contents

- Workflow
  - 1. Resolve the dashboard
  - 2. Open its draft
  - 3. Apply the change
  - 4. Hand it over
- Changes that are not part of the draft
- Guardrails
- Endpoints used
- Handoffs

## Workflow

### 1. Resolve the dashboard

Take the first of these that applies:

- **The dashboard the user is already working on.** Once this conversation has read or written one, every follow-up is about that one. "Remove the win-rate tile" and "make it 90 days" are about the dashboard on screen — do not ask which one, or whether to make a new one instead.
- **One the user named.** Match it in the list below.
- **A list, when the conversation has neither.**

  ```bash
  gb-call GET /api/v1/dashboards
  ```

  One clear match → use it. Several → ask which.

A dashboard with an `experimentId` belongs to that experiment and is edited on the experiment's own page. It has no draft. Say so and stop rather than writing to it.

### 2. Open its draft

```bash
gb-call GET /api/v2/dashboards/<id>/draft
```

This returns the draft, or the published content a new draft would start from. Reading never creates a draft; your first write does: `{ "draft": { "version", "title", "globalControls", "blocks": [...] } }`. Each block carries its `id`, `layout`, and — on a chart block — its `config`. Read it in the same turn you change it; block ids from an earlier turn may be gone.

### 3. Apply the change

| Change | Call |
| --- | --- |
| Add a tile | `POST /api/v2/dashboards/<id>/draft/blocks` with `type`, `title`, `description`, `config`, and a `layout` placing it below the others. Use the `description` to say what the chart shows and what to read from it. |
| Reconfigure, retitle, move or resize a tile | `PUT /api/v2/dashboards/<id>/draft/blocks/<blockId>` with the whole block: copy `type`, `title`, `description`, `layout` and `config` from the draft and apply the change. Leave out `id`, `uid`, `organization` and `explorerAnalysisId`. The chart is run again. |
| Remove a tile | `DELETE /api/v2/dashboards/<id>/draft/blocks/<blockId>` |
| Rename the dashboard | `PUT /api/v2/dashboards/<id>/draft` with `title` |
| Change the timeframe | `PUT /api/v2/dashboards/<id>/draft` with `globalControls.dateRange`. Only the nine `predefined` names are real; anything else is `customLookback`. Every chart that follows the dashboard's date range is run again. |

```bash
echo '<block-json>' | gb-call PUT /api/v2/dashboards/<id>/draft/blocks/<blockId> -
```

Draft changes need no confirmation: the draft is private to the people who can edit the dashboard. Do say what you changed once it is done.

**`markdown` blocks are the user's words.** Leave every one as it is. Add or reword one only when the user asks.

For block shapes, the config schema, and the layout arithmetic, read `references/dashboard-create.md`.

### 4. Hand it over

Report the change in a sentence: tiles added, removed or reconfigured, and anything dashboard-wide such as the date range. Say it is in the draft and that viewers still see the published version.

Publish only when the user says to:

```bash
echo '{}' | gb-call POST /api/v2/dashboards/<id>/draft/publish -
```

## Changes that are not part of the draft

Ownership, sharing and deletion act on the dashboard itself, straight away, with no draft.

- **Change the owner** — only when the user asks. `PUT /api/v1/dashboards/<id>` with `{ "owner": "<email or userId>" }` and nothing else, using exactly what the user gave. It must be an email or a `u_...` id; a bare name is rejected, so ask for the email instead of guessing one. Before sending it, tell the user who owns the dashboard now (`owner` and `ownerEmail` on `GET /api/v1/dashboards/<id>`) and who will own it after, and get a yes. Only the current owner or an admin can change it, the new owner must be a member who can manage the dashboard, and a private dashboard is visible only to its owner, so handing one over can take it out of the user's view.
- **Delete the dashboard** — `DELETE /api/v1/dashboards/<id>`, only when the user explicitly asks for that.

## Guardrails

- **Edit the draft, never the published dashboard's blocks.** Do not send `blocks`, `title` or `globalControls` to `PUT /api/v1/dashboards/<id>`. That writes straight to what viewers see and skips the draft.
- **Read the draft before you change it.** `GET` it in the same turn as the write, and take block ids from that response.
- **A block is replaced whole.** A `PUT` on a block is the full block, not a patch. Copy it from the draft and change only what was asked.
- **A chart that cannot run fails only its own call.** Nothing else in the draft changes, and the error names the field. Fix it and send that block again once. If it fails a second time, stop and tell the user rather than guessing another value.
- **A `409` means the draft was published or discarded while you were working.** `GET` the draft again to see what it holds now, and re-apply the change; the next write starts a new draft.
- **Never publish on your own.** Publishing changes what everyone with access sees. It waits for the user's word.
- **The closed `predefined` list applies twice here**: to `globalControls.dateRange` and to each block's `config.dateRange`. The names are in the router's shared conventions; anything outside them is `customLookback`, so six months is `{ "predefined": "customLookback", "lookbackValue": 6, "lookbackUnit": "month" }` in both places.
- **Charts cost money and time.** Adding or replacing a chart block runs a real warehouse query, and changing the date range re-runs every chart that follows it. Change only what the user asked for.
- **Never send `owner` unless the user asked to change the owner.** An admin's write with a wrong `owner` silently reassigns the dashboard.
- **Renaming a tile is not renaming the dashboard.** A block's `title` is the tile heading; the draft's `title` is the page name.

## Endpoints used

- `GET /api/v1/dashboards` — list dashboards
- `GET /api/v2/dashboards/:id/draft` — read the draft, or the content a new draft would start from (reading never creates one)
- `PUT /api/v2/dashboards/:id/draft` — rename, or change dashboard-wide controls
- `POST /api/v2/dashboards/:id/draft/blocks` — add one block; runs its chart
- `PUT /api/v2/dashboards/:id/draft/blocks/:blockId` — replace one block; runs its chart
- `DELETE /api/v2/dashboards/:id/draft/blocks/:blockId` — remove one block
- `POST /api/v2/dashboards/:id/draft/publish` — publish the draft, only when the user says so
- `GET /api/v1/dashboards/:id` and `PUT /api/v1/dashboards/:id` — read and change the owner, only when the user asks
- `DELETE /api/v1/dashboards/:id` — delete a dashboard, when the user explicitly asks for that
- `GET /api/v1/fact-metrics` and `GET /api/v1/fact-tables/:id` — when the change needs a metric or column the conversation has not resolved

## Handoffs

- `references/dashboard-create.md` — for block shapes, config schema, and layout rules, or to build a new dashboard
- `references/analytics-explore.md` — if the user just wants to look at a chart rather than change the dashboard
- `references/metric-search.md` — to resolve a metric the change needs
