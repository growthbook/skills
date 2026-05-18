# CLAUDE.md

Guide for working on this repo. Read this before adding or modifying a skill.

## ⚠ Always verify against the GrowthBook source of truth

This is the most important rule in this file.

Every API payload, endpoint path, statistical recommendation, lifecycle claim, or "best practice" in any SKILL.md must be cross-checked against the canonical GrowthBook sources. The skills sit downstream of decisions made there, and have already drifted once — a 2026-05 audit found three broken endpoints, contradictory stats framing, and a regex claim that disagreed with the actual handler. **Never write or change a guardrail, payload shape, or recommendation in a skill without verifying it against at least one of these:**

1. **Back-end source code** — `/Users/scott/projects/growthbook/packages/back-end/src/api/` and `/Users/scott/projects/growthbook/packages/shared/src/validators/`. The Zod validators here are the final authority on payload shapes, required fields, and accepted enum values. If docs and code disagree, the code wins.
2. **Docusaurus docs** — `/Users/scott/projects/growthbook/docs/docs/`. The canonical source for statistical methodology, lifecycle guidance, and "best practices we learned the hard way." Map of where things live:

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

A Claude Code plugin (`growthbook`) that ships agent skills for GrowthBook feature flags and experimentation. Skills shell out to a small Node helper (`scripts/gb-call`) that calls the GrowthBook REST API directly. No MCP server, no build step, no runtime deps beyond Node 18+.

## Architecture in one breath

```
skills/<name>/SKILL.md   ← workflow + guardrails (the entire skill)
scripts/gb-call          ← only thing skills are allowed to shell out to
.claude-plugin/          ← plugin.json (manifest) + marketplace.json (listing)
```

Skills are pure markdown. The helper is the only executable code in the plugin. This is intentional — the v0.2.0 commit (`daac766`) pivoted away from MCP to keep the surface that small.

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

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`.
It expects `GB_API_KEY` [and `GB_EMAIL`, if writing flags] in env.

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
- **`allowed-tools` is the security model.** Pin to `Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)` and nothing else, unless the skill genuinely needs another binary. The only existing exception is `experiment-analyze`, which also allows `Bash(sleep *)` for its poll loop. New tool grants need a defensible reason.
- **Use `${CLAUDE_PLUGIN_ROOT}` for paths**, never relative paths. It resolves to the plugin's install directory at runtime.

### Workflow conventions

- **Number every step.** Long skills (`experiment-launch`) lead with a `- [ ]` checklist so Claude tracks progress through multi-step writes. Short skills skip it.
- **Show bash + JSON literally.** Copy-pasteable examples beat prose. The reader is Claude executing the skill, not a human reading docs.
- **Model failure modes as branches**, not as "see error handling section." `experiment-launch` step 6 → 6a (approval) → 6b (checklist) is the pattern: each branch tells the user how to re-run from where the skill stopped.
- **Write skills track required vs. optional inputs at the top.** Collect what's missing before any state-changing call.

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

When a new API quirk bites you, add it here. Don't fix it by adding logic to `gb-call` — that helper stays dumb on purpose.

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

## The helper (`scripts/gb-call`)

Stays minimal on purpose. It is *one* Node file, *no* dependencies, uses built-in `fetch`. Reads `GB_API_KEY` + optional `GB_API_URL` from env, prints body to stdout on 2xx, status + body to stderr on non-2xx with exit 1.

Resist the urge to add features. Specifically, `scripts/README.md` lists what is **not in scope**:

- No retry / backoff (60 rpm rate limit; polling skills add their own delays)
- No pagination helper (skills loop `offset`/`limit` themselves)
- No response shape validation

Each of these gets added only when a real skill needs it. `experiment-analyze` will probably be the first caller that justifies retry/backoff.

## Naming and lifecycle

Skill names map to **what the user is doing**, not to API endpoints:

- Experiments: `brainstorm → design → launch → analyze → stop`
- Flags: `create`, `discovery` (today); `targeting`, `cleanup` (roadmap)

When proposing a new skill, name it after the user's intent. If you find yourself naming a skill after an endpoint (`feature-revisions-publish`), the scope is probably wrong — fold it into the lifecycle skill that uses it.

## Rate-limit awareness

GrowthBook is rate-limited at 60 rpm. Skills that fan out (brainstorm pulling 20 result sets, analyze polling for snapshot completion) should:

- Cap loop iterations explicitly (analyze caps at 60 iterations × 5s).
- Add `sleep` between polls when the polling target is async.
- Note the call budget in the Guardrails section when it's non-obvious.

## When in doubt

- Read `flag-create` for the minimal write-skill pattern.
- Read `flag-discovery` for the read-only / multi-path pattern.
- Read `experiment-launch` for the full state-machine-with-failure-branches pattern.
- Read `scripts/README.md` before extending the helper.
