You are updating the GrowthBook agent skills so they match the GrowthBook REST API and docs. A maintainer reviews every edit you make, so make only edits you can prove and a careful human author would make.

## Inputs

- `skills/` is this repo. Read `skills/CLAUDE.md` first. Its rules on file shape, guardrails, client neutrality, and experiment voice authority apply to every edit.
- `growthbook/` is the GrowthBook monorepo, checked out at `{{AFTER}}`.
- GrowthBook changes to review: commits `{{BEFORE}}..{{AFTER}}`, from these merged PRs:
{{GROWTHBOOK_PRS}}
- `.sync/drift.md` lists skill calls to endpoints that changed in that range, or that are missing or deprecated in the API.
- {{TARGET}}

Read files with the Read, Grep, and Glob tools. Shell access is limited to `git -C growthbook log|show|diff`, `git -C skills diff`, `git -C skills checkout -- <file>`, and the drift checker. Run them from the working directory as written, without `cd`.

## Find what is out of date

1. For each item in `.sync/drift.md`, read the skill text that makes the call. Then read the handler in `growthbook/packages/back-end/src/api/` and its Zod validator in `growthbook/packages/shared/src/validators/`. The validator is the contract.
2. Read the commits in the range with `git -C growthbook log` and `git -C growthbook show`. Look for changes the spec cannot show: approval and review gates, publish and revert behavior, stale-flag criteria, experiment start and stop checks, error codes, enum values, defaults, and the docs that `skills/CLAUDE.md` maps.
3. A skill is out of date only when its text is now wrong or would make an agent send a request that fails. "Could mention the new field" is not out of date. Leave optional additions alone.

## Edit

- Change the fewest words that make the skill correct. Keep the file's voice, formatting, and line structure. Don't rewrap, reorder, or reword text you aren't fixing.
- Describe current behavior only. Skill text never mentions PRs, issues, commits, dates, versions, "now", "updated", "previously", or this sync.
- Only edit existing files under `skills/`. Don't add or delete files, add `##` sections, or touch frontmatter `name`. Change a router `description` only when a trigger phrase is wrong.
- Keep examples literal and copy-pasteable, with the same placeholder style the file already uses (for example `<flag-id>`).
- Don't edit statistical framing or methodology in `experiment-launch.md`. Note it under "Needs a human".
- When the API has no replacement for something a skill relies on, don't invent one. Note it under "Needs a human".
- If you aren't sure, don't edit. Note it under "Needs a human".

## Review your own diff

Run `git -C skills diff`. Read it the way a skills maintainer would, and revert any hunk that:

- isn't required to make the skill correct,
- restates something the file already says,
- reads differently from the text around it, or
- you can't tie to a specific handler, validator, or doc line.

## Write the notes

If you changed nothing and have nothing under "Needs a human", stop without writing anything.

Otherwise write `.sync/notes.md` in exactly this shape. It becomes the PR description (or, when nothing changed, the job summary), so write it for a reviewer who has not seen this prompt.

```markdown
#### Changes

- `skills/<path>.md`: <what was wrong and what it says now>. Source: `<growthbook path>:<line>`.

#### Checked, no change

- `<item>`: <one-line reason>.

#### Needs a human

- `skills/<path>.md`: <the question to decide>.
```

Leave out a heading if it has no items. Don't add other sections, a summary, or a sign-off.
