# Changelog

All notable changes to the `growthbook` plugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [2.0.0] — Unreleased

### Changed — BREAKING: 25 skills reorganized into 4 domain skills

The plugin now ships **four** skills — `feature-flags`, `experiments`, `analytics`, and `gb-setup` — instead of 25 flat ones. Each domain skill is a router: its `SKILL.md` carries the description, a workflow index, and the conventions shared across that domain, and the individual workflows moved into `references/<workflow>.md` inside it. Nothing was dropped; all 24 non-setup workflows survive with their steps, guardrails, and endpoint lists intact.

**Why.** Skill frontmatter is always loaded into the agent's system prompt, whether or not you mention GrowthBook. Twenty-five descriptions cost 14.3 KB of context up front, and because the namespace was flat, each description also had to explain when to use its siblings instead. The four routers cost 2.9 KB, an 80% cut, and the sibling routing moved into the router body where it loads only on demand. This is the [three-level progressive disclosure model](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) the Agent Skills guidance describes: frontmatter, then `SKILL.md` body, then bundled files. The previous layout used the first two levels and none of the third.

**What changes.** Domain slash commands still work, but the 24 workflow-level slash commands are no longer registered or autocompleted. Invoke the domain skill, then state the workflow intent:

| Was | Now |
| --- | --- |
| `/growthbook:flag-*` (17 commands) | `/growthbook:feature-flags`, then say what you want |
| `/growthbook:experiment-*` (5 commands) | `/growthbook:experiments`, then say what you want |
| `/growthbook:metric-search`, `/growthbook:analytics-explore` | `/growthbook:analytics`, then say what you want |
| `/growthbook:gb-setup` | unchanged |

Automatic invocation is unaffected — describe the task and the right domain skill still fires, then reads the matching workflow. Scripted or aliased invocations of a workflow name need updating.

**Also changed:**
- Reference files longer than 100 lines gained a `## Contents` index, so a partial read still shows the file's full scope.
- The `open`/`xdg-open` deep-link blocks in `flag-publish`, `flag-review`, `flag-ramp`, and `flag-monitoring` now print the URL instead of opening a browser. This removes the `Bash(open https://*)` grant, which under a router would otherwise have applied to all 17 flag workflows rather than the 4 that used it. `experiments` and `analytics` keep `Bash(sleep *)` for their poll loops.
- Documented the approval-failure split that the workflows had right but never explained: the **explicit** publish endpoint returns **400** (`BadRequestError` in `postFeatureRevisionPublish.ts`), while paths that publish as a *side effect* return **403** (`PermissionError` from `createAndPublishRevision`) — the environment toggle and `POST /v2/features/<id>` with `{archived}`. The `feature-flags` router now states both, plus 409 (stale base) and 422 (`PublishBlockedError`, whose body distinguishes gates an `ignoreWarnings` retry clears from gates needing a permission).
- Clarified bandit scope: the GrowthBook REST API supports multi-armed bandit experiments and separate Enterprise beta Contextual Bandits, but the current experiment workflows operate standard A/B tests only and halt on either bandit type.

### Changed
- Experiment skills now use the filtering/sorting params added to `GET /api/v1/experiments` in [growthbook#6418](https://github.com/growthbook/growthbook/pull/6418) — `q`, `owner`, `result`, `tag`, `implementationType`, `metricId`, `bandits`, `archived`, `sortBy`, `sortOrder` (on Cloud now; self-hosted needs a release later than v5.0.0):
  - `experiment-brainstorm` pulls history newest-first via `sortBy=dateCreated&sortOrder=desc` (previously the API's fixed oldest-first order silently grounded proposals in the oldest experiments on multi-page orgs), and scopes pulls with `tag` / `projectId` / `owner` / `result` / `metricId` / `implementationType` when the user narrows the ask, plus optional `bandits=false` so per-arm bandit results don't distort the win-rate tally. Corrected the page-size claim: `limit` caps at 100, not 50.
  - `experiment-analyze` and `experiment-stop` gain a resolve-by-name entry point (`?q=<text>`, matching name / tracking key / description / hypothesis) for when the user doesn't have the experiment ID, plus a guardrail documenting that `q` rejects negation and comparison operators with a 400.
  - Guardrails for two naming traps the endpoint's shape invites: `result` is the *recorded* result and is retained if a stopped experiment is restarted (so `result=won` can return running experiments — keep `status=stopped`), and bandits are filtered with `bandits`, not `type` (there is no `type` list param; `implementationType` filters the linked-change kind instead, a different axis from the response's `type` field).

## [1.1.0] — 2026-06-01

### Removed
- `GB_EMAIL` env var and config option. The `GB_API_KEY` PAT is tied to a GrowthBook user, so the API attributes flags and experiments the write skills create to the token's user automatically. `flag-create` and `experiment-launch` now omit `owner` from their create payloads; `flag-metadata` still accepts an explicit `owner` (email or `u_...` userId) for assigning to someone else.

### Changed
- Personal Access Token management URL corrected to `/account/personal-access-tokens` (was `/settings/keys`) in the README, `gb-setup`, and `CLAUDE.md`.

## [1.0.0] — 2026-06-01

Major expansion: the feature flag side of the plugin grows from 2 skills to 19, covering the full lifecycle from draft creation through cleanup. The architecture is unchanged — all skills call the REST API through `gb-call`.

### Added

**Revision lifecycle**
- `flag-revisions` — list and inspect open drafts, check approval status, create or discard drafts.
- `flag-review` — request an approval review on a draft, or submit a review (approve / request-changes / comment).
- `flag-publish` — publish a draft, resolve merge conflicts (rebase field-by-field), discard, or revert to a prior revision.

**Flag operations**
- `flag-metadata` — update description, owner, project, tags, custom fields, or JSON schema via draft revision.
- `flag-default-value` — change the fallback value served when no rules match.
- `flag-toggle` — enable or disable a flag in a specific environment (the env-level kill switch). Review-gated happy path.
- `flag-prerequisites` — gate an entire flag on another boolean flag being on. Enforces boolean-flag-only constraint that the backend leaves permissive.

**Rules**
- `flag-rules` — entry point: list rules in evaluation order, delete a rule, reorder, or route to the right specialized skill.
- `flag-schedule` — add a timed start and/or end to a rule using ISO 8601 with timezone offset. Handles DST, natural-language date resolution, and defaultValue off-state verification.
- `flag-ramp` — multi-step ramp schedule with per-step intervals or hold-for-approval gates. Full live ramp management: start, pause, resume, advance, approve-step, rollback, restart, complete.
- `flag-monitoring` — monitored progressive rollout ("safe rollout"): ramp schedule with guardrail metric monitoring and optional auto-rollback. Covers status checks, step approval, guardrail response, and UI drill-down.
- `flag-experiment` — add an experiment-ref rule to a flag. Handles flag-first and experiment-first flows; routes to `experiment-launch` when no experiment exists yet (which detects and reuses the existing flag).

**Discovery**
- `flag-search` — search, list, and audit flags by project, tag, owner, environment state, or staleness. Full `StaleFeatureReason` interpretation table.
- `flag-graph` — trace a flag's dependency graph: prerequisites, reverse dependents, linked experiments, holdout associations.

### Changed
- `flag-targeting` — narrowed scope to force/rollout rules only (env-toggle moved to `flag-toggle`; experiment-ref moved to `flag-experiment`). Added full operator reference table for MongoDB-style conditions including case-insensitive variants (`$ini`, `$nini`, `$regexi`, `$notRegexi`, `$alli`), `$includes`/`$notIncludes`, `$empty`/`$notEmpty`, `$inGroup`/`$notInGroup`. Attribute list fetched upfront with `?projectId` scoping. Three targeting properties (condition, savedGroups, prerequisites) documented as separate rule fields.
- `flag-cleanup` — updated to detect active temporary rollouts (uses winner value as inline replacement, not `defaultValue`); references `flag-search` instead of retired `flag-discovery`; full post-cleanup handoffs.
- `experiment-launch` — description clarifies it handles the flag-first path (detects and reuses an existing flag via the 409/reuse path).
- `experiment-stop` — expanded post-stop flag disposition: three concrete paths for with/without temporary rollout. Full handoff chain to `flag-rules`, `flag-targeting`, `flag-default-value`, `flag-cleanup`.
- `plugin.json` bumped to `1.0.0`; descriptions in `marketplace.json` and `plugin.json` rewritten to reflect the full suite.
- README rewritten: full skill tables for all families, updated layout, two composition chains (experiment-first, flag-first).

### Removed
- `flag-discovery` — retired; content absorbed into `flag-search` and `flag-graph`.
- `notes/roadmap.md` — removed.
- Deprecated rule types `type: "experiment"` (inline) and `type: "safe-rollout"` removed from all skill content. Safe rollout concept preserved as a monitored ramp schedule.

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

[1.0.0]: https://github.com/growthbook/skills/releases/tag/v1.0.0
[0.3.0]: https://github.com/growthbook/skills/releases/tag/v0.3.0
[0.2.1]: https://github.com/growthbook/skills/releases/tag/v0.2.1
[0.2.0]: https://github.com/growthbook/skills/releases/tag/v0.2.0
[0.1.0]: https://github.com/growthbook/skills/releases/tag/v0.1.0
