---
name: sdk-connections
description: List, update, archive, restore, or delete a GrowthBook SDK connection. Use when the user says "list our SDK connections", "archive this SDK connection", "restore the archived connection", "delete the SDK connection", "rename the SDK connection", or "why can't I delete this SDK connection". Handles the approval rules that gate SDK connection writes. For flags served through a connection, use flag-search or flag-cleanup.
---

# sdk-connections

List, update, archive, restore, or delete a GrowthBook SDK connection. Updates, archives, and restores apply to the live connection immediately; they do not go through a draft revision. When the organization has an approval rule covering the connection, the API refuses the write unless the request passes `bypassApproval`. This workflow does not create connections or manage their webhooks.

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

Deletion is permanent. Offer archive first when the user only wants the connection to stop serving.

### 3. Handle an approval refusal

A `400` whose body says `This organization requires approvals on SDK connections` (on `PUT`), or `must be archived before it can be deleted` (on `DELETE` of a live connection), means an approval rule covers the connection. Halt and offer:

> This connection requires approval. To proceed:
>
> **A. Standard review flow** (recommended) — make the change in a draft on the connection page at `/sdks/<connection-id>`, get it approved, and publish it there.
>
> **B. Bypass** — I retry with `bypassApproval: true`. This needs a role with `bypassApprovalSDKConnections` on the connection's projects, or the organization setting "REST API always bypasses approval requirements".

Retry only after the user picks B:

```bash
echo '{"archived": true, "bypassApproval": true}' \
  | gb-call PUT /api/v1/sdk-connections/<connection-id> -
```

For `DELETE`, send `{"bypassApproval": true}` as the body. A `403` on the retry means the key has no bypass authority; stop and report it. A bypassed write returns `bypassedGates` with `type: "approval-required"`; tell the user the approval was bypassed.

A `400` that says another draft has a scheduled publish that locks other drafts means a scheduled draft is blocking the write. Surface the body and stop; a person has to cancel that schedule.

### 4. Report

State the connection `id`, its final state (`archived`, restored, updated, or deleted), and whether `bypassedGates` was returned. Link `/sdks/<connection-id>` for anything but a deleted connection.

## Guardrails

- **Never print `key`, `encryptionKey`, or `proxySigningKey`.** Every connection response includes them. Pick the fields you need before showing anything to the user.
- **Never send `bypassApproval` on the first attempt.** The refusal in step 3 is the approval policy working. Retry with it only when the user asks for the bypass.
- **Archive is gated too.** `archived` is one of the settings an approval rule covers, so on a gated connection `{"archived": true}` is refused like any other change. Deleting a live gated connection is refused until it is archived. Deleting an already archived connection needs no approval.
- **Unlike flags, a bypass role authorizes delete.** For `DELETE`, `bypassApprovalSDKConnections` works as well as the organization setting; `references/flag-cleanup.md` describes the flag case, where only the setting does.
- **A write that changes nothing returns `200` with the unchanged connection.** Archiving an archived connection is a no-op, not an error.

## Endpoints used

- `GET /api/v1/sdk-connections` (query: `archived`, `projectId`, `limit`, `offset`)
- `GET /api/v1/sdk-connections/:id`
- `GET /api/v1/sdk-connections/lookup/:key`
- `PUT /api/v1/sdk-connections/:id` (body: any create field, `archived`, `bypassApproval`)
- `DELETE /api/v1/sdk-connections/:id` (optional body: `{ "bypassApproval": true }`)

## Handoffs

- `references/flag-cleanup.md` — to archive or delete a feature flag rather than a connection
- the **gb-setup** skill — when `gb-call` reports a missing or invalid `GB_API_KEY`
