# extras/ollama

Optional pieces that only make sense with a local Ollama. Nothing here is installed by
`aos init`; the product's hooks and MCP server never call these files.

| File | What it is |
|---|---|
| `ollama-serve.sh` | Keeps `ollama serve` alive on 127.0.0.1:11434 (POSIX sh; run it under the launchd or systemd template below so a crash is a restart). Logs to `~/.local/state/agenticos/ollama-serve.log` (`AOS_OLLAMA_LOG`). |
| `model-pull.sh` | Pulls the three default tags in order (`ollama pull`, stops at the first failure). `model-pull.sh --list` prints the tags one per line without needing Ollama. Honors `BRAIN_MODEL` / `BRAIN_REASONER` / `BRAIN_EMBEDDER`. |
| `launchd/com.agenticos.ollama.plist.tmpl` | macOS supervisor for `ollama-serve.sh` (`KeepAlive`, `RunAtLoad`). Placeholders `{{EXTRAS}}`, `{{HOME}}`. |
| `systemd/agenticos-ollama.service.tmpl` | Linux user unit for `ollama-serve.sh` (`Restart=always`). Placeholder `{{EXTRAS}}`. |
| `delegate.sh` | One-shot prompt to the local reasoner (`gpt-oss:20b` by default) over `/api/chat`. Exit codes 2–7 documented in the header. Needs `curl` and `python3`. |
| `Oss.md` | A Claude Code subagent definition that wraps `delegate.sh`. Copy it to `<claude config dir>/agents/Oss.md` and export `AOS_EXTRAS=<this directory>` in your shell to use it. |
| `reason.js` | Direct Q&A with the local reasoner (no vault retrieval). `node extras/ollama/reason.js [--effort=low|medium|high] "question"` |
| `local-code.js` | Offline coding help from the local reasoner. `node extras/ollama/local-code.js [--file=path] "task"` |
| `wrap-headless.js` | Autonomous session wrap (mechanical wrap + local narrative summary). The product's SessionEnd hook (`auto-wrap`) supersedes it; kept for scripted use. |

The three Node scripts load the brain runtime from `../../brain/scripts` and resolve the
vault the same way every script does (`AOS_VAULT`, then `agenticos.json`). They talk to
Ollama directly and do not consult the provider setting.

Models the defaults expect: `qwen3.5:4b` (workhorse), `gpt-oss:20b` (reasoner),
`qwen3-embedding:0.6b` (embedder). Override with `BRAIN_MODEL`, `BRAIN_REASONER`,
`BRAIN_EMBEDDER`. Pull them all with `sh extras/ollama/model-pull.sh`.

## Keeping Ollama alive

Neither template is installed by `aos init` nor removed by `aos uninstall`; render and
load it by hand from the repo root, and remove it the same way.

macOS (launchd):
```sh
EXTRAS="$(pwd)/extras/ollama"
mkdir -p ~/Library/LaunchAgents ~/.local/state/agenticos
sed "s#{{EXTRAS}}#$EXTRAS#g; s#{{HOME}}#$HOME#g" "$EXTRAS/launchd/com.agenticos.ollama.plist.tmpl" \
  > ~/Library/LaunchAgents/com.agenticos.ollama.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.agenticos.ollama.plist
# remove: launchctl bootout "gui/$(id -u)/com.agenticos.ollama" && rm ~/Library/LaunchAgents/com.agenticos.ollama.plist
```

Linux (systemd user unit):
```sh
EXTRAS="$(pwd)/extras/ollama"
mkdir -p ~/.config/systemd/user ~/.local/state/agenticos
sed "s#{{EXTRAS}}#$EXTRAS#g" "$EXTRAS/systemd/agenticos-ollama.service.tmpl" \
  > ~/.config/systemd/user/agenticos-ollama.service
systemctl --user daemon-reload && systemctl --user enable --now agenticos-ollama.service
# remove: systemctl --user disable --now agenticos-ollama.service && rm ~/.config/systemd/user/agenticos-ollama.service
```

Tests: `node --test extras/ollama/*.test.js` (not part of `npm test`; the glob form — Node ≥22 rejects `node --test <dir>`).
