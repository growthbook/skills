---
name: learnings
description: Search, read, and record Learnings — the durable conclusions a team has drawn across multiple experiments. Use when the user asks "what have we learned about X", "do we already know whether Y works", "have we tested this before", "record this as a learning", or when a finished experiment produces a conclusion worth keeping. Check before designing a new experiment so you don't re-test something already settled. Most orgs have no Learnings yet — an empty result means none are recorded, not that there's no history, so fall through to experiment-brainstorm. For a single experiment's results, use experiment-analyze.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *)
---

# learnings

A Learning is a durable conclusion that spans **multiple** experiments — "urgency messaging lifts checkout on mobile" — not a summary of one test. Each cites the experiments supporting it and the ones contradicting it, so it carries its own evidence.

Learnings are a **curated layer on top of** the experiment record, never a replacement for it. A Learning is what someone concluded; the experiments are the evidence. Most teams have far more experiment history than Learnings, so reading Learnings is a shortcut when one exists — not a substitute for looking at past experiments.

All API calls go through the bundled helper: `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`. It needs `GB_API_KEY` — set in your shell, or written to `~/.config/growthbook/.env` by `/growthbook:gb-setup`. If unset or invalid, gb-call's error message points back at `/growthbook:gb-setup`.

## When to use this

1. **Before designing an experiment** — search first. The team may have already settled the question, or hold contrary evidence worth knowing. This is the highest-value use.
2. **When the user asks what's known** about an area, tactic, or audience.
3. **After analyzing a finished experiment**, when the result generalizes beyond that one test.

## An empty corpus is the normal starting state

Learnings only exist once someone has saved one, so **most orgs have none** — including orgs with years of experiment history. An empty search result is not a finding.

When a search returns nothing:

- Say plainly that no Learnings have been recorded yet. Do **not** report it as "the team has no prior knowledge about this" — that conflates an empty curated layer with an empty experiment history.
- Fall back to the experiment record: `experiment-brainstorm` grounds ideas in past stopped experiments, and `experiment-analyze` reads a specific experiment's results. An empty Learnings search must never stop you from checking those.
- If past experiments did answer the question, that's a good moment to offer to record the conclusion as the team's first Learning.

## Workflow

### Finding what's already known

Prefer search over list when the question is conceptual — it ranks by meaning, not keyword:

```bash
echo '{"query":"checkout friction"}' | gb-call POST /api/v1/learnings/search -
```

Optional `limit` (integer, max 50) and `projectId`. Each result carries a `similarity` score (0–1) alongside the Learning. This is a POST only because the query goes in the body — it reads and changes nothing.

Use the list endpoint when you want a filtered slice rather than a ranked one:

```bash
gb-call GET '/api/v1/learnings?tag=pricing'
gb-call GET '/api/v1/learnings?experimentId=exp_abc'
```

Filters: `projectId`, `experimentId`, `tag`, `status`. `experimentId` returns Learnings citing that experiment in **either** direction — supporting or contradicting.

One Learning in full:

```bash
gb-call GET /api/v1/learnings/<learning-id>
```

### Recording a Learning

1. **Search first.** If an existing Learning already covers the conclusion, extend it instead of creating a near-duplicate — add the new experiment to its `supportingExperimentIds`:

   ```bash
   echo '{"supportingExperimentIds":["exp_abc","exp_def","exp_new"]}' \
     | gb-call PUT /api/v1/learnings/<learning-id> -
   ```

   `PUT` replaces the arrays it receives, so include the existing ids as well as the new one.

2. **Otherwise create it.** Only `title` is required:

   ```bash
   cat <<'JSON' | gb-call POST /api/v1/learnings -
   {
     "title": "Urgency messaging lifts add-to-cart on mobile",
     "text": "Countdown copy moved add-to-cart in two tests...",
     "tags": ["urgency", "mobile"],
     "supportingExperimentIds": ["exp_abc", "exp_def"],
     "contradictingExperimentIds": [],
     "projects": ["prj_123"]
   }
   JSON
   ```

   `status` takes the id of a status configured under Settings → General → Experiment Settings; omit it or pass `""` for none. An unknown id is rejected.

## Quality bar

Be strict. A corpus full of restated single results is worse than a small one.

- **Two or more experiments.** One result is an experiment outcome, not a Learning. If only one test supports it, say so and suggest waiting for corroboration.
- **Cite the evidence.** Always populate `supportingExperimentIds`, and `contradictingExperimentIds` when results disagree. Contrary evidence makes a Learning more trustworthy, not less — never drop it to make one look cleaner.
- **Significance, not direction.** Only count a result as evidence when the metric actually moved significantly. An inconclusive test is "no result", which is not the same as evidence of no effect.
- **Check which way is good.** For inverse metrics (bounce rate, unsubscribes, latency) a positive lift is a regression, not a win.
- **Generalize.** State the transferable pattern and what to do next, not a recap of what happened.

## Guardrails

- **Confirm before writing.** Create and update are mutations — show the user the title and text and get agreement first. Never record a Learning as a side effect of an analysis the user asked for.
- **Attribution is automatic.** Learnings created over the API are marked `source: "api"`, distinguishing them from AI-discovered and hand-written ones. Do not try to set it.
- **Enterprise-gated.** Create, update, and search require a plan including Learnings; search also needs AI enabled for the org. A `403` means the org isn't entitled — report it plainly rather than retrying.
- **Not on the API:** the in-app AI flows that *discover* Learnings across experiments and *refresh* one against newer experiments are app-only routes. If the user wants those, point them at the Learnings page — there is no endpoint to call.

## Endpoints used

| Method | Path | Purpose |
| ------ | ---- | ------- |
| POST | `/api/v1/learnings/search` | Rank Learnings by meaning against a query |
| GET | `/api/v1/learnings` | List, filtered by `projectId` / `experimentId` / `tag` / `status` |
| GET | `/api/v1/learnings/<id>` | Read one |
| POST | `/api/v1/learnings` | Create |
| PUT | `/api/v1/learnings/<id>` | Update |
| DELETE | `/api/v1/learnings/<id>` | Delete |

## Handoffs

- `experiment-analyze` — to interpret a single experiment's results before deciding whether the conclusion generalizes.
- `experiment-design` — once you know what's already settled, design the next test around the gap rather than re-testing.
- `experiment-brainstorm` — to ground new ideas in past results.
