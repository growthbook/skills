# CLAUDE.md

Guide for working on this repo. Read this before adding or modifying a skill.

## ⚠ Always verify against the GrowthBook source of truth

This is the most important rule in this file.

Every API payload, endpoint path, statistical recommendation, lifecycle claim, or "best practice" in any SKILL.md must be cross-checked against the canonical GrowthBook sources. The skills sit downstream of decisions made there, and have already drifted once — a 2026-05 audit found three broken endpoints, contradictory stats framing, and a regex claim that disagreed with the actual handler. **Never write or change a guardrail, payload shape, or recommendation in a skill without verifying it against at least one of these:**

These live in a local checkout of the GrowthBook monorepo, referred to below as `<growthbook>`. It's typically cloned as a sibling of this repo (i.e. `../growthbook`); if you don't find it there, ask where the checkout lives rather than guessing.

1. **Back-end source code** — `<growthbook>/packages/back-end/src/api/` and `<growthbook>/packages/shared/src/validators/`. The Zod validators here are the final authority on payload shapes, required fields, and accepted enum values. If docs and code disagree, the code wins.
2. **Docusaurus docs** — `<growthbook>/docs/docs/`. The canonical source for statistical methodology, lifecycle guidance, and "best practices we learned the hard way." Map of where things live:

   | Topic | Doc path |
   | --- | --- |
   | Feature flag basics, environments, rules | `docs/features/` |
   | Stale-flag detection criteria | `docs/features/stale-detection.mdx` |
   | Approval & publishing flows | `docs/features/publishing-and-approval-flows.mdx` |
   | Experiment lifecycle, A/A tests, durations | `docs/experiments.mdx`, `docs/running-experiments/` |
   | Stats engine (Bayesian default, frequentist) | `docs/statistics/overview.mdx` |
   | SRM, peeking, sequential testing | `docs/statistics/sequential.mdx`, `docs/statistics/power.mdx` |
   | Multiple-comparison correction | `docs/statistics/multiple-corrections.mdx` |
   | Six data-quality checks for analysis | `docs/experimentation-analysis/experiment-results.mdx` |
   | Decision framework (ship/roll back/review) | `docs/experimentation-analysis/decision-framework.mdx` |
   | Goal vs. secondary vs. guardrail metrics | `docs/metrics/`, `docs/experimentation-analysis/` |
   | Sticky bucketing (commercial) | `docs/sticky-bucketing.mdx` |
   | Bandits | `docs/bandits/` |
   | Common pitfalls (SRM causes, bots, etc.) | `docs/kb/experiments/troubleshooting-experiments.mdx`, `docs/faq.mdx` |
   | API conventions, auth, rate limit | `docs/api-overview.mdx` |

3. **OpenAPI spec generated from the validators** — regenerated via `pnpm --filter back-end generate-openapi` in the GrowthBook repo. Useful as a flat view of every endpoint + body schema.

### How to verify before editing a skill

- **For an endpoint path or payload shape:** grep `packages/back-end/src/api/<area>/` for the handler, then read the corresponding validator in `packages/shared/src/validators/`. The Zod schema is the contract.
- **For a statistical claim or interpretation rule:** read the relevant `docs/statistics/` or `docs/experimentation-analysis/` page. Don't translate intuition from other A/B testing tools — GrowthBook has its own defaults (Bayesian, no correction on guardrails, sequential testing widens CIs).
- **For "what's a footgun" or "what do we tell users":** check `docs/kb/` and `docs/faq.mdx`. These are where the team writes down lessons.
- **When docs and code disagree:** trust the code, flag the doc drift for the GrowthBook team in a separate note (not in the skill).

The Guardrails section of each SKILL.md is an API-quirk catalog disguised as policy. Every new entry should cite — in your reasoning, not necessarily in the file — which source confirmed it.

## What this repo is

A Claude Code plugin (`growthbook`) that also ships as standalone agent skills for GrowthBook feature flags and experimentation. Skills shell out to a small Node helper (`scripts/gb-call`) that calls the GrowthBook REST API directly. No MCP server, no build step, no runtime deps beyond Node 18+.

## Architecture in one breath

```
skills/<name>/SKILL.md             ← workflow + guardrails (the entire skill)
skills/<name>/scripts/gb-call      ← symlink → ../../scripts/gb-call (for npx-installed agents)
scripts/gb-call                    ← canonical helper; Claude plugin invokes this
.claude-plugin/                    ← plugin.json (manifest) + marketplace.json (listing)
```

Skills are pure markdown. The helper is the only executable code in the plugin. This is intentional — the v0.2.0 commit (`daac766`) pivoted away from MCP to keep the surface that small.

The per-skill `scripts/gb-call` entries are git symlinks — edit only the canonical `scripts/gb-call`. Never create copies in skill directories.

## The skill contract

Every `SKILL.md` follows this structure. Don't invent new sections — extend the existing ones.

```markdown
---
name: <kebab-case, matches directory>
description: <triggers + routing — see below>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# <skill-name>

<one-paragraph intent: what this skill does and what it deliberately doesn't>

All API calls go through the bundled helper. Under the Claude Code plugin install, it lives at `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call` (the plugin root). Under `npx skills install`, it lives at `scripts/gb-call` relative to this skill's directory. It expects `GB_API_KEY` in env.

## Workflow
<numbered steps, with bash + JSON shown literally>

## Guardrails
<bulleted footguns and policies the API does not enforce>

## Endpoints used
<flat list of every endpoint the skill touches>

## Handoffs
<sibling skills the user might want next, with the trigger>
```

### Frontmatter rules

- **`description` does routing, not labeling.** Include (a) concrete trigger phrases the user might say, and (b) explicit "For X, use Y skill" handoff hints. Look at any existing skill — the description is dense by design. It's what teaches Claude when *not* to fire.
- **`allowed-tools` is the security model.** Pin to `Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)` and nothing else, unless the skill genuinely needs another binary. Two existing exceptions: `experiment-analyze` allows `Bash(sleep *)` for its poll loop; `gb-setup` allows four file-management commands to write `~/.config/growthbook/.env`. New tool grants need a defensible reason.
- **When you do grant another binary, prefer literal full-command patterns over wildcards.** `Bash(chmod 600 ~/.config/growthbook/.env)` is a much narrower grant than `Bash(chmod *)` — the latter would allow `chmod 777 ~/.ssh/authorized_keys` if a prompt-injected response asked Claude to run it. Wildcards are only appropriate when the variable portion is genuinely unbounded (e.g. `Bash(sleep *)` where the arg is a duration). For everything else, write out each accepted invocation as its own allowlist entry.
- **Use `${CLAUDE_PLUGIN_ROOT}` for paths**, never relative paths. It resolves to the plugin's install directory at runtime.

### Workflow conventions

- **Number every step.** Long skills (`experiment-launch`) lead with a `- [ ]` checklist so Claude tracks progress through multi-step writes. Short skills skip it.
- **Show bash + JSON literally.** Copy-pasteable examples beat prose. The reader is Claude executing the skill, not a human reading docs.
- **Model failure modes as branches**, not as "see error handling section." `experiment-launch` step 6 → 6a (approval) → 6b (checklist) is the pattern: each branch tells the user how to re-run from where the skill stopped.
- **Write skills track required vs. optional inputs at the top.** Collect what's missing before any state-changing call.
- **Thread the draft version through chained write skills.** When multiple write skills run in sequence in the same session (e.g. flag-targeting then flag-toggle then flag-publish), each skill should use the `version` number captured by the previous step rather than relying on `version=new` to silently pick a draft. The pattern: if a version is already in context, substitute it for `new` in every endpoint path; if no version is in context (fresh invocation), fall back to `new` (auto-create/reuse) or `/revisions/latest?mine=true`. This makes draft threading explicit and prevents a teammate's concurrent draft from being unexpectedly reused mid-chain.

### Guardrails are an API-quirk catalog

The "Guardrails" section is where you document things the REST API will not enforce but that produce footguns. Treat each guardrail as a hard-won lesson — name *what* and *why*, and verify against the back-end source (see top-of-file rule) before adding. Existing examples worth modeling after:

- `winnerVariationId` on `experiment-stop` is a string variation ID (e.g. `var_abc123`), not an integer index, not a name (experiment-stop)
- `experiment-ref` rule's `variations[]` requires both `value` and `variationId` (experiment-launch)
- `defaultValue` is always serialized as a string (flag-create)
- The v2 features endpoint regex still accepts `[a-zA-Z0-9_.:|-]` even though docs recommend the narrower `[a-zA-Z0-9_-]` — kebab-case is the safe default (flag-create)
- Metrics must live on the experiment's datasource or POST fails (experiment-launch)
- Don't mix `templateId` with `datasourceId`/`assignmentQueryId` (experiment-launch)
- Multiple-comparison correction is frequentist-only and excludes guardrails (experiment-analyze)
- Bayesian (default engine) reports Chance to Win + Credible Intervals; frequentist reports CIs. Don't manufacture a p-value (experiment-analyze)
- `/start` failure body is the canonical source for "what's wrong" — there is no `start-checklist` GET (experiment-launch)
- The v2 rule-edit handler **rejects** explicit `type` changes but **auto-flips** `force` ↔ `rollout` based on effective coverage (flag-targeting)
- `experimentId` and `variations` on an `experiment-ref` rule are API-allowed but skill-gated (warn-and-confirm) because they cause silent drift between the flag rule and the experiment (flag-targeting)
- A `409` on revision publish means the draft's base is stale; don't auto-rebase, halt and let the user resolve (flag-targeting)
- `POST /v2/features/<id>` with `{archived: true|false}` is not a metadata patch — it triggers `createAndPublishRevision` server-side, so it has the same approval-required (403) and merge-conflict (409) failure modes as any v2 publish (flag-cleanup)
- Per-token `bypassApprovalChecks` authorizes archive but **not** delete; only the org-wide `restApiBypassesReviews` setting authorizes destructive actions. Explicit comment in `deleteFeature.ts`: "review-workflow bypass, not destructive-action override" (flag-cleanup)
- Feature delete unlinks experiments (clears `experiment.linkedFeatures` for any affected experiment) but doesn't delete the experiments themselves — their tracking keys are left pointing at a non-existent flag. Surface this so the user isn't surprised by stale `trackingKey` values in experiment history (flag-cleanup)
- Feature delete does **not** explicitly clean up holdout associations. A holdout's `linkedExperiments` may have stale references after a flag with a holdout is deleted. Warn the user when `feature.holdout` was present (flag-cleanup)
- The public product-analytics surface is exactly the three `/api/v1/product-analytics/*-exploration` POSTs — there is no search, columns, or column-values endpoint. Discovery goes through `/fact-metrics`, `/fact-tables`, and the information-schema endpoints, and a fact table's `columns[].topValues` is the only way to look up a column's values (analytics-explore, metric-search)
- A `200` from an exploration POST is not success — the run is synchronous but errors are swallowed server-side; branch on `exploration.status` (`success`/`error`/`running`), and `cache=required` can return `exploration: null` (analytics-explore)
- The server does **not** backfill a missing `unit` on a metric exploration value — a `null` unit on a mean/proportion/retention/dailyParticipation metric silently switches to event-level aggregation instead of erroring. Always set `unit` explicitly (analytics-explore)
- Exploration cache matching ignores `chartType` (`withRequestedChartType` swaps the requested type into the cached run) — restyling a chart is a free cache hit, never re-query for it (analytics-explore)

When a new API quirk bites you, add it here. Don't fix it by adding logic to `gb-call` — that helper stays dumb on purpose.

**Refuse, don't sanitize.** When a skill or `gb-call` encounters a value that's *sometimes wrong in ways the system can't safely fix* — a `GB_API_KEY` containing CRLF that would inject headers, a `GB_API_URL` with a path component that would mis-route every request — reject with a clear error rather than silently coercing. Silent fix-ups train users to trust that the system "just works" when the value is sometimes meaningfully wrong; explicit refusals keep the human in the loop. Existing examples: `gb-call`'s control-character check on `GB_API_KEY`/`GB_API_URL`, `gb-setup`'s URL-shape validation. Use this pattern any time the safe response to a malformed value is "tell the user to fix their input."

## Experiment skills: voice authority

`skills/experiment-launch/SKILL.md` was authored directly by GrowthBook's head of data science. **When `experiment-design` (or any other experiment skill) differs from `experiment-launch` on statistical framing, hypothesis discipline, goal-metric counts, guardrail requirements, or other methodology, align the other skill to `experiment-launch` — not the other way around.** The 2026-05-26 overreach review (`notes/skills-overreach-review.md`) caught one drift cycle; future edits should treat `experiment-launch` as the canonical voice on these topics.

If a change to `experiment-launch` itself seems warranted, that's a conversation to have with the head of data science before applying — don't unilaterally edit. The same caveat applies to anything in `experiment-launch`'s Guardrails or its statistical commentary in the workflow.

## Read vs. write discipline

Most skills are read-only or proposal-only. Only three currently write:

- `flag-create` — creates one flag
- `experiment-launch` — creates an experiment + flag rule + starts it
- `experiment-stop` — updates experiment status

Read-only and proposal-only skills must *say so* in the intro and enforce it in Guardrails ("Propose, do not create. Never POST to ..."). The boundary is in the skill content, not the tooling — both kinds of skills get the same `gb-call` access. Don't blur it.

## API version split

- **`/api/v2/`** for feature flags. Flat top-level `rules` array, narrowed ID character set, `owner` required on create, `defaultValue` as a string.
- **`/api/v1/`** for everything else (experiments, metrics, datasources, attributes, projects, environments, templates, snapshots).

When in doubt, check the existing skill that hits the closest endpoint. Don't migrate v1 endpoints to v2 without confirming the v2 surface exists and the shape matches.

## Secret handling

Two surfaces hold credentials: the env var or `~/.config/growthbook/.env` (PATs go in), and the conversation transcript (the user pastes a PAT into chat when running `/growthbook:gb-setup`). Neither can be retroactively redacted.

Conventions every skill must follow:

- **Never echo `GB_API_KEY` in user-facing output.** Mask to last 4 characters when surfacing identity. The skill's stdout/stderr lands in the user's transcript.
- **Some GrowthBook API responses contain secrets** (SDK keys, webhook signing keys, etc.). The current eight skills don't hit those endpoints. A future skill that does must filter the response before surfacing — don't dump the raw body to the user.
- **The `gb-setup` flow names the transcript-exposure risk explicitly** before the user pastes. Any future skill that prompts for a secret must do the same; users deserve to know before they paste.
- **Recommend scoped, revocable PATs** over personal admin tokens. If a value is ever exposed, the only effective fix is rotation at `<host>/account/personal-access-tokens`.

## Env var contract

Two vars drive every skill: `GB_API_KEY` (required), `GB_API_URL` (self-hosted only). The PAT is tied to a GrowthBook user, so write skills let the API attribute new flags/experiments to the token's user — there is no separate owner var to set. `gb-call` reads them from `process.env` first, then falls back to `~/.config/growthbook/.env` if a var is unset. **Env always wins over the file** — useful for CI and one-off overrides.

- Users get the file via `/growthbook:gb-setup`, which validates against `GET /api/v1/projects` and writes with `chmod 600`.
- Skills never read or write the file themselves — only `gb-call` and `gb-setup` touch it. If you find yourself adding env-var-reading logic to another skill, stop: the helper handles it.
- New env vars should be rare. Adding one means updating `gb-setup`, `gb-call`, the README, and every skill preamble. Prefer richer existing-var semantics (e.g. `GB_API_KEY` accepting both PATs and Secret Keys) over a new variable.

## The helper (`scripts/gb-call`)

Stays minimal on purpose. It is *one* Node file, *no* dependencies, uses built-in `fetch`. Reads env vars (with `.env` fallback), prints body to stdout on 2xx, prints a routing-aware error to stderr on non-2xx with exit 1.

The error catalog is small but load-bearing — each branch in `explainHttpError` translates an HTTP failure into a one-line "here's what to do" hint (usually pointing at `/growthbook:gb-setup`). When adding a new branch, keep two properties: (a) the synthesized message names a fix, not just a failure; (b) the raw response body is still printed underneath so power users can debug.

Resist the urge to add features. `scripts/README.md` lists what is **not in scope**:

- No retry / backoff (60 rpm rate limit; polling skills add their own delays)
- No pagination helper (skills loop `offset`/`limit` themselves)
- No response shape validation
- No multi-profile support (one `~/.config/growthbook/.env`, no `GB_PROFILE`)

Each of these gets added only when a real skill needs it. `experiment-analyze` will probably be the first caller that justifies retry/backoff.

## Naming and lifecycle

Skill names map to **what the user is doing**, not to API endpoints:

- Experiments: `brainstorm → design → launch → analyze → stop`
- Flags: `create`, `discovery` (today); `targeting`, `cleanup` (roadmap)

When proposing a new skill, name it after the user's intent. If you find yourself naming a skill after an endpoint (`flag-revisions-publish`), the scope is probably wrong — fold it into the lifecycle skill that uses it.

## Rate-limit awareness

GrowthBook is rate-limited at 60 rpm. Skills that fan out (brainstorm pulling 20 result sets, analyze polling for snapshot completion) should:

- Cap loop iterations explicitly (analyze caps at 60 iterations × 5s).
- Add `sleep` between polls when the polling target is async.
- Note the call budget in the Guardrails section when it's non-obvious.

## When in doubt

- Read `flag-create` for the minimal write-skill pattern.
- Read `flag-discovery` for the read-only / multi-path pattern.
- Read `experiment-launch` for the full state-machine-with-failure-branches pattern.
- Read `gb-setup` for the pattern when a skill needs file operations and broader `allowed-tools` — including how to narrow each tool grant to a literal command and how to surface secret-handling risks to the user before they paste.
- Read `flag-targeting` for two patterns it pioneers: (a) the **warn-and-confirm** guardrail layer — for changes the server allows but the user shouldn't make lightly, like editing `experimentId` on an experiment-ref rule; and (b) the **merge-conflict (409) branch** — halt with the conflict body, don't auto-rebase, let the user resolve in the UI.
- Read `flag-cleanup` for three patterns it pioneers: (a) the **agent-mediated code-cleanup** flow — skill workflow coordinates code edits via Read/Edit on the user's working tree, batched by file, without expanding `allowed-tools` beyond gb-call; (b) the **archive-then-verify-then-delete safety gate** — a product-safety pause between two API calls (not the workflow-safety of approval), because permanent deletion is a one-way door; (c) the **bypass-asymmetry** awareness — per-token `bypassApprovalChecks` authorizes some destructive paths but not others, and the skill needs to surface this when offering bypass options.
- Read `scripts/README.md` before extending the helper.
