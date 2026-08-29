---
name: analytics
description: Chart GrowthBook product data, browse the metric catalog, and migrate legacy metrics to fact tables — run a Product Analytics exploration over a fact metric, fact table, or raw warehouse table, search metrics and fact tables, and convert legacy met_ metrics into fact tables and fact metrics. Use when the user asks "show me signups by country", "chart daily active users", "how many orders last week", "plot revenue over time", "break that down by plan", "what metrics do we have", "find our revenue metric", "what fact tables exist", "migrate our legacy metrics", "move metrics to fact tables", "convert met_ metrics", "consolidate our metric SQL", or any "show me / chart / plot / how many" question about product data. For an A/B test's results, use the experiments skill — this skill is general analytics, not experiment readouts. For feature flags, use the feature-flags skill. For first-time API key configuration, use gb-setup.
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
| `references/metric-migrate.md` | Migrate legacy `met_...` metrics to fact tables and fact metrics, then archive the originals (writes heavily) |

When the user names a metric you haven't resolved yet, read `metric-search.md` first — it's the discovery front door and hands `analytics-explore` a stable `fact__...` id. When they've already named something concrete and just want the numbers, go straight to `analytics-explore.md`.

When the user wants to *change* the catalog rather than read it — moving legacy metrics onto fact tables — that's `metric-migrate.md`. "We still have legacy metrics" is an audit (`metric-search`); "migrate our legacy metrics" is a migration (`metric-migrate`). If it's ambiguous, run the audit first and offer the migration.

## Shared conventions

- **Only fact metrics chart.** `fact__...` ids work in Product Analytics; legacy `met_...` metrics from `/api/v1/metrics` are valid experiment metrics but cannot be charted. Never promise a chart for one.
- **Explorations are datasource-scoped, and the datasource must be a SQL warehouse.** Mixpanel and Google Analytics datasources can't run explorations.
- **Pass ids, not display names, between workflows.** Names aren't unique. Fact metric ids always start `fact__`; fact table ids default to `ftb_...` but can be custom, so don't filter on that prefix.
- **There is no search endpoint** for metrics or fact tables — list and filter client-side, paginating at 100 per page.
- **A `200` from an exploration POST is not success.** The run is synchronous but errors are swallowed server-side: branch on `exploration.status` (`success` / `error` / `running`), and note that `cache=required` can return `exploration: null`.
- **Always set `unit` explicitly** on a metric exploration. A missing `unit` is not backfilled — it silently switches to event-level aggregation instead of erroring.
- **Restyling a chart is free.** Cache matching ignores `chartType`, so a different chart type on the same query is a cache hit. Never re-query just to restyle.
- **`GET /api/v1/metrics` includes archived metrics by default.** Pass `includeArchived=false` whenever you list legacy metrics to work with.
- **Bulk import defaults `managedBy` to `"api"`, which disables UI editing.** `POST /api/v1/bulk-import/facts` applies it to any fact table or fact metric that omits the field. Send `defaultManagedBy: ""` at the top level unless the user genuinely wants API-only resources.

## Read-only vs. write

`metric-search` is strictly read-only. `analytics-explore` runs warehouse queries but changes no GrowthBook configuration — it does not create metrics, fact tables, or dashboards, and must not start.

Note that explorations execute real warehouse queries, so they cost the user money and time even though they write nothing. Scope them the way the reference file describes rather than fanning out speculatively.

`metric-migrate` is the one workflow here that writes, and it writes on both sides: it creates fact tables and fact metrics, then archives the legacy metrics they replace. Two gates are non-negotiable. **A `dryRun: true` import must come back clean and be approved before any write** — the user sees every proposed fact table, every mapping, and everything being left behind first. And **a legacy metric is never archived until its replacement is verified to exist**, nor while it still feeds a running experiment. Ad-hoc metric creation outside a migration still belongs in the GrowthBook UI.

## Handoffs

- The **experiments** skill — when the question is an A/B test readout, or when a chart surfaces something worth testing.
- The **feature-flags** skill — when the user pivots to shipping or gating the thing the data is about.
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`.
