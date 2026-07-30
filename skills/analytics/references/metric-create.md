---
name: metric-create
description: Create a GrowthBook fact metric, and the fact table underneath it when one doesn't exist yet. Use when the user asks to "create a metric", "add a revenue metric", "track conversion rate in GrowthBook", "I need a metric for my experiment", "define a metric on the orders table", or "add a fact table for our events". For finding metrics that already exist, use metric-search. For charting one, use analytics-explore. For choosing which metrics an experiment should use, use experiment-design.
---

# metric-create

Create a fact metric — and, when the underlying event table is not in GrowthBook yet, the fact table it sits on. A fact table is event-level SQL; a fact metric defines the aggregation an experiment or Product Analytics exploration measures.

This workflow writes definitions the whole organization can see. Confirm the proposed fact table and metric payloads with the user before each POST.

It deliberately stops at the metric's definition. Analysis settings such as conversion windows, capping, priors, regression adjustment, minimum sample size, and target MDE inherit organization defaults and are better tuned in the GrowthBook UI.

## Contents

- Required before any write
- Workflow
  - Find or create the fact table
  - Choose the metric type
  - Build and create the metric
  - Report what was created
- Guardrails
- Endpoints used
- Handoffs

## Required before any write

Collect these first; do not POST with a guess:

- What the metric measures, in one sentence from the user
- The metric type
- An existing fact table, or the datasource and SQL needed to create one
- The identifier types used by a new fact table
- The metric's columns or funnel steps, verified against detected fact-table columns

## Workflow

### 1. Find the fact table

```bash
gb-call GET '/api/v1/fact-tables?limit=100'
```

Match the user's event source client-side; there is no search endpoint. Paginate with `offset` while `hasMore` is true.

If a fact table already covers the events, fetch its full definition:

```bash
gb-call GET /api/v1/fact-tables/ftb_abc123
```

Use `columns[]` to confirm column names and datatypes. Ignore entries with `deleted: true`. If no fact table matches, continue to step 2. Otherwise skip to step 4.

### 2. Prepare a new fact table

Resolve the datasource and the identifier types it supports:

```bash
gb-call GET /api/v1/data-sources
```

Read `settings.userIdTypes[].userIdType` from the target datasource. These are the only values the fact table's `userIdTypes` accepts; do not assume `user_id`.

Write SQL returning one row per event, including each identifier column and a timestamp. Show the SQL and payload to the user before creating anything:

```json
{
  "name": "Orders",
  "description": "One row per completed order",
  "datasource": "ds_abc123",
  "userIdTypes": ["user_id"],
  "sql": "SELECT user_id, received_at AS timestamp, amount, country FROM analytics.orders"
}
```

### 3. Confirm, create, and inspect the fact table

After the user confirms:

```bash
echo '{
  "name": "Orders",
  "description": "One row per completed order",
  "datasource": "ds_abc123",
  "userIdTypes": ["user_id"],
  "sql": "SELECT user_id, received_at AS timestamp, amount, country FROM analytics.orders"
}' | gb-call POST /api/v1/fact-tables -
```

Column detection runs in the background when columns were omitted or need detection. Re-fetch the returned fact-table ID:

```bash
gb-call GET /api/v1/fact-tables/<new-id>
```

If `columnRefreshPending` is true, wait and retry instead of guessing column names. If `columnsError` is populated, surface it verbatim and fix the SQL. Continue only after the required columns appear in `columns[]`.

### 4. Choose the metric type

GrowthBook supports seven fact metric types:

| Type | Measures | Required definition |
| --- | --- | --- |
| `proportion` | Share of units with at least one matching row | Numerator fact table and optional row filters |
| `retention` | Share of units active in a later window | Numerator fact table and optional aggregate filters |
| `dailyParticipation` | Days a unit was active | Numerator fact table |
| `mean` | Average of a per-unit aggregate | Numerator fact table and column |
| `ratio` | One aggregate divided by another | Numerator and denominator |
| `quantile` | A percentile of event values or unit aggregates | Numerator and `quantileSettings` |
| `funnel` | Conversion through two or more ordered steps | `funnelSettings`; no numerator or denominator |

For `proportion` and `retention`, the server forces the numerator column to `$$distinctUsers`. For `dailyParticipation`, it forces `$$distinctDates`. Narrow which rows count with `rowFilters`.

### 5. Build a standard numerator

Skip to step 6 for a funnel.

`factTableId` is required. Add `column` for `mean`, `ratio`, and `quantile`. Common special columns are `$$count`, `$$distinctUsers`, and `$$distinctDates`.

```json
{
  "factTableId": "ftb_abc123",
  "column": "amount",
  "aggregation": "sum",
  "rowFilters": [
    { "operator": "=", "column": "country", "values": ["FR"] }
  ]
}
```

Supported row-filter operators are `=`, `!=`, `>`, `<`, `>=`, `<=`, `between`, `not_between`, `in`, `not_in`, `contains`, `not_contains`, `starts_with`, `ends_with`, `is_null`, `not_null`, `is_true`, `is_false`, `sql_expr`, and `saved_filter`.

The boolean and null operators take no `values`. `sql_expr` and `saved_filter` take no `column`. `between` and `not_between` take at most two values in lower-bound, upper-bound order; use an empty string for an open bound.

Normal aggregations are `sum`, `max`, and `count distinct`. A string column needs `count distinct`. `hll merge` and `kll merge` are only for compatible pre-built sketch columns and datasource support; do not select them unless the user's schema explicitly uses those sketches.

### 6. Build type-specific settings

For a ratio, add a denominator with `factTableId`, required `column`, optional `aggregation`, and optional `rowFilters`. Its fact table may differ from the numerator's, but both tables must use the same datasource.

For a quantile, add:

```json
{
  "quantileSettings": {
    "type": "event",
    "quantile": 0.95,
    "ignoreZeros": false
  }
}
```

For a funnel, omit `numerator` and `denominator`. Add two to twenty ordered steps:

```json
{
  "metricType": "funnel",
  "funnelSettings": {
    "ordering": "sequential",
    "steps": [
      {
        "name": "Viewed checkout",
        "factTableId": "ftb_checkout",
        "rowFilters": [],
        "optional": false,
        "conversionWindow": null
      },
      {
        "name": "Purchased",
        "factTableId": "ftb_orders",
        "rowFilters": [],
        "optional": false,
        "conversionWindow": { "unit": "days", "value": 7 }
      }
    ]
  }
}
```

The v1 create API supports `ordering: "sequential"` only. Each step needs a name, fact table, `rowFilters`, and `optional`; `conversionWindow` may be null.

Set `"inverse": true` when a decrease is the improvement, such as latency or refunds. Optional metadata includes `projects`, `tags`, `displayAsPercentage`, and `managedBy`.

### 7. Confirm and create the metric

Show the assembled payload and explain what it measures in plain language. Check the existing metric list for a near-duplicate before asking for confirmation:

```bash
gb-call GET '/api/v1/fact-metrics?limit=100'
```

After the user confirms:

```bash
echo '{
  "name": "Revenue per user",
  "description": "Average order amount per user",
  "metricType": "mean",
  "numerator": {
    "factTableId": "ftb_abc123",
    "column": "amount",
    "aggregation": "sum"
  }
}' | gb-call POST /api/v1/fact-metrics -
```

### 8. Report what was created

Give the user the metric ID, what it measures in one line, and the fact-table ID if one was created. Provide the corresponding GrowthBook UI links when the host is known.

State explicitly that analysis settings came from organization defaults and should be reviewed in the UI before the metric is used to make experiment decisions.

## Guardrails

- **The API currently supports seven types, including `funnel`.** Funnel metrics use `funnelSettings` and reject a numerator or denominator; every other type requires a numerator and rejects `funnelSettings`.
- **`numerator.column` is overwritten for `proportion`, `retention`, and `dailyParticipation`.** The handler substitutes `$$distinctUsers` for the first two and `$$distinctDates` for the third. It also clears their aggregation.
- **A `ratio` requires a denominator at model validation time.** The request schema marks it optional, but creation fails with `Denominator required for ratio metric` when it is absent. Denominators sent for other standard metric types are silently cleared.
- **A quantile requires `quantileSettings` at model validation time.** The request schema marks it optional, but creation fails without it. `quantile` must be from 0.001 through 0.999 in increments of 0.001.
- **Do not send `datasource` on a fact metric.** It is derived from the primary fact table. A ratio denominator may use another fact table only when both tables use the same datasource.
- **Funnel, quantile, and retention metrics are premium features.** Their model validation fails when the organization lacks `funnel-metrics`, `quantile-metrics`, or `retention-metrics`, respectively.
- **`userIdTypes` must exist on the datasource.** Read them from `GET /api/v1/data-sources`; an unknown value fails with `Invalid userIdType: <value>`.
- **Fact-table column detection is conditional and asynchronous.** When `columnRefreshPending` is true, wait for detection. Supplied complete column definitions may already be present in the create response, so do not assume `columns[]` is always empty.
- **Project IDs are validated on create.** Resolve project names with `GET /api/v1/projects`.
- **Auto-slice columns and `metricAutoSlices` require an enterprise license.** Aggregated fact-table settings require the data pipeline feature.
- **`managedBy: "api"` makes the resource read-only in the GrowthBook UI.** Only use it for a definition managed by external automation, and tell the user before setting it.
- **Names are not unique and IDs are permanent.** Prefer an existing `managedBy: "admin"` official metric over creating a duplicate.
- **This workflow does not tune analysis settings.** Review inherited windows, capping, priors, regression adjustment, minimum sample size, and target MDE in the UI.

## Endpoints used

- `GET /api/v1/data-sources` — resolve datasource IDs and valid identifier types
- `GET /api/v1/projects` — resolve project names to IDs
- `GET /api/v1/fact-tables` — find an existing fact table
- `GET /api/v1/fact-tables/:id` — inspect SQL, column status, and detected columns
- `POST /api/v1/fact-tables` — create a fact table
- `GET /api/v1/fact-metrics` — check for near-duplicate metrics
- `POST /api/v1/fact-metrics` — create a fact metric

## Handoffs

- `references/metric-search.md` — inventory existing definitions before creating one
- `references/analytics-explore.md` — chart the new metric and sanity-check its values
- the **experiments** skill (`experiment-design` workflow) — design an experiment around the metric
- the **experiments** skill (`experiment-launch` workflow) — launch an experiment after its metrics are ready
