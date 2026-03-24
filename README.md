# GrowthBook Agent Skills

A collection of agent skills to help developers use [GrowthBook](https://www.growthbook.io/) — the open-source feature flagging and A/B testing platform — directly from their AI coding workflows.

## Installation

```bash
npx skills add growthbook/skills
```

## Available Skills

### install-growthbook-sdk

Install and integrate the GrowthBook SDK into any app. Supports JavaScript, TypeScript, React, Next.js, Python, Ruby, Go, and PHP.

**Use when:**
- "Add GrowthBook to my project"
- "Set up feature flags with GrowthBook"
- "Integrate the GrowthBook SDK"
- "Configure GrowthBook"

### wrap-feature-flag

Wrap existing code in a GrowthBook feature flag to enable remote control of features without redeploying.

**Use when:**
- "Add a feature flag to this"
- "Put this behind a flag"
- "Gate this feature"
- "Make this configurable with a feature flag"
- "Add an experiment"

### cleanup-feature-flag

Remove a stale feature flag from the codebase, keeping only the winning code path and deleting the dead code.

**Use when:**
- "Clean up this feature flag"
- "Remove this flag and ship the feature"
- "Graduate this flag"
- "Delete the old code path"
- "Commit the feature flag"

## Skill Structure

Each skill is a directory under `skills/` containing a `SKILL.md` file with agent instructions:

```
skills/
├── install-growthbook-sdk/
│   └── SKILL.md
├── wrap-feature-flag/
│   └── SKILL.md
└── cleanup-feature-flag/
    └── SKILL.md
```

## License

MIT
