---
name: gb-setup
description: Configure the GrowthBook plugin's API credentials so every other skill can run. Use when the user says "set up growthbook", "configure my api key", "growthbook isn't working", "where do I put my key", or when another skill emits an error pointing here ("GB_API_KEY is not set", "authentication failed", "owner is required"). Writes ~/.config/growthbook/.env with chmod 600 and validates against the live API. For listing flags or running experiments, the other skills handle that.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *) Bash(mkdir -p ~/.config/growthbook) Bash(chmod 700 ~/.config/growthbook) Bash(chmod 600 ~/.config/growthbook/.env) Bash(test -f ~/.config/growthbook/.env)
---

# gb-setup

One-skill onboarding for the GrowthBook plugin. Walks the user through `GB_API_KEY`, an owner identifier (`GB_EMAIL`, which accepts either an email or a `u_...` userId), and an optional `GB_API_URL` for self-hosted. Validates the credentials by hitting the live API, then writes `~/.config/growthbook/.env` with `chmod 600`.

`gb-call` reads this file when the corresponding environment variables aren't set, so the user gets a one-time config rather than editing their shell rc. Real environment variables always win over the file — useful for CI and one-off overrides.

## Workflow

1. **Detect current state.** Check what's already configured. Don't ask the user for values they already have unless they want to change them.

   ```bash
   test -f ~/.config/growthbook/.env && echo "exists" || echo "missing"
   ```

   If the file exists, read it with the Read tool, parse the `KEY=value` lines, and surface a masked summary:

   ```
   I see existing config at ~/.config/growthbook/.env:
     GB_API_KEY = gb_pat_****wxyz   (last 4 shown)
     GB_EMAIL   = you@example.com
     GB_API_URL = (not set — defaults to https://api.growthbook.io)

   Want to keep these, update one, or start fresh?
   ```

   Also note what's in `process.env` — if the user has shell exports, those will override the file. Surface that ("`GB_API_KEY` is also set in your shell environment; the file value won't be used unless you unset the shell var.")

2. **Collect `GB_API_KEY`** (required). If keeping the existing value, skip. Otherwise, **show the transcript-exposure notice first** so the user can make an informed choice:

   > Before you paste your key: anything you type into this chat is stored in your local Claude Code transcript (`~/.claude/projects/...`) and sent to Anthropic as part of the conversation. The skill will mask the key in its replies, but the value you paste cannot be masked retroactively.
   >
   > Recommendation: **generate a fresh PAT for this plugin** rather than reusing your personal admin token. That way you can revoke it independently if anything goes wrong, without affecting your other API access.

   Then ask:

   > Paste a Personal Access Token (PAT) or Secret Key. Get one at:
   > - Cloud: <https://app.growthbook.io/settings/keys>
   > - Self-hosted: `https://<your-host>/settings/keys`
   >
   > PATs start with `gb_pat_`; Secret Keys with `secret_`. Either works.

   Once captured, never echo the value back in any later step — mask all but the last 4 characters.

3. **Collect the owner identifier** (stored as `GB_EMAIL`, required by `flag-create` and `experiment-launch`). The v2 features API requires an `owner` on every created flag — without this, those skills will fail with `owner is required`.

   > Your GrowthBook owner identifier. Two forms work:
   > - **Email** (e.g. `you@example.com`) — the address you sign in with
   > - **User ID** (e.g. `u_abc123`) — visible in your profile URL in the GrowthBook UI
   >
   > Use whichever you prefer. Userids avoid putting your email in a config file; emails are easier to remember.

   If the user really doesn't want to set one, allow skipping — but warn that `flag-create` and `experiment-launch` will fail until they re-run setup. Read-only skills (`flag-discovery`, `experiment-brainstorm`, `experiment-design`, `experiment-analyze`) work without it.

4. **Ask about self-hosted** (optional `GB_API_URL`).

   > Are you using GrowthBook Cloud (api.growthbook.io) or a self-hosted instance?

   - Cloud → skip, leave `GB_API_URL` unset (gb-call defaults to `https://api.growthbook.io`).
   - Self-hosted → prompt for the API base URL (e.g. `https://api.acme-internal.com`).

   **Validate the shape** before accepting:

   - Must parse as a URL (i.e. `new URL(value)` does not throw).
   - Scheme must be `https://` (refuse `http://` — auth headers over cleartext leak credentials; refuse `file://`, `data://`, etc.).
   - Hostname must be non-empty.
   - **No path component** — `new URL(value).pathname` must be `/` or empty. A value like `https://api.acme.com/v1` would silently mis-route every request; reject with a message that asks for just the host.
   - Strip a single trailing slash before storing.

   Refuse any URL that fails these checks and loop back to ask again; don't silently coerce. Silent fix-ups train users to trust that the system "just works" when the value is sometimes wrong in ways the system can't fix.

5. **Validate against the live API.** Set the collected values as ad-hoc env vars and call a lightweight authenticated endpoint:

   ```bash
   GB_API_KEY='<value>' \
   GB_API_URL='<value or empty>' \
     ${CLAUDE_PLUGIN_ROOT}/scripts/gb-call GET /api/v1/projects
   ```

   Interpret the result:
   - **2xx** → credentials work. Move on.
   - **401 / 403** → "Authentication failed. The API key is invalid, expired, or has been revoked. Generate a fresh one at `<url-from-step-2>` and try again." Loop back to step 2.
   - **404 on a `growthbook.io` host** → "Got a 404 from `api.growthbook.io`. If you're actually on self-hosted, set `GB_API_URL` to your API base URL." Loop back to step 4.
   - **Network error / DNS** → "Couldn't reach `<host>`. Check the URL and your network." Surface the raw error.

   Don't proceed past validation. If the user is stuck, halt and let them debug — don't write a broken config.

6. **Write `~/.config/growthbook/.env` — order matters for security.**

   Create the directory and **lock it down first**:

   ```bash
   mkdir -p ~/.config/growthbook
   chmod 700 ~/.config/growthbook
   ```

   The directory's `0700` (owner-only) permission is what protects the file from being readable by other users on the system *during* the next step. Writing the file first and then chmod-ing it leaves a window where the file inherits the user's umask (typically `0022` → mode `0644`, world-readable). Locking the directory closes that window — files inside a `0700` directory aren't reachable by other users regardless of file mode.

   Then write with the Write tool. Format — one `KEY=value` per line, no quoting (our values never contain spaces, `=`, or newlines):

   ```
   GB_API_KEY=<value>
   GB_EMAIL=<value or omit line>
   GB_API_URL=<value or omit line>
   ```

   Then set the file mode as belt-and-suspenders:

   ```bash
   chmod 600 ~/.config/growthbook/.env
   ```

   `0600` means owner-read/write only. With the directory at `0700` and the file at `0600`, the secret is unreachable to any other user on the system.

7. **Report.** Tell the user:
   - Where the file is (`~/.config/growthbook/.env`).
   - What's in it (mask the API key — show only last 4).
   - That env vars take precedence over the file (so CI / one-off overrides keep working).
   - That re-running `/growthbook:setup` updates the file.
   - The next thing they probably want: `/growthbook:flag-discovery` to see their flags, or `/growthbook:experiment-brainstorm` to look at past results.

## Guardrails

- **Never echo the API key back in plain text.** Always mask except for the last 4 characters. The skill's output ends up in the user's terminal and transcript.
- **Surface the transcript-exposure risk before the user pastes a key.** The value typed into the chat is stored in `~/.claude/projects/...` and sent to Anthropic as part of the conversation; the skill cannot retroactively redact it. Always recommend a freshly-scoped PAT over reusing an admin token. This isn't paranoia — it's the right way to handle a workflow that requires a user to paste a secret into a conversational interface.
- **Revocation guidance is a real fix, not a footnote.** If a key was ever exposed, the only effective remediation is to revoke and rotate it at `<host>/settings/keys`. Surface this whenever the user expresses concern about an old or shared key.
- **Directory at `0700` before file write; file at `0600` after.** The order matters. The Write tool inherits the user's umask, which on most systems creates files at mode `0644` (world-readable). Locking the *directory* down first means even the brief window between Write and chmod is not reachable by other users. Then chmod the file as defense in depth. Both steps are non-optional; skipping either turns the PAT into a leak.
- **Env vars take precedence over the file.** If `process.env.GB_API_KEY` is set, gb-call ignores the file value. Surface this if both are configured so the user understands what's actually in effect.
- **Validate against a real endpoint, not just shape.** A token that "looks right" but doesn't work is worse than no token — the user thinks they're set up. `GET /api/v1/projects` is lightweight, requires auth, and works on every plan tier.
- **Owner is required for write skills only.** Don't refuse to write a config without `GB_EMAIL` — read-only skills are still useful without it. Warn instead.
- **Don't strip leading whitespace from line values, but strip trailing.** A PAT shouldn't have whitespace at all; if the user pasted one with a trailing newline from a clipboard, strip it. Leading whitespace is unusual enough that surfacing rather than silently fixing is safer.
- **Don't write a partial file.** If validation fails, halt without touching `~/.config/growthbook/.env`. The user re-runs setup; we never overwrite a working config with a broken one.
- **Strip trailing slash on `GB_API_URL`.** `gb-call` does this too, but doing it here avoids "the file has a slash and the URL has a slash" double-slash bugs in logs.
- **Don't propose env vars we don't actually use.** Only `GB_API_KEY`, `GB_EMAIL`, and `GB_API_URL`. Anything else is scope creep and will confuse future contributors.

## File format reference

`~/.config/growthbook/.env`:

```
GB_API_KEY=gb_pat_abc123def456
GB_EMAIL=you@example.com
GB_API_URL=https://api.your-self-hosted.com
```

Lines starting with `#` are comments. Blank lines are ignored. No quoting; values are taken verbatim from the first `=` to end of line.

## Endpoints used

- `GET /api/v1/projects` — validation only. Lightweight, requires auth, available on every tier.

## Handoffs

- `flag-discovery` — natural first call after setup completes (no required inputs, exercises the new config).
- `experiment-brainstorm` — if the org already has stopped experiments, surfaces them immediately.
- Any skill that emits a config-related error points back here.
