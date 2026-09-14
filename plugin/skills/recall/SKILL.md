---
name: recall
description: Ranked, recency-weighted recall over the whole vault — memories, patterns, daily notes, and the persona journal. Use when the user asks "when did I last touch X", "what did we decide about Y", "have we seen this before", "search my memory", "search the vault", "/recall", or at the start of any non-trivial task to load prior context before working.
---

# Recall

Ranked retrieval over the vault's living record through the `recall` tool of the
`agenticos` MCP server (`mcp__plugin_agenticos_agenticos__recall`): BM25 + recency boost + 1-hop
`[[wiki-link]]` expansion, fused with vector search when an embed index exists
(provider `ollama`), BM25 only otherwise. The index lives at
`brain/_index/recall-index.json`; `scan-vault` rebuilds it at every session end and
`aos recall --warm` rebuilds it on demand.

## The pre-task recall ritual

Before starting any non-trivial task (3+ files, a design decision, anything with
history), run ONE recall pass first:

1. Call `recall` with 2-5 keywords describing the task (e.g. `recall(query: "release workflow tags")`). Default limit 5.
2. Scan the hits: each carries `path`, `snippet`, `score`, and `flag` (`"3d"` = fresh; `"stale: 74d"` = older than 60 days).
3. `memory_read` (`mcp__plugin_agenticos_agenticos__memory_read`) at most the top 1-2 paths that look load-bearing. Never pull more than 2 full files into context from one recall pass.
4. Treat `stale:` hits as historical context, not current truth — verify against the live file before acting on them.

## Answering "when did I / what did we decide"

Route these to `recall` FIRST — never to raw Bash grep sweeps:
- "When did I last touch X" → `recall("X")`, read the freshest daily-note or `persona/journal` hit.
- "What did we decide about Y" → `recall("Y decision")`, prefer `brain/memory/**` hits over daily notes.
- Cite the hit's `path` and `flag` in the answer so staleness is visible.

## Behavior notes

- Self-healing: if the index is missing or older than 24h, the tool rebuilds it in-process (pure Node, zero tokens, seconds). This is the one write a read tool performs.
- Auto-recall on wake: session end writes `brain/_index/recall-wake.md` (top 3 snippets keyed off `SESSION.md`). If the injected `<brain-context>` already shows a "Recall (auto)" block, treat it as starting context — do not re-run recall for the same terms.
- Corpus: the `recallRoots` in `brain/config.json` (default `brain/memory`, `brain/patterns`, `persona/journal`) plus daily notes. Not indexed: code, transcripts, `brain/_index` caches.
- Command-line equivalent: `aos recall "<query>" [--limit N] [--json]`.
- The morning brief is a separate surface: read it with the `brief_read` tool, not with recall.
