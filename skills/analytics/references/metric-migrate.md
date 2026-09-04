---
name: metric-migrate
description: Migrate legacy GrowthBook metrics to Fact Tables and Fact Metrics — inventory the legacy metrics, group them into fact tables by shared SQL, bulk-import the equivalents with a replacement link back to each original, then archive the originals. Use when the user says "migrate our legacy metrics", "move metrics to fact tables", "convert met_ metrics to fact metrics", "we still have legacy metrics", "consolidate our metric SQL", or "archive the old metrics after migrating". For browsing what exists without changing it, use metric-search. For charting a fact metric once migrated, use analytics-explore.
---

# metric-migrate

Migrate legacy metrics (`met_...`) to fact tables and fact metrics (`fact__...`). Metrics sharing SQL collapse onto one fact table. Each new metric declares what it `replaces`; the originals are archived last.

Never guess. Anything ambiguous goes to the user in the step 5 dry run.

## Contents

- Inputs
- Workflow (1 fetch · 2 triage · 3 fact tables · 4 fact metrics · 5 dry run · 6 import · 7 consumers · 8 archive · 9 report)
- Guardrails
- Endpoints used
- Handoffs

## Inputs

- **Scope** — all metrics, or a `datasourceId` / `projectId`. Default to one datasource per run.
- **Archive originals?** — default yes.
- **Consolidate SQL differing only by `WHERE`?** — default no.

## Workflow

```
- [ ] 1. Fetch metrics (includeArchived=false), datasources, existing fact tables
- [ ] 2. Triage: migratable / needs-decision / blocked; resolve denominator chains
- [ ] 3. Group by SQL into fact tables
- [ ] 4. Map each metric to a fact metric (set replaces)
- [ ] 5. dryRun: true until errors is empty, then get user approval
- [ ] 6. Import for real, verify what landed
- [ ] 7. Update metric groups and experiment templates
- [ ] 8. Archive originals (batched usage check first)
- [ ] 9. Report
```

### 1. Fetch

```bash
gb-call GET '/api/v1/metrics?limit=100&offset=0&includeArchived=false'
gb-call GET /api/v1/data-sources
gb-call GET '/api/v1/fact-tables?limit=100'
```

Loop `offset` by 100 while `hasMore`. Add `&datasourceId=` / `&projectId=` for scope.

`includeArchived` defaults to **true** — pass `false` or you re-migrate retired metrics.

### 2. Triage

**Blocked** — `sql.conversionSQL` empty and no `sqlBuilder`. Nothing to build from.

**Needs a decision:**

- **`sqlBuilder` present** — `sql.conversionSQL` is empty; the definition lives in `tableName` / `valueColumnName` / `conditions`. Keep these out of step 3 or they all collapse into one bogus fact table. Offer to synthesize SQL, else leave legacy.
- **Aggregation with no equivalent** — anything outside the table below (`AVG`, `PERCENTILE`, `CASE`, any column but `value`).

| `sql.userAggregationSQL` | `aggregation` |
| --- | --- |
| `SUM(value)`, or missing | `sum` |
| `MAX(value)` | `max` |
| `COUNT(DISTINCT value)` | `count distinct` |

Compare case-insensitively, ignoring whitespace.

**Migratable** — everything else, including every denominator case.

`managedBy: "config"` metrics migrate but **cannot be archived** (the API rejects every field but `analysis`/`analysisError`/`queries`/`runStarted`). Skip them in step 8; `replaces` still signposts the duplicate. Tell the user to retire them in `config.yml`.

**Denominator chains.** Follow `sql.denominatorMetricId`, then check whether *that* metric also has one:

| Denominator | Target |
| --- | --- |
| None | `proportion` (binomial) or `mean` |
| One, `count`-typed | `ratio` |
| One, `binomial` | `ratio` — **numbers will change**, flag in step 5, allow `funnel` override |
| Two or more, binomial | `funnel` — one metric replaces the whole chain |

Legacy treated a binomial denominator as an activation filter (denominator had to convert first). A fact `ratio` divides two independent sides. That is the correction most users want, so it is the default — but never silent.

If any link in a chain is blocked or needs-decision, the whole chain does.

### 3. Group into fact tables

Group on **(`datasourceId`, normalized `sql.conversionSQL`, sorted `sql.identifierTypes`)**. Normalize for comparison only — collapse whitespace, strip trailing semicolons — and import the SQL verbatim.

Identifier types are part of the key: one fact table declares one `userIdTypes` list.

Each group becomes a fact table:

- **`id`** — deterministic slug matching `^[-a-zA-Z0-9_]+$`, e.g. `ftb_migrated_purchases`. Bulk import upserts by id, so determinism makes retries safe.
- **`name`** — what the group's metrics share; for a single-metric group, its name.
- **`datasource`**, **`sql`**, **`userIdTypes`** — from the key.
- **`projects`** — intersection (empty means all projects). **`tags`** — union.
- **`columns`** — declare the `value` column so formatting carries over:

```json
{ "column": "value", "datatype": "number", "numberFormat": "currency" }
```

Legacy encoded formatting in the metric `type`; fact tables put it on the column. Map `revenue` → `"currency"`, `duration` → `"time:seconds"`, `count` → `""`. Confirm duration metrics are really in seconds. If one group mixes `revenue` and `duration` over `value`, split it or ask.

Check proposed ids against the fact tables from step 1 — **an existing fact table's datasource cannot be changed**, so a collision means picking a new id.

**Consolidate mode only.** Where SQL differs only by a `WHERE` clause, propose one fact table on the broader SQL and move each clause to that metric's `numerator.rowFilters`:

```json
{ "operator": "sql_expr", "values": ["device_type = 'mobile'"] }
```

Inline, not a saved filter — leave `factTableFilters` empty. Show before/after SQL and get a per-group yes.

### 4. Map to fact metrics

One per migratable metric — except a chain, which yields one funnel.

- **`id`** — `fact__from_<legacy-id>`.
- **`replaces`** — the legacy ids this supersedes, e.g. `["met_abc123"]`. **Set it on every metric.** It links both pages in the UI and keeps pre-switch snapshots rendering. A funnel lists its whole chain. Cannot contain its own id, and bad ids fail silently — verify in step 6.

| Legacy | `metricType` | `numerator` |
| --- | --- | --- |
| `binomial`, no denominator | `proportion` | `column: ""` |
| `count`/`duration`/`revenue`, no denominator | `mean` | `column: "value"`, mapped `aggregation` |
| any, one denominator | `ratio` | as above, plus `denominator` |
| chain of 2+ binomial | `funnel` | omit — funnels reject `numerator` and `denominator` |

Legacy SQL always names its numeric column `value`.

**`denominator`** points at the denominator metric's fact table: `{ "factTableId": "<its step-3 group>", "column": "value", "aggregation": "<the denominator's own mapped aggregation>" }`. Map that from the **denominator's** `userAggregationSQL`, not the numerator's. A binomial denominator has no `value` column — use `column: "$$distinctUsers"` and omit `aggregation`.

**Funnel** steps run deepest-denominator-first:

```json
{
  "metricType": "funnel",
  "replaces": ["met_visited", "met_cart", "met_checkout"],
  "funnelSettings": {
    "steps": [
      { "name": "Visited Site", "factTableId": "ftb_pageviews", "rowFilters": [], "optional": false, "conversionWindow": null },
      { "name": "Viewed Cart",  "factTableId": "ftb_cart",      "rowFilters": [], "optional": false, "conversionWindow": null },
      { "name": "Checkout",     "factTableId": "ftb_checkout",  "rowFilters": [], "optional": false, "conversionWindow": null }
    ]
  }
}
```

`name`, `factTableId`, `rowFilters`, and `optional` are required on every step. Leave `conversionWindow` null — legacy windows do not map one-for-one — and tell the user to set them in the UI. Funnels need the `funnel-metrics` premium feature; the dry run reports if it is missing.

**Carry over:** `name`, `description`, `owner`, `projects`, `tags`, `inverse` (`behavior.goal === "decrease"`), `cappingSettings`, `windowSettings`.

**Also carry the six decision settings** — same names, but they move from `behavior.*` to **top level**: `minPercentChange`, `maxPercentChange`, `minSampleSize`, `targetMDE`, `riskThresholdSuccess`, `riskThresholdDanger`. Omitting them silently substitutes org defaults.

A `ratio` supports only `percentile` capping. The API accepts `absolute` anyway, so convert or drop it yourself.

Leave `priorSettings` and `regressionAdjustmentSettings` unset.

### 5. Dry run and approval gate

Write the payload to a file:

```json
{
  "dryRun": true,
  "defaultManagedBy": "",
  "factTables": [
    { "id": "ftb_migrated_purchases", "data": {
        "name": "Purchases", "datasource": "ds_abc123",
        "userIdTypes": ["user_id", "anonymous_id"],
        "sql": "SELECT user_id, anon_id as anonymous_id, received_at as timestamp, grand_total as value FROM purchases",
        "columns": [{ "column": "value", "datatype": "number", "numberFormat": "currency" }] } }
  ],
  "factTableFilters": [],
  "factMetrics": [
    { "id": "fact__from_met_abc123", "data": {
        "name": "Revenue per User", "metricType": "mean",
        "numerator": { "factTableId": "ftb_migrated_purchases", "column": "value", "aggregation": "sum" },
        "replaces": ["met_abc123"] } }
  ]
}
```

```bash
gb-call POST /api/v1/bulk-import/facts ./migration-payload.json
```

**`defaultManagedBy: ""` is required.** Without it everything is created as `managedBy: "api"`, which disables UI editing.

**A `200` is not success.** Branch on `success` and read `errors[]` (`resourceType`, `id`, `message`). Re-run until empty.

Then show the user and wait for approval:

- Each fact table: id, name, SQL, and which metrics map onto it.
- Each fact metric: legacy id → new id, `metricType`.
- Needs-decision and blocked buckets, with reasons, plus `managedBy: "config"` metrics that will not archive.
- **Every single-binomial-denominator → `ratio` conversion, individually** — say the numbers will move, offer a `funnel` override each.
- Each funnel and the metrics it consolidates.
- Consolidate-mode merges, with before/after SQL.

### 6. Import and verify

Set `"dryRun": false` and re-send the same file.

**Not transactional.** A failure stops at that resource and returns `400` (`403` for permissions) with counts and `errors[]` — everything before it is already created. Fix, dry-run clean, re-run; deterministic ids make it an upsert. **Do not proceed to step 8** if anything failed.

```bash
gb-call GET '/api/v1/fact-metrics?limit=100'
```

Verify against what step 4 planned, not per legacy metric — a chain is one metric covering several legacy ids. For each planned metric confirm it exists and `replaces` holds every id it should. Build the legacy-id → fact-metric-id map from what actually exists, mapping every chain member to the one funnel id. Steps 7 and 8 use only verified pairs.

### 7. Update metric groups and experiment templates

**Metric groups** resolve at read time, so an in-place swap reaches every experiment using them. That is fine here: `replaces` makes pre-swap snapshots still render.

```bash
gb-call GET /api/v1/metric-groups
echo '{"metrics":["fact__from_met_abc123","met_notmigrated"]}' | gb-call PUT /api/v1/metric-groups/mg_abc123 -
```

This list endpoint takes **no query parameters at all** — no `limit`, no `projectId`. It returns everything. Match client-side on `metrics[]`. Unmigrated members stay as-is; mixed groups are fine.

Surface, don't decide: a running experiment on the group switches metric on its next refresh, and a group that held a whole chain now holds one funnel.

**Experiment templates** are by-value — editing one affects only experiments created afterwards.

```bash
gb-call GET /api/v1/experiment-templates
echo '{"goalMetrics":["fact__from_met_abc123"],"activationMetric":"fact__from_met_def456"}' | gb-call PUT /api/v1/experiment-templates/tmpl_abc123 -
```

Four fields hold metric ids: `goalMetrics`, `secondaryMetrics`, `guardrailMetrics` (arrays) and `activationMetric` (a string). `PUT` is a partial patch. Do **not** use `/experiment-templates/bulk-import` — its `data` is the full create body, so a partial round-trip silently rewrites the template.

Templates may also hold `mg_...` group ids; those were handled above.

### 8. Archive the originals

Only verified replacements, only if the user opted in, never `managedBy: "config"`.

```bash
gb-call GET '/api/v1/usage/metrics?ids=met_abc123,met_def456'
```

One call for the batch (~50 ids each), and it resolves metric groups — an experiment using a metric *through a group* only shows up here. Filter `experimentStatus === "running"` client-side; there is no status filter. An `error` on an entry means do-not-archive, not unused. It only sees experiments the token can read, so on a scoped PAT say so in the report.

Skip anything with a running experiment — collect it as deferred. Archive the rest:

```bash
echo '{"archived":true}' | gb-call PUT /api/v1/metrics/met_abc123 -
```

Partial patch; reversible with `archived: false`. Roughly one call per metric — mind the 60 rpm limit on large runs.

### 9. Report

- **Migrated** — legacy → fact metric, grouped by fact table, linking `<host>/fact-tables/<id>` (`<host>` is `GB_API_URL` with `api.` → `app.`).
- **Deferred** — not archived, with the blocking experiment ids or `managedBy: "config"`.
- **Needs a decision** / **Blocked** — with reasons.
- **Groups and templates updated** — template edits are forward-only.
- **Numbers that will move** — every binomial-denominator → `ratio`, every chain → funnel, every assumed duration unit.

## Guardrails

- Archiving is the destructive half. Never archive before step 6 verifies the replacement, and never a metric feeding a running experiment. This workflow never deletes.
- `replaces` is what keeps historical results readable. A snapshot predating the switch renders through it; without it that experiment shows nothing.
- The server **silently rewrites** `numerator.column` to `$$distinctUsers` for `proportion`, `retention`, and `funnel` (and `$$distinctDates` for `dailyParticipation`), and clears `aggregation`. It does not error, so a wrong column yields a quietly different metric. Send `""` and expect the stored value to differ.
- Fact metric ids are auto-prefixed `fact__` when missing — send it explicitly so the payload matches what is created.
- Undeclared columns are auto-detected by a background job, so a fresh fact table can look incomplete in the UI briefly. Not a failure.

## Endpoints used

- `GET /api/v1/metrics` — inventory (`limit`, `offset`, `datasourceId`, `projectId`, `includeArchived`)
- `PUT /api/v1/metrics/:id` — partial patch to set `archived`
- `GET /api/v1/usage/metrics?ids=` — batched usage check; resolves metric groups
- `GET /api/v1/metrics/:id/experiments` — detail on one blocker
- `POST /api/v1/bulk-import/facts` — `dryRun: true`, then for real
- `GET /api/v1/fact-metrics` · `GET /api/v1/fact-tables` — verify, and detect id collisions
- `GET /api/v1/data-sources` — validate `userIdTypes`
- `GET /api/v1/metric-groups` (no query params) · `PUT /api/v1/metric-groups/:id`
- `GET /api/v1/experiment-templates` · `PUT /api/v1/experiment-templates/:id`

## Handoffs

- `references/metric-search.md` — audit the catalog before or after
- `references/analytics-explore.md` — chart a new fact metric against the legacy numbers
- the **experiments** skill (`experiment-analyze`) — when running experiments block archival
- the **experiments** skill (`experiment-design`) — to start using the new metrics
