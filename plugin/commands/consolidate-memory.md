---
description: Find duplicate or overlapping memories and patterns and propose merges — a review draft only, sources are never edited
allowed-tools: Bash, Read, Write
argument-hint: [--local]
---

Produce a memory consolidation draft:

1. Bash: `aos consolidate-memory $ARGUMENTS` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" consolidate-memory $ARGUMENTS`). Without `--local` it prints a `<<<AOS_CONTEXT feature=consolidate-memory>>> … <<<END>>>` block listing candidate clusters with their file contents and the draft format.
2. Write the proposal (one section per cluster: keep / merge into / delete, with the merged text) to a temp file and persist it with `aos consolidate-memory --write <file>`; it lands at `brain/_index/memory-consolidation.md`.
3. Remind the user it is a proposal; no source file was modified. Offer to execute specific sections on request.
