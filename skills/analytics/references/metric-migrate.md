---
name: metric-migrate
description: Migrate legacy GrowthBook metrics to Fact Tables and Fact Metrics — inventory the legacy metrics, group them into fact tables by shared SQL, bulk-import the equivalents with a replacement link back to each original, then archive the originals. Use when the user says "migrate our legacy metrics", "move metrics to fact tables", "convert met_ metrics to fact metrics", "we still have legacy metrics", "consolidate our metric SQL", or "archive the old metrics after migrating". For browsing what exists without changing it, use metric-search. For charting a fact metric once migrated, use analytics-explore.
---

# metric-migrate

Migrate legacy metrics (`met_...`, from `/api/v1/metrics`) to Fact Tables and Fact Metrics (`fact__...`). The migration groups legacy metrics that share the same SQL into a single reusable fact table, bulk-imports the fact table plus one fact metric per legacy metric — each declaring the legacy metric it `replaces` — then archives the originals.

This workflow writes a lot: it creates fact tables and fact metrics, and it archives existing metrics. It is **not** a like-for-like conversion — several legacy features have no fact-table equivalent, and ratio semantics genuinely changed. The triage step (2) exists to separate what can be migrated faithfully from what needs a human decision. Never migrate a metric you had to guess about; leave it legacy and report it.

## Contents

- Required inputs
- Workflow
  - 1. Fetch the legacy metric inventory
  - 2. Triage into migratable, needs-decision, and blocked
  - 3. Group migratable metrics into fact tables by shared SQL
  - 4. Map each legacy metric to a fact metric
  - 5. Build the bulk-import payload
  - 6. Dry run and review gate
  - 7. Bulk-import the fact tables and fact metrics
  - 7a. Partial failure on bulk import
  - 8. Verify what landed
  - 9. Update downstream metric consumers
  - 9a. Metric groups
  - 9b. Experiment templates
  - 10. Archive the legacy metrics
  - 10a. Legacy metric still used by a running experiment
  - 11. Report
- Guardrails
- Endpoints used
- Handoffs

## Required inputs

Collect before any write. Prompt for what's missing.

- **Scope** — all legacy metrics, or filtered by `datasourceId` / `projectId`. Default to one datasource at a time; fact tables are datasource-scoped and a mixed-datasource run is harder to review.
- **Archive the originals?** — `yes` (default) or `no` (create fact metrics only, leave legacy metrics active). Confirm explicitly; archiving is the destructive half.
- **Update experiment templates?** — `yes` (default). Templates are by-value, so the change is forward-only. Only ask because it is a write.
- **Update metric groups?** — `yes` (default). Groups are edited in place; the `replaces` link keeps historical readouts rendering. Only ask because it is a write.
- **Grouping tier** — `exact` (default: only byte-identical SQL shares a fact table) or `consolidate` (also propose merging SQL that differs only by a `WHERE` clause, turning the clause into a fact table filter). `consolidate` always requires per-group confirmation in step 6.

## Workflow

Track progress with this checklist. Steps 1–6 are read-only and reversible; do not start step 7 until the user approves the dry run.

```
- [ ] 1. Fetch legacy metrics (includeArchived=false)
- [ ] 2. Triage: migratable / needs-decision / blocked
- [ ] 3. Group migratable metrics into fact tables by shared SQL
- [ ] 4. Map each legacy metric to a fact metric definition (replaces: [legacy id])
- [ ] 5. Build the bulk-import payload (defaultManagedBy: "")
- [ ] 6. POST with dryRun: true, review errors, user approves
- [ ] 7. POST /api/v1/bulk-import/facts for real
- [ ] 8. Verify what landed against the payload
- [ ] 9. Update downstream consumers — 9a metric groups, 9b experiment templates
- [ ] 10. Archive legacy metrics (batched usage check first)
- [ ] 11. Report, including everything left behind
```

### 1. Fetch the legacy metric inventory

```bash
gb-call GET '/api/v1/metrics?limit=100&offset=0&includeArchived=false'
```

Loop `offset` by 100 while `hasMore` is true. Add `&datasourceId=<id>` or `&projectId=<id>` to honor the scope from Required inputs.

**`includeArchived` defaults to `true`.** Pass `false` explicitly or you will re-migrate metrics somebody already retired.

Also fetch the datasources and the existing fact tables, so step 3 can validate identifier types and avoid colliding with tables that already exist:

```bash
gb-call GET /api/v1/data-sources
gb-call GET '/api/v1/fact-tables?limit=100'
```

Record for each legacy metric: `id`, `name`, `description`, `type`, `datasourceId`, `projects`, `tags`, `owner`, `managedBy`, `behavior` (goal, capping, window), and the `sql` block — `sql.conversionSQL`, `sql.identifierTypes`, `sql.userAggregationSQL`, `sql.denominatorMetricId`. Note whether a `sqlBuilder` block is present.

### 2. Triage into migratable, needs-decision, and blocked

Sort every metric into exactly one bucket. Report the counts before doing anything else.

**Blocked — cannot migrate, do not attempt:**

- **`sql.conversionSQL` is empty and there is no `sqlBuilder` block** — there is no query to build a fact table from. Report it and move on.

**Needs a decision — surface each one, migrate only what the user resolves:**

- **`sqlBuilder` is present** (`queryFormat: "builder"`). These metrics have an **empty** `sql.conversionSQL` and carry `tableName` / `valueColumnName` / `timestampColumnName` / `conditions` instead. Never let them into step 3: grouping on empty SQL collapses every builder metric into one nonsense fact table. Either synthesize SQL from the builder fields and show it to the user for approval, or leave the metric legacy.
- **An aggregation that is not one of the three supported forms.** Fact tables replaced arbitrary aggregation SQL with three fixed options, and each has an exact legacy equivalent — map these rather than excluding them:

  | `sql.userAggregationSQL` | Fact metric `aggregation` |
  | --- | --- |
  | `SUM(value)`, or missing/empty | `sum` |
  | `MAX(value)` | `max` |
  | `COUNT(DISTINCT value)` | `count distinct` |

  Compare case-insensitively and ignore surrounding whitespace. Anything else — `AVG`, `PERCENTILE`, a `CASE`, any expression over a column other than `value` — has no equivalent and needs a decision. Missing or empty counts as `sum`: the API substitutes `SUM(value)` when a legacy metric set no aggregation, so an absent value is the default, not a custom one.

**Migratable — everything else**, including every denominator case. A metric qualifies when it has a non-empty `sql.conversionSQL`, no `sqlBuilder`, and a `userAggregationSQL` that maps to one of the three supported aggregations.

**`managedBy: "config"` metrics migrate but cannot be archived.** The update path rejects everything except `analysis` / `analysisError` / `queries` / `runStarted`, so step 10 must skip them. The replacement fact metric's `replaces` still surfaces the pointer on the legacy metric's page, so the duplicate is signposted rather than silent. Flag them in the dry run and tell the user to retire them in `config.yml`.

Resolve denominators by walking the chain. For a metric with `sql.denominatorMetricId` set, look up that metric in the inventory and check whether it *also* has a `sql.denominatorMetricId`. The depth of that chain decides the target:

| Denominator shape | Target | Why |
| --- | --- | --- |
| None | `proportion` or `mean` | Nothing to resolve |
| One `count`-typed denominator | `ratio` | Faithful — legacy already treated this as a true ratio |
| One `binomial` denominator, which has no denominator of its own | `ratio` **(default)** | Semantics change; most users want a real ratio anyway. Flag it, allow override |
| A chain of two or more binomial denominators | `funnel` | An ordered sequence of steps is exactly what the legacy chain encoded |

**The single-binomial-denominator default is `ratio`, and it changes the numbers.** Legacy treated one binomial denominator as an activation filter — the denominator had to convert first, and only those users counted. A fact `ratio` computes both sides independently and divides. The results will differ, and that is usually the *desired* correction rather than a regression, which is why it is the default. But it is never silent: every metric in this bucket must appear in the step 6 dry run under its own heading, and the user can override any of them to `funnel`.

**A chain of two or more binomial denominators becomes one funnel metric.** `A → denominator B → denominator C` is a three-step ordered sequence, and a single funnel metric replaces all three legacy metrics rather than producing one fact metric each. Order the steps from the deepest denominator forward: `C`, then `B`, then `A`. Funnel metrics require the `funnel-metrics` premium feature — the step 6 dry run reports the failure per metric if the org lacks it.

Chains where a denominator resolves to a metric that is itself blocked or needs-decision cannot be migrated — move the whole chain to needs-decision and say which link broke it.

### 3. Group migratable metrics into fact tables by shared SQL

Group on the tuple **(`datasourceId`, normalized `sql.conversionSQL`, sorted `sql.identifierTypes`)**. Normalize the SQL only for comparison — collapse runs of whitespace, strip trailing semicolons and trailing blank lines, and compare case-sensitively. **Store and import the original SQL verbatim**, not the normalized form.

Identifier types must be part of the key: a fact table declares one `userIdTypes` list for every metric hanging off it, so two metrics with identical SQL but different supported identifiers cannot share one.

Each resulting group becomes one fact table:

- **`id`** — a deterministic, human-readable slug matching `^[-a-zA-Z0-9_]+$` (the model rejects anything else). Something like `ftb_migrated_purchases`. Determinism matters: bulk import upserts by `id`, so a re-run with the same ids updates rather than duplicating.
- **`name`** — derived from what the group's metrics have in common, not from one metric's name. For a single-metric group, reuse that metric's name.
- **`datasource`**, **`sql`**, **`userIdTypes`** — from the group key.
- **`projects`** / **`tags`** — the intersection of the group's metrics' projects, and the union of their tags. An empty `projects` array means "all projects"; only narrow when every metric in the group agrees.
- **`columns`** — see below.

Before importing, check each proposed `id` against the fact tables fetched in step 1. If one already exists, you are updating it, and **the datasource cannot be changed** on an existing fact table — the import rejects that resource. Pick a fresh id or drop that group.

**Columns carry the display formatting.** This is the main thing that moves during migration: legacy metrics encoded currency-vs-duration in the metric `type`, while fact tables attach it to the column. For every group containing a non-binomial metric, declare the `value` column explicitly:

```json
{ "column": "value", "datatype": "number", "numberFormat": "currency" }
```

Map `numberFormat` from the legacy `type`: `revenue` → `"currency"`, `duration` → `"time:seconds"`, `count` → `""`. Valid values are `""`, `"currency"`, `"time:seconds"`, `"memory:bytes"`, `"memory:kilobytes"`.

Two cautions. Legacy `duration` metrics store whatever unit their SQL returned — confirm with the user that it is seconds before setting `time:seconds`. And if one group mixes a `revenue` metric with a `duration` metric over the same `value` column, the formats conflict; either split the group or ask which format wins.

Columns you do not declare are auto-detected by a background job queued at import time, so a freshly imported fact table may briefly show undetected columns in the UI. That is expected and does not block metric creation.

**Tier 2 (`consolidate` grouping only).** After exact grouping, look for groups whose SQL differs only by a `WHERE` clause. Propose merging them into one fact table using the broader (or unfiltered) SQL, and move each narrower variant's `WHERE` clause into that metric's `numerator.rowFilters` as an inline expression:

```json
{ "operator": "sql_expr", "values": ["device_type = 'mobile'"] }
```

Inline, not saved. A saved fact-table filter would be reusable in the UI, but it is a second resource to name, create, and reference by id, and nothing else in the migration needs it — leave `factTableFilters` empty and let the user promote a filter by hand later if they want one. Never merge silently: show the before-and-after SQL for each merge and get a per-group yes. If the SQL differs anywhere but the `WHERE` clause, do not propose it.

### 4. Map each legacy metric to a fact metric

One fact metric per migratable legacy metric.

**`id`** — deterministic and traceable: `fact__from_<legacy-id>`, e.g. `fact__from_met_abc123`. Bulk import prefixes `fact__` automatically when it is missing, so passing it explicitly just makes the payload match what gets created. Deterministic ids make the run idempotent.

**`replaces`** — the legacy metric ids this fact metric supersedes, e.g. `["met_abc123"]`. Set it on every migrated metric. It links the two definitions in the UI (the legacy metric's page points forward, the fact metric's page points back) and keeps experiment results rendering: when a snapshot predates the switch, the results page falls back to the replaced metric's numbers and flags the row. A funnel built from a denominator chain lists every legacy metric in the chain. The field is API-only and cannot contain the metric's own id.

**`metricType` and `numerator`**, from the legacy `type` and denominator:

| Legacy | Fact metric | `numerator` |
| --- | --- | --- |
| `binomial`, no denominator | `proportion` | `column: ""` — the server forces `$$distinctUsers` regardless |
| `count` / `duration` / `revenue`, no denominator | `mean` | `column: "value"`, `aggregation: "sum"` |
| any, one `count` denominator | `ratio` | `column: "value"`, `aggregation: "sum"`, plus a `denominator` object |
| any, one `binomial` denominator | `ratio` (default) | as above — for a `binomial` numerator use `column: ""` |
| chain of 2+ binomial denominators | `funnel` | none — funnel metrics reject both `numerator` and `denominator` |

Legacy metric SQL always names its numeric column `value`, which is why `"value"` is the faithful column for non-binomial metrics. A `count` metric whose SQL selects `1 as value` sums to a row count, so `sum` over `value` still reproduces it.

For `ratio`, the `denominator` object points at the denominator metric's **fact table** — resolve which group the denominator metric landed in during step 3 and use `{ "factTableId": "<that group's id>", "column": "value", "aggregation": "<the denominator's own mapped aggregation>" }`. Map that aggregation from the **denominator** legacy metric's `sql.userAggregationSQL` using the step 2 table, not from the numerator's — the two sides are independent, so a `SUM` numerator over a `MAX` denominator is a legitimate pairing that hardcoding `sum` would silently get wrong. A `binomial` denominator has no `value` column, so use `{ "factTableId": "<group id>", "column": "$$distinctUsers" }` for it and omit `aggregation`. If the denominator metric was blocked or needs-decision in step 2, the numerator metric cannot be migrated either; move it to needs-decision.

For `funnel` (a chain of two or more binomial denominators), build one metric with no numerator and no denominator, and an ordered `funnelSettings.steps` array running deepest-denominator-first:

```json
{
  "metricType": "funnel",
  "replaces": ["met_visited", "met_cart", "met_checkout"],
  "funnelSettings": {
    "steps": [
      { "name": "Visited Site", "factTableId": "ftb_migrated_pageviews", "rowFilters": [], "optional": false, "conversionWindow": null },
      { "name": "Viewed Cart",  "factTableId": "ftb_migrated_cart",      "rowFilters": [], "optional": false, "conversionWindow": null },
      { "name": "Checkout",     "factTableId": "ftb_migrated_checkout",  "rowFilters": [], "optional": false, "conversionWindow": null }
    ]
  }
}
```

Each step's `name` is the legacy metric it came from, and its `factTableId` is whichever step-3 group that metric's SQL landed in. `rowFilters`, `optional`, and `name` are all required on every step; `conversionWindow` is nullable. Minimum two steps. The chain's legacy conversion windows do not map onto funnel steps one-for-one — leave `conversionWindow` null and tell the user to set the per-step windows in the UI.

**Carry over the rest** from the legacy metric: `name`, `description`, `owner`, `projects`, `tags`, `inverse` (from `behavior.goal === "decrease"`), `cappingSettings`, and `windowSettings`. The window and capping shapes match the legacy `behavior` block field-for-field, so they copy across directly — except for capping on a `ratio` metric, which supports only `percentile`. The API will happily accept an `absolute` cap on a ratio metric — only the UI prevents it — so if a legacy metric heading for `ratio` has `absolute` capping, surface it and let the user choose percentile or no capping. Do not just pass it through.

**Also carry the decision settings.** Six values live under the legacy `behavior` block but are **top-level** fields on a fact metric, so they are easy to drop — and dropping them is silent, because the metric is then created with whatever the organization default happens to be:

| Legacy `behavior.*` | Fact metric (top level) |
| --- | --- |
| `minPercentChange` | `minPercentChange` |
| `maxPercentChange` | `maxPercentChange` |
| `minSampleSize` | `minSampleSize` |
| `targetMDE` | `targetMDE` |
| `riskThresholdSuccess` | `riskThresholdSuccess` |
| `riskThresholdDanger` | `riskThresholdDanger` |

The names match; only the nesting changes. Note that `GET /api/v1/metrics` always returns these populated — it substitutes the org default when the metric set none — so you cannot tell an explicit value from an inherited one. Copying them across is still the safe move: it pins the behavior the metric has today, which is what a migration should preserve.

Leave `priorSettings` and `regressionAdjustmentSettings` unset so the fact metrics inherit organization defaults, unless the legacy metric overrode them.

### 5. Build the bulk-import payload

One call creates everything, funnels included. Shape:

```json
{
  "dryRun": true,
  "defaultManagedBy": "",
  "factTables": [
    {
      "id": "ftb_migrated_purchases",
      "data": {
        "name": "Purchases",
        "datasource": "ds_abc123",
        "userIdTypes": ["user_id", "anonymous_id"],
        "sql": "SELECT user_id, anon_id as anonymous_id, received_at as timestamp, grand_total as value FROM purchases",
        "columns": [{ "column": "value", "datatype": "number", "numberFormat": "currency" }],
        "tags": ["revenue"]
      }
    }
  ],
  "factTableFilters": [],
  "factMetrics": [
    {
      "id": "fact__from_met_abc123",
      "data": {
        "name": "Revenue per User",
        "description": "Total revenue per user",
        "metricType": "mean",
        "numerator": { "factTableId": "ftb_migrated_purchases", "column": "value", "aggregation": "sum" },
        "replaces": ["met_abc123"],
        "tags": ["revenue"]
      }
    }
  ]
}
```

**Set `defaultManagedBy: ""`.** Without it every fact table and fact metric that omits `managedBy` is created as `"api"`, which disables editing in the GrowthBook UI. Filters inherit `"api"` only from an `"api"` parent table, so the one top-level field covers the whole payload.

Order does not matter within the payload; the handler processes fact tables, then filters, then metrics, and resolves `factTableId` references against tables created earlier in the same call.

Write the payload to a file so it is reviewable and re-runnable across steps 6 and 7.

### 6. Dry run and review gate

**Do not skip this.** Send the payload with `"dryRun": true` — it runs full validation, including column refs, premium-feature gates, and permissions, and writes nothing:

```bash
gb-call POST /api/v1/bulk-import/facts ./migration-payload.json
```

```json
{ "success": true, "dryRun": true, "factTablesAdded": 3, "factTablesUpdated": 0, "factTableFiltersAdded": 0, "factTableFiltersUpdated": 0, "factMetricsAdded": 12, "factMetricsUpdated": 0, "errors": [] }
```

**A `200` is not success.** A dry run collects every failing resource instead of stopping at the first, so branch on `success` and read `errors[]` — each entry names the `resourceType`, the `id`, and the `message`. Fix the payload and re-run the dry run until `errors` is empty. The counts tell you what a live run would write; any `*Updated` above zero means you are hitting an existing resource, which is expected on a re-run and a red flag on a first run.

Then show the user, before any write:

- Each proposed fact table: id, name, datasource, `userIdTypes`, the SQL, and which legacy metrics map onto it.
- Each proposed fact metric: legacy name and id → new id, `metricType`, numerator/denominator.
- Every metric in the needs-decision and blocked buckets, with the reason, plus any `managedBy: "config"` metrics that will migrate but not archive.
- **Under its own heading: every metric converting from a single binomial denominator to `ratio`.** State plainly that the legacy metric filtered to users who converted on the denominator first, that the fact metric divides two independently computed sides, and that the reported numbers will move. List them individually with their legacy and new ids, and offer a per-metric override to `funnel` (which becomes a two-step funnel: denominator, then numerator). Default to `ratio` for any the user does not call out.
- Each proposed funnel metric from a denominator chain, with its ordered steps and the legacy metrics it consolidates.
- Whether archiving is on, and how many metrics it will archive.
- For `consolidate` grouping, each proposed merge with before-and-after SQL.

Wait for explicit approval. If the user amends the grouping, return to step 3 and re-run the dry run.

### 7. Bulk-import the fact tables and fact metrics

Set `"dryRun": false` (or drop the field) and send the same payload:

```bash
gb-call POST /api/v1/bulk-import/facts ./migration-payload.json
```

The response repeats the dry run's shape with `"dryRun": false`. Check the counts against the payload.

#### 7a. Partial failure on bulk import

**This endpoint is not transactional.** A live run stops at the first failing resource and returns `400` (or `403` for a permission failure), leaving everything before it already created. The error body carries the same write counts plus `errors[]`, so it tells you exactly how far the run got — a non-2xx does not mean nothing happened.

Because ids are deterministic, a corrected re-run upserts the resources that landed and creates the rest. Fix the cause the error names, re-run the dry run to confirm it is clean, then re-run for real.

**Do not proceed to step 10.** Archiving legacy metrics whose replacements failed to import leaves the org with neither.

### 8. Verify what landed

```bash
gb-call GET '/api/v1/fact-metrics?limit=100'
```

Verify against what step 4 planned, not against the legacy metric list — the two are not one-to-one. For each **planned fact metric**, check it exists, and that `replaces` contains every legacy id it was meant to absorb.

- A metric migrated on its own has one `replaces` entry and a `numerator.factTableId` matching its intended fact table.
- A funnel built from a denominator chain **replaces every metric in the chain**, so one `fact__...` id covers two or more legacy ids. Expecting a `fact__from_<legacy-id>` per legacy metric here reports phantom failures for the other chain members. Check its `replaces` array holds the whole chain and its `funnelSettings.steps` are in the intended order; it has no `numerator` to check.

Build the legacy-id → fact-metric-id map from what actually exists, mapping **every** chain member to the single funnel id. Steps 9 and 10 use only verified pairs, so a chain member missing from `replaces` means that legacy metric does not get annotated or archived — which is the correct outcome, since its replacement is incomplete.

### 9. Update downstream metric consumers

Two things hold metric ids and keep working after the migration without ever pointing at the new fact metrics: **metric groups** and **experiment templates**.

#### 9a. Metric groups

Metric groups are datasource-scoped named bundles of metric ids at `/api/v1/metric-groups`; an experiment stores the **group id** in `goalMetrics` / `secondaryMetrics` / `guardrailMetrics` and expands it at read time.

Swap migrated ids in place. `replaces` covers the historical case: a snapshot taken before the swap holds the legacy id, and the results page renders it in the new metric's row with a "replaced by" flag until someone refreshes.

1. List the groups and find the ones containing metrics you migrated:

   ```bash
   gb-call GET /api/v1/metric-groups
   ```

   This endpoint takes **no query parameters** — the default `ApiModel` list validator is `z.never()`, so adding `limit`, `offset`, or `projectId` returns an error rather than filtering. It is unpaginated and returns every group in one call. Match client-side on `metrics[]` containing any migrated legacy id.

2. Write back the substituted list:

   ```bash
   echo '{"metrics":["fact__from_met_abc123","met_notmigrated"]}' | gb-call PUT /api/v1/metric-groups/mg_abc123 -
   ```

Members you did **not** migrate stay as their original legacy ids — a group may legitimately end up mixed.

**Two things to surface rather than decide.** A running experiment on the group starts measuring the fact metric on its next refresh; that is usually what the user wants, but changing metrics mid-flight is theirs to approve. And where a denominator chain collapsed into one funnel metric, a group that held all three legacy metrics becomes a group holding one funnel — the bundle's meaning changes, so call it out individually.

#### 9b. Experiment templates

Templates hard-code metric ids, and they are **by-value**. When `POST /api/v1/experiments` is called with a `templateId`, the handler spreads `templateToPostExperimentDefaults(template)` into the payload, the request body overrides it, and the *result* is persisted onto the experiment. `templateId` is retained as provenance only — nothing resolves metrics from the template at read time. **Editing a template therefore affects only experiments created afterwards.**

List them:

```bash
gb-call GET /api/v1/experiment-templates
```

The query schema is strict and accepts only `projectId` — there is no `limit`/`offset`, so this returns everything in one call.

Four fields can hold metric ids: `goalMetrics`, `secondaryMetrics`, `guardrailMetrics` (arrays), and `activationMetric` (a single string, not an array). Swap any migrated legacy id for its fact metric id and write back:

```bash
echo '{"goalMetrics":["fact__from_met_abc123"],"activationMetric":"fact__from_met_def456"}' | gb-call PUT /api/v1/experiment-templates/tmpl_abc123 -
```

`PUT` is a true partial patch — the update body is the create body `.partial()` — so send only the fields you are changing.

**Do not reach for the bulk endpoint here.** `POST /api/v1/experiment-templates/bulk-import` exists and takes `{templates: [{id, data}]}`, but its `data` is the **full create body**, not a partial: `templateMetadata`, `type`, `datasource`, `exposureQueryId`, `statsEngine`, and `targeting` are all required. Using it means round-tripping each template in full, and any field you fail to echo back is silently rewritten. One `PUT` per template is safer and templates are few.

**Templates can reference metric groups too.** These arrays are plain id lists, so a template may contain `mg_...` ids. Those groups were updated in 9a and need no further change here.

### 10. Archive the legacy metrics

Only for metrics whose replacement was verified in step 8, only if the user chose to archive, and never for `managedBy: "config"` metrics.

**Run the usage check for the whole batch in one call**, before touching anything:

```bash
gb-call GET '/api/v1/usage/metrics?ids=met_abc123,met_def456,met_ghi789'
```

This returns a `metricUsage[]` entry per id, each with an `experiments[]` array of `{experimentId, experimentStatus, lastSnapshotAttempt}`. There is no status filter — filter client-side for `experimentStatus === "running"`. Any entry with an `error` field set means the metric does not exist or you cannot read it; treat that as "do not archive" rather than "not in use".

Prefer this over the per-metric `GET /api/v1/metrics/:id/experiments`, for two reasons. It is one call instead of one per metric. And it **resolves metric groups** server-side — an experiment referencing a legacy metric through a group rather than directly still counts as usage. A reverse index built only from `GET /api/v1/experiments` misses those, because experiments store the unexpanded group id.

Batch the `ids` list to keep URLs manageable — around 50 ids per call — and mind that the server does one lookup per id, so a very large batch is slow even though it is a single request.

Any metric with a running experiment branches to 10a. Archive the rest one at a time:

```bash
echo '{"archived":true}' | gb-call PUT /api/v1/metrics/met_abc123 -
```

`PUT /api/v1/metrics/:id` is a true partial patch, so this leaves the SQL, type, description, and behavior untouched. The change is reversible — a later `PUT` with `archived: false` restores it — which is what makes this gate softer than a delete.

#### 10a. Legacy metric still used by a running experiment

Do not archive it. Archiving hides the metric and excludes it from new experiments, and swapping metrics under a running experiment mid-flight breaks the comparison. The fact metric's `replaces` already links the two, so nothing needs writing — collect these into a deferred list for step 11 with their experiment ids, and hand off to the **experiments** skill (`experiment-analyze` workflow) if the user wants to know how close those experiments are to done.

If you need the detail behind one blocker — variation-level results, filters, dates — `GET /api/v1/metrics/<legacy-id>/experiments` gives the per-metric view. It considers at most the 1000 most recent experiments using the metric, so on a very heavily used metric treat an empty result as "probably clear" rather than proof.

### 11. Report

Give the user:

- **Migrated** — legacy metric → fact metric, grouped by fact table, with the fact table's UI link (`<host>/fact-tables/<id>`). Derive `<host>` from `GB_API_URL` by swapping `api.` → `app.` (cloud default: `https://app.growthbook.io`).
- **Consolidation win** — how many legacy metrics collapsed onto how many fact tables.
- **Deferred** — migrated but not archived, with the blocking experiment ids (from 10a) or `managedBy: "config"` as the reason.
- **Needs a decision** — with the specific reason per metric from step 2, and what a human has to decide.
- **Blocked** — metrics with no usable SQL, with the reason each one cannot be migrated.
- **Metric groups and experiment templates** — which were updated. Note that template edits are forward-only: experiments already created from those templates keep their own copies of the old metric ids and are unaffected.
- **Behavior changes to review** — every metric that went from a single binomial denominator to a `ratio` fact metric (numbers will have moved; say so), every denominator chain consolidated into one funnel, and every `duration` metric whose unit you assumed.

Remind the user that archiving is reversible (`archived: false`) and that experiments referencing the legacy metrics keep their historical results.

## Guardrails

- **`GET /api/v1/metrics` includes archived metrics by default.** Pass `includeArchived=false` or you will re-migrate retired metrics.
- **Bulk import defaults `managedBy` to `"api"`, which locks the resource out of the UI.** Send `defaultManagedBy: ""` at the top level of the payload; a per-resource `managedBy` overrides it. Fact table filters inherit `"api"` only from an `"api"` parent table.
- **A `200` from a dry run is not success.** `dryRun: true` collects every failure instead of stopping at the first, and still returns `200` — branch on `success` and read `errors[]` (`resourceType`, `id`, `message`).
- **Bulk import is not transactional.** A live run stops at the first failure and returns `400` (`403` for permissions) with the write counts and `errors[]` — everything before that point is already created. Re-fetch, fix, dry-run, re-run; deterministic ids make the retry an upsert.
- **Funnel metrics take `funnelSettings` and reject `numerator` and `denominator`.** Sending either, or omitting `funnelSettings`, is a validation error. They also require the `funnel-metrics` premium feature, which the dry run reports per metric.
- **Ratio semantics changed — this is a math change, not a shape change.** A legacy metric with a binomial denominator behaved like a funnel: the denominator had to convert first, and only those users counted. A fact `ratio` computes both sides independently and divides, so the numbers move. `ratio` is still the right default for a single binomial denominator — it is the correction most users want — but it must be called out per metric in the dry run with a `funnel` override offered. A chain of two or more binomial denominators is a different case: that is a genuine ordered sequence and becomes a `funnel`.
- **Ratio metrics support only `percentile` capping, but the API does not enforce it.** Only the GrowthBook UI drops an absolute cap when a metric becomes a ratio; the API accepts `cappingSettings.type: "absolute"` on a ratio metric without complaint, leaving an unsupported configuration in place. Convert absolute caps to percentile or drop them yourself during step 4 — nothing downstream will catch it. (Legacy metrics also capped numerator and denominator separately; fact ratio metrics have one capping setting for the pair.)
- **`replaces` is what keeps historical results readable.** Without it, an experiment switched to the fact metric renders nothing for snapshots taken before the switch. Set it on every migrated metric, list the whole chain on a consolidated funnel, and never include the metric's own id. Replaced ids are not checked for existence, so a typo fails silently rather than erroring — verify it in step 8.
- **Custom aggregations do not exist in fact tables.** Only `sum`, `max`, and `count distinct`. Treat `sql.userAggregationSQL` of exactly `SUM(value)` as "none" — that is the value the API returns when a legacy metric set no aggregation — and anything else as unmigratable.
- **Builder-mode metrics have empty `sql.conversionSQL`.** When `sqlBuilder` is present, the SQL string is empty and the definition lives in `tableName` / `valueColumnName` / `conditions`. Grouping on SQL without excluding these merges every builder metric into one bogus fact table.
- **`managedBy: "config"` metrics cannot be archived.** The update path allows only `analysis`, `analysisError`, `queries`, and `runStarted` and throws on anything else. Migrate the definition, set `replaces` so the pointer shows on the legacy metric's page, and tell the user to retire the original in `config.yml`.
- **A fact table's datasource is immutable once it exists.** Importing an existing fact table id with a different `datasource` fails that resource. Check proposed ids against the existing fact tables first.
- **The server silently overrides `numerator.column` for `proportion` metrics** — it forces `$$distinctUsers` and clears `aggregation`, whatever you send. It does **not** error. So a copy-paste mistake that leaves `column: "value"` on a binomial-derived metric produces a *working but silently different* metric rather than a failure you'd notice. Send `""` as a deliberate placeholder — the server overwrites it with `$$distinctUsers`, which is what the stored metric will actually read, so do not expect the payload and the stored record to match here. The same override applies to `retention` and `dailyParticipation` (which forces `$$distinctDates`).
- **Fact table ids must match `^[-a-zA-Z0-9_]+$`.** Fact metric ids are auto-prefixed with `fact__` when the prefix is missing — pass it explicitly so the payload matches reality.
- **Deterministic ids are what make a re-run safe.** Bulk import upserts by id. Slug-derived or randomly generated ids turn a retry into a second set of duplicates.
- **Experiment templates are by-value; metric groups are by-reference. Do not treat them alike.** `POST /api/v1/experiments` spreads the template's defaults into the payload at creation and persists the result, keeping `templateId` only as provenance — so editing a template never touches an existing experiment. A metric group is resolved at read time, so editing one reaches backwards into how past experiments are rendered.
- **`POST /api/v1/experiment-templates/bulk-import` takes full create bodies, not partials.** Its `data` is `apiCreateExperimentTemplateBody` with `templateMetadata`, `type`, `datasource`, `exposureQueryId`, `statsEngine`, and `targeting` all required — so a partial round-trip silently rewrites the template. Use one `PUT /api/v1/experiment-templates/:id` per template instead; the update body is a true partial.
- **Archive is the destructive half; keep it last and gated.** Never archive before the replacement is verified to exist (step 8), and never archive a metric feeding a running experiment. It is reversible via `archived: false`, unlike a delete — which this workflow never performs.
- **The usage check only sees experiments the token can read.** `GET /api/v1/usage/metrics` says so explicitly: without admin or cross-project experiment read access, it may under-report. An under-report here means archiving a metric that is still feeding someone's running experiment. On a scoped PAT, say so in the step 11 report rather than presenting the usage check as exhaustive.
- **Rate limit is 60 rpm and step 10 is one write per metric.** With the batched usage check, a 100-metric migration is about 102 calls in step 10. Pace the loop and tell the user the call budget up front on large runs.
- **Column auto-detection is asynchronous.** Undeclared columns are filled in by a background job queued at import. A fact table can look incomplete in the UI for a short while after import; that is not a failed migration.

## Endpoints used

- `GET /api/v1/metrics` — legacy metric inventory (`limit`, `offset`, `datasourceId`, `projectId`, `includeArchived`)
- `GET /api/v1/metrics/:id` — full legacy definition when the list response is not enough
- `GET /api/v1/usage/metrics?ids=` — batched pre-archive safety check; resolves metric groups (preferred)
- `GET /api/v1/metrics/:id/experiments` — single-metric usage detail, for drilling into one blocker
- `PUT /api/v1/metrics/:id` — partial patch to set `archived`
- `POST /api/v1/bulk-import/facts` — validate with `dryRun: true`, then create the fact tables, filters, and fact metrics in one call
- `GET /api/v1/fact-metrics` — verify what landed
- `GET /api/v1/fact-tables` — detect id collisions before import
- `GET /api/v1/data-sources` — validate `userIdTypes` against the datasource
- `GET /api/v1/metric-groups` — find groups containing migrated legacy metrics (no query params; unpaginated)
- `PUT /api/v1/metric-groups/:id` — swap migrated ids into the group's `metrics`
- `GET /api/v1/experiment-templates` — list templates (`projectId` only; no pagination)
- `PUT /api/v1/experiment-templates/:id` — partial patch to swap metric ids in a template
- `GET /api/v1/projects` — resolve project names to ids for scoping

## Handoffs

- `references/metric-search.md` — to inventory or audit the metric catalog before migrating, or to confirm the result afterward
- `references/analytics-explore.md` — to chart a newly created fact metric and sanity-check it against the legacy numbers
- the **experiments** skill (`experiment-analyze` workflow) — when running experiments are blocking archival and the user wants to know how close they are to stopping
- the **experiments** skill (`experiment-design` workflow) — to start using the new fact metrics as goal or guardrail metrics
