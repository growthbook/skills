---
name: gb-setup
description: Configure GrowthBook API credentials and the trusted app origin so the other skills can run and link to the UI. Use when the user says "set up growthbook", "configure my api key", "growthbook isn't working", "where do I put my key", or when another skill emits an error pointing here ("GB_API_KEY is not set", "authentication failed", "GB_APP_URL is required"). Gives the user a command that writes ~/.config/growthbook/.env with chmod 600 (the key never enters the chat) and validates it against the live API. For listing flags or running experiments, the domain skills handle that.
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/scripts/gb-call *) Bash(test -f ~/.config/growthbook/.env) Bash(test -n "$GB_API_KEY") Bash(grep -o '^GB_[A-Z_]*=' ~/.config/growthbook/.env)
---

# gb-setup

One-skill onboarding for GrowthBook Agent Skills. Walks the user through `GB_API_KEY` plus `GB_API_URL` and `GB_APP_URL` for self-hosted. The **user** creates `~/.config/growthbook/.env` by running a command in their own terminal, so the API key never passes through the conversation. This skill then validates the credentials and the trusted app origin.

The API key is a Personal Access Token (PAT) tied to a GrowthBook user, so the API attributes any flags or experiments the write skills create to that user automatically — there's no separate owner identifier to configure.

`gb-call` reads this file when the corresponding environment variables aren't set, so the user gets a one-time config rather than editing their shell rc. Real environment variables always win over the file — useful for CI and one-off overrides.

Resolve the bundled helper for the current client before using it: under the Claude Code plugin it is `${CLAUDE_PLUGIN_ROOT}/scripts/gb-call`; under a standalone Agent Skills install it is `scripts/gb-call` relative to this skill directory. Substitute that resolved command for `<gb-call>` below.

**This skill never sees the key.** Don't ask the user to paste it, don't read `~/.config/growthbook/.env` with a file tool, and don't put the key in any command. `gb-call` reads the file itself.

## Workflow

1. **Detect current state.** Check what's already configured. Don't ask the user for values they already have unless they want to change them.

   ```bash
   test -f ~/.config/growthbook/.env && echo "exists" || echo "missing"
   test -n "$GB_API_KEY" && echo "set" || echo "unset"
   ```

   If the file exists, list which variables it defines — names only, no values:

   ```bash
   grep -o '^GB_[A-Z_]*=' ~/.config/growthbook/.env
   ```

   Summarize it (for example: "the file sets `GB_API_KEY` and `GB_API_URL`") and ask whether to keep it, update it, or start fresh. If `GB_API_KEY` is `set` in the shell environment, tell the user it overrides the file's value, so a new key in the file will not take effect until they unset the shell variable.

   If the file exists and the user only wants to confirm it works, skip to step 4.

2. **Ask about self-hosted** (optional `GB_API_URL` and `GB_APP_URL`).

   > Are you using GrowthBook Cloud (api.growthbook.io) or a self-hosted instance?

   - Cloud → skip, leaving both URLs unset (`gb-call` defaults to `https://api.growthbook.io` for API calls and `https://app.growthbook.io` for UI links).
   - Self-hosted → prompt separately for:
     - The API origin stored as `GB_API_URL` (e.g. `https://api.acme-internal.com`).
     - The user-facing GrowthBook UI origin stored as `GB_APP_URL` (e.g. `https://growthbook.acme-internal.com`).

   Do not derive one origin from the other. Self-hosted deployments may use unrelated hostnames or serve the API and UI from the same origin.

   **Validate each URL's shape** before accepting:

   - Must parse as a URL (i.e. `new URL(value)` does not throw).
   - Scheme must be `https://` (refuse `http://` — auth headers over cleartext leak credentials; refuse `file://`, `data://`, etc.).
   - Hostname must be non-empty and contain only letters, digits, `.`, and `-`, with an optional numeric `:port`. Step 3 places these values inside a command the user runs, and URL parsing alone accepts quotes and `;` in a host.
   - No username or password.
   - **No path, query, or hash** — `new URL(value).pathname` must be `/` or empty, with empty `search` and `hash`. A value like `https://api.acme.com/v1` would silently mis-route requests or links; reject with a message that asks for just the origin.
   - Strip a single trailing slash before storing.

   Refuse any URL that fails these checks and loop back to ask again; don't silently coerce. Silent fix-ups train users to trust that the system "just works" when the value is sometimes wrong in ways the system can't fix.

3. **Have the user create the file.** Point them at the page where they create a Personal Access Token, and recommend a fresh PAT for this plugin rather than their personal admin token, so it can be revoked on its own:

   - Cloud: <https://app.growthbook.io/account/personal-access-tokens>
   - Self-hosted: `https://<your-host>/account/personal-access-tokens`

   PATs start with `gb_pat_`; Secret Keys with `secret_`. Either works.

   Then give them this command and ask them to run it **in their own terminal, not in this chat** (it needs a real terminal for the hidden prompt, and that keeps the key out of the transcript). For Cloud:

   ```bash
   (
     umask 077
     mkdir -p ~/.config/growthbook && chmod 700 ~/.config/growthbook
     printf 'GrowthBook API key (input hidden): '
     stty -echo; read -r key; stty echo; printf '\n'
     printf 'GB_API_KEY=%s\n' "$key" > ~/.config/growthbook/.env
     chmod 600 ~/.config/growthbook/.env
   )
   ```

   For self-hosted, replace the `printf 'GB_API_KEY=...'` line with one that also writes the validated URLs from step 2 (substitute the real origins):

   ```bash
   printf 'GB_API_KEY=%s\nGB_API_URL=%s\nGB_APP_URL=%s\n' "$key" 'https://<api-origin>' 'https://<app-origin>' > ~/.config/growthbook/.env
   ```

   Explain what it does, briefly: it prompts for the key without echoing it, so the key does not appear on screen, in shell history, or in the process list; it creates the directory as owner-only (`0700`) and the file as owner-read/write (`0600`); and it overwrites any existing file, so the user should re-enter everything they want kept. If they interrupt the prompt and their terminal stops echoing typed text, `stty echo` restores it.

   Alternatives, if the command doesn't suit them (Windows, for instance): create `~/.config/growthbook/.env` in any editor with one `KEY=value` line per variable (see the file format below), or export `GB_API_KEY` in their shell instead. Either way the key stays out of this chat.

   Wait for the user to say it's done. If they paste the key into the chat instead, do not use it or repeat it. Tell them the key is now in the transcript, that they should revoke it at the same token page and create a new one, and then have them run the command above.

4. **Validate against the live API.** The key is already in the file, so call a lightweight authenticated endpoint with no credentials in the command:

   ```bash
   <gb-call> GET /api/v1/projects
   ```

   Interpret the result:
   - **2xx** → credentials work. Move on.
   - **`GB_API_KEY is not set`** → the file wasn't written where `gb-call` looks. Check `test -f ~/.config/growthbook/.env`, and confirm the user ran the command as the same user and `HOME` this client uses.
   - **Whitespace or control characters in a value** → the pasted key or URL was malformed. Have the user re-run the command in step 3.
   - **401 / 403** → "Authentication failed. The API key is invalid, expired, or has been revoked. Generate a fresh one at the token page and re-run the command." Loop back to step 3. If `GB_API_KEY` is set in the shell, that value is what failed, not the file's.
   - **404 on a `growthbook.io` host** → "Got a 404 from `api.growthbook.io`. If you're actually on self-hosted, set `GB_API_URL` to your API base URL." Loop back to step 2.
   - **Network error / DNS** → "Couldn't reach `<host>`. Check the URL and your network." Surface the raw error.

   If the user is stuck, halt and let them debug.

   Then verify that the trusted app origin resolves exactly as expected:

   ```bash
   <gb-call> app-origin
   ```

   The output must equal the expected UI origin with no trailing slash. If it fails, return to step 2.

5. **Report.** Tell the user:
   - Where the file is (`~/.config/growthbook/.env`).
   - Which variables it sets (names only) and the trusted UI origin that `gb-call app-origin` returns. Never show the key.
   - That env vars take precedence over the file (so CI / one-off overrides keep working).
   - That re-running the **gb-setup** skill updates the file.
   - The next thing they probably want: the **feature-flags** skill (`flag-search` workflow) to see their flags, or the **experiments** skill (`experiment-brainstorm` workflow) to look at past results.

## Guardrails

- **The key never enters the conversation.** The user types it into a hidden prompt in their own terminal, and `gb-call` reads it from the file. Never ask the user to paste it into chat, never put it in a command, argument, or env prefix, and never read the `.env` file with a file tool or print it with `cat`. A value in the transcript cannot be redacted afterward.
- **If the key lands in the chat anyway, treat it as exposed.** Don't echo it back or use it. The only effective remediation is to revoke and rotate it at `<GB_APP_URL>/account/personal-access-tokens` (or the cloud default). Surface this whenever the user expresses concern about an old or shared key.
- **Recommend a freshly scoped PAT** over reusing an admin token, so it can be revoked independently.
- **Don't suggest `echo '<key>' > file` or `echo '<key>' | tee file`.** The key is then in the shell history and on a command line other users can see in the process list. The hidden `read` prompt avoids both.
- **Directory at `0700` and file at `0600`, set by the command.** `umask 077` makes the file owner-only from the moment it is created, and the explicit `chmod` is defense in depth. A pre-existing file keeps its old mode on overwrite, which is why the `chmod 600` stays in the command.
- **Env vars take precedence over the file per variable.** If `GB_API_KEY` is set in the shell, `gb-call` ignores the file's value. Surface this if both are configured so the user understands what's actually in effect.
- **Validate against a real endpoint, not just shape.** A token that "looks right" but doesn't work is worse than no token — the user thinks they're set up. `GET /api/v1/projects` is lightweight, requires auth, and works on every plan tier.
- **The file exists before it is validated.** If validation fails, say so and have the user re-run the command with a corrected key; it overwrites the file. Don't claim setup is complete until step 4 succeeds.
- **No owner identifier to collect.** The PAT is tied to a GrowthBook user, so the write skills (`flag-create`, `experiment-launch`) let the API attribute new flags and experiments to the token's user automatically. Don't prompt for an email or userId during setup.
- **Strip trailing slashes from both URLs.** `gb-call` normalizes `GB_APP_URL` too, but storing clean origins avoids inconsistent output and double-slash bugs.
- **Never infer `GB_APP_URL` from `GB_API_URL`.** The `api.` → `app.` convention is not guaranteed for self-hosted deployments. Ask for the app origin explicitly.
- **Don't propose env vars we don't actually use.** Only `GB_API_KEY`, `GB_API_URL`, and `GB_APP_URL`. Anything else is scope creep and will confuse future contributors.

## File format reference

`~/.config/growthbook/.env`:

```
GB_API_KEY=gb_pat_abc123def456
GB_API_URL=https://api.your-self-hosted.com
GB_APP_URL=https://growthbook.your-self-hosted.com
```

Lines starting with `#` are comments. Blank lines are ignored. No quoting; values are taken verbatim from the first `=` to end of line.

## Endpoints used

- `GET /api/v1/projects` — validation only. Lightweight, requires auth, available on every tier.

## Handoffs

- The **feature-flags** skill (`flag-search` workflow) — natural first call after setup completes (no required inputs, exercises the new config).
- The **experiments** skill (`experiment-brainstorm` workflow) — if the org already has stopped experiments, surfaces them immediately.
- Any skill that emits a config-related error points back here.
