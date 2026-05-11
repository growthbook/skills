# scripts/

## `gb-call`

Minimal REST client for the GrowthBook API. Every `growthbook` plugin skill calls it via Bash.

Plain Node, no dependencies, no build step. Uses `fetch` (Node 18+).

### Usage

```bash
gb-call <METHOD> <PATH> [BODY_FILE | -]
```

| Form | Behavior |
| --- | --- |
| `gb-call GET /api/v1/features` | GET request, no body |
| `gb-call GET '/api/v1/features?limit=50&projectId=prj_abc'` | Quote the path when it has query params |
| `gb-call POST /api/v1/features ./payload.json` | POST with body read from file |
| `echo '{"id":"foo"}' \| gb-call POST /api/v1/features -` | POST with body read from stdin (last arg `-`) |

### Environment variables

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `GB_API_KEY` | yes | — | PAT or Secret Key. Sent as `Authorization: Bearer <key>`. |
| `GB_API_URL` | no | `https://api.growthbook.io` | Self-hosted instances point here. |

### Output

- **2xx:** response body printed verbatim to stdout (raw JSON). Skills read it directly.
- **non-2xx:** status line + body printed to stderr; exit code `1`.
- **usage error:** stderr message; exit code `2`.

### Why it exists

Skills could call `curl` directly, but that means repeating the auth header, base URL, and error handling in every skill body. The helper hides that boilerplate so skill content stays focused on workflow and intent. It also gives us one place to add retry, pagination, or rate-limit backoff when those become needed (probably for `experiment-analyze`).

### Not in scope (yet)

- No retry / backoff (GrowthBook is rate-limited at 60 rpm; skills that poll should add delays).
- No pagination helper (skills loop themselves using `offset` / `limit`).
- No response shape validation.

These get added when a skill needs them. Until then, keep it simple.
