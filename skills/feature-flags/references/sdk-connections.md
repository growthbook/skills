---
name: sdk-connections
description: List, update, archive, restore, or delete a GrowthBook SDK connection. Use when the user says "list our SDK connections", "archive this SDK connection", "restore the archived connection", "delete the SDK connection", "rename the SDK connection", or "why can't I delete this SDK connection". Handles the approval rules that gate SDK connection writes. For flags served through a connection, use flag-search or flag-cleanup.
---

# sdk-connections

List, update, archive, restore, or delete a GrowthBook SDK connection. `PUT` applies to the live connection immediately and is recorded as a published revision. When the organization has an approval rule covering the connection, the API refuses the write unless the request passes `bypassApproval`; the alternative is to stage the change in a draft revision and get it reviewed. This workflow does not create connections or manage their webhooks.

## Required inputs

- **Connection ID** — resolve it from the list in step 1 if the user gives a name.
- **Action** — update settings, archive, restore, or delete.
- **New values** — only for an update. Send only the fields that change.

## Workflow

### 1. Find the connection

```bash
gb-call GET '/api/v1/sdk-connections?limit=100'
gb-call GET '/api/v1/sdk-connections?archived=true&limit=100'
gb-call GET /api/v1/sdk-connections/<connection-id>
```

The list omits archived connections unless `archived=true`, which returns them alongside the active ones. `GET` by id and `GET /api/v1/sdk-connections/lookup/<sdk-key>` return archived connections too. Show the user only `id`, `name`, `environment`, `projects`, `languages`, and `archived`.

### 2. Confirm, then write

Ask before any write. An archived connection serves no payload, so tell the user which environment and projects stop receiving updates.

```bash
echo '{"archived": true}' \
  | gb-call PUT /api/v1/sdk-connections/<connection-id> -
```

Use `{"archived": false}` to restore. To change settings, send only the changed fields, for example `{"name": "<new-name>"}`. Omitted fields keep their current values. Archiving takes the same permission as deleting; restoring takes publish permission.

```bash
gb-call DELETE /api/v1/sdk-connections/<connection-id>
```

Deletion is permanent. Offer archive first when the user only wants the connection to stop serving. `DELETE` takes no body and removes only an archived connection; archive a live one first.

### 3. Handle a refusal

**A `400` that says `This organization requires approvals on SDK connections`** (on `PUT`) means an approval rule covers the connection. Halt and offer:

> This connection requires approval. To proceed:
>
> **A. Standard review flow** (recommended) — I stage the change in a draft revision and request review. A teammate approves it in GrowthBook at `/sdks/<connection-id>`, then I publish it.
>
> **B. Bypass** — I retry with `bypassApproval: true`. This needs a role with `bypassApprovalSDKConnections` on the connection's projects, or the organization setting "REST API always bypasses approval requirements".

If the user picks A, stage the change in a draft. The `new` version creates the draft and applies the edit in one call:

```bash
echo '{"archived": true, "revisionTitle": "<title>"}' \
  | gb-call PUT /api/v1/sdk-connections-revisions/<connection-id>/new/archive -

echo '{"name": "<new-name>", "revisionTitle": "<title>"}' \
  | gb-call PUT /api/v1/sdk-connections-revisions/<connection-id>/new/settings -
```

Use `/archive` for `archived` and `/settings` for every other field. Each response holds the `revision` and its `version`; pass that `version` in place of `new` for further edits to the same draft. Then request review:

```bash
echo '{}' \
  | gb-call POST /api/v1/sdk-connections-revisions/<connection-id>/<version>/request-review -
```

Stop and tell the user a different member has to approve; no one can approve a draft they created. After the draft's `status` is `approved`, publish it:

```bash
echo '{}' \
  | gb-call POST /api/v1/sdk-connections-revisions/<connection-id>/<version>/publish -
```

A publish that cannot go ahead returns one `422` whose `gates` array lists every blocker with its `override` flag, `requiresPermission`, and `resolution` route. Show the gates to the user and stop. A `stale-base` gate means the live connection changed after the draft opened and the draft needs a rebase; tell the user and do not force the publish.

If the user picks B, retry only after they say so:

```bash
echo '{"archived": true, "bypassApproval": true}' \
  | gb-call PUT /api/v1/sdk-connections/<connection-id> -
```

A `403` on the retry means the key has no bypass authority; stop and report it. A bypassed write returns `bypassedGates` with `type: "approval-required"`; tell the user the approval was bypassed.

A `400` that says another draft has a scheduled publish that locks other drafts means a scheduled draft is blocking the write. Surface the body and stop; a person has to cancel that schedule.

**A `403` on `DELETE` of a live connection** says `Cannot delete a live SDK Connection via the REST API`. The organization has not enabled "REST API always bypasses approval requirements", so a live connection cannot be deleted in one step. Archive it first with step 2 (or with the draft flow above when `PUT` is refused), then delete it once the archive is live. `DELETE` has no `bypassApproval` field.

### 4. Report

State the connection `id`, its final state (`archived`, restored, updated, or deleted), and whether `bypassedGates` was returned. Link `/sdks/<connection-id>` for anything but a deleted connection.

## Guardrails

- **Never print `key`, `encryptionKey`, or `proxySigningKey`.** Every connection response includes them. Pick the fields you need before showing anything to the user.
- **Never send `bypassApproval` on the first attempt.** The refusal in step 3 is the approval policy working. Retry with it only when the user asks for the bypass.
- **Archive is gated too.** `archived` is one of the settings an approval rule covers, so on a gated connection `{"archived": true}` is refused like any other change. Deleting a live connection is refused until it is archived, whether or not an approval rule covers it. Deleting an already archived connection needs no approval.
- **A bypass role does not authorize deleting a live connection.** Only the organization setting does, as for flags; `references/flag-cleanup.md` describes the flag case.
- **Never send `ignoreWarnings` or `skipHooks` on a publish unless the user asks.** `ignoreWarnings` acknowledges a warning, such as a webhook that references a missing secret; `skipHooks` overrides a Custom Hook rejection and needs Bypass draft approvals access for SDK connections in every project.
- **A write that changes nothing returns `200` with the unchanged connection.** Archiving an archived connection is a no-op, not an error.

## Endpoints used

- `GET /api/v1/sdk-connections` (query: `archived`, `projectId`, `limit`, `offset`)
- `GET /api/v1/sdk-connections/:id`
- `GET /api/v1/sdk-connections/lookup/:key`
- `PUT /api/v1/sdk-connections/:id` (body: any create field, `archived`, `bypassApproval`)
- `DELETE /api/v1/sdk-connections/:id` (no body)
- `PUT /api/v1/sdk-connections-revisions/:id/:version/settings` and `.../archive` (`:version` is a number or `new`; body: the fields to stage, plus `revisionTitle`, `revisionComment`)
- `POST /api/v1/sdk-connections-revisions/:id/:version/request-review`
- `POST /api/v1/sdk-connections-revisions/:id/:version/publish`

## Handoffs

- `references/flag-cleanup.md` — to archive or delete a feature flag rather than a connection
- the **gb-setup** skill — when `gb-call` reports a missing or invalid `GB_API_KEY`
