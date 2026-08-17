---
name: metric-search
description: Search, list, and audit GrowthBook metrics and fact tables. Use when the user asks "what metrics do we have", "find our revenue metric", "what fact tables exist", "which metrics are official", "what can I chart", "show me metrics tagged growth", "what columns does the orders fact table have", or "audit our metrics". Read-only — for actually charting a metric, use analytics-explore. For designing an experiment around a metric, use experiment-design.
---

# metric-search

Search, list, and audit GrowthBook metrics and fact tables. Three jobs share this skill: inventory ("what do we have?"), lookup ("find the revenue metric and show me its definition"), and chartability triage ("what can I actually explore?"). It is the discovery front door for `references/analytics-explore.md` and for experiment design.

Read-only — this skill never writes.

## Workflow

Pick the path that matches the user's request.

### Path A — Inventory ("what metrics / fact tables do we have?")

There is no search endpoint; list and filter client-side.

```bash
gb-call GET '/api/v1/fact-metrics?limit=100'
gb-call GET '/api/v1/fact-tables?limit=100'
```

Both paginate with `limit`/`offset` (loop while `hasMore` is true) and accept `datasourceId` and `projectId` filters; `/fact-metrics` also accepts `factTableId`. Scope to a datasource when the user is heading toward charting — explorations are datasource-scoped.

Present the inventory grouped by fact table (metrics hang off their `numerator.factTableId`), with each metric's `metricType` and a one-line description. Flag `managedBy: "admin"` entries as **official** — vetted definitions the org manages centrally; prefer them when several similar metrics exist.

For completeness on older orgs, legacy metrics live at:

```bash
gb-call GET '/api/v1/metrics?limit=100'
```

List them separately and label them: legacy metrics work in experiments but **cannot be charted in Product Analytics** — only fact metrics can.

### Path B — Lookup and detail ("find the revenue metric", "what's in the orders fact table?")

Fetch the list (Path A) and match client-side by name — matching is on your side, so try substrings and synonyms before declaring a miss ("purchase" for "order", "signup" for "registration").

Then pull the full definition:

```bash
gb-call GET /api/v1/fact-metrics/fact__abc123
gb-call GET /api/v1/fact-tables/ftb_abc123
```

Surface for a metric: `metricType` (`mean`, `proportion`, `retention`, `dailyParticipation`, `ratio`, `quantile`), `numerator` (fact table, column, aggregation, row filters), `denominator` (ratio metrics), `inverse`, and window/capping settings when they change interpretation. For a fact table: `userIdTypes`, `sql`, and `columns[]` — each column has `column`, `datatype`, `deleted`, and for string columns `topValues` (the observed values, refreshed by a background job).

### Path C — Chartability triage ("what can I chart?", pre-analytics audit)

Answer three questions per candidate:

1. **Is it a fact metric?** Only `fact__...` IDs chart in Product Analytics. Legacy `met_...` metrics don't.
2. **Is its datasource a SQL warehouse?** Cross-check `datasource` against `GET /api/v1/data-sources` — Mixpanel and Google Analytics datasources can't run explorations.
3. **Does mixing work?** On one chart, ratio metrics can't mix with non-ratio metrics, and quantile metrics can't mix with anything. All other types mix freely.

Report the chartable set and hand off to `references/analytics-explore.md` to actually run one.

## Guardrails

- **Read-only.** Never POST, PUT, or DELETE from this skill. Route chart-running to `references/analytics-explore.md` and metric creation to the GrowthBook UI.
- **There is no server-side search.** `/fact-metrics` and `/fact-tables` have no name/query param — fetch and filter client-side. On large orgs paginate the full set first (100 per page), and mind the 60 rpm rate limit.
- **"Official" is `managedBy: "admin"`.** There is no `official` field on the API response — the Official badge in the GrowthBook UI corresponds to `managedBy: "admin"`. `"api"` means managed by API automation; `""` means anyone can edit it in the UI.
- **Legacy metrics are not chartable.** `/api/v1/metrics` entries work as experiment metrics but Product Analytics explorations only accept fact metrics. Don't promise a chart for one.
- **Ignore `deleted: true` columns** on fact tables — they're soft-deleted leftovers from schema refreshes and can't be used in values, filters, or dimensions.
- **`topValues` can be stale or absent.** It's populated by a background job for string columns only. Treat it as a hint at what values exist, not a complete or current enumeration.
- **IDs are stable handles; names aren't unique.** When handing off to `references/analytics-explore.md` or to the **experiments** skill (`experiment-design` workflow), pass the `id`, not the display name. Fact metric IDs always start `fact__`; fact table IDs default to `ftb_...` but can be custom (API-created tables often are), so don't filter by prefix.

## Endpoints used

- `GET /api/v1/fact-metrics` — paginated fact metric list (`datasourceId`, `factTableId`, `projectId`, `limit`, `offset`)
- `GET /api/v1/fact-metrics/:id` — full metric definition
- `GET /api/v1/fact-tables` — paginated fact table list (`datasourceId`, `projectId`, `limit`, `offset`)
- `GET /api/v1/fact-tables/:id` — columns, `userIdTypes`, `topValues`, SQL
- `GET /api/v1/metrics` — legacy metrics, listed for completeness only
- `GET /api/v1/data-sources` — datasource types for chartability triage
- `GET /api/v1/projects` — resolve project name to ID for project-scoped listings

## Handoffs

- `references/analytics-explore.md` — to chart a metric or fact table found here
- the **experiments** skill (`experiment-design` workflow) — to pick goal/guardrail metrics for a new experiment
- the **experiments** skill (`experiment-analyze` workflow) — when the user's question is about an experiment's metric results, not the metric catalog
