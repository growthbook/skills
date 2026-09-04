---
name: dashboard-create
description: Build a new GrowthBook Analytics dashboard from a goal or a set of metrics — settle the brief, pick the blocks, and create it in one call. Use when the user asks to "build me a dashboard", "make a dashboard for X", "put these metrics on a dashboard", "I want to track X and Y", or "set up reporting for X". For changing a dashboard that already exists, use dashboard-edit. For a single one-off chart, use analytics-explore.
---

# dashboard-create

Create a general (Product Analytics) dashboard: a saved page of chart tiles over the metrics and fact tables the organization already has.

Chart blocks carry a `config` and nothing else. The create call runs every one of them server-side and wires the results onto the tiles, so this workflow never runs an exploration of its own — one write, one confirmation, one dashboard.

It deliberately stops at creation. Renaming, re-scoping, and adding or removing tiles afterwards belong to `dashboard-edit`.

## Contents

- Workflow
  - 1. Pick the datasource
  - 2. Settle the name and the project
  - 3. Pick the shape
  - 4. Find the metrics
  - 5. Look up columns and values
  - 6. Build the blocks
  - 7. Create the dashboard
- Block reference
- Layout
- Ask budget
- Guardrails
- Endpoints used
- Handoffs

## Workflow

### 1. Pick the datasource

Each chart carries its own `config.datasource`, so one dashboard can span several. This step picks the **default** — the source a chart uses when nothing else pins it, and the one to browse when the user named no metrics. Step 4 can add more: a named metric brings its own datasource with it. If one is already established in this conversation, reuse it.

```bash
gb-call GET /api/v1/data-sources
```

Mixpanel and Google Analytics cannot run explorations. Drop them from the list first, then count what is left:

- **0** → tell the user no chartable datasource is configured, and stop there.
- **1** → use it and say which one.
- **2+** → use the one the user named; otherwise ask.

### 2. Settle the name and the project

These are the two things the user cannot fix afterwards without a separate edit, so settle both before building.

- **Name** — use the user's own words. Ask when they gave none.
- **Project** — `gb-call GET /api/v1/projects`. None or one → send `[]` or that single id without asking. Two or more and the user named none → ask. `[]` means visible in every project.

Ask for both in one question, not two round-trips.

### 3. Pick the shape

Pick an archetype before picking blocks — one decision here replaces half a dozen field-by-field questions.

| Archetype | Blocks, in order |
| --- | --- |
| **KPI overview** | one `bigNumber` metric-exploration per metric, then one `line` trend per metric |
| **Funnel / conversion** | `funnel-exploration` full width, then a `line` trend of the entry metric, then a breakdown of it by one dimension |
| **Single-metric deep dive** | `bigNumber`, `line` trend, one `bar` breakdown per dimension, optional `fact-table-exploration` table |
| **Experiment program review** | `experiments-status` + `experiments-win-rate`, then `metric-experiments` + `experiments-scaled-impact` |

Archetypes compose: "signup funnel plus how our tests are doing" is the funnel set followed by the experiment-program set, under one legend.

If the request clearly implies an archetype, pick it and say which one you picked. Only ask when two or more are genuinely plausible.

### 4. Find the metrics

Use `metric-search` if the user's metrics are not resolved yet, or list directly:

```bash
# The user named metrics: search every datasource, so one outside the default is still found.
gb-call GET '/api/v1/fact-metrics?limit=100'

# They named none: browse what the default can chart.
gb-call GET '/api/v1/fact-metrics?datasourceId=<ds_id>&limit=100'
```

Filtering by the step-1 pick before the metrics are resolved is how a requested metric goes missing. Each hit's own `datasource` becomes that chart's `config.datasource`; when a hit belongs to a source that cannot run explorations, say so rather than dropping it quietly.

Only fact metrics (`fact__...`) are chartable. Capture `id`, `metricType`, and `numerator.factTableId` for each, then fetch the fact table for its `userIdTypes`:

```bash
gb-call GET /api/v1/fact-tables/<factTableId>
```

### 5. Look up columns and values

Only when the dashboard needs a breakdown or a row filter. `columns[]` on the fact table gives the column names and datatypes; `topValues` on a string column is the only value lookup the API offers. Take every filter value from `topValues`. When the one you need is absent, ask the user or fall back to a `contains` filter, and say which you did.

### 6. Build the blocks

Every block needs `type`, `title`, and `description` (`""` is fine for the description, but always give a chart a real title — it is the tile's heading). Chart blocks add `config`. See **Block reference** below, and **Layout** for `layout`.

Add exactly one `markdown` block, first in the list, as the legend: one opening line on what the dashboard is for, then one line per chart saying what to read from it. That one covers the whole page — each chart labels itself through its own `title`.

### 7. Create the dashboard

One POST with the whole thing. Show the user the payload and get confirmation first — this creates something the whole organization may see.

```bash
echo '<dashboard-json>' | gb-call POST /api/v1/dashboards -
```

```json
{
  "title": "Growth KPIs",
  "editLevel": "private",
  "shareLevel": "private",
  "enableAutoUpdates": false,
  "projects": ["prj_abc123"],
  "globalControls": {
    "dateRange": { "predefined": "last30Days" },
    "dateGranularity": "auto"
  },
  "blocks": [
    {
      "type": "markdown",
      "title": "About this dashboard",
      "description": "",
      "layout": { "x": 0, "y": 0, "w": 24, "h": 3 },
      "content": "How revenue and signups are tracking over the last 30 days.\n\n- **Revenue** — total revenue in the period.\n- **Revenue over time** — daily revenue; watch for step changes."
    },
    {
      "type": "metric-exploration",
      "title": "Revenue",
      "description": "",
      "layout": { "x": 0, "y": 3, "w": 8, "h": 4 },
      "config": { "...": "a bigNumber metric config" }
    },
    {
      "type": "metric-exploration",
      "title": "Revenue over time",
      "description": "",
      "layout": { "x": 0, "y": 7, "w": 12, "h": 8 },
      "config": { "...": "a line metric config" }
    }
  ]
}
```

The response is `{ "dashboard": { "id": "dash_...", ... } }`. Report what is on the dashboard in a sentence, plus any assumption you made, and link it at `/product-analytics/dashboards/<id>`.

## Block reference

**Required top-level fields:** `title`, `editLevel`, `shareLevel`, `enableAutoUpdates`, `blocks`. `projects`, `globalControls`, and `comparison` are optional. Omit `experimentId` — a general dashboard has none, and setting it makes an experiment dashboard instead.

- `editLevel` — `"private"` (only you can edit) or `"published"` (members with permission can). Default to `"private"`.
- `shareLevel` — same two values, for viewing. Default to `"private"`; the user can publish it afterwards.
- `enableAutoUpdates` — `false` unless the user asks for a refresh schedule, which also needs `updateSchedule` (`{ "type": "stale", "hours": 24 }` or `{ "type": "cron", "cron": "0 6 * * *" }`).
- `globalControls` — the dashboard-wide filter bar: `dateRange`, `dateGranularity`, and for experimentation blocks `projects` and `experimentSearchString`. A chart block is enrolled in the date range automatically, and queried over it.
- `comparison` — dashboard-wide compare-to-previous-period, e.g. `{ "enabled": true, "mode": "previousPeriod" }`. Modes: `previousPeriod`, `previousPeriodMatchDayOfWeek`, `previousYear`, `previousYearMatchDayOfWeek`, `custom`.

### Chart blocks

`metric-exploration`, `fact-table-exploration`, `data-source-exploration`, and `funnel-exploration` each carry a `config` — the same exploration config `analytics-explore` posts, with the same rules for `unit`, dimensions, chart types, and date ranges. Read that workflow for the config shape.

**Omit `explorerAnalysisId`.** The create call runs each `config` and fills it in. Sending one binds the tile to a run you made yourself, which is only worth doing when you already have it.

`config.type` is the **dataset kind** — `metric`, `fact_table`, `data_source`, or `funnel` — and it must match `dataset.type`. The picture is `chartType`, a separate field: `line`, `area`, `bar`, `stackedBar`, `horizontalBar`, `stackedHorizontalBar`, `table`, `timeseries-table`, `bigNumber`. A chart type is never a `config.type`.

`datasource`, `dimensions`, `chartType`, `dateRange`, `type`, and `dataset` are all required. `dimensions: []` when the tile has no breakdown — leaving it out fails the write.

A `metric-exploration` config, the one most tiles use:

```json
{
  "type": "metric",
  "datasource": "ds_abc123",
  "chartType": "line",
  "dateRange": { "predefined": "last30Days" },
  "dimensions": [{ "dimensionType": "date", "column": null, "dateGranularity": "auto" }],
  "dataset": {
    "type": "metric",
    "values": [
      { "type": "metric", "name": "Revenue per User", "metricId": "fact__abc", "unit": "user_id", "denominatorUnit": null, "rowFilters": [] }
    ]
  }
}
```

A big-number tile is that same config with `"chartType": "bigNumber"` and `"dimensions": []`. There is no `metric` shorthand — one metric is a `dataset.values` array of length one, and several big numbers on one tile are several entries in it.

A `funnel-exploration` config uses the funnel dataset:

```json
{
  "type": "funnel",
  "datasource": "ds_abc123",
  "chartType": "bar",
  "dateRange": { "predefined": "last30Days" },
  "dimensions": [],
  "dataset": {
    "type": "funnel",
    "unit": "user_id",
    "steps": [
      { "name": "Viewed pricing", "factTableId": "ftb_abc", "rowFilters": [], "optional": false },
      { "name": "Started signup", "factTableId": "ftb_abc", "rowFilters": [], "optional": false }
    ],
    "yAxisScale": "percent"
  }
}
```

`unit` must exist on every step's fact table. `optional` is required per step. At most 10 steps.

### Experimentation blocks

These compute from experiment data and take no `config`.

| Type | Required fields |
| --- | --- |
| `experiments-status` | `dateRange`, `projects` |
| `experiments-win-rate` | `dateRange`, `projects`, `showProjectBreakdown` |
| `experiments-scaled-impact` | `dateRange`, `projects`, `metricId` |
| `metric-experiments` | `metricId`, `projects`, `experimentSearchString`, `differenceType`, `bandits` |

`projects: []` means every project. `experimentSearchString: ""` means no filter. `differenceType` is `absolute`, `relative`, or `scaled`. `dateRange` takes the same shape as an exploration's.

### Other blocks

- `markdown` — `content`. The legend, and nothing else.
- `sql-explorer` — `savedQueryId` and `blockConfig` (an array of visualization ids; `[]` is valid). Only for a saved query that already exists.

### Blocks that do not belong here

The per-experiment result blocks — `experiment-metric`, `experiment-dimension`, `experiment-time-series`, `experiment-metadata`, `experiment-traffic` — read from one experiment's snapshot and belong on that experiment's own dashboard. The API accepts them on a general dashboard, where they render nothing. If the user wants one experiment's results, say they live on the experiment's page and offer the **experiments** skill (`experiment-analyze` workflow).

`metric-explorer` is deprecated. Use `metric-exploration`.

## Layout

The grid is 24 columns wide. Each block takes `layout: { x, y, w, h }` — `x` and `w` in columns, `y` and `h` in rows. Omit it and the block is stacked full width beneath everything before it, which is a safe but dull default.

| Intent | `w` | `h` |
| --- | --- | --- |
| KPI tile (`bigNumber`) | 8 | 4 |
| Paired chart | 12 | 8 |
| Full-width chart, table, or funnel | 24 | 8 |
| The legend `markdown` | 24 | 3 |

To place them: walk the blocks in reading order, filling a row left to right while the widths still fit in 24, then start a new row. `x` is the running total of widths in the current row; `y` is the running total of the heights of the rows above; a row is as tall as its tallest block.

Three KPI tiles then a full-width chart:

```json
[
  { "x": 0, "y": 0, "w": 8, "h": 4 },
  { "x": 8, "y": 0, "w": 8, "h": 4 },
  { "x": 16, "y": 0, "w": 8, "h": 4 },
  { "x": 0, "y": 4, "w": 24, "h": 8 }
]
```

Minimum widths are enforced when the user drags a tile, so a narrower `w` snaps wider on first touch: keep `w` at 8 or more for a chart or markdown block, and 12 or more for `metric-experiments` and `experiments-scaled-impact`.

The user can rearrange the grid on the dashboard itself, so aim for a sensible default rather than a perfect one.

## Ask budget

The name and the project have no default. Ask for both in one question, then **at most one more**, bundling any remaining gaps into it.

| Slot | Default | Ask only when |
| --- | --- | --- |
| Name | none | always, unless the user already named it |
| Project | none | the org has 2+ projects and the user named none |
| Datasource | the only one | 2+ exist and none is named |
| Archetype | inferred from wording | 2+ genuinely plausible |
| Metrics | search hits | 0 hits, or one named metric matches 2+ results |
| Timeframe | `{ "predefined": "last30Days" }` | the user is vague about a period |
| Granularity | `"auto"` | never |
| Breakdown | none | the user said "by X" and X maps to 2+ columns |
| Comparison | off | the user implies one but the mode is unclear |
| Share and edit level | `"private"` | never |
| Auto-updates | `false` | never |

Ask only where the answer changes a block. Everywhere else, build something reasonable and state the assumption you made.

## Guardrails

- **One POST per dashboard.** Every block goes in the create call; the server runs each chart. Do not POST explorations first, and do not create the dashboard and then add tiles to it.
- **Say what the dashboard will contain, then get a yes.** A dashboard is organization-visible configuration, and the payload is unreadable at a glance. Lead with the name and where it lands, then one bullet per tile — chart type, metric, timeframe — in the words the user would use. Someone who never opens the JSON should be able to tell you got it wrong.
- **`explorerAnalysisId` is the server's to fill.** Omit it on every chart block you have not run yourself.
- **A chart that cannot run fails the whole create.** The dashboard is not created, and the error names what went wrong. Fix that block's config and call again — there is no partial dashboard to clean up.
- **One datasource per chart.** Every metric in a chart's `values[]`, every fact table, and every raw table must belong to that chart's own `config.datasource`, or the run fails. Different tiles may use different ones.
- **Always set `unit` explicitly** on a metric exploration value: `userIdTypes[0]` for `mean`, `proportion`, `retention`, and `dailyParticipation`; `null` for `ratio` and `quantile`. A missing unit is not backfilled — it silently switches to event-level aggregation.
- **`last14Days` is not a valid date range.** Only `today`, `yesterday`, `last7Days`, `last30Days`, `last90Days`, `last12Months`, `lastCalendarYear`, `customLookback`, and `customDateRange`. Anything else goes through `customLookback`.
- **One legend, and only on a new dashboard.** Exactly one `markdown` block, first. No section headings, no per-group captions.
- **Charts cost money and time.** Every chart block runs a real warehouse query on create. A twelve-tile dashboard is twelve queries — build what the user asked for, not a speculative superset.

## Endpoints used

- `GET /api/v1/data-sources` — pick the datasource
- `GET /api/v1/projects` — settle which project the dashboard belongs to
- `GET /api/v1/fact-metrics` — find chartable metrics
- `GET /api/v1/fact-tables` and `GET /api/v1/fact-tables/:id` — fact tables, columns, `userIdTypes`, `topValues`
- `POST /api/v1/dashboards` — create the dashboard

## Handoffs

- `references/dashboard-edit.md` — to change a dashboard that already exists
- `references/analytics-explore.md` — for the exploration config shape, and when the user only wanted one chart
- `references/metric-search.md` — to resolve which metrics exist before building
- the **experiments** skill (`experiment-analyze` workflow) — for one experiment's results
