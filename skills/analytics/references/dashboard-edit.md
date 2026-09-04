---
name: dashboard-edit
description: Change a GrowthBook Analytics dashboard that already exists — add or remove a chart, swap a metric, change the timeframe, rename it, or re-scope it. Use when the user asks to "add a chart to this dashboard", "remove that block", "change the dashboard to last 90 days", "rename this dashboard", or refers to a dashboard they are already looking at. For building one from scratch, use dashboard-create.
---

# dashboard-edit

Read a dashboard, apply the change, and write the whole thing back. An update replaces the dashboard's block list outright, so the list you send is the dashboard the user ends up with — every tile being kept, not just the one that changed.

Read-then-write is not optional here. Sending a block list assembled from memory is how a tile the user still wants gets deleted.

## Contents

- Workflow
  - 1. Resolve the dashboard
  - 2. Read it
  - 3. Apply the change
  - 4. Write it back
- What each field does when omitted
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

A dashboard with an `experimentId` belongs to that experiment and is edited on the experiment's own page. Say so and stop rather than writing to it.

### 2. Read it

```bash
gb-call GET /api/v1/dashboards/<id>
```

Capture `title`, `projects`, `globalControls`, `comparison`, and the full `blocks` array. Each stored block carries `id`, `uid`, `organization`, `layout`, and — on a chart block — `explorerAnalysisId` and `config`.

### 3. Apply the change

Start from the blocks you just read and change only what was asked. For every block you are keeping, **send it back exactly as it came**, including `id`, `uid`, `organization`, `layout`, and `explorerAnalysisId`. That is what preserves the tile's identity, its position, and its last result.

| Change | What to do |
| --- | --- |
| Add a tile | Append a new block with `type`, `title`, `description`, `config`, and a `layout` placing it below the others. Omit `explorerAnalysisId` — the write runs the chart. |
| Remove a tile | Leave it out of the array. |
| Reorder or resize | Change the `layout` on the blocks involved. |
| Reconfigure a chart | Change its `config` **and drop its `explorerAnalysisId`**, so the write re-runs it. Keeping the old id leaves the tile showing the old numbers. |
| Rename the dashboard | Send `title`. |
| Change the timeframe | Send `globalControls.dateRange`. |
| Turn comparison on | Send `comparison`. |

**`markdown` blocks on a saved dashboard are the user's words.** Carry every one through verbatim and in place, however many there are. Add or reword one only when the user asks — a dashboard with none may well have had one removed on purpose. If your change leaves a legend describing a chart that is gone, say so in your reply and offer to update it, leaving their words as they are.

For block shapes, the config schema, and the layout arithmetic, read `references/dashboard-create.md`.

### 4. Write it back

```bash
echo '<update-json>' | gb-call PUT /api/v1/dashboards/<id> -
```

```json
{
  "globalControls": { "dateRange": { "predefined": "last90Days" } },
  "blocks": ["...the full list, kept blocks unchanged..."]
}
```

Show the user what changes before the PUT: which tiles are being added, which removed, and which settings altered. Then report what changed in a sentence.

## What each field does when omitted

Every field on an update is optional, and leaving one out keeps the saved value. That makes a narrow change genuinely narrow — a timeframe change needs `globalControls` alone.

The exception is `blocks`. Send it and it replaces the list; omit it and every tile is left alone.

**Carry a tile you are not changing as `{ "id": "dshblk_…" }`.** The list still defines membership and order, so a tile you leave out is deleted — but a tile you are keeping needs nothing but its id. Only write out a block in full when you are adding it or changing it. Copying a saved tile back verbatim is a transcription job with nothing to gain and a metric id to get wrong.

Adding one chart to a five-tile dashboard is therefore five refs and one new block:

```json
{
  "blocks": [
    { "id": "dshblk_a" },
    { "id": "dshblk_b" },
    { "id": "dshblk_c" },
    { "id": "dshblk_d" },
    { "id": "dshblk_e" },
    { "type": "metric-exploration", "title": "Revenue per User — past 6 months", "description": "", "layout": { "x": 0, "y": 24, "w": 24, "h": 8 }, "config": { "…": "…" } }
  ]
}
```

An id that is not on the dashboard is rejected, so a mistyped ref fails the write instead of quietly dropping a tile.

Changing `globalControls.dateRange` re-runs every chart enrolled in it, against the new range. A dashboard with many tiles is many warehouse queries, so change the date range only when that is what the user asked for.

## Guardrails

- **Read before you write.** Always `GET` the dashboard in the same turn as the `PUT`. A block list built from an earlier read, or from the create call you made, can be stale.
- **Send the full block list, or none.** A partial list deletes the tiles it omits.
- **Carry an unchanged tile by id alone.** `{ "id": "dshblk_…" }` keeps it exactly as saved. When you do send a block in full because you changed it, keep its `id` and `layout` — a block sent without an id is treated as new, so it gets a fresh one, loses its position, and the tile the user had is gone.
- **Drop `explorerAnalysisId` only when you changed that chart's `config`.** Dropping it otherwise re-runs a query for nothing; keeping it after a config change shows numbers that do not match the tile.
- **Summarize the delta, then get a yes.** State what changes, not what the dashboard ends up as: tiles added, tiles removed, tiles whose config moved, and anything dashboard-wide such as the date range. Name removals explicitly — that is the change a user is most likely to have meant differently. Tiles carried through untouched need no mention.
- **A chart that cannot run fails the whole update.** Nothing is written, and the error names the block. Fix that config and call again.
- **Leave `experimentId` out of the update.** It is rejected there, and a general dashboard has none.
- **Renaming a tile is not renaming the dashboard.** A block's `title` is the tile heading; the dashboard's `title` is the page name.

## Endpoints used

- `GET /api/v1/dashboards` — list dashboards
- `GET /api/v1/dashboards/:id` — read one, including its blocks
- `PUT /api/v1/dashboards/:id` — write the change
- `DELETE /api/v1/dashboards/:id` — delete a dashboard, when the user explicitly asks for that
- `GET /api/v1/fact-metrics` and `GET /api/v1/fact-tables/:id` — when the change needs a metric or column the conversation has not resolved

## Handoffs

- `references/dashboard-create.md` — for block shapes, config schema, and layout rules, or to build a new dashboard
- `references/analytics-explore.md` — if the user just wants to look at a chart rather than change the dashboard
- `references/metric-search.md` — to resolve a metric the change needs
