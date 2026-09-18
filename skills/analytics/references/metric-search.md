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

Use Product Analytics search. Pass an empty `query` to browse, or a short search term to filter. Scope by datasource when the user is heading toward charting.

```bash
gb-call GET '/api/v1/product-analytics/search?query=&limit=20&skip=0'
gb-call GET '/api/v1/product-analytics/search?query=revenue&datasourceId=<ds_id>&limit=20&skip=0'
```

Paginate with `skip`/`limit` until `skip + matches.length >= totalMatches`. Search matches metric and fact-table names, descriptions, owners, tags, and IDs. Keep terms short and focused; if a specific query misses, broaden it or try a synonym before declaring there is no match.

Each match includes `kind`, `explorerType`, `id`, `name`, and `official`; metric matches also include `type`, description, owner, and tags. Present useful identifying details, group by `kind`, and prefer `official: true` when several resources could answer the question.

Search returns only resources supported by Product Analytics. If the user explicitly asks for legacy experiment metrics, hand off to the **experiments** skill instead of mixing them into this inventory.

### Path B — Lookup and detail ("find the revenue metric", "what's in the orders fact table?")

Search by name, then use the selected match's stable `id`. When the user asks for its definition or an audit, fetch the selected resource's full model:

```bash
gb-call GET /api/v1/fact-metrics/fact__abc123
gb-call GET /api/v1/fact-tables/ftb_abc123
```

For a metric, surface its type, numerator and denominator logic, aggregation, row and aggregate filters, inverse direction, and material analysis settings. For a fact table, surface its event definition, identifier types, SQL, and active columns. Do not fetch every full model during a broad inventory; use these detail calls after selecting a resource.

To inspect what can be grouped or filtered in Product Analytics, call the columns endpoint:

```bash
gb-call GET '/api/v1/product-analytics/columns?source=metric&metricIds=fact__abc123'
gb-call GET '/api/v1/product-analytics/columns?source=fact_table&factTableId=ftb_abc123'
```

For metrics, pass all selected IDs as a comma-separated `metricIds` query value. The response returns the intersection of usable columns, `userIdTypes`, per-metric `needsUnit` information, and a `unitNote`. For fact tables it returns usable columns, `userIdTypes`, and a `unitNote`. Keep these chartability fields distinct from the full definition returned by the detail endpoints.

### Path C — Chartability triage ("what can I chart?", pre-analytics audit)

Answer three questions per candidate:

1. **Did Product Analytics search return it?** Search results are the chartable catalog; use the returned `explorerType` to choose metric or fact-table exploration.
2. **Does the datasource support exploration?** Scope search with `datasourceId` and cross-check `GET /api/v1/data-sources` — Mixpanel and Google Analytics datasources cannot run SQL explorations.
3. **Are the required columns and units available?** Call `/columns` for the selected resource and follow its `unitNote`; do not infer them from a name.

Report the chartable set and hand off to `references/analytics-explore.md` to actually run one.

## Guardrails

- **Read-only.** Never POST, PUT, or DELETE from this skill. Route chart-running to `references/analytics-explore.md` and metric creation to `references/metric-create.md`.
- **Use server-side Product Analytics search.** Pass an empty query to browse and short terms to filter. Its hard maximum is `limit=20`; never substitute a generic page size such as 50 or 100. Paginate with `skip`, and mind the 60 rpm rate limit.
- **Treat 404s conservatively.** A 404 from `/product-analytics/search` means the server predates these workflow endpoints. On `/columns`, it can also mean the resource is missing or inaccessible. Surface the failure and stop; do not invent replacement paths or probe around access checks.
- **Trust `official`.** The search response exposes the vetted-resource signal directly; prefer `official: true` when equivalent choices exist.
- **Search is discovery, not definition detail.** Use the matching fact-metric or fact-table detail GET after selecting a resource for lookup or audit. Use `/columns` separately for Product Analytics columns and units.
- **Never guess values.** This workflow does not query warehouse values because it is strictly read-only. If the user needs a concrete filter or breakdown value, hand off to `references/analytics-explore.md`, which must call `POST /column-values`.
- **Legacy metrics are not chartable.** `/api/v1/metrics` entries work as experiment metrics but Product Analytics explorations only accept fact metrics. Don't promise a chart for one.
- **IDs are stable handles; names aren't unique.** When handing off, pass the returned `id` and `explorerType`, not the display name.

## Endpoints used

- `GET /api/v1/product-analytics/search` — search or browse chartable metrics and fact tables (`query`, `datasourceId`, `limit`, `skip`)
- `GET /api/v1/product-analytics/columns` — usable columns and unit requirements (`source`, plus `factTableId` or comma-separated `metricIds`)
- `GET /api/v1/fact-metrics/:id` — full fact-metric definition for lookup and audit
- `GET /api/v1/fact-tables/:id` — full fact-table definition for lookup and audit
- `GET /api/v1/data-sources` — datasource types for chartability triage

## Handoffs

- `references/analytics-explore.md` — to chart a metric or fact table found here
- `references/metric-create.md` — when the metric the user needs does not exist yet
- `references/sql-query.md` — when no metric or fact table covers the question and the user needs direct SQL against the warehouse
- the **experiments** skill (`experiment-design` workflow) — to pick goal/guardrail metrics for a new experiment
- the **experiments** skill (`experiment-analyze` workflow) — when the user's question is about an experiment's metric results, not the metric catalog
