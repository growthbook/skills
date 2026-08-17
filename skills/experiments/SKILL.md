---
name: experiments
description: Design, launch, analyze, and stop standard GrowthBook A/B tests. Use when the user mentions an experiment, A/B test, split test, variation, hypothesis, sample size, goal or guardrail metric, SRM, chance to win, lift, or declaring a winner. Also use for multi-armed or contextual bandit requests, but only to identify them and direct the user to GrowthBook UI — these workflows do not operate bandits. For feature-flag work — creating flags, targeting rules, rollouts, kill switches, or publishing drafts — use feature-flags. For charting product data or browsing metrics, use analytics. For first-time API key configuration, use gb-setup.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *), Bash(sleep *)
---

# experiments

Domain router for GrowthBook experiments. Each stage of the lifecycle lives in a reference file under `references/`. Read this router, pick the stage that matches where the user is, then read that one file and follow it.

Experiments use the **v1 API** (`/api/v1/experiments`). When a workflow also touches a feature flag, the flag calls are v2 — the reference file spells out which is which.

All API calls go through the bundled helper. Under the Claude Code plugin install, it lives at `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call` (the plugin root). Under `npx skills install`, it lives at `scripts/gb-call` relative to this skill's directory. Resolve that path once and substitute it whenever a reference example says `gb-call`; do not assume `gb-call` is on `PATH`. It reads `GB_API_KEY` from the environment first, then falls back to `~/.config/growthbook/.env` (written by **gb-setup**); environment variables take precedence.

## Pick a stage

The lifecycle runs brainstorm → design → launch → analyze → stop. Enter wherever the user is.

These workflows target `type: "standard"` experiments. GrowthBook's REST API also supports multi-armed bandit experiments and separate Enterprise beta Contextual Bandit resources, but neither lifecycle is implemented here. If the request is about either kind of bandit, identify it accurately and direct the user to GrowthBook UI; do not apply the standard-experiment workflows to it.

| Read this | When the user wants to |
| --- | --- |
| `references/experiment-brainstorm.md` | Get ideas for what to test, grounded in past stopped experiments (proposes only) |
| `references/experiment-design.md` | Turn an idea into a launchable spec — hypothesis, variations, metrics, sample size (writes nothing) |
| `references/experiment-launch.md` | Create the experiment, prep or reuse the flag, wire the experiment-ref rule, and start it |
| `references/experiment-analyze.md` | Read results — refresh the snapshot if stale, then interpret (read-only) |
| `references/experiment-stop.md` | Stop a running experiment, optionally declare a winner and roll it out |

If the user has an idea but no hypothesis, start at `experiment-design`; it routes back to `experiment-brainstorm` when the idea needs grounding. If they hand you a name rather than an ID, `experiment-analyze` and `experiment-stop` both open with a resolve-by-name step.

## Methodology authority

`references/experiment-launch.md` was authored directly by GrowthBook's head of data science and is the **canonical voice** on statistical framing, hypothesis discipline, goal-metric counts, and guardrail requirements. When another reference file appears to disagree with it on methodology, follow `experiment-launch` and flag the drift. Do not resolve such a conflict by reasoning from general A/B testing intuition — GrowthBook's defaults are its own (Bayesian by default, no multiple-comparison correction on guardrails, sequential testing widens intervals).

This router deliberately carries no statistical guidance of its own. Interpretation rules live in the reference files.

## Shared conventions

- **Metrics must already exist.** No workflow here creates a metric. When one is missing, the user creates it in the GrowthBook UI first; the reference file says where.
- **Metrics must live on the experiment's datasource** or the experiment POST fails.
- **Don't mix `templateId` with `datasourceId` / `assignmentQueryId`** on create.
- **`winnerVariationId` is a variation ID string** (e.g. `var_abc123`) — not an integer index, not a variation name.
- **Resolve-by-name uses `q`,** which matches name, tracking key, description, and hypothesis. It rejects `!`, `~`, `^`, `>`, `<`, `=` with a 400 — send plain `field:value` tokens and free text. Filter bandits with `bandits`, never `type` (`type` is not a list param; `implementationType` is a different axis).
- **`result` is the recorded result and survives a restart,** so `result=won` can return a running experiment. Pair it with `status=stopped`.
- **`limit` caps at 100** on the experiments list.
- **Show users the experiment name and link `<host>/experiment/<id>`,** not raw ids alone.

## Read-only vs. write

`experiment-brainstorm`, `experiment-design`, and `experiment-analyze` never write — brainstorm and design are proposal-only and must not POST an experiment into existence, and analyze must not stop or modify one. `experiment-launch` and `experiment-stop` are the only writers.

## Budget

GrowthBook rate-limits at 60 rpm. `experiment-brainstorm` fans out across paginated history and `experiment-analyze` polls for snapshot completion behind an explicit iteration cap with `sleep` between polls. Keep both caps — they're what stops a busy org from pinning the limit.

## Handoffs

- The **feature-flags** skill — anything about the flag itself: creating it, its targeting rules, its rollout, publishing its draft, cleaning it up after a test ships.
- The **analytics** skill — picking metrics out of the catalog before designing, or charting product data that isn't an experiment readout.
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`.
