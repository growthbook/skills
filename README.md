# GrowthBook Agent Skills

[GrowthBook](https://www.growthbook.io) is an open source Feature Flagging and Experimentation platform.

Agent skills for GrowthBook — feature flagging and experimentation playbooks for Claude Code, Cursor, and other agent tools that follow the [Agent Skills](https://agentskills.io) standard.

The skills call the [GrowthBook REST API](https://docs.growthbook.io/api) directly through a small bundled helper. No MCP server required.

## What's included

### Setup
| Skill | What it does |
| --- | --- |
| `gb-setup` | Walks you through API key, owner, and (self-hosted) API URL. Validates against the live API and writes `~/.config/growthbook/.env` with `chmod 600`. Re-run anytime to update. |

### Feature flags — Revision lifecycle

Every flag change goes through a draft revision before going live. These three skills handle the full draft → review → publish flow.

| Skill | What it does |
| --- | --- |
| `flag-revisions` | List and inspect open drafts, check who owns them, see approval status, create or discard drafts. The "what's in flight?" skill. |
| `flag-review` | Request an approval review on a draft, or submit a review (approve / request-changes / comment). |
| `flag-publish` | Publish a draft live, resolve merge conflicts (rebase), discard, or revert to a prior revision. |

### Feature flags — Operations

| Skill | What it does |
| --- | --- |
| `flag-create` | Create a new feature flag — collision check, value type, environments, defaultValue. Ships disabled everywhere. |
| `flag-metadata` | Update a flag's description, owner, project, tags, custom fields, or JSON schema. |
| `flag-default-value` | Change the fallback value served when no rules match. |
| `flag-toggle` | Enable or disable a flag in a specific environment (the kill switch). Review-gated. |
| `flag-prerequisites` | Gate an entire flag on another boolean flag being on. |
| `flag-cleanup` | Archive or delete a stale flag, walking through code-site inlining first. Detects temporary rollouts, handles code references, two-step safety gate (archive → verify → delete). |

### Feature flags — Rules

| Skill | What it does |
| --- | --- |
| `flag-rules` | Entry point: list rules, delete a rule, reorder, or route to the right rule skill. |
| `flag-targeting` | Add, edit, or remove force / rollout rules — with conditions, saved groups, and rule-level prerequisites. Full operator reference for MongoDB-style conditions. |
| `flag-schedule` | Time-gate a rule: set a start and/or end datetime for automatic activation. |
| `flag-ramp` | Multi-step ramp schedule: progressively increase coverage over time with per-step intervals or manual approval gates. Includes full live ramp management (advance, pause, rollback, approve-step). |
| `flag-monitoring` | Monitored progressive rollout ("safe rollout"): ramp schedule with guardrail metric monitoring and optional auto-rollback. |
| `flag-experiment` | Add an experiment-ref rule to a flag to run an A/B test through it. |

### Feature flags — Discovery

| Skill | What it does |
| --- | --- |
| `flag-search` | Search, list, and audit flags by project, tag, owner, environment state, or staleness. Read-only. |
| `flag-graph` | Trace a flag's dependency graph: what it depends on (prerequisites), what depends on it, linked experiments and holdouts. |

### Experimentation

| Skill | What it does |
| --- | --- |
| `experiment-brainstorm` | Propose new experiment ideas grounded in your team's past stopped-experiment history. |
| `experiment-design` | Walk through hypothesis, variations, primary metric, guardrails, and sample size to produce a launchable spec. Reads only. |
| `experiment-launch` | End-to-end launch: create the experiment, prep or reuse the feature flag, wire the experiment-ref rule, and call `/start`. Works for both experiment-first and flag-first workflows. Handles approval and pre-launch checklist failure paths. |
| `experiment-analyze` | Trigger a fresh snapshot, poll until ready, then interpret results (SRM check, lifts, CIs, guardrails). |
| `experiment-stop` | Stop a running experiment, optionally declaring a winner and enabling a temporary rollout. Full post-stop flag disposition guidance. |

### Product analytics

Turn the metrics and fact tables you already use for experimentation into ad-hoc charts with GrowthBook's [Product Analytics](https://docs.growthbook.io/app/product-analytics) Explorer.

| Skill | What it does |
| --- | --- |
| `metric-search` | Search, list, and audit fact metrics and fact tables — definitions, columns, and what's chartable. Read-only. |
| `analytics-explore` | Build and run a chart: a metric over time, a fact-table aggregation, or a raw warehouse table. Returns the numbers plus a deep link to the rendered chart. |

## Install

### 1. Install the plugin

**Claude Code:**

```text
/plugin marketplace add growthbook/skills
/plugin install growthbook@growthbook-skills
```

**Cursor, Codex, Warp, Zed, and other [agentskills.io](https://agentskills.io)-compatible agents:**

```bash
npx skills add growthbook/skills
```

This installs the skills at project scope. Restart your agent if the skills don't appear immediately. Node 18+ is required (which is what most agents already run on).

### 2. Configure credentials

The quickest path is to run the setup skill:

```text
/growthbook:gb-setup
```

It walks you through your API key and (for self-hosted) your API URL — then validates against the live API and writes `~/.config/growthbook/.env` with `chmod 600`. Every other skill reads that file automatically.

**Prefer shell-rc?** You can export the variables instead. The skills read environment variables first; the file is only consulted when an env var is unset.

```bash
export GB_API_KEY=<your-key>             # required: PAT or Secret Key
export GB_API_URL=https://api.your-host  # self-hosted only
```

Get a Personal Access Token from [`app.growthbook.io/account/personal-access-tokens`](https://app.growthbook.io/account/personal-access-tokens). The token is tied to your GrowthBook user, so flags and experiments the write skills create are attributed to you automatically — no separate owner setting needed.

### 3. Verify

```text
/growthbook:flag-search
```

Should list your existing GrowthBook feature flags. If anything's wrong with the config, the error points back at `/growthbook:gb-setup`.

## How to invoke

Skills can fire two ways:

- **Automatically** when the agent detects an intent matching the skill's description ("create a feature flag for the new pricing page" → `flag-create`; "what should we test next" → `experiment-brainstorm`; "stop this experiment and ship the winner" → `experiment-stop`).
- **Explicitly** by typing the slash command, e.g. `/growthbook:gb-setup`, `/growthbook:flag-search`, `/growthbook:experiment-launch`.

Each skill's description names its trigger phrases and routes to sibling skills when the request is a better fit elsewhere — so they compose cleanly when chained:

- **Experiment-first:** `experiment-design` → `experiment-launch` → `experiment-analyze` → `experiment-stop` → `flag-cleanup`
- **Flag-first:** `flag-create` → `flag-toggle` → `flag-targeting` → `flag-ramp` / `flag-monitoring` → `flag-cleanup`
- **Experiment on an existing flag:** `flag-experiment` → `experiment-launch` (reuses the existing flag) → `experiment-stop` → `flag-cleanup`
- **Analytics:** `metric-search` → `analytics-explore` → `experiment-design` (when a chart surfaces something worth testing)

## What these skills do not do

- **No metric or datasource creation.** Create metrics and datasources in the GrowthBook UI and reference them by ID in the experiment and analytics skills.
- **No SDK code generation.** Follow GrowthBook's SDK docs; these skills manage flags and experiments via the REST API, not the SDK.
- **No multi-armed bandit support.** The experiment skills target standard A/B tests; the skills halt rather than mis-interpret bandit experiments.
- **No silent retries or rate-limit backoff in the helper.** GrowthBook is rate-limited at 60 rpm. The skills that fan out cap their call counts; multi-tenant orgs hitting concurrent requests may still see `429`s, which `gb-call` surfaces explicitly rather than retrying.

## How it works

The plugin bundles a small Node helper (`scripts/gb-call`) that handles auth, base URL, and error reporting for every REST request. Each skill directory also contains a `scripts/gb-call` symlink so agents installed via `npx skills install` (Cursor, Codex, etc.) can resolve it relative to the skill directory. Skills call it via Bash:

```bash
gb-call GET /api/v2/features
echo '<payload>' | gb-call POST /api/v2/features -
```

See [`scripts/README.md`](scripts/README.md) for the full usage reference.

## Repository layout

```
.claude-plugin/
  marketplace.json
  plugin.json
scripts/
  gb-call                              # Node REST helper (zero deps, Node 18+)
  README.md                            # gb-call usage, config sources, error catalog
skills/
  <name>/
    SKILL.md                           # workflow + guardrails
    scripts/gb-call                    # symlink → ../../scripts/gb-call (for npx-installed agents)
  gb-setup/SKILL.md                    # one-time onboarding

  # Revision lifecycle
  flag-revisions/SKILL.md              # draft management
  flag-review/SKILL.md                 # approval workflow
  flag-publish/SKILL.md                # publish, rebase, revert

  # Flag operations
  flag-create/SKILL.md
  flag-metadata/SKILL.md
  flag-default-value/SKILL.md
  flag-toggle/SKILL.md
  flag-prerequisites/SKILL.md
  flag-cleanup/SKILL.md

  # Rules
  flag-rules/SKILL.md                  # entry point, list, delete, reorder
  flag-targeting/SKILL.md              # force/rollout rules + conditions
  flag-schedule/SKILL.md               # timed activation windows
  flag-ramp/SKILL.md                   # multi-step ramp schedules
  flag-monitoring/SKILL.md             # monitored rollouts
  flag-experiment/SKILL.md             # experiment-ref rules

  # Discovery
  flag-search/SKILL.md
  flag-graph/SKILL.md

  # Experimentation
  experiment-brainstorm/SKILL.md
  experiment-design/SKILL.md
  experiment-launch/SKILL.md
  experiment-analyze/SKILL.md
  experiment-stop/SKILL.md

  # Product analytics
  metric-search/SKILL.md
  analytics-explore/SKILL.md

CLAUDE.md                              # authoring conventions for contributors
.gitignore
README.md
LICENSE
CHANGELOG.md
```

## Security & secrets

- **Where the key lives.** `gb-setup` writes `~/.config/growthbook/.env` inside a `0700` directory at file mode `0600` — owner-read/write only. Environment variables take precedence over the file, so CI and one-off overrides keep working.
- **Pasting a key into chat.** The value you give `gb-setup` lands in your local transcript and is sent to Anthropic as part of the conversation; it cannot be retroactively masked. Generate a fresh PAT for the plugin rather than reusing your personal admin token — that way you can revoke it independently if anything goes wrong.
- **Revoking a leaked key.** Visit [`app.growthbook.io/account/personal-access-tokens`](https://app.growthbook.io/account/personal-access-tokens) (or your self-hosted equivalent) and revoke. Then re-run `/growthbook:gb-setup` with the replacement.
- **What the helper rejects.** `gb-call` refuses values containing whitespace or control characters (CRLF in `GB_API_KEY` would inject headers); `gb-setup` refuses `http://` URLs and URLs with a path component.

## Contributing

Issues and PRs welcome at [github.com/growthbook/skills](https://github.com/growthbook/skills). For larger proposals (new skills, changes to skill scope), open an issue first.

Before changing a skill: read [`CLAUDE.md`](CLAUDE.md). It documents the skill structure, the `allowed-tools` security model, the "verify every payload shape against the GrowthBook back-end source before shipping" rule, and a doc cross-reference map for finding the canonical answer on any GrowthBook concept.

## License

MIT — see [LICENSE](LICENSE).
