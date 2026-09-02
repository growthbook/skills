---
name: sql-query
description: Run read-only SQL queries directly against the warehouse when no metric, fact table, or exploration can answer the question. Use as a last resort — prefer metric-search and analytics-explore first. Covers table discovery, schema inspection, column value preview, and query execution with a 500-row limit.
---

# sql-query

Run ad-hoc read-only SQL against the user's data warehouse via four dedicated endpoints. This is a **last resort** — prefer `references/metric-search.md` and `references/analytics-explore.md` when the question can be answered with existing metrics or fact tables. Use SQL only for custom joins, unmodeled tables, or aggregations the exploration config can't express.

SQL queries run real warehouse compute and are capped at 500 rows.

## Contents

- Workflow
  - 1. Pick a datasource
  - 2. Discover tables
  - 3. Inspect table schema
  - 4. Preview column values
  - 5. Write and run the query
  - 6. Interpret and report
  - 7. Create exploration link
- Guardrails
- Endpoints used
- Handoffs

## Workflow

### 1. Pick a datasource

SQL queries are scoped to one datasource. **Always ask the user which datasource to use** — do not assume from the active datasource hint or previous context. List the available datasources first:

```bash
gb-call GET /api/v1/data-sources
```

- **0 datasources** → tell the user none is configured and stop.
- **1 datasource** → use it without asking.
- **2+ datasources** → always ask which to use, even if a datasource hint is present.

Only SQL warehouse datasources work (not Mixpanel or Google Analytics). Capture the datasource `id` for all subsequent calls.

### 2. Discover tables

Search the warehouse's information schema for tables matching a keyword:

```bash
echo '{"query": "users", "limit": 20}' | gb-call POST /api/v1/data-sources/<ds_id>/sql/search-tables -
```

Returns `{ tables: [{ database, schema, table, columnCount }], total, schemas, datasourceType }`.

Pass an empty `query` to list all tables. `limit` range: 1–50 (default 20).
`schemas` lists all distinct `database.schema` paths that matched, even when `tables` is truncated by the limit — use it to understand the full scope. If `total` exceeds the number of returned tables, narrow with a more specific `query`.

### 3. Inspect table schema

Get column names and types for specific tables:

```bash
echo '{"tables": [{"databaseName": "analytics", "tableSchema": "public", "tableName": "events"}]}' | gb-call POST /api/v1/data-sources/<ds_id>/sql/table-schema -
```

Returns `{ tables: [{ database, schema, table, columns: [{ name, type, description? }] }] }`.

Up to 5 tables per request. Column descriptions are enriched from matching fact tables when available.

### 4. Preview column values

**You MUST call this before filtering on any column value.** Never guess enum spellings, date formats, or null patterns.

```bash
echo '{"table": "analytics.public.events", "columns": ["event_type", "country"], "limit": 20}' | gb-call POST /api/v1/data-sources/<ds_id>/sql/preview-values -
```

Returns `{ table, columns, rows: [...], rowCount }`.

Up to 3 columns per request, `limit` range: 1–20 (default 20).

**WARNING:** On scan-billed warehouses (BigQuery), this scans full columns even with LIMIT.

### 5. Write and run the query

Always include `tableMetadata` from your earlier discovery steps so the response includes an `explorationUrl` link:

```bash
echo '{
  "sql": "SELECT event_type, COUNT(*) as cnt FROM analytics.public.events WHERE created_at >= CURRENT_DATE - INTERVAL '"'"'30 days'"'"' GROUP BY 1 ORDER BY 2 DESC LIMIT 20",
  "purpose": "Top event types in the last 30 days",
  "tableMetadata": {
    "table": "events",
    "path": "analytics.public.events",
    "timestampColumn": "created_at",
    "columnTypes": { "event_type": "string", "created_at": "date", "user_id": "string", "value": "number" }
  }
}' | gb-call POST /api/v1/data-sources/<ds_id>/sql/run-query -
```

Build `tableMetadata` from the table info gathered in steps 2–3:
- `table`: table name from step 2
- `path`: fully qualified `database.schema.table` path from step 2
- `timestampColumn`: a date/timestamp column from step 3
- `columnTypes`: map each column to its type — translate warehouse types: `INT64`/`FLOAT64`/`NUMERIC` → `"number"`, `TIMESTAMP`/`DATE`/`DATETIME` → `"date"`, `BOOL` → `"boolean"`, `STRING`/`VARCHAR`/`TEXT` → `"string"`, anything else → `"other"`

Returns on success:
```json
{
  "status": "success",
  "summary": "SQL query (20 rows, 1234ms): SELECT ...",
  "rowCount": 20,
  "columns": [{ "name": "event_type", "dataType": "string" }, { "name": "cnt", "dataType": "number" }],
  "resultCsv": "event_type|cnt\npageview|45231\n...",
  "truncated": false,
  "durationMs": 1234,
  "sql": "SELECT event_type, COUNT(*) as cnt FROM ... LIMIT 500",
  "explorationUrl": "https://app.growthbook.io/product-analytics/explore/data-source?config=..."
}
```

Returns when confirmation is needed (large queries on cost-threshold datasources):
```json
{
  "status": "confirmation_required",
  "estimatedBytesProcessed": 5368709120,
  "estimatedCostUsd": 0.0312,
  "sql": "SELECT ...",
  "message": "This query would scan 5.00 GiB, which exceeds the 1.00 GiB threshold. Estimated cost: $0.0312. Re-call with confirm: true to execute."
}
```

In the GrowthBook app, the confirmation is handled automatically by the chat UI — the user sees a confirmation card with the cost details and clicks to approve or cancel. You do not need to handle this response in-app.

For external agents: when you get `confirmation_required`, show the user the estimated scan size (from `estimatedBytesProcessed`), the estimated cost (from `estimatedCostUsd`), and ask whether to proceed. If they confirm, re-call with `confirm: true`:
```bash
echo '{"sql": "...", "purpose": "...", "confirm": true}' | gb-call POST /api/v1/data-sources/<ds_id>/sql/run-query -
```

Returns on error:
```json
{
  "status": "error",
  "message": "Only SELECT or WITH statements are allowed"
}
```

The `resultCsv` field contains the first ~20 rows as pipe-delimited text for quick analysis. `truncated` is true when results hit the 500-row cap.

### 6. Interpret and report

After results come back:
1. Analyze the data in `resultCsv` to answer the user's question.
2. Write a brief (1–3 sentence) text summary highlighting the key numbers.

If the query returned 0 rows, check your filters and date ranges before concluding there's no data.

### 7. Include exploration link

When `tableMetadata` was provided in step 5, the response includes an
`explorationUrl` field. Always include this as a link in your reply so the user
can view and interact with the data in the product analytics explorer.

If `explorationUrl` is absent (e.g. `tableMetadata` was omitted or the query
involved joins across multiple tables), present the SQL results as text only.

## Guardrails

- **Read-only SQL only.** The endpoint rejects any query that isn't a SELECT or WITH statement. DML (INSERT, UPDATE, DELETE), DDL (CREATE, DROP, ALTER), and escape hatches (INTO OUTFILE, COPY TO, pg_read_file, etc.) are blocked.
- **500-row hard limit.** The server enforces `LIMIT 500` regardless of what you write. If your result hits 500, tell the user the data is truncated and suggest re-aggregating at a coarser grain.
- **Preview before filtering.** Never guess column values for WHERE clauses. Always call `preview-values` first to see actual values, spellings, and formats.
- **One query at a time.** Multi-statement queries (semicolons between statements) are rejected.
- **Query length cap.** Queries over 100K characters are rejected.
- **Last resort.** Before writing SQL, check whether a metric or fact table already models the data. `references/metric-search.md` finds metrics; `references/analytics-explore.md` charts them. SQL is for when those can't answer the question.
- **Cost awareness.** SQL queries execute real warehouse compute. BigQuery charges per bytes scanned; Snowflake charges per warehouse-second. Don't fan out multiple exploratory queries — narrow your question first with schema inspection and value previews.
- **Scan-billed warehouse warning.** On BigQuery, even `preview-values` scans full columns. Mention this if the user is on BigQuery and seems unaware of scan costs.
- **No mutations, ever.** These endpoints are gated behind `canRunSchemaQueries` and `canRunSqlExplorerQueries` permissions. A 403 means the user's token lacks permission — point them at their role/scopes.
- **Feature gate.** These endpoints require the organization's `aiAskDataEnabled` setting and the datasource's `askData.enabled` setting to both be true. A 400 or 403 may indicate the feature isn't enabled.

## Endpoints used

- `GET /api/v1/data-sources` — list datasources for selection
- `POST /api/v1/data-sources/:id/sql/search-tables` — search warehouse tables by name
- `POST /api/v1/data-sources/:id/sql/table-schema` — get column schemas for tables
- `POST /api/v1/data-sources/:id/sql/preview-values` — preview distinct column values
- `POST /api/v1/data-sources/:id/sql/run-query` — execute read-only SQL

## Handoffs

- `references/metric-search.md` — when the user wants to find metrics or fact tables before resorting to SQL
- `references/analytics-explore.md` — when the question can be answered with an exploration chart instead of raw SQL
- the **experiments** skill — when SQL results surface something worth A/B testing
- the **feature-flags** skill — when the user pivots to shipping a change based on the data
