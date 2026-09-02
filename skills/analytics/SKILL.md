---
name: analytics
description: Chart GrowthBook product data, browse the metric catalog, or query the warehouse directly — run a Product Analytics exploration over a fact metric, fact table, or raw warehouse table, search metrics and fact tables, or fall back to ad-hoc SQL. Use when the user asks "show me signups by country", "chart daily active users", "how many orders last week", "plot revenue over time", "break that down by plan", "what metrics do we have", "find our revenue metric", "what fact tables exist", "which metrics are official", "what columns does the orders fact table have", "what tables contain user data", "run a SQL query", or any "show me / chart / plot / how many" question about product data. For an A/B test's results, use the experiments skill — this skill is general analytics, not experiment readouts. For feature flags, use the feature-flags skill. For first-time API key configuration, use gb-setup.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *), Bash(sleep *)
---

# analytics

Domain router for GrowthBook Product Analytics and the metric catalog. Both workflows live in `references/`. Read this router, pick one, then read that file and follow it.

Analytics uses the **v1 API** — `/api/v1/product-analytics/*-exploration` for charts, `/fact-metrics` and `/fact-tables` for the catalog.

All API calls go through the bundled helper. Under the Claude Code plugin install, it lives at `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call` (the plugin root). Under `npx skills install`, it lives at `scripts/gb-call` relative to this skill's directory. Resolve that path once and substitute it whenever a reference example says `gb-call`; do not assume `gb-call` is on `PATH`. It reads `GB_API_KEY` from the environment first, then falls back to `~/.config/growthbook/.env` (written by **gb-setup**); environment variables take precedence.

## Pick a workflow

| Read this | When the user wants to |
| --- | --- |
| `references/metric-search.md` | Browse, find, or audit metrics and fact tables — inventory, a specific definition, or "what can I chart" triage (read-only) |
| `references/analytics-explore.md` | Actually run a chart and report the numbers plus a deep link |
| `references/sql-query.md` | Run ad-hoc SQL against the warehouse when no metric or exploration can answer the question (last resort) |

When the user names a metric you haven't resolved yet, read `metric-search.md` first — it's the discovery front door and hands `analytics-explore` a stable `fact__...` id. When they've already named something concrete and just want the numbers, go straight to `analytics-explore.md`. Use `sql-query.md` only when the question can't be answered with existing metrics or the exploration config — custom joins, unmodeled tables, or aggregations the exploration can't express.

## Shared conventions

- **Only fact metrics chart.** `fact__...` ids work in Product Analytics; legacy `met_...` metrics from `/api/v1/metrics` are valid experiment metrics but cannot be charted. Never promise a chart for one.
- **Explorations are datasource-scoped, and the datasource must be a SQL warehouse.** Mixpanel and Google Analytics datasources can't run explorations.
- **Pass ids, not display names, between workflows.** Names aren't unique. Fact metric ids always start `fact__`; fact table ids default to `ftb_...` but can be custom, so don't filter on that prefix.
- **There is no search endpoint** for metrics or fact tables — list and filter client-side, paginating at 100 per page.
- **A `200` from an exploration POST is not success.** The run is synchronous but errors are swallowed server-side: branch on `exploration.status` (`success` / `error` / `running`), and note that `cache=required` can return `exploration: null`.
- **Always set `unit` explicitly** on a metric exploration. A missing `unit` is not backfilled — it silently switches to event-level aggregation instead of erroring.
- **Restyling a chart is free.** Cache matching ignores `chartType`, so a different chart type on the same query is a cache hit. Never re-query just to restyle.

## Read-only vs. write

`metric-search` is strictly read-only. `analytics-explore` runs warehouse queries but changes no GrowthBook configuration — it does not create metrics, fact tables, or dashboards, and must not start. Metric and fact-table creation belong in the GrowthBook UI.

Note that explorations execute real warehouse queries, so they cost the user money and time even though they write nothing. Scope them the way the reference file describes rather than fanning out speculatively.

## Handoffs

- The **ask-data** skill — when no metric or exploration can answer the question and the user needs direct SQL against the warehouse (custom joins, unmodeled tables, complex aggregations). Try `metric-search` and `analytics-explore` first.
- The **experiments** skill — when the question is an A/B test readout, or when a chart surfaces something worth testing.
- The **feature-flags** skill — when the user pivots to shipping or gating the thing the data is about.
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`.
