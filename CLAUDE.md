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

The Guardrails section of each workflow file is an API-quirk catalog disguised as policy. Every new entry should cite — in your reasoning, not necessarily in the file — which source confirmed it.

## What this repo is

A Claude Code plugin (`growthbook`) that also ships as standalone agent skills for GrowthBook feature flags, experimentation, and product analytics. Skills shell out to a small Node helper (`scripts/gb-call`) that calls the GrowthBook REST API directly. No MCP server, no build step, no runtime deps beyond Node 18+.

## Architecture in one breath

```
skills/<domain>/SKILL.md                 ← router: description, workflow index, shared conventions
skills/<domain>/references/<workflow>.md ← one workflow: steps, guardrails, endpoints, handoffs
skills/<domain>/scripts/gb-call          ← symlink → ../../../scripts/gb-call (for npx-installed agents)
scripts/gb-call                          ← canonical helper; Claude plugin invokes this
.claude-plugin/                          ← plugin.json (manifest) + marketplace.json (listing)
.cursor-plugin/                          ← plugin.json (Cursor manifest)
```

Four domains: `feature-flags` (17 workflows), `experiments` (5), `analytics` (2), and `gb-setup` (no `references/` — it's a single workflow).

Skills are pure markdown. The helper is the only executable code in the plugin. This is intentional — the v0.2.0 commit (`daac766`) pivoted away from MCP to keep the surface that small.

The per-domain `scripts/gb-call` entries are git symlinks — edit only the canonical `scripts/gb-call`. Never create copies in skill directories.

### Client-neutral core, client-specific adapters

The workflow content is canonical and must stay client-agnostic. It describes GrowthBook tasks in terms of REST methods, paths, payloads, sequencing, and guardrails. `gb-call` is the shell adapter used by Agent Skills clients; MCP and the in-app assistant may execute the same contract through different adapters.

- Keep client packaging in client-owned surfaces such as `.claude-plugin/` and `.cursor-plugin/`. It is fine for those manifests, invocation examples, and permission declarations to differ.
- Do not put Claude-, Cursor-, MCP-, or model-provider-specific behavior into `references/` workflow semantics. A client adapter may change how a request is executed, but not what request is made or which safety gate applies.
- Treat `${CLAUDE_PLUGIN_ROOT}` and Claude Code's `Bash(...)` permission patterns as packaging details, not part of the workflow contract. Other Agent Skills clients may ignore the experimental `allowed-tools` field and resolve `scripts/gb-call` relative to the skill directory.
- Keep user-facing security language provider-neutral. Name a provider only in that provider's installation or adapter documentation.
- If a runtime has no shell, port the REST method, path, query, and body mechanically. Do not maintain a second copy of the workflow logic for that runtime.

### Why two levels and not 25 skills

Frontmatter is loaded into the agent's system prompt at startup for **every** installed skill, whether or not GrowthBook comes up. The flat layout paid 14.3 KB of context for 25 descriptions before the user typed anything, and a flat namespace forced each description to also explain when to use its 24 siblings. The four routers cost 2.9 KB and move sibling routing into the router body, which loads only when the domain is relevant.

This is the third level of [progressive disclosure](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): frontmatter, then `SKILL.md` body, then bundled files read on demand. Two constraints make `references/` the right mechanism rather than nested skill directories:

- **Claude Code does not scan a plugin's `skills/` recursively** — only its immediate children. `skills/feature-flags/flag-create/SKILL.md` would be invisible there while working fine in Cursor, which does walk the tree. See [anthropics/claude-code#18192](https://github.com/anthropics/claude-code/issues/18192).
- **Keep references one level deep.** Reference files are reached directly from the router, never through another reference file. Agent clients may only partially read files found through a chain, so a reference-to-reference hop risks a preview instead of a complete read.

**Adding a workflow** means adding `references/<name>.md` and one row to the router's index table — not a new top-level skill. Only add a top-level skill for a genuinely new domain, and expect to justify the frontmatter cost.

## The skill contract

There are now two file shapes. Don't invent new sections in either — extend the existing ones.

### The router (`skills/<domain>/SKILL.md`)

```markdown
---
name: <kebab-case, matches directory>
description: <triggers + cross-domain routing — see below>
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# <domain>

<one paragraph: what the domain covers, which API version it uses>

<the gb-call preamble — stated once here, not repeated in reference files>

## Pick a workflow
<table: `references/<name>.md` → when the user wants it, plus ambiguity tie-breakers>

## Shared conventions
<the rules every workflow in the domain assumes, including verified failure modes>

## Read-only vs. write
<which workflows must never mutate, and which product-safety gates are non-negotiable>

## Handoffs
<sibling domain skills, by skill name — never by a `references/` path>
```

### A workflow (`skills/<domain>/references/<name>.md`)

```markdown
---
name: <kebab-case, matches filename>
description: <kept for the in-app port; see below>
---

# <workflow-name>

<one-paragraph intent: what this does and what it deliberately doesn't>

## Contents
<index of ## sections and the ### paths under Workflow — required over 100 lines>

## Workflow
<numbered steps, with bash + JSON shown literally>

## Guardrails
<bulleted footguns and policies the API does not enforce>

## Endpoints used
<flat list of every endpoint this workflow touches>

## Handoffs
<`references/<sibling>.md` in-domain; "the **<domain>** skill (`<workflow>` workflow)" across domains>
```

### Frontmatter rules

- **`allowed-tools` lives on the router only.** Reference files don't carry it; the tool boundary is the skill, and a reference file isn't one. A grant on the router applies to every workflow in the domain, so **the union is the wrong default** — ask whether the grant is worth giving to all of them. The deep-link `open`/`xdg-open` grant was dropped for exactly this reason: 4 of 17 flag workflows wanted it, so those workflows now print the URL instead. `experiments` and `analytics` keep `Bash(sleep *)` for poll loops; `gb-setup` keeps its four literal file-management commands.
- **When you do grant another binary, prefer literal full-command patterns over wildcards.** `Bash(chmod 600 ~/.config/growthbook/.env)` is a much narrower grant than `Bash(chmod *)` — the latter would allow `chmod 777 ~/.ssh/authorized_keys` if a prompt-injected response asked the agent to run it. Wildcards are only appropriate when the variable portion is genuinely unbounded (e.g. `Bash(sleep *)` where the arg is a duration). For everything else, write out each accepted invocation as its own allowlist entry.
- **A router `description` does all the routing that used to be spread across its workflows.** It needs (a) the trigger phrases for every workflow it owns, and (b) explicit "for X, use the Y skill" hints pointing at the other three domains. It is the only thing the agent sees when deciding whether to open the domain at all. Cap is 1,024 characters; the current routers sit at roughly 800.
- **A workflow `description` is no longer read by any host** — the router does the routing. Keep it anyway, verbatim: the in-app GrowthBook assistant's loader reads leaf `name` and `description` when porting these files (see `PORTING_SKILLS.md` in the GrowthBook repo), so it stays the porting payload. Don't spend effort tuning it, and don't delete it.
- **`name` must match its directory** (routers) **or filename** (workflows). The Agent Skills specification requires the directory match.
- **Use `${CLAUDE_PLUGIN_ROOT}` for paths**, never relative paths. It resolves to the plugin's install directory at runtime.

### Workflow conventions

- **Number every step.** Long skills (`experiment-launch`) lead with a `- [ ]` checklist so the agent tracks progress through multi-step writes. Short skills skip it.
- **Show bash + JSON literally.** Copy-pasteable examples beat prose. The reader is an agent executing the skill, not a human reading docs.
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

`skills/experiments/references/experiment-launch.md` was authored directly by GrowthBook's head of data science. **When `experiment-design` (or any other experiment skill) differs from `experiment-launch` on statistical framing, hypothesis discipline, goal-metric counts, guardrail requirements, or other methodology, align the other skill to `experiment-launch` — not the other way around.** The 2026-05-26 overreach review (`notes/skills-overreach-review.md`) caught one drift cycle; future edits should treat `experiment-launch` as the canonical voice on these topics.

If a change to `experiment-launch` itself seems warranted, that's a conversation to have with the head of data science before applying — don't unilaterally edit. The same caveat applies to anything in `experiment-launch`'s Guardrails or its statistical commentary in the workflow.

## Read vs. write discipline

Five workflows must never mutate anything:

- `flag-search`, `flag-graph`, `metric-search` — read-only
- `experiment-brainstorm`, `experiment-design` — proposal-only; they must not POST an experiment into existence
- `experiment-analyze` — read-only in the sense that matters: it may POST a snapshot refresh, but it must never stop or modify the experiment

`analytics-explore` is a third category worth naming: it writes no GrowthBook configuration but does execute real warehouse queries, which cost the user money. Don't treat "writes nothing" as "free."

Everything else writes. Read-only and proposal-only workflows must *say so* in their intro and enforce it in Guardrails ("Propose, do not create. Never POST to ..."). **The boundary is in the content, not the tooling** — every workflow in a domain inherits the same router `allowed-tools`, so nothing stops a read-only workflow from writing except the words in its file. That's exactly why those words have to be explicit, and it matters more under a router than it did when each skill had its own grant.

## Crossing domains

Yes, workflows reference other domains constantly — `feature-flags` points into `experiments` 18 times, and experiments and analytics point back. The lifecycle doesn't respect the domain split: you stop an experiment, then clean up its flag; you chart a metric, then design a test around it. Two mechanisms, and picking the wrong one is the most likely way to break this structure.

**Sequential handoff — name the sibling skill, in prose.** When the user's *next* job lives in another domain, end your workflow and name where they're going: "the **experiments** skill (`experiment-stop` workflow)". The agent activates that skill and reads that workflow. Use this for every genuine handoff.

**Inline dependency — make the calls yourself.** When another domain's work is a *step inside* your workflow rather than the next job, inline the specific API calls. `experiment-launch` is the model: creating the flag and wiring the experiment-ref rule are steps 4–6 of its own sequence, so it calls `POST /api/v2/features` and `POST /api/v2/features/<id>/revisions/new/rules` directly instead of delegating to `flag-create` and `flag-experiment`. Launching is one atomic job; handing off mid-sequence would lose the state it's carrying and strand the user halfway.

**Never read another domain's reference file.** No `../experiments/references/experiment-stop.md`, and no `${CLAUDE_PLUGIN_ROOT}/skills/...` path into a sibling domain. Two reasons:

- **The path isn't stable across installs.** Under the plugin install everything sits at `<root>/skills/<domain>/`, so a sibling hop resolves. Under `npx skills install` a skill directory is the unit of installation and `${CLAUDE_PLUGIN_ROOT}` isn't set — which is exactly why each domain carries its own `scripts/gb-call` symlink instead of reaching for a shared one. A cross-domain file path works in one mode and silently fails in the other.
- **The sibling may not be installed at all.** Someone can install `experiments` without `feature-flags`. A named skill reference degrades gracefully — the agent reports it can't find that skill. A hard file path just fails.

The rule of thumb: **`references/` paths are domain-private.** Inside a domain, cross-reference by path. Across domains, cross-reference by skill name and let the host resolve it. If a cross-domain handoff feels too expensive to make the user re-enter, that's a signal the work belongs inline (option 2), not that the boundary should be pierced.

## API version split

- **`/api/v2/`** for feature flags. Flat top-level `rules` array, narrowed ID character set, `owner` required on create, `defaultValue` as a string.
- **`/api/v1/`** for everything else (experiments, metrics, datasources, attributes, projects, environments, templates, snapshots).

When in doubt, check the existing skill that hits the closest endpoint. Don't migrate v1 endpoints to v2 without confirming the v2 surface exists and the shape matches.

## Secret handling

Two surfaces hold credentials: the env var or `~/.config/growthbook/.env` (PATs go in), and the conversation transcript (the user pastes a PAT into chat when running `/growthbook:gb-setup`). Neither can be retroactively redacted.

Conventions every skill must follow:

- **Never echo `GB_API_KEY` in user-facing output.** Mask to last 4 characters when surfacing identity. The skill's stdout/stderr lands in the user's transcript.
- **Some GrowthBook API responses contain secrets** (SDK keys, webhook signing keys, etc.). None of the current workflows hit those endpoints. A future workflow that does must filter the response before surfacing — don't dump the raw body to the user.
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

Workflow names map to **what the user is doing**, not to API endpoints:

- Experiments: `brainstorm → design → launch → analyze → stop`
- Flags: `create → toggle → targeting → ramp`/`monitoring → cleanup`, with `revisions → review → publish` running underneath all of them
- Analytics: `metric-search → analytics-explore`

When proposing a new workflow, name it after the user's intent. If you find yourself naming one after an endpoint (`flag-revisions-publish`), the scope is probably wrong — fold it into the lifecycle workflow that uses it.

Domain names are the ones that cost context, so they're deliberately generic and few. A new workflow is cheap (a file plus a router row); a new domain needs to justify permanent frontmatter.

## Rate-limit awareness

GrowthBook is rate-limited at 60 rpm. Skills that fan out (brainstorm pulling 20 result sets, analyze polling for snapshot completion) should:

- Cap loop iterations explicitly (analyze caps at 60 iterations × 5s).
- Add `sleep` between polls when the polling target is async.
- Note the call budget in the Guardrails section when it's non-obvious.

## When in doubt

- Read `skills/feature-flags/SKILL.md` for the router pattern: how a description absorbs 17 workflows' triggers, and how shared conventions get hoisted out of the leaves.
- Read `feature-flags/references/flag-create.md` for the minimal write-workflow pattern.
- Read `feature-flags/references/flag-search.md` or `analytics/references/metric-search.md` for the read-only / multi-path pattern.
- Read `experiments/references/experiment-launch.md` for the full state-machine-with-failure-branches pattern.
- Read `gb-setup/SKILL.md` for the pattern when a skill needs file operations and broader `allowed-tools` — including how to narrow each tool grant to a literal command and how to surface secret-handling risks to the user before they paste. It's also the one domain that stays a single flat skill, because it has exactly one job.
- Read `feature-flags/references/flag-targeting.md` for two patterns it pioneers: (a) the **warn-and-confirm** guardrail layer — for changes the server allows but the user shouldn't make lightly, like editing `experimentId` on an experiment-ref rule; and (b) the **merge-conflict (409) branch** — halt with the conflict body, don't auto-rebase, let the user resolve in the UI.
- Read `feature-flags/references/flag-cleanup.md` for three patterns it pioneers: (a) the **agent-mediated code-cleanup** flow — the workflow coordinates code edits via Read/Edit on the user's working tree, batched by file, without expanding `allowed-tools` beyond gb-call; (b) the **archive-then-verify-then-delete safety gate** — a product-safety pause between two API calls (not the workflow-safety of approval), because permanent deletion is a one-way door; (c) the **bypass-asymmetry** awareness — per-token `bypassApprovalChecks` authorizes some destructive paths but not others, and the workflow needs to surface this when offering bypass options.
- Read `analytics/references/analytics-explore.md` for the **status-in-the-body** pattern — a `200` that isn't success, so the workflow branches on `exploration.status` rather than the HTTP code.
- Read `scripts/README.md` before extending the helper.
