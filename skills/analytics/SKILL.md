---
name: analytics
description: Chart GrowthBook product data, build Analytics dashboards, and manage the metric catalog — run Product Analytics explorations, save charts together on a dashboard, search metrics and fact tables, or create fact metrics and their fact tables. Use for "show me signups by country", "chart daily active users", "how many orders last week", "build me a dashboard", "put these metrics on a dashboard", "add a chart to this dashboard", "set up reporting for X", "find our revenue metric", "what fact tables exist", "create a metric", or "define a metric on the orders table". For an A/B test's results or choosing experiment metrics, use experiments. For feature flags, use feature-flags. For first-time API key configuration, use gb-setup.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *), Bash(sleep *)
---

# analytics

Domain router for GrowthBook Product Analytics, Analytics dashboards, and the metric catalog. The workflows live in `references/`. Read this router, pick one, then read that file and follow it.

Analytics uses the **v1 API** — `/api/v1/product-analytics/*-exploration` for charts, `/dashboards` for saved pages of charts, and `/fact-metrics` and `/fact-tables` for the catalog.

All API calls go through the bundled helper. Under the Claude Code plugin install, it lives at `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call` (the plugin root). Under `npx skills install`, it lives at `scripts/gb-call` relative to this skill's directory. Resolve that path once and substitute it whenever a reference example says `gb-call`; do not assume `gb-call` is on `PATH`. It reads `GB_API_KEY` from the environment first, then falls back to `~/.config/growthbook/.env` (written by **gb-setup**); environment variables take precedence.

## Pick a workflow

| Read this | When the user wants to |
| --- | --- |
| `references/metric-search.md` | Browse, find, or audit metrics and fact tables — inventory, a specific definition, or "what can I chart" triage (read-only) |
| `references/metric-create.md` | Create a fact metric, creating its underlying fact table first when necessary (writes configuration) |
| `references/analytics-explore.md` | Actually run a chart and report the numbers plus a deep link |
| `references/dashboard-create.md` | Build a new dashboard — several charts saved together on one page (writes a dashboard) |
| `references/dashboard-edit.md` | Change a dashboard that already exists: add or remove a chart, swap a metric, change the timeframe, rename it |

When the user names a metric you have not resolved yet, read `metric-search.md` first. It hands `analytics-explore` or `metric-create` a stable definition. When they already named something concrete and just want the numbers, go straight to `analytics-explore.md`.

One chart or several? A single question gets one chart from `analytics-explore`. "Track", "monitor", "reporting", or two or more things to watch together means a dashboard. Route on whether the dashboard exists: no id yet is `dashboard-create`, an id is `dashboard-edit`.

## Shared conventions

- **Only fact metrics chart.** `fact__...` ids work in Product Analytics; legacy `met_...` metrics from `/api/v1/metrics` are valid experiment metrics but cannot be charted. Never promise a chart for one.
- **Explorations are datasource-scoped, and the datasource must be a SQL warehouse.** Mixpanel and Google Analytics datasources can't run explorations.
- **Pass ids, not display names, between workflows.** Names aren't unique. Fact metric ids always start `fact__`; fact table ids default to `ftb_...` but can be custom, so don't filter on that prefix.
- **There is no search endpoint** for metrics or fact tables — list and filter client-side, paginating at 100 per page.
- **Check before creating.** Prefer an existing official (`managedBy: "admin"`) metric over adding a duplicate with the same meaning.
- **A `200` from an exploration POST is not success.** The run is synchronous but errors are swallowed server-side: branch on `exploration.status` (`success` / `error` / `running`), and note that `cache=required` can return `exploration: null`.
- **Always set `unit` explicitly** on every `dataset.values[]` entry — that is the only level that takes one; a `unit` on the config itself is rejected. A missing `unit` is not backfilled — it silently switches to event-level aggregation instead of erroring.
- **A date range's `predefined` is a closed list**, everywhere one appears: `today`, `yesterday`, `last7Days`, `last30Days`, `last90Days`, `last12Months`, `lastCalendarYear`, `customLookback`, `customDateRange`. Any other name is rejected, so every window outside the list is `customLookback` with `lookbackValue` and `lookbackUnit` (`hour`, `day`, `week`, `month`).
- **Restyling a chart is free.** Cache matching ignores `chartType`, so a different chart type on the same query is a cache hit. Never re-query just to restyle.
- **A dashboard's chart blocks carry a `config`, not a result.** The create and update calls run every chart server-side, so never POST an exploration first just to get an id for a tile.
- **An update replaces a dashboard's whole block list.** Read the dashboard in the same turn you write it, and list every tile being kept — but carry an unchanged one as `{ "id": "dshblk_…" }` rather than copying it back in full.
- **Dashboards are not scoped to a datasource** the way metrics and explorations are, but every chart on one is.

## Read-only vs. write

`metric-search` is strictly read-only. `analytics-explore` runs warehouse queries but changes no GrowthBook configuration — it does not create metrics, fact tables, or dashboards. `metric-create` writes organization-visible fact-table and fact-metric definitions, and `dashboard-create` / `dashboard-edit` write dashboards; all three must summarize the change in plain language and get confirmation before each write.

Note that explorations execute real warehouse queries, so they cost the user money and time even though they write nothing — and a dashboard write runs one per chart block. Scope them the way the reference files describe rather than fanning out speculatively.

## Handoffs

- The **experiments** skill — when the question is an A/B test readout, or when a chart surfaces something worth testing.
- The **feature-flags** skill — when the user pivots to shipping or gating the thing the data is about.
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`.
