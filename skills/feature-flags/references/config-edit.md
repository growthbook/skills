---
name: config-edit
description: Edit the value or schema of a GrowthBook Config through a draft revision, then publish it. Use when the user says "change the value of config X", "add a field to config X", "update the schema of config X", "import a JSON schema for this config", "retype a field in config X", or "publish my config draft". Handles writes rejected because the value no longer fits the schema. For a feature flag's value, use flag-default-value or flag-targeting. For a flag's own draft or publish, use flag-publish.
---

# config-edit

Change the value or the field schema of an existing GrowthBook Config. A Config is a typed JSON object that other Configs and feature flags build on. Every change goes through a draft revision and takes effect only when the draft is published. This workflow does not create, lock, archive, or delete Configs, and does not edit parents, mixins, rules, or projections.

## Required inputs

- **Config key** — the `key`, not the `id`. List with `gb-call GET '/api/v1/configs?limit=100'` if the user gives a name.
- **The change** — a new `value`, a new schema, or both.

## Workflow

### 1. Fetch the Config

```bash
gb-call GET /api/v1/configs/<config-key>
```

Capture `value`, `schema`, `parent`, `extensible`, `locked`, and `archived`. `value` and `schema` hold only this Config's own fields; fields from `parent` are layered in when the Config is served. Show the user the current `value` before changing it.

If `locked` is `true`, you can still stage a draft, but it cannot be published until someone with Bypass draft approvals access unlocks the Config. Tell the user before staging.

### 2. Stage the change in a draft

Write a value. `new` opens a fresh draft and stages the change in one call:

```bash
echo '{"value": {<own fields>}, "revisionTitle": "<title>"}' \
  | gb-call PUT /api/v1/configs-revisions/<config-key>/new/value -
```

`value` replaces the draft's whole own value. To change one field, send `{"property": "<name>", "value": <json>}` to `.../<version>/property` instead, which leaves the other fields as they are.

Write a schema. Send exactly one source, `schema` or `infer`:

```bash
echo '{"schema": {"type": "json-schema", "value": {<JSON Schema>}}}' \
  | gb-call PUT /api/v1/configs-revisions/<config-key>/<version>/schema -
```

`schema.type` is `json-schema` (preferred) or `typescript`. `infer: true` derives the schema from the draft's value. Add `value` to the same request to stage a value with the schema.

Each response holds the `revision` and its `version`, plus `warnings` when the importer or an ancestor changed something. Show every warning to the user.

### 3. Handle a rejected write

The API checks each write against what the draft would publish: its own schema, parent, mixins, and `extensible` setting, not the live Config. A `400` names the field and what is wrong. When the write was the first call on `new`, the draft it opened is discarded. Fix the request by cause:

- **The value sets a key the schema doesn't declare** (and the Config does not allow extra fields). Ask the user whether to declare it. If yes, resend the value with `"inferUndeclaredFields": true`. That adds an optional field, inferred from its value, for each undeclared top-level key; it never changes an existing field and skips keys that hold a `@const:` or `@config:` reference. Each added field comes back in `warnings` with `code: "inferred-field"`.
- **The value no longer fits a field's type, or sets a field you are removing.** Send one `PUT .../schema` with both `schema` and `value`. A schema write alone is checked against the old value, and a value write alone against the old schema, so a retype or removal fails as two calls.
- **The Config has no schema yet.** Send `"inferSchemaIfMissing": true` with the value write. It has no effect once the draft has schema fields.
- **A `@config:` entry in `value`.** Not accepted. Inheritance comes from `parent` and `extends`, which this workflow does not change.

### 4. Publish

Ask the user to confirm, then:

```bash
echo '{}' | gb-call POST /api/v1/configs-revisions/<config-key>/<version>/publish -
```

Branch on the response:

- **200** → step 5.
- **202** → held for a person's confirmation; nothing is published. Handle it as the router's failure modes describe.
- **400 `This revision requires approval before publishing`** → the organization requires review. Request it and stop:

  ```bash
  echo '{}' \
    | gb-call POST /api/v1/configs-revisions/<config-key>/<version>/request-review -
  ```

  Tell the user a teammate has to approve the draft in GrowthBook at `/configs/<config-key>`, then ask you to publish again.
- **409** → the live Config changed after the draft opened, or the organization requires a rebase. Halt and show the body; do not rebase or force the publish.
- **422** → one or more publish gates block it. `gates` lists each with its `resolution`. Show them and stop.

### 5. Report

State the Config `key`, the published `version`, the fields that changed, and any `bypassedGates` in the response. Link `/configs/<config-key>`.

## Guardrails

- **Thread the `version`; send `new` only for the first write.** Unlike feature flags, `new` on a Config always opens another draft and never reuses an existing one. Sending it for every call leaves one draft per field.
- **Never send `ignoreWarnings`, `skipSchemaValidation`, or `skipHooks` unless the user asks.** They override publish checks, and `skipSchemaValidation` and `skipHooks` need Bypass draft approvals access.
- **Do not publish a value that fails the schema by editing the schema to match.** Ask the user whether the value or the schema is wrong first.
- **Only a draft in `draft`, `pending-review`, `approved`, or `changes-requested` status can be edited.** A write to a `merged` or `discarded` revision returns `400`.

## Endpoints used

- `GET /api/v1/configs` (query: `limit`, `offset`)
- `GET /api/v1/configs/:key`
- `PUT /api/v1/configs-revisions/:key/:version/value` (`:version` is a number or `new`; body: `value`, `inferSchemaIfMissing`, `inferUndeclaredFields`, `revisionTitle`, `revisionComment`)
- `PUT /api/v1/configs-revisions/:key/:version/property` (body: `property`, `value`)
- `PUT /api/v1/configs-revisions/:key/:version/schema` (body: `schema` or `infer`, `value`, `additionalProperties`, `revisionTitle`, `revisionComment`)
- `POST /api/v1/configs-revisions/:key/:version/request-review`
- `POST /api/v1/configs-revisions/:key/:version/publish`

## Handoffs

- `references/flag-default-value.md` — to change what a feature flag serves rather than a Config
- `references/flag-publish.md` — to publish a feature flag draft
- the **gb-setup** skill — when `gb-call` reports a missing or invalid `GB_API_KEY`
