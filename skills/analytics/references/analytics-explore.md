---
name: analytics-explore
description: Build and run a GrowthBook Product Analytics chart via the REST API — visualize a metric over time, aggregate a fact table, or chart a raw warehouse table, then return the numbers plus a deep link to the chart. Use when the user asks "show me signups by country", "chart daily active users", "how many orders last week", "plot revenue over time", "break that down by plan", or any "show me / chart / plot / how many" question about product data. For discovering what metrics and fact tables exist first, use metric-search. For experiment results, use experiment-analyze — this skill is for general analytics, not A/B test readouts.
---

# analytics-explore

Build and run a Product Analytics exploration — GrowthBook's ad-hoc charting surface — and report the numbers with a deep link to the rendered chart. Four dataset types are supported: an existing fact metric, a fact table aggregation, a raw warehouse table, or a funnel. This skill runs warehouse queries but never changes GrowthBook configuration; it does not create metrics, fact tables, or dashboards.

## Contents

- Workflow
  - 1. Pick a datasource
  - 2. Pick the path
  - Path A — metric exploration
  - Path B — fact-table exploration
  - Path C — data-source exploration (raw table)
  - Path D — funnel exploration
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

| The user wants                                                                  | Path                            |
| ------------------------------------------------------------------------------- | ------------------------------- |
| A defined metric ("signup conversion", "revenue")                               | **A — metric exploration**      |
| Event counts/sums from a fact table ("pageviews", "orders by country")          | **B — fact-table exploration**  |
| A warehouse table with no fact table defined on it                              | **C — data-source exploration** |
| Ordered completion through fact-table events ("signup → activation → purchase") | **D — funnel exploration**      |

Prefer A over B when a fact metric exists — metrics carry curated logic that a raw fact-table aggregation will not reproduce. Use C only when no fact table covers the data. Before any path, remember the per-turn query budget: discovery and polling are allowed, but stop after the first successful exploration and answer from that chart.

### Path A — metric exploration

**A-1. Find the metric.** Use Product Analytics search with a short term; broaden it or try a synonym if needed:

```bash
gb-call GET '/api/v1/product-analytics/search?query=signup&datasourceId=<ds_id>&limit=20&skip=0'
```

Use a match with `explorerType: "metric"` and capture its `id`, `name`, and `type`. Prefer `official: true` when equivalent matches exist.

**A-2. Get columns and units.** Pass one or more selected metric IDs:

```bash
gb-call GET '/api/v1/product-analytics/columns?source=metric&metricIds=fact__abc123'
```

Follow the returned `userIdTypes` and per-metric `needsUnit` fields. Use `userIdTypes[0]` whenever `needsUnit` is true and as the safe default for `mean`, `proportion`, `retention`, and `dailyParticipation`; use `null` for other metric types unless `needsUnit` says otherwise. If a row filter or concrete dimension value is needed, query the actual string-column values first:

```bash
echo '{"source":"metric","metricIds":["fact__abc123"],"columns":["country"],"searchTerm":"US","limit":20}' \
  | gb-call POST /api/v1/product-analytics/column-values -
```

Never guess a value. If the response is empty, broaden `searchTerm` once or ask the user for a different value.

**A-3. Build and run.**

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

**B-1. Find the fact table and its columns.**

```bash
gb-call GET '/api/v1/product-analytics/search?query=orders&datasourceId=<ds_id>&limit=20&skip=0'
gb-call GET '/api/v1/product-analytics/columns?source=fact_table&factTableId=ftb_abc123'
```

Choose a match with `explorerType: "fact_table"`. Use the returned columns, `userIdTypes`, and `unitNote`. Before using a concrete string value, call `/column-values`:

```bash
echo '{"source":"fact_table","factTableId":"ftb_abc123","columns":["country"],"limit":20}' \
  | gb-call POST /api/v1/product-analytics/column-values -
```

**B-2. Build and run.** Each value has a `valueType`:

| `valueType`  | Meaning                            | `valueColumn`              | `unit`           |
| ------------ | ---------------------------------- | -------------------------- | ---------------- |
| `unit_count` | Distinct units (e.g. unique users) | `null`                     | `userIdTypes[0]` |
| `count`      | Row count                          | `null`                     | `null`           |
| `sum`        | Sum of a numeric column            | a `number`-datatype column | `null`           |

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

### Path D — funnel exploration

Search for each step's fact table, then call `/columns` for every selected table. Choose a single identifier present in every table's `userIdTypes`. Use `/column-values` before adding any concrete row-filter value to a step.

Each step is `{ "name", "factTableId", "rowFilters", "optional", "conversionWindow" }`. Keep the user's order. `conversionWindow` is `null` or `{ "unit": "hours" | "days" | "weeks", "value": <positive number> }`.

```bash
echo '<config-json>' | gb-call POST '/api/v1/product-analytics/funnel-exploration?cache=preferred' -
```

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
      {
        "name": "Signed up",
        "factTableId": "ftb_signup",
        "rowFilters": [],
        "optional": false,
        "conversionWindow": null
      },
      {
        "name": "Purchased",
        "factTableId": "ftb_purchase",
        "rowFilters": [],
        "optional": false,
        "conversionWindow": { "unit": "days", "value": 7 }
      }
    ],
    "concurrencyWindowSeconds": 0,
    "yAxisScale": "percent"
  }
}
```

### 3. Interpret the response

A `200` is only a transport-level success. Branch on `exploration.status`:

- `"success"` → read the complete `exploration.result.rows` returned by the API. Standard rows contain `dimensions` and `values`; funnel rows contain `dimensions` and `steps`. Sort date dimensions before describing a trend. Use these full rows—not a rendered chart, config, summary, or truncated preview—for every concrete number.
- `"running"` → pending, not success. Capture `exploration.id`, wait 10 seconds, then poll:

  ```bash
  sleep 10
  gb-call GET /api/v1/product-analytics/explorations/<exploration-id>
  ```

  Repeat the wait + GET pair for at most 6 GET attempts (about 60 seconds), stopping immediately on `success` or `error`. Do not re-POST while the same exploration is running. If it is still running after the final poll, report a timeout and the latest `explorationUrl`; do not invent or estimate results.

  If the polling GET returns 404, the endpoint is unsupported or the exploration is missing or inaccessible. Stop, return the POST response's `explorationUrl`, and surface that ambiguity; never probe around access checks or poll by re-POSTing the config.

- `"error"` → surface `exploration.error`, correct the config, and retry within the Guardrails budget.
- `exploration: null` with a `message` → no result was returned (for example, `cache=required` found no cached run). Surface the message and stop or retry with `cache=preferred` when appropriate.

On success, report 1–2 sentences with concrete insights from the full rows plus `explorationUrl`. For per-unit values divide `numerator / denominator`; for totals use `numerator` alone—except for `proportion`, `retention`, and `dailyParticipation`, where `numerator` is a distinct-unit count rather than a standalone rate. Treat the current day and any low-volume trailing bucket as partial.

If the full result has 0 rows, do not present it as the answer yet. Widen the date range, verify or loosen filters with `/column-values`, or search for a better source, then retry once. If the retry is still empty, say no data was found. An empty result is not a successful chart for the per-turn budget, but the single empty-result retry is still the limit—do not fan out alternatives.

### 4. Follow-up modifications

For "break that down by country", "make it a bar chart", or "last 90 days instead", start from the previous response's `exploration.config` and change only what the user asked for. Never reconstruct from the original request config. Re-POST to the same endpoint. Changing only `chartType` is free (it hits the cache); anything else re-queries. Because follow-ups arrive in a new user turn, they get a new one-successful-chart budget.

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

**Row filters.** Shape: `{ "operator", "column", "values": ["..."] }` per filter, ANDed together. Operators: `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not_in`, `contains`, `not_contains`, `starts_with`, `ends_with`, `is_null`, `not_null`, `is_true`, `is_false`. Null/boolean operators take no `values`. Never guess a filter value—call `POST /api/v1/product-analytics/column-values` first.

**`showAs`.** Optional top-level toggle between raw totals (`"total"`) and per-unit averages (`"per_unit"`). Omit it in almost all cases — the chart infers a sensible default. Set it only when the user clearly asks for one view ("per user" → `per_unit`; "total X" → `total`), and only when at least one value is a `mean` metric — it has no effect on fact-table/data-source datasets or on proportion/retention/ratio/quantile metrics.

## Guardrails

- **A `200` can still be pending or failed.** Always branch on `exploration.status`. Poll a running exploration by ID; do not re-POST it. Surface errors, and stop after the bounded timeout.
- **Poll existing runs by id.** When a POST returns `"running"`, wait 10 seconds and use `GET /api/v1/product-analytics/explorations/:id`. Stop after 6 GET attempts and return the exploration link if it is still running.
- **Treat 404s conservatively.** A 404 from `/product-analytics/search` means the server predates these workflow endpoints. On resource-specific calls it can also mean missing or inaccessible. Surface the failure and stop. For a running exploration, return its existing `explorationUrl`; never probe around access checks or fall back to re-POSTing it.
- **Use full rows for numbers.** Concrete insights must come from all returned `exploration.result.rows`, never a chart image, preview, truncated summary, requested config, or guess.
- **At most one successful chart per user turn.** Discovery calls, value lookups, polling, config-error retries, and one empty-result retry are permitted. After one non-empty exploration succeeds, report it and stop.
- **Explorations run real warehouse queries.** They cost compute and can take tens of seconds. Default to `cache=preferred` (reuses a recent identical run); use `cache=never` only when the user explicitly wants fresh numbers. Run explorations one at a time and mind the 60 rpm API rate limit.
- **Cache matching ignores `chartType`.** Re-rendering the same data as a different chart type is a free cache hit — never re-query just to restyle.
- **Always set `unit` explicitly.** Follow `/columns` response fields `metrics[].needsUnit`, `userIdTypes`, and `unitNote`; a missing or invalid unit can silently change aggregation or fail the run.
- **`proportion`, `retention`, and `dailyParticipation` metrics return `numerator == denominator` in a standalone exploration.** These types emit one row per qualifying unit (`CASE WHEN filter THEN 1 ELSE NULL`, then `MAX` per unit, then `SUM AS numerator` / `COUNT AS denominator`), so the ratio is structurally ~1.0 (100%) — outside an experiment there is no exposure population to divide against. Read the **`numerator` as a distinct-unit count** ("users who did X that day"), never the ratio as a rate. `showAs: per_unit` degenerates to ~1 for these and has no effect (the server's own `metricHasMeaningfulPerUnit` returns false for them). `mean` is the exception — its denominator is a real unit count, so per-unit is a true average; `ratio`/`quantile` emit no `COUNT` denominator at all.
- **Never guess column values.** Call `POST /api/v1/product-analytics/column-values` before using a concrete string value in a filter or breakdown. It executes a warehouse query, supports up to five columns, and can return warnings for non-string or missing columns. If no exact value is returned after one broader lookup, ask the user instead of inventing one.
- **Use Product Analytics search as the chartable catalog.** Pick returned resources by `explorerType`; do not substitute a legacy experiment metric or an unreturned name.
- **Everything must live on the exploration's datasource.** All metrics in `values[]` (and the fact table, and the raw table) must belong to `config.datasource`, or the POST fails with a 400.
- **SQL datasources only.** Mixpanel and Google Analytics datasources return "Datasource is not a SQL datasource". Filter them out during datasource selection.
- **403 means missing `runQueries` permission** on the datasource for the token's user — not a bad key. Point the user at their PAT's role/scopes, or hand off to the **gb-setup** skill to switch tokens.
- **`last14Days` is not a valid date range** — it's a natural guess by analogy with `last7Days`/`last30Days`, but the API rejects it. Any lookback outside the four fixed presets goes through `customLookback` (see Config rules).
- **Stick to `date` + `dynamic` dimensions.** The validator also accepts `static` and `slice` dimension types and any `maxValues` number, but those are internal UI surface — unsupported configs render badly or fail downstream. Keep `maxValues` ≤ 20.
- **Product Analytics Explorer is in Beta** — chart types and rules may shift between GrowthBook releases. If a config that matches this skill is rejected, trust the error message in `body.message` over this file, and stop after 3 similar failures with a plain explanation.
- **Retry budget.** On a config error, fix and retry up to 3 times, then stop and explain. On 0 rows, retry once with a widened range or loosened filters before reporting "no data".

## Endpoints used

- `GET /api/v1/data-sources` — list datasources for selection
- `GET /api/v1/product-analytics/search` — search or browse chartable metrics and fact tables
- `GET /api/v1/product-analytics/columns` — get usable columns and unit requirements
- `POST /api/v1/product-analytics/column-values` — query actual string-column values; read-only but incurs warehouse cost
- `GET /api/v1/data-sources/:id/information-schema` — browse warehouse databases/schemas/tables
- `GET /api/v1/information-schema-tables/:tableId` — raw table columns + datatypes
- `POST /api/v1/product-analytics/metric-exploration` — run a metric chart
- `POST /api/v1/product-analytics/fact-table-exploration` — run a fact-table chart
- `POST /api/v1/product-analytics/data-source-exploration` — run a raw-table chart
- `POST /api/v1/product-analytics/funnel-exploration` — run a funnel chart
- `GET /api/v1/product-analytics/explorations/:id` — poll a pending exploration

## Handoffs

- `references/metric-search.md` — when the user wants to browse or audit what metrics and fact tables exist before charting anything
- the **experiments** skill (`experiment-analyze` workflow) — when the question is about an A/B test's results rather than general product data
- the **experiments** skill (`experiment-design` workflow) — when a chart surfaces something worth testing ("conversion dropped — should we test a fix?")
