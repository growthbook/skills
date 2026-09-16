# scripts/

## `gb-call`

Minimal REST client for the GrowthBook API. Every `growthbook` plugin skill calls it via Bash.

Plain Node, no dependencies, no build step. Uses `fetch` (Node 18+).

### Usage

```bash
gb-call <METHOD> <PATH> [BODY_FILE | -]
gb-call app-origin
```

| Form | Behavior |
| --- | --- |
| `gb-call GET /api/v1/features` | GET request, no body |
| `gb-call GET '/api/v1/features?limit=50&projectId=prj_abc'` | Quote the path when it has query params |
| `gb-call POST /api/v1/features ./payload.json` | POST with body read from file |
| `echo '{"id":"foo"}' \| gb-call POST /api/v1/features -` | POST with body read from stdin (last arg `-`) |
| `gb-call app-origin` | Print the trusted GrowthBook UI origin once for constructing links |

### Configuration

`gb-call` reads config from two sources, in precedence order:

1. **Process environment** — `GB_API_KEY`, `GB_API_URL`, `GB_APP_URL`. Always wins per variable. Useful for CI and one-off overrides.
2. **`~/.config/growthbook/.env`** — same keys, `KEY=value` per line, no quoting. Written by the `gb-setup` skill. Only consulted when the corresponding env var is unset.

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `GB_API_KEY` | yes | — | PAT or Secret Key. Sent as `Authorization: Bearer <key>`. The token's user is the default `owner` for flags/experiments the write skills create. |
| `GB_API_URL` | no | `https://api.growthbook.io` | Self-hosted instances point here. Trailing slashes are stripped. |
| `GB_APP_URL` | self-hosted only | `https://app.growthbook.io` on Cloud | Trusted GrowthBook UI origin used by `app-origin`. It is never inferred from `GB_API_URL`. |

For self-hosted installations, configure both URL variables even when the API and UI share an origin. `GB_APP_URL` must be an HTTPS origin with no path, query, hash, or credentials. If `GB_API_URL` is custom and `GB_APP_URL` is missing, `gb-call app-origin` refuses and points to **gb-setup** instead of guessing.

### Output

- **2xx:** response body printed verbatim to stdout (raw JSON). Skills read it directly.
- **`app-origin`:** normalized UI origin printed to stdout; does not require an API key or make a network request.
- **non-2xx:** targeted error message printed to stderr; exit code `1`. See "Error catalog" below.
- **usage error:** stderr message; exit code `2`.

### Error catalog

`gb-call` translates common HTTP failures into messages that point at the fix:

| Condition | Stderr message routes user to |
| --- | --- |
| `GB_API_KEY` not set in env *and* not in `~/.config/growthbook/.env` | `gb-setup` skill |
| Custom `GB_API_URL` with no `GB_APP_URL` when running `app-origin` | `gb-setup` skill (configure the trusted UI origin) |
| Invalid `GB_APP_URL` | `gb-setup` skill (provide an HTTPS origin without a path, query, hash, or credentials) |
| `401` / `403` from API | `gb-setup` skill (key invalid, expired, or revoked) |
| `404` on `api.growthbook.io` | `gb-setup` skill (likely self-hosted, configure `GB_API_URL`) |
| `429` | rate-limit notice (60 rpm); retry after a moment |
| Anything else | raw status + body |

When adding a new error category, keep two properties intact:

- **The message tells the user what to do**, not just what failed. If the fix is the `gb-setup` skill, name it without assuming a client-specific invocation syntax.
- **The raw response body is still shown** below the synthesized hint, so power users can debug without re-running.

### Why this helper exists

Skills could call `curl` directly, but that means repeating the auth header, base URL, app-origin resolution, error translation, and `.env` loading in every skill body. The helper hides that boilerplate so skill content stays focused on workflow and intent. A shell-capable agent calls `app-origin` once per conversation when it first needs a UI link, retains the result across workflow handoffs, and prepends it to the root-relative paths defined by workflows.

### Not in scope (yet)

- No retry / backoff (GrowthBook is rate-limited at 60 rpm; skills that poll should add delays).
- No pagination helper (skills loop themselves using `offset` / `limit`).
- No response shape validation.
- No multi-profile support (one `~/.config/growthbook/.env`, no `GB_PROFILE` selector).

These get added when a skill needs them. Until then, keep it simple.
