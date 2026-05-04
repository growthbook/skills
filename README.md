# GrowthBook Agent Skills

Agent skills for [GrowthBook](https://growthbook.io) — feature flagging and experimentation playbooks for Claude Code, Cursor, and other agent tools that follow the [Agent Skills](https://agentskills.io) standard.

These skills wrap the [GrowthBook MCP server](https://github.com/growthbook/growthbook-mcp) with lifecycle workflows that encode ordering, naming conventions, and known footguns. The MCP exposes the verbs; these skills supply the playbooks.

## v0.1.0 — what's included

Three skills, all read-only or low-risk and powered entirely by the MCP:

| Skill | What it does |
| --- | --- |
| `flag-create` | Create a new feature flag, with collision check, valueType picking, and the "flag is created disabled" reminder. |
| `flag-discovery` | List flags, inspect one, or audit for stale flags. Reads only. |
| `experiment-brainstorm` | Propose new experiment ideas grounded in your team's past stopped-experiment history. |

More skills are on the roadmap: `flag-targeting`, `flag-cleanup`, `experiment-design`, `experiment-launch`, `experiment-analyze`, `experiment-stop`, plus dedicated metric and SDK skills.

## Install

### 1. Install the GrowthBook MCP server

These skills call the MCP — install it first.

```bash
claude mcp add growthbook \
  --transport stdio \
  --env GB_API_KEY=<your-key> \
  --env GB_EMAIL=<your-gb-account-email> \
  -- npx -y @growthbook/mcp@latest
```

Required env vars:

- `GB_API_KEY` — your GrowthBook API key ([Personal Access Token](https://app.growthbook.io/settings/keys) or Secret Key).
- `GB_EMAIL` — the email on your GrowthBook account. Used as the `owner` on flags and experiments created through the MCP. The server will not start without it.

Optional env vars (self-hosted only):

- `GB_API_URL` — defaults to `https://api.growthbook.io`.
- `GB_APP_ORIGIN` — defaults to `https://app.growthbook.io`.

The MCP server name **must be `growthbook`** — the skills' permission rules use the slug `mcp__growthbook__*`. Verify with `claude mcp get growthbook`.

### 2. Install the plugin

```bash
/plugin marketplace add growthbook/skills
/plugin install growthbook@growthbook-skills
```

That's it. Restart Claude Code if the skills don't appear immediately.

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

- **No writes outside flag creation.** v0.1 deliberately ships only one write skill (`flag-create`). Targeting rules, cleanup, and experiment lifecycle are coming next.
- **No experiment results analysis.** That needs GrowthBook REST endpoints not yet exposed by the MCP. Coming once the MCP catches up or the plugin ships its own REST helper.
- **No SDK code generation.** The MCP itself returns SDK snippets when you create a flag; a dedicated `sdk-developer` knowledge skill is on the roadmap.

## Repository layout

```
.claude-plugin/
  marketplace.json
  plugin.json
skills/
  flag-create/SKILL.md
  flag-discovery/SKILL.md
  experiment-brainstorm/SKILL.md
README.md
LICENSE
```

## Contributing

This is the first public ship. Issues and PRs welcome at [github.com/growthbook/skills](https://github.com/growthbook/skills). For larger proposals (new skills, changes to skill scope), open an issue first.

## License

MIT — see [LICENSE](LICENSE).
