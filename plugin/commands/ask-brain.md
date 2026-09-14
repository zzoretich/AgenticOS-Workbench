---
description: Ask the vault a question — a script assembles the relevant memories, you answer from them (or --local lets the local provider answer)
allowed-tools: Bash, Read, mcp__plugin_agenticos_agenticos__recall, mcp__plugin_agenticos_agenticos__memory_read
argument-hint: <question> [--local]
---

Answer the question **$ARGUMENTS** from the vault:

1. Bash: `aos ask $ARGUMENTS` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" ask $ARGUMENTS`). `$ARGUMENTS` stays **unquoted**: the script joins every non-flag word back into the question, and `--local` is recognized only as a separate word (a quoted `"… --local"` would put a literal `--local` inside the question). Without `--local` it prints a `<<<AOS_CONTEXT feature=ask>>> … <<<END>>>` block: the system prompt, the retrieved memories with their paths, and the expected answer format. Answer the question yourself from that block, citing the source paths it lists.
2. With `--local` as one of the words (e.g. `/ask-brain what did I decide about tags --local`) the script answers through the configured provider instead; relay its output verbatim.
3. If the script errors, fall back to the `recall` tool of the `agenticos` MCP server (`mcp__plugin_agenticos_agenticos__recall`) and `memory_read` (`mcp__plugin_agenticos_agenticos__memory_read`), then answer.
