#!/usr/bin/env bash
# Run the GrowthBook sync workflow on this machine, as a dry run.
#
#   .github/sync/local/run-local.sh <growthbook checkout> [options]
#
# Options:
#   --stub          Use a stand-in for Claude that makes a known edit (free,
#                   checks the plumbing). Default: the real `claude` CLI.
#   --since <sha>   GrowthBook commit to review from (default: 7 days ago).
#   --state <sha>   Pretend a previous run saved <sha> as the sync point.
#   --event <name>  GitHub event name (default: workflow_dispatch, which always
#                   runs the model; use schedule to test skipping).
#
# The workspace mirrors CI: skills/ is this checkout with your uncommitted
# changes committed on top, growthbook/ is the given checkout's HEAD. It is
# created outside ~/.claude, because Claude Code refuses edits under it.
#
# Nothing reaches GitHub: dry_run is always on, a gh wrapper drops every write
# (issues, PRs, comments) and a git wrapper refuses push. Reads use your gh
# login. Requires node, gh (logged in), git, unzip, python3 with PyYAML, and
# claude unless --stub.
set -euo pipefail

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

[ $# -ge 1 ] || usage 1
[ "$1" = "-h" ] || [ "$1" = "--help" ] && usage 0
GROWTHBOOK_SRC=$(cd "$1" && pwd); shift
STUB=0 SINCE="" STATE="" EVENT=workflow_dispatch
while [ $# -gt 0 ]; do
  case "$1" in
    --stub) STUB=1 ;;
    --since) SINCE=$2; shift ;;
    --state) STATE=$2; shift ;;
    --event) EVENT=$2; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown option: $1" >&2; usage 1 ;;
  esac
  shift
done

HERE=$(cd "$(dirname "$0")" && pwd)
SKILLS_SRC=$(git -C "$HERE" rev-parse --show-toplevel)
WORKFLOW="$SKILLS_SRC/.github/workflows/sync-from-growthbook.yml"
[ -f "$GROWTHBOOK_SRC/scripts/check-agent-skills-drift.mjs" ] || {
  echo "$GROWTHBOOK_SRC has no scripts/check-agent-skills-drift.mjs. Use a checkout that includes growthbook/growthbook#7202." >&2
  exit 1
}
python3 -c 'import yaml' 2>/dev/null || { echo "PyYAML is required: pip install pyyaml" >&2; exit 1; }
[ "$STUB" = 1 ] || command -v claude > /dev/null || { echo "claude CLI not found; install it or pass --stub" >&2; exit 1; }

W=$(mktemp -d "${TMPDIR:-/tmp}/skills-sync-local.XXXXXX")
W=$(cd "$W" && pwd -P)
case "$W" in "$HOME/.claude"*) echo "Workspace must be outside ~/.claude" >&2; exit 1 ;; esac
echo "Workspace: $W"

echo "Preparing skills/ ..."
git clone -q "$SKILLS_SRC" "$W/skills"
git -C "$W/skills" checkout -q "$(git -C "$SKILLS_SRC" rev-parse HEAD)"
rsync -a --exclude .git "$SKILLS_SRC/" "$W/skills/"
git -C "$W/skills" add -A
git -C "$W/skills" -c user.name=local -c user.email=local@localhost commit -q --allow-empty -m "local: working tree under test"
git -C "$W/skills" branch -q -f main HEAD
git -C "$W/skills" checkout -q main
git -C "$W/skills" fetch -q https://github.com/growthbook/skills.git '+refs/heads/*:refs/remotes/origin/*'
# The workflow builds new sync branches from origin/main; point it at the code
# under test so the guard and drift report see this checkout's skills.
git -C "$W/skills" update-ref refs/remotes/origin/main HEAD

echo "Preparing growthbook/ ..."
git clone -q --no-local "$GROWTHBOOK_SRC" "$W/growthbook"
git -C "$W/growthbook" checkout -q "$(git -C "$GROWTHBOOK_SRC" rev-parse HEAD)"

mkdir -p "$W/bin"
REAL_GH=$(command -v gh)
REAL_GIT=$(command -v git)
STATE_ZIP="$W/state.zip"
if [ -n "$STATE" ]; then
  mkdir -p "$W/state"
  printf '{"growthbook":"%s"}\n' "$(git -C "$W/growthbook" rev-parse "$STATE")" > "$W/state/state.json"
  (cd "$W/state" && zip -q "$STATE_ZIP" state.json)
fi

cat > "$W/bin/gh" <<EOF
#!/usr/bin/env bash
# Local stand-in: serve the saved sync point, drop writes, pass reads through.
case "\$*" in
  *"actions/artifacts?name=sync-state"*)
    [ -f "$STATE_ZIP" ] && echo "local://state.zip"; exit 0 ;;
  *"local://state.zip"*) cat "$STATE_ZIP"; exit 0 ;;
esac
case "\$1 \$2" in
  "issue create"|"issue comment"|"pr create"|"pr edit"|"pr comment")
    echo "[local] dropped: gh \$*" | tee -a "$W/dropped-writes.log" >&2; exit 0 ;;
esac
if [ "\$1" = api ] && printf '%s\n' "\$@" | grep -qE '^(-X|--method)$|^-f$|^-F$|^--field|^--raw-field|^--input'; then
  echo "[local] dropped: gh \$*" | tee -a "$W/dropped-writes.log" >&2; exit 0
fi
exec "$REAL_GH" "\$@"
EOF
cat > "$W/bin/git" <<EOF
#!/usr/bin/env bash
for arg in "\$@"; do
  if [ "\$arg" = push ]; then echo "[local] refused: git push" >&2; exit 1; fi
done
exec "$REAL_GIT" "\$@"
EOF
if [ "$STUB" = 1 ]; then
  cat > "$W/bin/claude" <<'EOF'
#!/usr/bin/env bash
# Stand-in for Claude: fix the known /api/v2/flag-revisions calls.
sed -i.bak 's#/api/v2/flag-revisions#/api/v2/feature-revisions#g' \
  skills/skills/feature-flags/references/flag-{revisions,review,publish}.md
rm -f skills/skills/feature-flags/references/*.bak
printf '%s\n' '#### Changes' '' \
  '- `skills/feature-flags/references/flag-review.md`: the cross-feature revision list path does not exist; it now uses `GET /api/v2/feature-revisions`. Source: `growthbook/packages/shared/src/validators/feature-revisions-v2.ts`.' \
  > .sync/notes.md
echo '{"subtype":"success","num_turns":0,"total_cost_usd":0}'
EOF
fi
chmod +x "$W/bin/"*

INPUTS=$(printf '{"dry_run": true, "since": "%s"}' "$SINCE")
echo "Running the workflow (event: $EVENT, $([ "$STUB" = 1 ] && echo "stub Claude" || echo "real Claude")) ..."
set +e
(cd "$W" && GITHUB_EVENT_NAME="$EVENT" PATH="$W/bin:$PATH" \
  python3 "$HERE/run-workflow.py" "$WORKFLOW" "$W" "$INPUTS") 2>&1 | tee "$W/run.log"
status=${PIPESTATUS[0]}
set -e

echo
echo "Job summary:   $W/_runner_temp/summary.md"
[ -f "$W/.sync/dry-run.md" ] && echo "Would-be PR:   $W/.sync/dry-run.md"
[ -f "$W/.sync/notes.md" ] && echo "Model notes:   $W/.sync/notes.md"
[ -f "$W/dropped-writes.log" ] && echo "Dropped writes: $W/dropped-writes.log"
if [ -f "$W/_runner_temp/claude.json" ]; then
  # shellcheck disable=SC2016
  node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(`Claude: ${r.num_turns ?? "?"} turns, $${(r.total_cost_usd ?? 0).toFixed(2)}`);' "$W/_runner_temp/claude.json" || true
fi
exit "$status"
