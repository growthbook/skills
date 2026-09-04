---
name: analytics
description: Chart GrowthBook product data and manage the metric catalog — run Product Analytics explorations, search metrics and fact tables, create fact metrics and their fact tables, and migrate legacy metrics onto fact tables. Use for "show me signups by country", "chart daily active users", "how many orders last week", "find our revenue metric", "what fact tables exist", "create a metric", "add a revenue metric", "track conversion rate", "define a metric on the orders table", "migrate our legacy metrics", "move metrics to fact tables", or "convert met_ metrics". For an A/B test's results or choosing experiment metrics, use experiments. For feature flags, use feature-flags. For first-time API key configuration, use gb-setup.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *), Bash(sleep *)
---

# analytics

Domain router for GrowthBook Product Analytics and the metric catalog. The workflows live in `references/`. Read this router, pick one, then read that file and follow it.

Analytics uses the **v1 API** — `/api/v1/product-analytics/*-exploration` for charts, `/fact-metrics` and `/fact-tables` for the catalog.

All API calls go through the bundled helper. Under the Claude Code plugin install, it lives at `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call` (the plugin root). Under `npx skills install`, it lives at `scripts/gb-call` relative to this skill's directory. Resolve that path once and substitute it whenever a reference example says `gb-call`; do not assume `gb-call` is on `PATH`. It reads `GB_API_KEY` from the environment first, then falls back to `~/.config/growthbook/.env` (written by **gb-setup**); environment variables take precedence.

## Pick a workflow

| Read this | When the user wants to |
| --- | --- |
| `references/metric-search.md` | Browse, find, or audit metrics and fact tables — inventory, a specific definition, or "what can I chart" triage (read-only) |
| `references/metric-create.md` | Create a fact metric, creating its underlying fact table first when necessary (writes configuration) |
| `references/analytics-explore.md` | Actually run a chart and report the numbers plus a deep link |
| `references/metric-migrate.md` | Migrate legacy `met_...` metrics to fact tables and fact metrics, then archive the originals (writes heavily) |

When the user names a metric you have not resolved yet, read `metric-search.md` first. It hands `analytics-explore` or `metric-create` a stable definition. When they already named something concrete and just want the numbers, go straight to `analytics-explore.md`.

Both `metric-create` and `metric-migrate` write to the catalog: `metric-create` defines a new metric from scratch, `metric-migrate` mechanically ports ones that already exist as legacy metrics. When the user wants to *change* the catalog rather than read it — moving legacy metrics onto fact tables — that's `metric-migrate.md`. "We still have legacy metrics" is an audit (`metric-search`); "migrate our legacy metrics" is a migration (`metric-migrate`). If it's ambiguous, run the audit first and offer the migration.

## Shared conventions

- **Only fact metrics chart.** `fact__...` ids work in Product Analytics; legacy `met_...` metrics from `/api/v1/metrics` are valid experiment metrics but cannot be charted. Never promise a chart for one.
- **Explorations are datasource-scoped, and the datasource must be a SQL warehouse.** Mixpanel and Google Analytics datasources can't run explorations.
- **Pass ids, not display names, between workflows.** Names aren't unique. Fact metric ids always start `fact__`; fact table ids default to `ftb_...` but can be custom, so don't filter on that prefix.
- **There is no search endpoint** for metrics or fact tables — list and filter client-side, paginating at 100 per page.
- **Check before creating.** Prefer an existing official (`managedBy: "admin"`) metric over adding a duplicate with the same meaning.
- **A `200` from an exploration POST is not success.** The run is synchronous but errors are swallowed server-side: branch on `exploration.status` (`success` / `error` / `running`), and note that `cache=required` can return `exploration: null`.
- **Always set `unit` explicitly** on a metric exploration. A missing `unit` is not backfilled — it silently switches to event-level aggregation instead of erroring.
- **Restyling a chart is free.** Cache matching ignores `chartType`, so a different chart type on the same query is a cache hit. Never re-query just to restyle.
- **`GET /api/v1/metrics` includes archived metrics by default.** Pass `includeArchived=false` whenever you list legacy metrics to work with.
- **Bulk import defaults `managedBy` to `"api"`, which disables UI editing.** `POST /api/v1/bulk-import/facts` applies it to any fact table or fact metric that omits the field. Send `defaultManagedBy: ""` at the top level unless the user genuinely wants API-only resources.

## Read-only vs. write

`metric-search` is strictly read-only. `analytics-explore` runs warehouse queries but changes no GrowthBook configuration — it does not create metrics, fact tables, or dashboards. `metric-create` writes organization-visible fact-table and fact-metric definitions; it must show the payload and get confirmation before each POST.

Note that explorations execute real warehouse queries, so they cost the user money and time even though they write nothing. Scope them the way the reference file describes rather than fanning out speculatively.

`metric-migrate` is the one workflow here that writes, and it writes on both sides: it creates fact tables and fact metrics, then archives the legacy metrics they replace. Two gates are non-negotiable. **A `dryRun: true` import must come back clean and be approved before any write** — the user sees every proposed fact table, every mapping, and everything being left behind first. And **a legacy metric is never archived until its replacement is verified to exist**, nor while it still feeds a running experiment. Creating a metric from scratch, rather than as the equivalent of an existing legacy one, is `metric-create`.

## Handoffs

- The **experiments** skill — when the question is an A/B test readout, or when a chart surfaces something worth testing.
- The **feature-flags** skill — when the user pivots to shipping or gating the thing the data is about.
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`.
