---
name: experiment-visual-editor
description: Create a GrowthBook Visual Editor experiment from a natural-language description of the change, using the same AI endpoint the Chrome extension's prompt box uses. Use when the user says "A/B test this page", "test a different headline on our pricing page", "visual experiment", "test a green CTA", "try a banner on the homepage", or names a URL plus a change they want to test. For a code-level test behind a feature flag, use experiment-launch instead. For attaching metrics and starting the test this creates, use experiment-launch.
---

# experiment-visual-editor

Create a Visual Editor experiment on a live page from a plain-language description of the change — "make the hero headline shorter and more urgent", "swap the CTA to green", "add a free-shipping banner at the top". Every change goes through GrowthBook's visual-editor AI endpoint, the same one behind the Chrome extension's prompt box, which grounds selectors against a catalog of the page, refuses to wreck the page with a whole-document `innerHTML` swap, compiles inserts into safe idempotent JS, and generates images inline.

**Send prompts, not hand-written mutations.** The endpoint carries a large amount of edge-case handling that a hand-built `domMutations` array gets no benefit from. Writing mutations directly is possible (`PUT /api/v1/visual-changesets/<id>/visual-change/<visualChangeId>`) but is a last resort for a change the prompt genuinely can't express — say so plainly if you fall back to it.

This workflow leaves a **draft** experiment with no metrics. It does not start anything.

## Contents

- Required inputs
- Workflow
  - 1. Check the org is set up for this
  - 2. Create the experiment
  - 3. Build the page catalog
  - 4. Describe the change
  - 5. Report and hand off
- Guardrails
- Endpoints used
- Handoffs

## Required inputs

Collect all four before the first write:

- **Page URL** — the live page the test runs on.
- **The change to test** — free text, becomes the prompt. Vague input produces vague variations; push for what and where ("the hero headline", "the primary CTA") but not how.
- **Hash attribute** — comes from step 1. Never guess it.
- **Experiment name** — propose one from the change description and confirm it.

Optional: project, hypothesis, description, extra URL patterns.

## Workflow

- [ ] 1. Bootstrap and check prerequisites
- [ ] 2. Create the draft experiment and changeset
- [ ] 3. Build the page catalog
- [ ] 4. Prompt for each variation
- [ ] 5. Report, and hand off to `experiment-launch`

### 1. Check the org is set up for this

```bash
gb-call GET /api/v1/visual-editor/bootstrap
```

Returns `projects` (`{id, name}`), `hashAttributes` (`{property, description?}` — send the **`property`** value as `hashAttribute` in step 2), and up to 30 `recentExperiments` (each with `experimentId`, `experimentName`, `visualChangesetId`, `primaryUrl`, `status`, `updatedAt`).

- **`hashAttributes` empty → stop.** The org has no hashable attribute configured. The user sets one under Settings → Attributes in GrowthBook; nothing here works without it.
- **Pick the hash attribute.** If there's exactly one, use it and say which. If several, ask — it decides how visitors are bucketed.
- **Check `recentExperiments` for the same `primaryUrl`.** If one already targets this page, surface it before creating a second: overlapping visual experiments on one URL interfere with each other.


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

Default the pattern to the page URL with **query string and hash stripped**. A `simple` pattern matches on host and path, and only checks query params or the hash when the pattern itself names them — so stripping them makes the test fire regardless of tracking parameters, which is nearly always what's wanted. Offer `https://example.com/blog/*` when the user wants a whole section. Host matching is exact: `example.com` does not match `www.example.com`.

Capture from the response:

- `experiment.id`
- `experiment.variations[].variationId` — the field is **`variationId`**, not `id`
- `visualChangeset.id`

The experiment is created as a **draft**, with a `Control` and a `Variant 1`, split 50/50.

**On a 422**, the body carries a `warnings` array from the org's custom validation hooks. Show the warnings to the user and re-send with `"ignoreWarnings": true` added to the body **only** if they explicitly accept them.

### 3. Build the page catalog

The endpoint grounds every selector against a catalog of what's actually on the page. Without one it cannot check its own work — its self-correction pass is skipped entirely, and invented selectors reach the saved experiment unchallenged. Build one.

Fetch the page HTML with whatever web-fetch capability you have, then build the catalog. It becomes the `domDigest` field of the step-4 request body:

```json
{
  "url": "https://example.com/pricing",
  "title": "Pricing — Example",
  "elements": [
    { "selector": "#hero-title", "tag": "h1", "text": "Plans for every team" },
    { "selector": ".hero .cta-primary", "tag": "a", "text": "Start free", "href": "/signup" },
    { "selector": "#hero img", "tag": "img", "src": "/img/hero.png", "alt": "Dashboard" }
  ]
}
```

Selector rules — a selector that doesn't resolve on the real page produces a change that silently never applies:

- Prefer `#id`. Then a class that appears exactly once. Then a short scoped path (`.hero h1`).
- **Never invent one.** If you can't derive a selector from the HTML, leave the element out.
- Cap at ~150 entries. Cover headings, CTAs, nav links, form fields, and images — not every `<span>`.

Optionally add `pageStructure` (max 400 entries) for sections and layout wrappers:

```json
{ "selector": ".trusted-by", "parentSelector": "main", "tag": "section", "label": "Trusted by" }
```

This is the only thing that lets the model look up containers by name — needed for "move the Trusted-by section above the pricing table", since sections are deliberately absent from the element catalog.

**If the page is client-rendered** and the HTML has no real content, say so, proceed without a catalog, and warn that the model can only reliably target `body`, `html`, and selectors the user names explicitly.

### 4. Describe the change

One call per variation. It generates *and* saves.

Build the request body as a file — the catalog is far too big to inline in a shell string, and `gb-call` takes a body file as its third argument:

```json
{
  "prompt": "Make the hero headline shorter and lead with the value prop",
  "variationId": "<variationId of Variant 1>",
  "visualChangesetId": "<visualChangeset.id>",
  "persist": true,
  "domDigest": {
    "url": "https://example.com/pricing",
    "title": "Pricing — Example",
    "elements": [
      { "selector": "#hero-title", "tag": "h1", "text": "Plans for every team" }
    ]
  }
}
```

```bash
gb-call POST /api/v1/visual-editor/ai/edit ./ve-edit.json
```

Do **not** send `streamingMode` — it's for the extension's interactive tool loop and is rejected alongside `persist`.

The response carries:

- `explanation` — one paragraph on what it did. Show this to the user.
- `mutations`, `css`, `js` — what was applied. Summarise; don't dump raw JSON unless asked.
- `saved: true` and `visualChangeId` — confirm both. Their absence means nothing was written.
- `images` — any images generated for this prompt.
- `warnings` — image generation that was capped or failed. Surface these; the text edits still applied.

Leave Control alone. It is the unmodified page, and that's the point.

**Image prompts need nothing extra.** "Replace the hero image with a photo of a team collaborating" is handled inside this one call — generated, stored permanently, and referenced in the saved change.

**Asking for alternatives doesn't work here, by design.** With `persist` there is no chooser to pick from, so the endpoint returns one best answer rather than paying to generate options it would throw away. "Give me three headlines" gets you one — re-prompt for a different take instead.

**To refine**, send another prompt with the same `variationId`. Mutations accumulate; `css` and `js` are rewritten in full each time. Pass the exchanges so far as `conversationHistory` (max 12 turns, `{"role": "user"|"assistant", "text": "..."}`) so "make the green less neon" resolves against the previous turn.

**For a third variation**, `POST /api/v1/visual-editor/add-variant` with `{"visualChangesetId": "<id>"}`, then prompt against the `newVariationId` it returns.

### 5. Report and hand off

Give the user the link:

```
<host>/experiment/<experiment-id>
```

Derive `<host>` from `GB_API_URL` by swapping `api.` → `app.` (on the default cloud host, `https://app.growthbook.io`).

Then state plainly, without being asked:

- The experiment is a **draft**. It has no metrics and is not running.
- **Visual changes only render if the SDK connection has `Include Visual Experiments` enabled.** Without it the experiment is valid and does nothing. This is the single most common reason a visual test appears to do nothing on the live site.
- They should preview the variation before starting it — the model works from a catalog, not a rendered page.

Then hand off to `references/experiment-launch.md` to attach goal and guardrail metrics and start the test.

## Guardrails

- **These endpoints need a Personal Access Token.** An org Secret Key works everywhere else in this domain and is rejected here. On that error, route to **gb-setup** to swap in a `gb_pat_` key rather than treating it as a permissions problem.
- **Only draft experiments accept visual changes.** `persist` checks this before generating, so a running or archived experiment fails fast rather than burning AI quota. To edit a running test, the user sets it back to draft in GrowthBook.
- **`variationId` is the `var_…` string** from `experiment.variations[].variationId` — not the visual change id, not the key `"1"`, not an index. Anything else returns `variationId does not belong to the given changeset`.
- **Never write `""` to `css` or `js` to clear them.** The endpoint omits those fields when unchanged, and treats a falsy value as "no change" rather than "wipe" — deliberately, so a prompt can't destroy a stylesheet. Clearing global CSS/JS is a manual edit in the GrowthBook UI.
- **`insert` in the response is a preview, not a to-do.** New elements are already compiled into the variation's `js` server-side, as scoped idempotent snippets. Applying them again double-inserts.
- **"Title" means the visible `<h1>`**, not the browser tab. If the user wants `document.title`, say "browser tab title" in the prompt explicitly.
- **Adding new elements produces global JS, which a strict CSP can block.** A site with a `script-src` policy needs `'unsafe-inline'` and `'unsafe-eval'`, or a nonce. Copy and style changes are unaffected — mention this only for insert-style prompts.
- **Heavily client-rendered pages are a poor fit.** A framework re-render can overwrite DOM mutations after hydration. For a React/Vue app, a feature-flagged code change is usually the better tool — say so rather than shipping a flickery test.
- **These endpoints are internal.** `/api/v1/visual-editor/*` is the private contract between the back end and the Chrome extension: it is excluded from the OpenAPI spec and carries no deprecation guarantees. If a call starts failing with a schema error, re-verify against `packages/back-end/src/api/visual-editor-ai/` in the GrowthBook repo. The `/api/v1/visual-changesets/*` endpoints used for verification are public and stable.
- **Budget.** 60 requests/minute per key. `prompt` caps at 8000 characters and the whole body at 2 MB — the catalog is what gets near that, so keep it trimmed. Image generation is capped at 3 per prompt. GrowthBook Cloud also enforces a daily AI cap.

## Endpoints used

- `GET /api/v1/visual-editor/bootstrap` — hash attributes, projects, and recent visual experiments
- `POST /api/v1/visual-editor/create-experiment` — draft experiment, variations, and changeset in one call
- `POST /api/v1/visual-editor/ai/edit` — natural-language prompt to saved changes, with `persist: true`
- `POST /api/v1/visual-editor/add-variant` — add a third or later variation to the changeset
- `GET /api/v1/visual-changesets/<id>` — read back what was saved, to verify or to inspect before re-prompting

## Handoffs

- `references/experiment-launch.md` — attach goal and guardrail metrics and start the test. Always the next step; this workflow never starts anything.
- `references/experiment-design.md` — when the user has a page but no clear hypothesis yet, design the test first and come back with something specific to prompt for.
- `references/experiment-analyze.md` — once it's running and has data.
- `references/experiment-stop.md` — to stop it and declare a winner.
- the **feature-flags** skill — when the change turns out to belong in code behind a flag rather than in the DOM, which is the better call for client-rendered apps.
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`, or when the key is a Secret Key and needs to be a PAT.
