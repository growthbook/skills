# GrowthBook Agent Skills

Agent skills for [GrowthBook](https://growthbook.io) — feature flagging and experimentation playbooks for Claude Code, Cursor, and other agent tools that follow the [Agent Skills](https://agentskills.io) standard.

The skills call the [GrowthBook REST API](https://docs.growthbook.io/api) directly through a small bundled helper. No MCP server required.

## What's included

Ten skills, all powered by the REST API:

### Setup
| Skill | What it does |
| --- | --- |
| `gb-setup` | Walks you through API key, owner, and (self-hosted) API URL. Validates against the live API and writes `~/.config/growthbook/.env` with `chmod 600`. Re-run anytime to update. |

### Feature flags
| Skill | What it does |
| --- | --- |
| `flag-create` | Create a new feature flag, with collision check, valueType picking, and the "flag is created disabled" reminder. |
| `flag-discovery` | List flags, inspect one, or audit for stale flags. Reads only. |
| `flag-targeting` | Add, edit, or remove targeting rules on an existing flag — including percentage rollouts, forced-value rules, and the env-level kill switch. Handles approval-required and merge-conflict failure paths. |
| `flag-cleanup` | Archive or delete a stale flag, walking the user through inlining the flag's `defaultValue` at call sites first. Two-step safety gate (archive → verify → delete); uses Code References API or Grep to find call sites. |

### Experimentation
| Skill | What it does |
| --- | --- |
| `experiment-brainstorm` | Propose new experiment ideas grounded in your team's past stopped-experiment history. |
| `experiment-design` | Walk through hypothesis, variations, primary metric, guardrails, and sample size to produce a launchable spec. Reads only. |
| `experiment-launch` | End-to-end launch: create the experiment, prep the flag, wire the experiment-ref rule, and call `/start`. Handles approval and pre-launch checklist failure paths. |
| `experiment-analyze` | Trigger a fresh snapshot, poll until ready, then interpret results (SRM check, lifts, CIs, guardrails). |
| `experiment-stop` | Stop a running experiment, optionally declaring a winning variation. |

More skills are on the roadmap — see [`notes/roadmap.md`](notes/roadmap.md) for scope, priority, and likely endpoints. The remaining Phase 2 addition is `metric-create` (define new metrics from the agent). Phase 3 includes `experiment-statistics` and the SDK-related skills.

## Install

### 1. Install the plugin

```text
/plugin marketplace add growthbook/skills
/plugin install growthbook@growthbook-skills
```

Restart Claude Code if the skills don't appear immediately. Node 18+ is required (it's what Claude Code already runs on, so this is usually satisfied).

### 2. Configure credentials

The quickest path is to run the setup skill:

```text
/growthbook:setup
```

It walks you through your API key, owner identifier, and (for self-hosted) your API URL — then validates against the live API and writes `~/.config/growthbook/.env` with `chmod 600`. Every other skill reads that file automatically.

**Prefer shell-rc?** You can export the variables instead. The skills read environment variables first; the file is only consulted when an env var is unset.

```bash
export GB_API_KEY=<your-key>             # required: PAT or Secret Key
export GB_EMAIL=you@example.com          # required for flag-create + experiment-launch
                                         # (accepts an email OR a u_... userId)
export GB_API_URL=https://api.your-host  # self-hosted only
```

Get a Personal Access Token from [`app.growthbook.io/settings/keys`](https://app.growthbook.io/settings/keys). The v2 features API requires an `owner` on every created flag — that's what `GB_EMAIL` provides.

### 3. Verify

```text
/growthbook:flag-discovery
```

Should list your existing GrowthBook feature flags. If anything's wrong with the config, the error points back at `/growthbook:setup`.

## How to invoke

Skills can fire two ways:

- **Automatically** when Claude detects an intent matching the skill's description ("create a feature flag for the new pricing page" → `flag-create` triggers; "what should we test next" → `experiment-brainstorm`; "stop this experiment and ship the winner" → `experiment-stop`).
- **Explicitly** by typing the slash command, e.g. `/growthbook:setup`, `/growthbook:flag-discovery`, `/growthbook:experiment-launch`.

Each skill's description names its trigger phrases and routes to sibling skills when the request would be a better fit elsewhere — so they compose cleanly when chained ("brainstorm → design → launch → analyze → stop").

## What these skills do not do

- **No metric or datasource creation.** A `metric-create` skill is planned; until then, create metrics and datasources in the GrowthBook UI and reference them by ID.
- **No SDK code generation.** A dedicated `sdk-install` / `sdk-developer` skill is on the roadmap; for now, follow GrowthBook's SDK docs and use these skills to manage flags and experiments around your SDK integration.
- **No multi-armed bandit support.** The experiment skills target standard A/B tests; bandits use the same REST endpoints but report differently. Manage bandits in the UI for now — the skills halt rather than mis-interpret them.
- **No silent retries or rate-limit backoff in the helper.** GrowthBook is rate-limited at 60 rpm. The skills that fan out (`experiment-analyze`, `experiment-brainstorm`) cap their call counts; multi-tenant orgs hitting concurrent requests may still see `429`s, which `gb-call` surfaces explicitly rather than retrying.

## How it works

The plugin bundles a small Node helper (`scripts/gb-call`) that handles auth, base URL, and error reporting for every REST request. Skills call it via Bash:

```bash
gb-call GET /api/v1/features
echo '<payload>' | gb-call POST /api/v1/features -
```

See [`scripts/README.md`](scripts/README.md) for the full usage reference.

## Repository layout

```
.claude-plugin/
  marketplace.json
  plugin.json
scripts/
  gb-call                          # Node REST helper called by every skill (zero deps, Node 18+)
  README.md                        # gb-call usage, config sources, error catalog
skills/
  gb-setup/SKILL.md                # one-time onboarding (writes ~/.config/growthbook/.env)
  flag-create/SKILL.md
  flag-discovery/SKILL.md
  flag-targeting/SKILL.md
  flag-cleanup/SKILL.md
  experiment-brainstorm/SKILL.md
  experiment-design/SKILL.md
  experiment-launch/SKILL.md
  experiment-analyze/SKILL.md
  experiment-stop/SKILL.md
CLAUDE.md                          # conventions + verify-against-source rule for contributors
.gitignore
README.md
LICENSE
CHANGELOG.md
```

## Security & secrets

- **Where the key lives.** `gb-setup` writes `~/.config/growthbook/.env` inside a `0700` directory at file mode `0600` — owner-read/write only, no other user on the system can read it. Environment variables (if exported) take precedence over the file, so CI and one-off overrides keep working.
- **Pasting a key into chat.** The value you give `gb-setup` lands in your local Claude Code transcript and is sent to Anthropic as part of the conversation; it cannot be retroactively masked. Generate a fresh PAT for the plugin rather than reusing your personal admin token — that way you can revoke it independently if anything goes wrong.
- **Revoking a leaked key.** Visit [`app.growthbook.io/settings/keys`](https://app.growthbook.io/settings/keys) (or your self-hosted equivalent) and revoke. Then re-run `/growthbook:setup` with the replacement.
- **What the helper rejects.** `gb-call` refuses values containing whitespace or control characters (CRLF in `GB_API_KEY` would inject headers); `gb-setup` refuses `http://` URLs and URLs with a path component. These produce explicit errors rather than silent fix-ups.

## Contributing

Issues and PRs welcome at [github.com/growthbook/skills](https://github.com/growthbook/skills). For larger proposals (new skills, changes to skill scope), open an issue first.

Before changing a skill: read [`CLAUDE.md`](CLAUDE.md). It documents the skill structure, the `allowed-tools` security model, the "verify every payload shape against the GrowthBook back-end source before shipping" rule, and a doc cross-reference map for finding the canonical answer on any GrowthBook concept. Every guardrail in every skill has a reason — `CLAUDE.md` is how we keep those reasons accessible.

## License

MIT — see [LICENSE](LICENSE).
