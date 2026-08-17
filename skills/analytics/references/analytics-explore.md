---
name: analytics-explore
description: Build and run a GrowthBook Product Analytics chart via the REST API — visualize a metric over time, aggregate a fact table, or chart a raw warehouse table, then return the numbers plus a deep link to the chart. Use when the user asks "show me signups by country", "chart daily active users", "how many orders last week", "plot revenue over time", "break that down by plan", or any "show me / chart / plot / how many" question about product data. For discovering what metrics and fact tables exist first, use metric-search. For experiment results, use experiment-analyze — this skill is for general analytics, not A/B test readouts.
---

# analytics-explore

Build and run a Product Analytics exploration — GrowthBook's ad-hoc charting surface — and report the numbers with a deep link to the rendered chart. Three dataset types are supported: an existing fact metric, a fact table aggregation, or a raw warehouse table. This skill runs warehouse queries but never changes GrowthBook configuration; it does not create metrics, fact tables, or dashboards.

## Contents

- Workflow
  - 1. Pick a datasource
  - 2. Pick the path
  - Path A — metric exploration
  - Path B — fact-table exploration
  - Path C — data-source exploration (raw table)
  - 3. Interpret the response
  - 4. Follow-up modifications
- Config rules
- Guardrails
- Endpoints used
- Handoffs

## Workflow

### 1. Pick a datasource

Explorations are scoped to one SQL datasource. If a datasource is already established in this conversation, reuse it.

```bash
gb-call GET /api/v1/data-sources
```

- **0 datasources** → tell the user none is configured and stop.
- **1 datasource** → use it without asking, but say which one you're using.
- **2+ datasources** → use the one the user named; otherwise ask which to use.

Only SQL warehouse datasources work (Postgres, BigQuery, Snowflake, etc.). Mixpanel and Google Analytics datasources are rejected by the exploration endpoints.

### 2. Pick the path

| The user wants | Path |
| --- | --- |
| A defined metric ("signup conversion", "revenue") | **A — metric exploration** |
| Event counts/sums from a fact table ("pageviews", "orders by country") | **B — fact-table exploration** |
| A warehouse table with no fact table defined on it | **C — data-source exploration** |

Prefer A over B when a fact metric exists — metrics carry curated logic (filters, aggregation, capping) that a raw fact-table aggregation won't reproduce. Use C only when no fact table covers the data.

### Path A — metric exploration

**A-1. Find the metric.** There is no search endpoint; list and filter client-side by name:

```bash
gb-call GET '/api/v1/fact-metrics?datasourceId=<ds_id>&limit=100'
```

Paginate with `offset` if `hasMore` is true. Only **fact metrics** (IDs starting `fact__`) can be explored — legacy metrics from `/api/v1/metrics` cannot. Capture from the chosen metric: `id`, `metricType` (`mean`, `proportion`, `retention`, `dailyParticipation`, `ratio`, `quantile`), and `numerator.factTableId`.

**A-2. Get the unit.** Fetch the numerator's fact table for `userIdTypes`:

```bash
gb-call GET /api/v1/fact-tables/<factTableId>
```

**A-3. Build and run.** For `mean`, `proportion`, `retention`, and `dailyParticipation` metrics set `unit` to `userIdTypes[0]` (e.g. `"user_id"`); for `ratio` and `quantile` metrics set `unit: null`. `denominatorUnit` is always `null`.

```bash
echo '<config-json>' | gb-call POST '/api/v1/product-analytics/metric-exploration?cache=preferred' -
```

```json
{
  "type": "metric",
  "datasource": "ds_abc123",
  "chartType": "line",
  "dateRange": { "predefined": "last30Days" },
  "dimensions": [
    { "dimensionType": "date", "column": null, "dateGranularity": "auto" }
  ],
  "dataset": {
    "type": "metric",
    "values": [
      {
        "type": "metric",
        "name": "Signup conversion",
        "metricId": "fact__abc123",
        "unit": "user_id",
        "denominatorUnit": null,
        "rowFilters": []
      }
    ]
  }
}
```

Multiple metrics can share one chart via multiple `values[]` entries, with limits: all metrics must live on the exploration's datasource; ratio metrics can't mix with non-ratio metrics; quantile metrics can't mix with anything.

### Path B — fact-table exploration

**B-1. Find the fact table.**

```bash
gb-call GET '/api/v1/fact-tables?datasourceId=<ds_id>&limit=100'
```

Filter client-side by name. Capture `id`, `userIdTypes`, and `columns[]` (each has `column`, `datatype`, `deleted`, and — for string columns — `topValues`). Ignore columns with `deleted: true`.

**B-2. Build and run.** Each value has a `valueType`:

| `valueType` | Meaning | `valueColumn` | `unit` |
| --- | --- | --- | --- |
| `unit_count` | Distinct units (e.g. unique users) | `null` | `userIdTypes[0]` |
| `count` | Row count | `null` | `null` |
| `sum` | Sum of a numeric column | a `number`-datatype column | `null` |

```bash
echo '<config-json>' | gb-call POST '/api/v1/product-analytics/fact-table-exploration?cache=preferred' -
```

```json
{
  "type": "fact_table",
  "datasource": "ds_abc123",
  "chartType": "bar",
  "dateRange": { "predefined": "last7Days" },
  "dimensions": [
    { "dimensionType": "dynamic", "column": "country", "maxValues": 5 }
  ],
  "dataset": {
    "type": "fact_table",
    "factTableId": "ftb_abc123",
    "values": [
      {
        "type": "fact_table",
        "name": "Orders",
        "valueType": "count",
        "valueColumn": null,
        "unit": null,
        "rowFilters": []
      }
    ]
  }
}
```

The fact table must belong to the exploration's datasource.

### Path C — data-source exploration (raw table)

**C-1. Browse the warehouse schema.**

```bash
gb-call GET /api/v1/data-sources/<ds_id>/information-schema
```

Returns `databases[].schemas[].tables[]`, each table with `tableName`, `path` (fully qualified, e.g. `db.schema.events`), `id`, and `numOfColumns`. If no information schema exists yet, the user must generate one in the GrowthBook UI first (Product Analytics → Data Source explorer) — there is no API call to trigger it.

**C-2. Get the columns.**

```bash
gb-call GET /api/v1/information-schema-tables/<tableId>
```

Returns `columns[]` with `columnName` and the warehouse's raw `dataType`. Build the `columnTypes` map by classifying each raw type with GrowthBook's own rules (substring match, in this order): contains `int`/`numeric`/`decimal`/`float`/`double`/`real` → `number`; contains `date`/`time` → `date`; contains `bool` → `boolean`; contains `char`/`text`/`string` → `string`; anything else → `other`.

**C-3. Build and run.** Pick the `timestampColumn` from the `date`-typed columns (ask if ambiguous). `table` is the table name, `path` is the fully qualified path from C-1 — it is interpolated into `SELECT * FROM <path>` server-side, so copy it exactly. Values work like Path B; for `unit_count`, `unit` must be one of the datasource's identifier types (`identifierTypes[].id` from step 1) that also exists as a column on the table — e.g. `user_id`. Anything else fails the run.

```bash
echo '<config-json>' | gb-call POST '/api/v1/product-analytics/data-source-exploration?cache=preferred' -
```

```json
{
  "type": "data_source",
  "datasource": "ds_abc123",
  "chartType": "line",
  "dateRange": { "predefined": "last30Days" },
  "dimensions": [
    { "dimensionType": "date", "column": null, "dateGranularity": "auto" }
  ],
  "dataset": {
    "type": "data_source",
    "table": "events",
    "path": "analytics.public.events",
    "timestampColumn": "received_at",
    "columnTypes": {
      "received_at": "date",
      "user_id": "string",
      "event_name": "string",
      "revenue": "number"
    },
    "values": [
      {
        "type": "data_source",
        "name": "Events",
        "valueType": "count",
        "valueColumn": null,
        "unit": null,
        "rowFilters": []
      }
    ]
  }
}
```

### 3. Interpret the response

A `200` is **not** success — check `exploration.status`:

- `"success"` → read `exploration.result.rows`. Each row is `{ dimensions: [...], values: [{ metricId, numerator, denominator }] }`. **Rows come back unordered** — sort by the date dimension client-side before presenting any trend, or you'll read the series out of sequence. When the numbers look surprising, read the response's `query.query` field: it carries the fully compiled SQL, which shows exactly how each metric's numerator and denominator were built (this is the fastest way to catch an unexpected aggregation).
- `"error"` → surface `exploration.error`, fix the config, and retry (see Guardrails for the retry budget).
- `"running"` → rare; the run ended without resolving. There is no GET to poll an exploration, and the cache only matches succeeded runs — so wait (`sleep 10`), then re-POST the identical config with `cache=preferred` **once** (it either hits the now-finished cache or re-runs). If it's still `"running"`, stop and hand the user the `explorationUrl` — the app polls it live.
- `exploration: null` with a `message` → only happens with `cache=required`; there was no cached result.

Then report: 1–2 sentences with the key numbers, plus the `explorationUrl` from the response — that link renders the interactive chart in GrowthBook, which is the user's visual. For per-unit values divide `numerator / denominator`; for totals use `numerator` alone — **except** for `proportion`, `retention`, and `dailyParticipation` metrics, where the two come back equal (see Guardrails), so read the `numerator` as a distinct-unit count, never the ratio as a rate. **Treat the current day (and any low-volume trailing bucket) as partial** — today's bucket is still filling, so it reads as a sharp drop that isn't real. Flag it as partial rather than presenting it as a decline.

If the result has 0 rows, don't present that as the answer yet: widen the date range, loosen row filters, or reconsider the metric/fact-table choice, then retry once before concluding there's no data.

### 4. Follow-up modifications

For "break that down by country", "make it a bar chart", "last 90 days instead": start from the config you just ran and change only what was asked — don't rebuild from scratch. Re-POST to the same endpoint. Changing only `chartType` is free (it hits the cache); anything else re-queries.

## Config rules

**Chart types.** `line`, `area`, `timeseries-table`, `table`, `bar`, `stackedBar`, `horizontalBar`, `stackedHorizontalBar`, `bigNumber`.

- Timeseries charts (`line`, `area`, `timeseries-table`): always include the date dimension.
- Cumulative charts (all others): never include a date dimension.
- Defaults when the user doesn't specify: `line` for trends over time, `bar` for totals/breakdowns. Don't use `bigNumber` unless the user explicitly asks for a single-stat display.

**Date ranges.** Valid `predefined` values: `today`, `last7Days`, `last30Days`, `last90Days`, `customLookback`, `customDateRange`. Anything else (e.g. `last14Days`) is a validation error — for 14 days use `{ "predefined": "customLookback", "lookbackValue": 14, "lookbackUnit": "day" }` (`lookbackUnit`: `hour`, `day`, `week`, or `month`). For explicit dates use `customDateRange` with `startDate`/`endDate` ISO strings.

**Dimensions.** Two shapes:

- Date: `{ "dimensionType": "date", "column": null, "dateGranularity": "auto" }` — keep `auto` unless the user asks for a specific granularity (`hour`, `day`, `week`, `month`, `year`).
- Breakdown: `{ "dimensionType": "dynamic", "column": "<string column>", "maxValues": 5 }` — shows the top N values, `maxValues` 1–20.

Maximum 2 dimensions total (the date dimension counts); with more than one `values[]` entry, maximum 1 dimension. Only add a breakdown dimension when the user asks to break down / split / group by something.

**Row filters.** Shape: `{ "operator", "column", "values": ["..."] }` per filter, ANDed together. Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not_in`, `contains`, `not_contains`, `starts_with`, `ends_with`, `is_null`, `not_null`, `is_true`, `is_false`. Null/boolean operators take no `values`. Never guess a filter value — check the column's `topValues` on the fact table first (see Guardrails).

**`showAs`.** Optional top-level toggle between raw totals (`"total"`) and per-unit averages (`"per_unit"`). Omit it in almost all cases — the chart infers a sensible default. Set it only when the user clearly asks for one view ("per user" → `per_unit`; "total X" → `total`), and only when at least one value is a `mean` metric — it has no effect on fact-table/data-source datasets or on proportion/retention/ratio/quantile metrics.

## Guardrails

- **A `200` is not success.** The exploration runs synchronously but query errors are swallowed server-side; the response can carry `status: "error"` (with the reason in `exploration.error`) or `status: "running"`. Always branch on `exploration.status`, never on the HTTP code alone.
- **Explorations run real warehouse queries.** They cost compute and can take tens of seconds. Default to `cache=preferred` (reuses a recent identical run); use `cache=never` only when the user explicitly wants fresh numbers. Don't fan out multiple exploration calls in parallel — one at a time, and mind the 60 rpm API rate limit.
- **Cache matching ignores `chartType`.** Re-rendering the same data as a different chart type is a free cache hit — never re-query just to restyle.
- **Always set `unit` explicitly.** The server does not backfill a missing unit: a `null` unit on a `mean`/`proportion`/`retention`/`dailyParticipation` metric silently switches the SQL to event-level aggregation instead of erroring — wrong numbers, no warning. Set `userIdTypes[0]` for those types; `null` for `ratio`/`quantile`. A unit not in the fact table's `userIdTypes` fails the run.
- **`proportion`, `retention`, and `dailyParticipation` metrics return `numerator == denominator` in a standalone exploration.** These types emit one row per qualifying unit (`CASE WHEN filter THEN 1 ELSE NULL`, then `MAX` per unit, then `SUM AS numerator` / `COUNT AS denominator`), so the ratio is structurally ~1.0 (100%) — outside an experiment there is no exposure population to divide against. Read the **`numerator` as a distinct-unit count** ("users who did X that day"), never the ratio as a rate. `showAs: per_unit` degenerates to ~1 for these and has no effect (the server's own `metricHasMeaningfulPerUnit` returns false for them). `mean` is the exception — its denominator is a real unit count, so per-unit is a true average; `ratio`/`quantile` emit no `COUNT` denominator at all.
- **Never guess column values for filters.** There is no value-lookup endpoint on the REST API. Use the `topValues` array on the fact table's string columns (`GET /api/v1/fact-tables/:id`) — it's refreshed by a background job, so it can be stale or absent. If the value you need isn't there, ask the user for the exact value or fall back to a `contains` filter, and say which you did.
- **Metric explorations take fact metrics only.** Legacy metrics (`GET /api/v1/metrics`, IDs like `met_...`) are not chartable — only `fact__...` IDs from `/api/v1/fact-metrics`. If the user's metric is legacy-only, say so and offer the fact-table path against the underlying table.
- **Everything must live on the exploration's datasource.** All metrics in `values[]` (and the fact table, and the raw table) must belong to `config.datasource`, or the POST fails with a 400.
- **SQL datasources only.** Mixpanel and Google Analytics datasources return "Datasource is not a SQL datasource". Filter them out during datasource selection.
- **403 means missing `runQueries` permission** on the datasource for the token's user — not a bad key. Point the user at their PAT's role/scopes, or hand off to the **gb-setup** skill to switch tokens.
- **`last14Days` is not a valid date range** — it's a natural guess by analogy with `last7Days`/`last30Days`, but the API rejects it. Any lookback outside the four fixed presets goes through `customLookback` (see Config rules).
- **Stick to `date` + `dynamic` dimensions.** The validator also accepts `static` and `slice` dimension types and any `maxValues` number, but those are internal UI surface — unsupported configs render badly or fail downstream. Keep `maxValues` ≤ 20.
- **Product Analytics Explorer is in Beta** — chart types and rules may shift between GrowthBook releases. If a config that matches this skill is rejected, trust the error message in `body.message` over this file, and stop after 3 similar failures with a plain explanation.
- **Retry budget.** On a config error, fix and retry up to 3 times, then stop and explain. On 0 rows, retry once with a widened range or loosened filters before reporting "no data".

## Endpoints used

- `GET /api/v1/data-sources` — list datasources for selection
- `GET /api/v1/fact-metrics` — find fact metrics (`datasourceId`, `factTableId`, `projectId`, `limit`, `offset`)
- `GET /api/v1/fact-tables` — find fact tables (`datasourceId`, `projectId`, `limit`, `offset`)
- `GET /api/v1/fact-tables/:id` — columns, `userIdTypes`, `topValues`
- `GET /api/v1/data-sources/:id/information-schema` — browse warehouse databases/schemas/tables
- `GET /api/v1/information-schema-tables/:tableId` — raw table columns + datatypes
- `POST /api/v1/product-analytics/metric-exploration` — run a metric chart
- `POST /api/v1/product-analytics/fact-table-exploration` — run a fact-table chart
- `POST /api/v1/product-analytics/data-source-exploration` — run a raw-table chart

## Handoffs

- `references/metric-search.md` — when the user wants to browse or audit what metrics and fact tables exist before charting anything
- the **experiments** skill (`experiment-analyze` workflow) — when the question is about an A/B test's results rather than general product data
- the **experiments** skill (`experiment-design` workflow) — when a chart surfaces something worth testing ("conversion dropped — should we test a fix?")
