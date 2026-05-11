# Changelog

All notable changes to the `growthbook` plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

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

[0.2.0]: https://github.com/growthbook/skills/releases/tag/v0.2.0
[0.1.0]: https://github.com/growthbook/skills/releases/tag/v0.1.0
