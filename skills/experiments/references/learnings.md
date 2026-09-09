---
name: learnings
description: Search, read, and record Learnings — the durable conclusions a team has drawn across multiple experiments. Use when the user asks "what have we learned about X", "do we already know whether Y works", "have we tested this before", "record this as a learning", or when a finished experiment produces a conclusion worth keeping. Check before designing a new experiment so you don't re-test something already settled. For a single experiment's results, use experiment-analyze.
---

# learnings

A Learning is a durable conclusion that spans multiple experiments — for example, "urgency messaging lifts checkout on mobile" — rather than a summary of one test. Each Learning cites experiments supporting it and experiments contradicting it, so the conclusion carries its evidence.

Use this workflow before designing an experiment, when the user asks what the team knows, or after analysis produces a conclusion that generalizes beyond one test.

## Contents

- Workflow
  - Find what is already known
  - Record a Learning
  - Update or delete a Learning
- Quality bar
- Guardrails
- Endpoints used
- Handoffs

## Workflow

### 1. Find what is already known

Prefer semantic search when the question is conceptual:

```bash
echo '{"query":"checkout friction"}' | gb-call POST /api/v1/learnings/search -
```

Optional fields are `limit` (positive integer, maximum 50) and `projectId`. Results include a `similarity` score from 0 through 1.

This POST is read-only: the query is in the request body, and the endpoint runs immediately without changing a Learning.

Use the list endpoint for a filtered slice:

```bash
gb-call GET '/api/v1/learnings?tag=pricing'
gb-call GET '/api/v1/learnings?experimentId=exp_abc'
```

Available filters are `projectId`, `experimentId`, `tag`, and `status`. `experimentId` returns Learnings that cite the experiment as either supporting or contradicting evidence.

Fetch one Learning in full with:

```bash
gb-call GET /api/v1/learnings/<learning-id>
```

An empty result is normal, especially for organizations that have not started curating Learnings. Semantic search excludes Learnings that have no usable embedding, so check the list endpoint before treating the curated corpus as empty. It still does not mean the organization has no experiment history or relevant evidence. Fall back to `references/experiment-brainstorm.md` to search stopped experiments, or `references/experiment-analyze.md` for a known experiment.

### 2. Record a Learning

Search first. If an existing Learning covers the conclusion, extend it instead of creating a near-duplicate. `PUT` is a partial update, but any array included in the request replaces the whole stored array, so include both existing and new experiment IDs.

Show the proposed update and get confirmation:

```bash
echo '{
  "supportingExperimentIds": ["exp_abc", "exp_def", "exp_new"]
}' | gb-call PUT /api/v1/learnings/<learning-id> -
```

If no Learning covers the conclusion, show the proposed title, text, evidence, projects, tags, and status. Create it only after confirmation:

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

Only `title` is required by the API. A useful Learning should also include explanatory text and experiment evidence.

`status` takes the ID of a status configured under Settings → General → Experiment Settings. Omit it or pass `""` for no status. An unknown ID is rejected.

### 3. Update or delete a Learning

Fetch the current Learning first. For updates, show the fields that will change and get confirmation:

```bash
echo '{
  "title": "Updated conclusion",
  "status": "validated"
}' | gb-call PUT /api/v1/learnings/<learning-id> -
```

The update body is partial. Allowed fields are `title`, `text`, `tags`, `supportingExperimentIds`, `contradictingExperimentIds`, `projects`, and `status`. Owner and source cannot be changed through this endpoint.

Deletion is permanent. Show the full Learning, explain that its curated conclusion and evidence links will be removed, and require explicit confirmation immediately before:

```bash
gb-call DELETE /api/v1/learnings/<learning-id>
```

## Quality bar

- **Require evidence across experiments.** One result is an experiment outcome, not a durable Learning. If only one test supports it, say so and wait for corroboration.
- **Cite both directions.** Populate `supportingExperimentIds`, and include `contradictingExperimentIds` when results disagree. Do not drop contrary evidence to make a conclusion look cleaner.
- **Use decision-quality results, not direction alone.** Judge evidence with the experiment's configured statistical engine, intervals, data-quality checks, and decision thresholds. An inconclusive directional movement is not proof of an effect.
- **Check which direction is desirable.** For inverse metrics such as latency or refunds, an increase is a regression.
- **Generalize carefully.** State the transferable pattern, its scope, and what to do next instead of restating an individual result.

## Guardrails

- **Confirm before every write.** Create, update, and delete are mutations. Never record a Learning as an unrequested side effect of experiment analysis.
- **An empty Learning corpus is not an empty experiment record.** Search the experiment history before concluding that the team has no prior evidence.
- **Semantic search only returns Learnings with usable embeddings.** If search returns nothing, check `GET /api/v1/learnings` before concluding that no Learnings are saved.
- **Search is read-only despite using POST.** The natural-language query lives in the body; it does not create or update configuration.
- **API attribution is automatic.** Learnings created through the REST API have `source: "api"`. Do not send `source`.
- **Create and update require the Learnings premium feature.** Semantic search also requires Learnings entitlement, AI access, and available embedding capacity. Reads remain available after a downgrade.
- **Array updates replace arrays.** When adding one experiment ID, first fetch the Learning and send the complete revised array.
- **The API validates configured status IDs.** An unknown non-empty status fails; do not invent one.
- **The in-app discovery and refresh flows are not public REST endpoints.** Direct users to the Learnings page for AI discovery across experiments or refreshing a Learning against newer experiments.
- **Writes are permission-checked.** If create, update, or delete is denied, surface the API error rather than retrying or attempting to change ownership.

## Endpoints used

- `POST /api/v1/learnings/search` — rank saved Learnings by semantic similarity
- `GET /api/v1/learnings` — list with `projectId`, `experimentId`, `tag`, and `status` filters
- `GET /api/v1/learnings/:id` — read one Learning
- `POST /api/v1/learnings` — create a Learning
- `PUT /api/v1/learnings/:id` — update selected fields
- `DELETE /api/v1/learnings/:id` — permanently delete a Learning

## Handoffs

- `references/experiment-analyze.md` — interpret a single experiment before deciding whether its result contributes to a broader conclusion
- `references/experiment-design.md` — design the next test around a remaining knowledge gap
- `references/experiment-brainstorm.md` — inspect stopped experiments when the Learning corpus is empty or incomplete
