# GrowthBook Agent Skills

Agent skills for [GrowthBook](https://growthbook.io) — feature flagging and experimentation playbooks for Claude Code, Cursor, and other agent tools that follow the [Agent Skills](https://agentskills.io) standard.

The skills call the [GrowthBook REST API](https://docs.growthbook.io/api) directly through a small bundled helper. No MCP server required.

## v0.2.0 — what's included

Three skills, all powered by the REST API:

| Skill | What it does |
| --- | --- |
| `flag-create` | Create a new feature flag, with collision check, valueType picking, and the "flag is created disabled" reminder. |
| `flag-discovery` | List flags, inspect one, or audit for stale flags. Reads only. |
| `experiment-brainstorm` | Propose new experiment ideas grounded in your team's past stopped-experiment history. |

More skills are on the roadmap: `flag-targeting`, `flag-cleanup`, `experiment-design`, `experiment-launch`, `experiment-analyze`, `experiment-stop`, plus dedicated metric and SDK skills.

## Install

### 1. Set your GrowthBook env vars

Skills authenticate via two env vars:

```bash
export GB_API_KEY=<your-key>         # required: PAT or Secret Key
export GB_EMAIL=you@example.com      # required: used as the owner on created flags
```

Get a Personal Access Token from [`app.growthbook.io/settings/keys`](https://app.growthbook.io/settings/keys). `GB_EMAIL` is the address you use to sign in to GrowthBook — the v2 features API requires an `owner` on every created flag.

For self-hosted, also export:

```bash
export GB_API_URL=https://api.your-host.com
```

Add the exports to your shell rc file so they persist.

### 2. Install the plugin

```text
/plugin marketplace add growthbook/skills
/plugin install growthbook@growthbook-skills
```

That's it. Restart Claude Code if the skills don't appear immediately. Node 18+ is required (it's what Claude Code already runs on, so this is usually satisfied).

### 3. Verify

```text
/growthbook:flag-discovery
```

Should list your existing GrowthBook feature flags.

## How to invoke

Skills can fire two ways:

- **Automatically** when Claude detects an intent matching the skill's description ("create a feature flag for the new pricing page" → `flag-create` triggers).
- **Explicitly** by typing the slash command: `/growthbook:flag-create`, `/growthbook:flag-discovery`, `/growthbook:experiment-brainstorm`.

## What these skills do not do

- **No writes outside flag creation.** v0.2 deliberately ships only one write skill (`flag-create`). Targeting rules, cleanup, and experiment lifecycle are coming next.
- **No experiment results analysis.** The `experiment-analyze` skill is on the roadmap and will need this plugin's REST helper to handle snapshot polling and result aggregation.
- **No SDK code generation.** A dedicated `sdk-install` / `sdk-developer` knowledge skill is on the roadmap.

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
  gb-call          # Node REST helper, called by every skill
  README.md
skills/
  flag-create/SKILL.md
  flag-discovery/SKILL.md
  experiment-brainstorm/SKILL.md
README.md
LICENSE
CHANGELOG.md
```

## Contributing

Issues and PRs welcome at [github.com/growthbook/skills](https://github.com/growthbook/skills). For larger proposals (new skills, changes to skill scope), open an issue first.

## License

MIT — see [LICENSE](LICENSE).
