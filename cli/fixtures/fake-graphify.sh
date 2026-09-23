#!/bin/sh
# Stand-in for the pinned `graphify` binary (fake-uv.sh installs it). `--version` reports what fake-uv recorded;
# `update <dir>` writes a small fixed graph into $GRAPHIFY_OUT the way graphify 0.9.66 does. No network, no model.
# Knobs: FAKE_GRAPHIFY_LOG (args + a few env probes per call), FAKE_GRAPHIFY_EXIT + FAKE_GRAPHIFY_STDERR (fail),
# FAKE_GRAPHIFY_SLEEP (seconds, to prove the timeout).
here=$(dirname "$0")
[ -n "${FAKE_GRAPHIFY_LOG:-}" ] && echo "$* | out=${GRAPHIFY_OUT:-} nobackup=${GRAPHIFY_NO_BACKUP:-} apikey=${ANTHROPIC_API_KEY:+set}${OPENAI_API_KEY:+set}" >> "$FAKE_GRAPHIFY_LOG"
case "$1" in
  --version) echo "graphify $(cat "$here/.fake-graphify-version" 2>/dev/null || echo 0.0.0)" ;;
  update)
    [ -n "${FAKE_GRAPHIFY_SLEEP:-}" ] && exec sleep "$FAKE_GRAPHIFY_SLEEP"
    if [ -n "${FAKE_GRAPHIFY_EXIT:-}" ]; then echo "${FAKE_GRAPHIFY_STDERR:-error: fake failure}" >&2; exit "$FAKE_GRAPHIFY_EXIT"; fi
    [ -d "${2:-}" ] || { echo "error: path not found: ${2:-}" >&2; exit 1; }
    out="${GRAPHIFY_OUT:-$2/graphify-out}"
    mkdir -p "$out"
    if [ -f "$out/graph.json" ] && ! grep -q '"nodes"' "$out/graph.json"; then
      echo "error: Cannot read $out/graph.json for incremental merge: Expecting value. Delete the file and run a full rebuild." >&2
      exit 1
    fi
    cat > "$out/graph.json" <<'JSON'
{"directed": false, "multigraph": false, "graph": {}, "nodes": [
  {"id": "memory_index", "label": "MEMORY", "file_type": "document", "source_file": "MEMORY.md", "community": 0, "community_name": "Memory"},
  {"id": "agenticos", "label": "AGENTICOS", "file_type": "document", "source_file": "AGENTICOS.md", "community": 0, "community_name": "Memory"},
  {"id": "profile", "label": "profile", "file_type": "document", "source_file": "brain/memory/user/profile.md", "community": 0, "community_name": "Memory"},
  {"id": "todo", "label": "To-Do", "file_type": "document", "source_file": "TODO.md", "community": 1, "community_name": "Tasks"},
  {"id": "patterns_readme", "label": "Patterns", "file_type": "document", "source_file": "brain/patterns/README.md", "community": 1, "community_name": "Tasks"}
], "links": [
  {"source": "memory_index", "target": "agenticos", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "MEMORY.md"},
  {"source": "memory_index", "target": "profile", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "MEMORY.md"},
  {"source": "agenticos", "target": "todo", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "AGENTICOS.md"},
  {"source": "agenticos", "target": "patterns_readme", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "AGENTICOS.md"},
  {"source": "todo", "target": "patterns_readme", "relation": "references", "confidence": "EXTRACTED", "weight": 1.0, "source_file": "TODO.md"}
], "hyperedges": []}
JSON
    echo "[graphify update] wrote $out/graph.json: 5 nodes, 5 edges, 2 communities"
    ;;
  *) exit 0 ;;
esac
