---
name: feature-flags
description: Read and modify GrowthBook feature flags — create, search, toggle, target, schedule, ramp, monitor, publish drafts, and archive. Use when the user mentions a feature flag, feature toggle, kill switch, rollout, targeting rule, percentage release, saved group, prerequisite, draft revision, flag approval, or flag cleanup. Triggers include "create a flag for X", "release this to 10% of users", "turn on flag X in production", "gradually roll this out", "publish this draft", "what flags do we have", "who needs to approve this", and "delete this stale flag". For designing, launching, analyzing, or stopping an A/B test, use the experiments skill. For charting product data or browsing the metric catalog, use the analytics skill. For first-time API key configuration, use gb-setup.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# feature-flags

Domain router for GrowthBook feature flags. Every flag workflow lives in a reference file under `references/`. Read this router, pick the workflow that matches the user's intent, then read that one file and follow it.

Flags use the **v2 API** (`/api/v2/features`). Environments, projects, and saved groups are v1.

All API calls go through the bundled helper. Under the Claude Code plugin install, it lives at `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call` (the plugin root). Under `npx skills install`, it lives at `scripts/gb-call` relative to this skill's directory. Resolve that path once and substitute it whenever a reference example says `gb-call`; do not assume `gb-call` is on `PATH`. It reads `GB_API_KEY` from the environment first, then falls back to `~/.config/growthbook/.env` (written by **gb-setup**); environment variables take precedence.

## Pick a workflow

Read exactly one of these, based on what the user is doing. If two look plausible, read the more specific one.

| Read this | When the user wants to |
| --- | --- |
| `references/flag-create.md` | Create a new flag |
| `references/flag-search.md` | Find, list, or audit flags — by project, tag, owner, environment state, or staleness (read-only) |
| `references/flag-graph.md` | Trace what a flag depends on, what depends on it, and its linked experiments or holdouts (read-only) |
| `references/flag-toggle.md` | Enable or disable a flag in an environment — the kill switch |
| `references/flag-targeting.md` | Add, edit, or remove force / rollout rules, conditions, saved groups, rule-level prerequisites |
| `references/flag-rules.md` | List, reorder, or delete rules, or route to the right rule-type workflow |
| `references/flag-experiment.md` | Add an experiment-ref rule so an A/B test runs through the flag |
| `references/flag-schedule.md` | Time-gate a rule with a start and/or end datetime |
| `references/flag-ramp.md` | Build or drive a multi-step ramp schedule (progressive coverage over time) |
| `references/flag-monitoring.md` | Set up a monitored / safe rollout — a ramp plus guardrail metrics and optional auto-rollback |
| `references/flag-prerequisites.md` | Gate the whole flag on another boolean flag |
| `references/flag-default-value.md` | Change the value served when no rules match |
| `references/flag-metadata.md` | Change description, owner, project, tags, custom fields, or JSON schema |
| `references/flag-revisions.md` | See what drafts are open, who owns them, start or discard a draft |
| `references/flag-review.md` | Request a review, or approve / request changes / comment on a draft |
| `references/flag-publish.md` | Publish a draft, resolve a merge conflict, revert, or discard |
| `references/flag-cleanup.md` | Archive or delete a stale flag, inlining its value at code sites first |

Ambiguity worth resolving before you read: "turn off the flag" is `flag-toggle` if they mean the whole environment, `flag-rules` if they mean one rule. "Roll this out" is `flag-targeting` for a one-shot percentage, `flag-ramp` for a schedule, `flag-monitoring` if guardrail metrics should gate it.

## Shared conventions

These hold across every flag workflow. The reference files assume them.

- **Everything writes through a draft revision.** Rules, metadata, default value, and toggles all create or update a draft, which then has to be published. `flag-publish` owns the publish step; the write workflows hand off to it.
- **Thread the draft version through a chain.** When several write workflows run in sequence in one session, carry the `version` returned by the previous step instead of re-sending `new`. `new` auto-creates or reuses a draft, which can silently pick up a teammate's concurrent draft mid-chain. Only fall back to `new` (or `/revisions/latest?mine=true`) on a fresh start.
- **POSTing `rules` replaces the entire array.** The v2 rules array is top-level and scoped by `environments` or `allEnvironments`. GET the current rules first for any partial edit.
- **`defaultValue` is always a string,** whatever the flag's value type.
- **Show users the flag key** (the `id`), never an internal Mongo id. Link to `<host>/features/<key>`.
- **Print deep links, don't open them.** This skill has no browser grant on purpose — surface the URL and let the user click.

### Failure modes

Verified against the back-end handlers; don't collapse these into one another.

- **400 on the publish endpoint** means approval is required (`This revision requires approval before publishing`). The policy gate is working as intended — hand to `references/flag-review.md`.
- **403 on a path that publishes as a side effect** means the same thing, from a different code path: the environment toggle and `POST /v2/features/<id>` with `{archived}` both go through `createAndPublishRevision`, which raises a permission error rather than a bad-request error. Read the body — if it doesn't mention review, the token lacks permission outright and the problem is `GB_API_KEY`.
- **409 on publish** means the draft's base is stale — the live flag moved. Do not auto-rebase. Halt, show the conflict, let the user resolve it.
- **422 on publish** means a publish gate is blocking. The body lists which gates a plain `ignoreWarnings` retry would clear and which need a permission instead.

## Read-only vs. write

`flag-search` and `flag-graph` are read-only and must stay that way — they never POST, PUT, or DELETE. Every other workflow writes, and each one states its own confirmation requirements. `flag-cleanup`'s archive-then-verify-then-delete gate is a product-safety pause, not a mutation confirmation: don't skip it even when the user sounds certain.

## Budget

GrowthBook rate-limits at 60 rpm. `flag-search` and `flag-graph` fan out across paginated lists — cap loops explicitly and mention the call budget when it's non-obvious.

## Handoffs

- The **experiments** skill — designing, launching, analyzing, or stopping an A/B test. A flag's experiment-ref rule is this skill's business; the experiment itself is not.
- The **analytics** skill — charting product data or browsing metrics and fact tables.
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`.
