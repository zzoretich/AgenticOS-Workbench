#!/bin/sh
# First-run rehearsal (spec §14): a fresh HOME and Claude config dir, `aos init` with the fake
# claude CLI, then scan, compile, MCP recall, wrap_session, doctor, and uninstall --keep-vault.
# Needs: node >= 20 and npm on PATH, network for `npm install` inside the vendored runtime.
# Run from anywhere: sh cli/rehearsal/first-run.sh
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TMP=$(mktemp -d)
export HOME="$TMP/home" CLAUDE_CONFIG_DIR="$TMP/cfg"
mkdir -p "$HOME" "$CLAUDE_CONFIG_DIR"
echo '{}' > "$CLAUDE_CONFIG_DIR/settings.json"
BEFORE=$(ls -A "$CLAUDE_CONFIG_DIR" | sort)
export AOS_CLAUDE_BIN="$ROOT/cli/fixtures/fake-claude.sh" FAKE_CLAUDE_LOG="$TMP/claude.log"
# FAKE_PLUGIN_PATH is NOT set yet: with it, fake-claude's `plugin list --json` reports the plugin as installed,
# installPlugin() takes the "plugin already installed" branch, and the `plugin install` grep below would fail.
unset AOS_VAULT BRAIN_VAULT AOS_CONFIG CLAUDE_PROJECT_DIR || true
VAULT="$TMP/aos"

echo "== init"
node "$ROOT/cli/aos.js" init --vault "$VAULT" --no-obsidian --provider none --persona-json "$ROOT/cli/fixtures/persona.json" --yes

echo "== seed set"
for f in MEMORY.md AGENTICOS.md .gitignore brain/config.json brain/_index/SESSION.md brain/_index/BRAIN.md \
    brain/_index/MOC-reference.md brain/_index/MOC-projects.md brain/_index/MOC-patterns.md brain/_index/scanner-config.json \
    brain/memory/user/profile.md brain/patterns/README.md templates/daily-note.md templates/meeting-note.md \
    templates/decision-record.md templates/project-note.md .obsidian/daily-notes.json \
    brain/scripts/package.json brain/scripts/bin/aos brain/scripts/cli/aos.js \
    brain/scripts/node_modules/@modelcontextprotocol/sdk/package.json; do
  [ -e "$VAULT/$f" ] || { echo "missing $f"; exit 1; }
done
[ -f "$CLAUDE_CONFIG_DIR/agenticos.json" ]
grep -q '"provider": "none"' "$CLAUDE_CONFIG_DIR/agenticos.json"
grep -q '^plugin install agenticos@agenticos-workbench$' "$FAKE_CLAUDE_LOG"

echo "== scan + compile through the launcher"
AOS="$VAULT/brain/scripts/bin/aos"
AOS_DETACHED=1 sh "$AOS" scan-vault --quiet
AOS_DETACHED=1 sh "$AOS" build-brain-md
[ -f "$VAULT/brain/_index/snapshot.json" ]
[ -f "$VAULT/brain/_index/recall-index.json" ]
grep -q '^## Who' "$VAULT/brain/_index/BRAIN.md"

echo "== MCP recall over stdio"
node "$ROOT/cli/rehearsal/mcp-call.js" recall '{"query":"workbench vault profile"}' | grep -q 'brain/memory/user/profile.md'

echo "== wrap_session writes a memory and a MEMORY.md line"
node "$ROOT/cli/rehearsal/mcp-call.js" wrap_session '{"facts":["The first-run rehearsal ran."],"decisions":[],"feedback":[],"threads":[],"candidates":[{"type":"reference","title":"Rehearsal marker","description":"Written by the CI first-run rehearsal through wrap_session.","body":"This memory proves that wrap_session writes through the shared memory writer. It was created by cli/rehearsal/first-run.sh in a throwaway vault. It is safe to delete."}]}' | grep -Eq '"written": ?1'
[ -f "$VAULT/brain/memory/reference/rehearsal-marker.md" ]
grep -q 'rehearsal-marker.md' "$VAULT/MEMORY.md"

echo "== doctor"
# doctor's "plugin installed" check reads fake-claude's `plugin list --json`, which lists the plugin only while
# FAKE_PLUGIN_PATH is set — so it is exported here, after init has already exercised the install path.
export FAKE_PLUGIN_PATH="$ROOT/plugin"
node "$ROOT/cli/aos.js" doctor

echo "== uninstall --keep-vault restores the config dir"
node "$ROOT/cli/aos.js" uninstall --keep-vault --yes
AFTER=$(ls -A "$CLAUDE_CONFIG_DIR" | sort)
[ "$BEFORE" = "$AFTER" ] || { echo "config dir changed: $AFTER"; exit 1; }
[ -f "$VAULT/MEMORY.md" ]
[ ! -e "$HOME/.local/bin/aos" ]
echo REHEARSAL-OK
