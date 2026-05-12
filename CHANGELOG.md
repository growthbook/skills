# Changelog

All notable changes to the `growthbook` plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.3.0] — 2026-05-08

Adds the experiment lifecycle. Four new skills covering design through stop. The flag side stays where it is (create + discovery); flag-targeting and flag-cleanup are still on the roadmap.

### Added
- `experiment-design` — knowledge-led walk-through of hypothesis, variations, primary metric, guardrails, and sample-size sanity. Reads `/v1/metrics`, `/v1/fact-metrics`, `/v1/projects`, `/v1/data-sources`. Ends with a structured spec; does not write.
- `experiment-launch` — end-to-end launch covering template selection, hash-attribute → datasource → assignment-query resolution, experiment create, flag create-or-reuse with compatibility checks, atomic draft+rule via `POST /v2/features/<id>/revisions/new/rules`, and `POST /v1/experiments/<id>/start` to publish the draft and flip the experiment to running. Handles the approval-required and pre-launch-checklist failure paths explicitly (steps 6a and 6b in the skill body).
- `experiment-analyze` — triggers a snapshot, polls `/v1/experiment-snapshots/<id>/status` (5s interval, 60-iteration cap), then interprets `/v1/experiments/<id>/results`. SRM check first, primary metric, guardrails, secondaries. Read-only.
- `experiment-stop` — updates experiment status via `POST /v1/experiments/<id>`, optionally declaring a winner. Bakes in the documented footgun: `winner` is a 0-based integer index, not a name or key.

### Roadmap (still pending)
- Flag lifecycle: `flag-targeting`, `flag-cleanup`.
- Metrics: `metric-choose`, `metric-create`, `metric-instrument`.
- Onboarding: `onboarding`, `sdk-install`.
- Knowledge: `sdk-developer`, `experiment-statistics`.

## [0.2.1] — 2026-05-08

Switches the feature-flag skills to GrowthBook's v2 feature endpoints. The v2 surface is now the recommended path; v1 still works but is treated as legacy by the docs.

### Changed
- `flag-create` and `flag-discovery` now call `/api/v2/features`, `/api/v2/feature-keys`, `/api/v2/features/{id}`, and `/api/v2/stale-features` (project, environment, and other resources stay on v1 — they have no v2 form yet).
- `flag-create` payload updated for the v2 shape: `owner` is now required; the per-environment `rules` array is removed (rules in v2 are a flat top-level array with `allEnvironments` / `environments` scope).
- `flag-create` guidance: feature-flag IDs in v2 accept only `[a-zA-Z0-9_-]`. The MCP era allowed `.`, `:`, `|` — those no longer pass v2 validation. Kebab-case remains the recommendation.
- README install step adds `GB_EMAIL` as a required env var (used to populate the v2 `owner` field).

## [0.2.0] — 2026-05-08

**Architecture change: REST-only.** The plugin no longer depends on the GrowthBook MCP server. Skills call the GrowthBook REST API directly through a small bundled Node helper.

### Added
- `scripts/gb-call` — minimal Node REST client used by every skill. Reads `GB_API_KEY` from env. ~60 lines, no dependencies, uses Node 18+ built-in `fetch`.
- `scripts/README.md` — helper usage reference.

### Changed
- `flag-create`, `flag-discovery`, `experiment-brainstorm` rewritten to call REST endpoints via `gb-call`. Workflows expanded to handle steps the MCP server used to do for us (environment map construction, project resolution, experiment summary aggregation).
- README install instructions: removed the MCP install step; added the `GB_API_KEY` env-var setup and a note about the bundled helper.
- `plugin.json` description updated to reflect REST-only.
- `mcp-onboarding` is removed from the roadmap; `sdk-install` and a top-level `onboarding` skill remain.

### Removed
- MCP server dependency. Skills no longer reference `mcp__growthbook__*` permission rules.
- The `when_to_use` frontmatter field (already removed in 0.1.1 description tightening; noted here for completeness).

### Migration from 0.1.x
Uninstall the GrowthBook MCP server if you installed it just for this plugin:
```bash
claude mcp remove growthbook
```
Set `GB_API_KEY` in your environment (and `GB_API_URL` if self-hosted), then reinstall the plugin. Slash commands and skill names are unchanged.

## [0.1.0] — 2026-04-29

Initial public release. Three MCP-only skills built on the [GrowthBook MCP server](https://github.com/growthbook/growthbook-mcp).

### Added
- `flag-create` — create a feature flag with collision check, project resolution, and the "created disabled" guardrail.
- `flag-discovery` — list, inspect, or audit feature flags. Read-only. Routes across `list_feature_keys`, `get_feature_flags`, and `get_stale_feature_flags`.
- `experiment-brainstorm` — propose new experiment ideas grounded in past stopped-experiment history via `get_experiments` summary mode.
- `.claude-plugin/marketplace.json` (`growthbook-skills`) and `.claude-plugin/plugin.json` (`growthbook` v0.1.0).
- README with MCP install, plugin install, and invocation guidance.

### Roadmap (still pending)
- Flag lifecycle: `flag-targeting`, `flag-cleanup`.
- Experiment lifecycle: `experiment-design`, `experiment-launch`, `experiment-analyze`, `experiment-stop`.
- Metrics: `metric-choose`, `metric-create`, `metric-instrument`.
- Onboarding: `onboarding`, `sdk-install`.
- Knowledge: `sdk-developer`, `experiment-statistics`.

[0.3.0]: https://github.com/growthbook/skills/releases/tag/v0.3.0
[0.2.1]: https://github.com/growthbook/skills/releases/tag/v0.2.1
[0.2.0]: https://github.com/growthbook/skills/releases/tag/v0.2.0
[0.1.0]: https://github.com/growthbook/skills/releases/tag/v0.1.0
