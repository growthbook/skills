---
name: analytics
description: Chart GrowthBook product data and manage the metric catalog — run Product Analytics explorations, search metrics and fact tables, or create fact metrics and their fact tables. Use for "show me signups by country", "chart daily active users", "how many orders last week", "find our revenue metric", "what fact tables exist", "create a metric", "add a revenue metric", "track conversion rate", or "define a metric on the orders table". For an A/B test's results or choosing experiment metrics, use experiments. For feature flags, use feature-flags. For first-time API key configuration, use gb-setup.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *), Bash(sleep *)
---

# analytics

Domain router for GrowthBook Product Analytics and the metric catalog. The workflows live in `references/`. Read this router, pick one, then read that file and follow it.

Analytics uses the **v1 API** — `/api/v1/product-analytics/search`, `/columns`, and `/column-values` for discovery, four `/api/v1/product-analytics/*-exploration` endpoints for charts, and `/api/v1/product-analytics/explorations/:id` for polling.

All API calls go through the bundled helper. Under the Claude Code plugin install, it lives at `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call` (the plugin root). Under `npx skills install`, it lives at `scripts/gb-call` relative to this skill's directory. Resolve that path once and substitute it whenever a reference example says `gb-call`; do not assume `gb-call` is on `PATH`. It reads `GB_API_KEY` from the environment first, then falls back to `~/.config/growthbook/.env` (written by **gb-setup**); environment variables take precedence.

## Pick a workflow

| Read this                         | When the user wants to                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `references/metric-search.md`     | Browse, find, or audit metrics and fact tables — inventory, a specific definition, or "what can I chart" triage (read-only) |
| `references/metric-create.md`     | Create a fact metric, creating its underlying fact table first when necessary (writes configuration)                       |
| `references/analytics-explore.md` | Actually run a chart and report the numbers plus a deep link                                                                |

When the user names a metric you have not resolved yet, read `metric-search.md` first. It hands `analytics-explore` or `metric-create` a stable definition. When they already named something concrete and just want the numbers, go straight to `analytics-explore.md`.

## Shared conventions

- **Only fact metrics chart.** `fact__...` ids work in Product Analytics; legacy `met_...` metrics from `/api/v1/metrics` are valid experiment metrics but cannot be charted. Never promise a chart for one.
- **Explorations are datasource-scoped, and the datasource must be a SQL warehouse.** Mixpanel and Google Analytics datasources can't run explorations.
- **Pass ids, not display names, between workflows.** Names aren't unique. Fact metric ids always start `fact__`; fact table ids default to `ftb_...` but can be custom, so don't filter on that prefix.
- **Discover before constructing.** Use Product Analytics search and columns, and call column-values before using any concrete filter or breakdown value. Never guess a value.
- **Check before creating.** Prefer an existing `official: true` metric over adding a duplicate with the same meaning.
- **A `200` from an exploration POST is not necessarily success.** Branch on `exploration.status`; poll `running` explorations by id, surface `error`, and note that `cache=required` can return `exploration: null`.
- **Handle workflow-endpoint 404s conservatively.** A 404 from `/product-analytics/search` means the server predates these endpoints. On `/columns`, `/column-values`, or `/explorations/:id`, it can also mean the resource is missing or inaccessible. Surface the failure and stop; never probe around access checks, substitute an undocumented endpoint, or re-POST a running exploration.
- **Use the returned full result rows for numeric insights.** Do not infer values from a chart preview, truncated summary, or config.
- **Run at most one successful chart per user turn.** Discovery, polling, and one empty-result retry are allowed; once one non-empty exploration succeeds, answer from it unless the user explicitly asks for another chart in a later turn.
- **Always set `unit` explicitly** on a metric exploration. A missing `unit` is not backfilled — it silently switches to event-level aggregation instead of erroring.
- **Restyling a chart is free.** Cache matching ignores `chartType`, so a different chart type on the same query is a cache hit. Never re-query just to restyle.

## Read-only vs. write

`metric-search` is strictly read-only. `analytics-explore` runs warehouse queries but changes no GrowthBook configuration — it does not create metrics, fact tables, or dashboards. `metric-create` writes organization-visible fact-table and fact-metric definitions; it must show the payload and get confirmation before each POST.

Note that explorations execute real warehouse queries, so they cost the user money and time even though they write nothing. Scope them the way the reference file describes rather than fanning out speculatively.

## Handoffs

- The **experiments** skill — when the question is an A/B test readout, or when a chart surfaces something worth testing.
- The **feature-flags** skill — when the user pivots to shipping or gating the thing the data is about.
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`.
