#!/bin/sh
# delegate.sh — send one prompt to the local reasoner via Ollama /api/chat.
# Usage: delegate.sh --stdin   (prompt on stdin — safest for multi-line)
#        delegate.sh 'prompt text'
# Env: OSS_MODEL (default $BRAIN_REASONER else gpt-oss:20b)
#      OSS_EFFORT low|medium|high|none (default medium; none = omit think field)
#      OSS_NUM_PREDICT (default 1024) · OSS_TIMEOUT seconds (default 300)
#      OLLAMA_HOST / OLLAMA_PORT (default 127.0.0.1 / 11434)
# Exit: 2 usage · 3 ollama down · 4 model missing · 5 HTTP failure · 6 API error · 7 empty
set -u

MODEL="${OSS_MODEL:-${BRAIN_REASONER:-gpt-oss:20b}}"
EFFORT="${OSS_EFFORT:-medium}"
NUM_PREDICT="${OSS_NUM_PREDICT:-1024}"
TIMEOUT="${OSS_TIMEOUT:-300}"
BASE="http://${OLLAMA_HOST:-127.0.0.1}:${OLLAMA_PORT:-11434}"

if [ "${1:-}" = "--stdin" ]; then PROMPT="$(cat)"; elif [ -n "${1:-}" ]; then PROMPT="$*"; else
  echo "usage: delegate.sh --stdin | delegate.sh 'prompt'" >&2; exit 2; fi
[ -n "$PROMPT" ] || { echo "usage: empty prompt" >&2; exit 2; }

curl -sfm 3 "$BASE/api/tags" >/dev/null 2>&1 || { echo "[delegate] Ollama unreachable at $BASE" >&2; exit 3; }
curl -sm 3 "$BASE/api/tags" | grep -q "\"$MODEL\"" || { echo "[delegate] model $MODEL not installed — run: ollama pull $MODEL" >&2; exit 4; }

printf '%s' "$PROMPT" | python3 -c '
import json, sys, urllib.request
base, model, effort, npred, timeout = sys.argv[1:6]
body = {"model": model, "messages": [{"role": "user", "content": sys.stdin.read()}],
        "stream": False, "keep_alive": "10m",
        "options": {"num_predict": int(npred), "num_ctx": 16384}}
if effort != "none":
    body["think"] = effort
req = urllib.request.Request(base + "/api/chat", data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json"})
try:
    resp = urllib.request.urlopen(req, timeout=int(timeout))
    data = json.load(resp)
except Exception as e:
    print("[delegate] HTTP failure: " + str(e), file=sys.stderr); sys.exit(5)
if "error" in data:
    print("[delegate] API error: " + str(data["error"]), file=sys.stderr); sys.exit(6)
out = ((data.get("message") or {}).get("content") or "").strip()
if not out:
    print("[delegate] empty response", file=sys.stderr); sys.exit(7)
print(out)
' "$BASE" "$MODEL" "$EFFORT" "$NUM_PREDICT" "$TIMEOUT"
