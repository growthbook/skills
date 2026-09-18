---
name: experiment-visual-editor
description: Create a GrowthBook Visual Editor experiment from a natural-language description of the change, using the same AI endpoint the Chrome extension's prompt box uses. Use when the user says "A/B test this page", "test a different headline on our pricing page", "visual experiment", "test a green CTA", "try a banner on the homepage", or names a URL plus a change they want to test. For a code-level test behind a feature flag, use experiment-launch instead. For attaching metrics and starting the test this creates, use experiment-launch.
---

# experiment-visual-editor

Create a Visual Editor experiment on a live page by describing the change — "shorter, more urgent hero headline", "swap the CTA to green", "add a free-shipping banner". The AI endpoint fetches the page, grounds selectors against it, compiles inserts into idempotent JS, and generates images inline.

**Send prompts, never hand-written `domMutations`.** Building a page catalog or writing mutations directly (`PUT /api/v1/visual-changesets/<id>/visual-change/<visualChangeId>`) skips all of that — a last resort, and say so if you fall back to it.

## Workflow

Collect before writing: the page URL, the change (push for what and where — "the hero headline", "the primary CTA" — not how), and an experiment name you propose and confirm.

### 1. Check the org is set up

```bash
gb-call GET /api/v1/visual-editor/bootstrap
```

- **`hashAttributes` empty → stop.** The user must add one under Settings → Attributes first. Otherwise send `hashAttributes[].property` as step 2's `hashAttribute`: use it if there's one, ask if there are several — it decides bucketing.
- **A `recentExperiments` entry with the same `primaryUrl`** means another visual experiment already targets this page. Surface it before creating a second; they interfere. `projects` supplies the optional `project` id.

### 2. Create the experiment

```bash
echo '{
  "name": "<experiment name>",
  "pageUrl": "https://example.com/pricing",
  "urlPatterns": [
    { "include": true, "type": "simple", "pattern": "https://example.com/pricing" }
  ],
  "hashAttribute": "<from step 1>",
  "hypothesis": "<optional>",
  "project": "<optional project id>"
}' | gb-call POST /api/v1/visual-editor/create-experiment -
```

`pageUrl` becomes the changeset's `editorUrl` — the URL the server refetches to ground every prompt. One concrete public page, no wildcard; breadth goes in `urlPatterns`, which is only matched at runtime (`https://example.com/blog/*` for a section).

Default the pattern to `pageUrl` with query string and hash stripped, so tracking parameters don't stop the test firing — a `simple` pattern checks them only when it names them. Host matching is exact: `example.com` does not match `www.example.com`.

Capture `experiment.id`, `visualChangeset.id`, and `experiment.variations[].variationId` — the field is **`variationId`**, not `id`, and sending anything else in step 3 returns `variationId does not belong to the given changeset`.

**On a 422**, show the body's `warnings` from the org's validation hooks, and resend with `"ignoreWarnings": true` only if the user explicitly accepts them.

### 3. Describe the change

One call per variation — it generates *and* saves. Leave Control alone.

```bash
echo '{
  "prompt": "Make the hero headline shorter and lead with the value prop",
  "variationId": "<variationId of Variant 1>",
  "visualChangesetId": "<visualChangeset.id>",
  "persist": true
}' | gb-call POST /api/v1/visual-editor/ai/edit -
```

Omitting `domDigest` is the point — the server fetches `editorUrl` and builds the element catalog itself. Never send `streamingMode`; it's rejected alongside `persist`.

From the response: show `explanation`; confirm `saved: true` and `visualChangeId`, whose absence means nothing was written; summarise `mutations`/`css`/`js` rather than dumping them; surface `warnings` (capped or failed image generation — the text edits still applied).

- **Images need no extra call.** "Replace the hero image with a photo of a team collaborating" is generated, stored, and referenced inside this one request.
- **One answer per prompt.** With `persist` there's no chooser, so "give me three headlines" returns one. Re-prompt for a different take.
- **To refine**, prompt again with the same `variationId` — mutations accumulate, `css`/`js` are rewritten whole. Pass `conversationHistory` (max 12 `{"role": "user"|"assistant", "text": "..."}` turns) so "less neon" resolves against the previous turn.
- **A third variation**, `POST /api/v1/visual-editor/add-variant` with `{"visualChangesetId": "<id>"}`, then prompt its `newVariationId`.

### 4. Report and hand off

Link the user to `<host>/experiment/<experiment-id>`, deriving `<host>` from `GB_API_URL` by swapping `api.` → `app.` (cloud default: `https://app.growthbook.io`). Then state unprompted that it's a draft with no metrics and isn't running, plus:

- **Visual changes render only if the SDK connection has `Include Visual Experiments` enabled** — the most common reason a visual test appears to do nothing live.
- Preview the variation before starting it: the server works from fetched HTML, not a rendered page.

Then hand off to `references/experiment-launch.md` for metrics and `/start`.

## Guardrails

- **These endpoints need a Personal Access Token.** An org Secret Key works everywhere else in this domain and is rejected here — route to **gb-setup** for a `gb_pat_` key rather than treating it as a permissions problem.
- **Grounding is best-effort and silent.** The fetch is skipped for a page that needs a login, returns a non-200, redirects off-page, exceeds 2 MB or 8 seconds, resolves to a private address on Cloud, or parses as a thin client-rendered shell — and the response looks identical either way. When the URL is plainly one of those, say the model is working blind and the variation needs a preview before it's trusted. Client-rendered pages fail this twice over — the fetch sees an empty shell, and a re-render can overwrite the mutations after hydration — so recommend a feature-flagged code change rather than shipping a flickery test.
- **Only drafts accept visual changes**, checked before generating. To edit a running test the user returns it to draft in GrowthBook.
- **Two prompt quirks:** "title" means the visible `<h1>`, so say "browser tab title" for `document.title`; and a prompt can't clear global `css`/`js`, because the endpoint deliberately treats a falsy value as "no change" rather than "wipe" — clearing is a manual UI edit.
- **Insert prompts produce global JS**, which a strict `script-src` CSP blocks without `'unsafe-inline'` and `'unsafe-eval'` or a nonce. Copy and style changes are unaffected.
- **Caps:** 8000 characters per `prompt`, 3 images per prompt, 60 requests/minute, plus a daily AI cap on Cloud.

## Endpoints used

- `GET /api/v1/visual-editor/bootstrap` — hash attributes, projects, recent visual experiments
- `POST /api/v1/visual-editor/create-experiment` — draft experiment, variations, and changeset in one call
- `POST /api/v1/visual-editor/ai/edit` — prompt to saved change, with `persist: true`
- `POST /api/v1/visual-editor/add-variant` — a third or later variation

## Handoffs

- `references/experiment-launch.md` — attach metrics and start. Always the next step; this workflow never starts anything.
- `references/experiment-design.md` — a page but no hypothesis yet; design first, come back with something to prompt for.
- the **feature-flags** skill — when the change belongs in code behind a flag, which is the better call for client-rendered apps.
- **gb-setup** — a missing or invalid `GB_API_KEY`, or a Secret Key that needs to be a PAT.
