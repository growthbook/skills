---
name: datasource-create
description: Connect a data warehouse or Mixpanel project to GrowthBook as a new data source. Use when the user asks to "connect our warehouse", "add a data source", "set up Postgres/BigQuery/Snowflake in GrowthBook", or "create a data source". For finding or charting data in an existing data source, use metric-search or analytics-explore.
---

# datasource-create

Create a data source from a warehouse connection the user supplies. The server tests the connection before it saves anything, and credentials are stored encrypted and never returned.

This workflow writes organization configuration and handles credentials. It stops at the connection: identifier types, assignment queries, and pipeline settings are optional body fields that this workflow leaves out unless the user supplies them.

## Workflow

### 1. Check for an existing data source

```bash
gb-call GET '/api/v1/data-sources?limit=100'
```

Match on `type`, `name`, and the user's description of the warehouse. If one already covers it, stop and offer `references/metric-create.md` or `references/analytics-explore.md`. Paginate with `offset` while `hasMore` is true.

### 2. Collect the connection

Get the warehouse `type` from the user, then every required field for it from the table below. Take credentials from the user only; never guess a field or fill one from another source. Before they paste a secret, tell them it stays in this conversation's transcript, and suggest a read-only warehouse user. Ask for optional fields only when the user mentions them.

| `connection.type` | Required fields besides `type` |
| --- | --- |
| `postgres`, `redshift`, `vertica` | `host`, `port`, `database`, `user`, `password` |
| `mysql` | `host`, `port`, `database`, `user`, `password` |
| `mssql` | `server`, `port`, `database`, `user`, `password` |
| `snowflake` | `account`, `username`, `password`, `database`, `schema` |
| `bigquery` | `defaultProject`, `defaultDataset`, plus `projectId`, `clientEmail`, `privateKey` with `authType: "json"` |
| `athena` | `region`, `bucketUri`, plus `accessKeyId`, `secretAccessKey` with `authType: "accessKey"` |
| `presto` | `engine` (`presto` or `trino`), `host`, `port`, `catalog`, `schema` |
| `databricks` | `authType` (`pat` or `oauth-m2m`), `host`, `port`, `path`, `catalog`, plus `token` for `pat` or `oauthClientId` and `oauthClientSecret` for `oauth-m2m` |
| `clickhouse` | `url`, `port`, `password`, `database` |
| `mixpanel` | `username`, `secret`, `projectId` |
| `adobe_experience_platform_query_service` | `host`, `port`, `database`, `username`, `technicalAccountId`, `credential` |

Resolve project names to ids with `GET /api/v1/projects` when the user wants the data source scoped to projects.

### 3. Confirm and create

Show the user the payload with every secret value replaced by `<redacted>`. After they confirm:

```bash
echo '{
  "name": "Production warehouse",
  "description": "Event and order tables",
  "projectIds": [],
  "connection": {
    "type": "postgres",
    "host": "db.example.com",
    "port": 5432,
    "database": "analytics",
    "user": "growthbook_reader",
    "password": "<password>"
  }
}' | gb-call POST /api/v1/data-sources -
```

Branch on the response:

- **200** → `{ "dataSource": { "id": "ds_...", ... } }`. Go to step 4.
- **202** → held for a person's confirmation; nothing was created. Handle it as the router's failure modes describe, and go to step 4 only when the confirmation is `completed` with a `200` `response`.
- **400** → read `message`. A failed connection test names the connection error and saves nothing. Fix the field it names with the user and resend once.
- **403** → the key lacks permission to create data sources for those projects. Stop and say so.

### 4. Report what was created

Give the user the data source `id`, `type`, and `name`. Check `assignmentQueries[].error` in the response when the user supplied assignment queries, and surface any that are set. Point the user to `references/metric-create.md` to define metrics on it.

## Guardrails

- **Send only the fields in the table, plus `name`, `description`, and `projectIds`.** The body and every `connection` object are strict: an unknown field, or a field from another warehouse's connection, fails with a 400.
- **Do not create a Managed Warehouse (`growthbook_clickhouse`), a Google Analytics data source, or an Event Forwarder.** They have no `connection` type, and `eventTracker: "eventForwarder"` is rejected. Direct the user to set them up in the GrowthBook app.
- **`authType: "auto"` on `bigquery` and `athena`, and `assumeRole` on `athena`, use the server's own AWS or Google identity and work on self-hosted only.** On Cloud, use `json` or `accessKey` with the user's credentials.
- **Do not send the ClickHouse `caCertPath`, `clientCertPath`, `clientKeyPath`, or `clientCertChainPath` fields.** They read files on the GrowthBook server, so they apply to self-hosted installs only. Use `caCert`, `clientCert`, and `clientKey` with the PEM contents.
- **A data source can be created even when an assignment query fails validation.** The failure is stored in that query's `error` field instead of rejecting the request.
- **A held request keeps `connection` encrypted.** The confirmation page shows the connection's non-secret fields to the approver, so tell the user which data source they are approving. Never resend a held request.
- **Data sources managed by `config.yml` cannot be created through the API.** The request fails with a 400.
- **Names are not unique.** Check step 1 first; a second request with the same `name` creates a second data source.

## Endpoints used

- `GET /api/v1/data-sources` — check for an existing data source
- `GET /api/v1/projects` — resolve project names to ids
- `POST /api/v1/data-sources` — create the data source
- `GET /api/v1/confirmations/:id` — poll a held create

## Handoffs

- `references/metric-create.md` — define fact tables and metrics on the new data source
- `references/analytics-explore.md` — chart data once metrics exist
- **gb-setup** — when `gb-call` reports a missing or invalid `GB_API_KEY`
