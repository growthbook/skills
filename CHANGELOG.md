# Changelog

All notable changes to the `growthbook` plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.1.0] — 2026-04-29

Initial public release. Three MCP-only skills built on the [GrowthBook MCP server](https://github.com/growthbook/growthbook-mcp).

### Added
- `flag-create` — create a feature flag with collision check, project resolution, and the "created disabled" guardrail.
- `flag-discovery` — list, inspect, or audit feature flags. Read-only. Routes across `list_feature_keys`, `get_feature_flags`, and `get_stale_feature_flags`.
- `experiment-brainstorm` — propose new experiment ideas grounded in past stopped-experiment history via `get_experiments` summary mode.
- `.claude-plugin/marketplace.json` (`growthbook-skills`) and `.claude-plugin/plugin.json` (`growthbook` v0.1.0).
- README with MCP install, plugin install, and invocation guidance.

### Roadmap
- Flag lifecycle: `flag-targeting`, `flag-cleanup`.
- Experiment lifecycle: `experiment-design`, `experiment-launch`, `experiment-analyze`, `experiment-stop`.
- Metrics: `metric-choose`, `metric-create`, `metric-instrument`.
- Onboarding: `onboarding`, `mcp-configure`, `sdk-install`.
- Knowledge: `sdk-developer`, `experiment-statistics`.

[0.1.0]: https://github.com/growthbook/skills/releases/tag/v0.1.0
