---
name: persona-flag-closer
description: Batch-review your Chief of Staff agent's pending proposals, STATE.md flags, and new silent duty failures — deterministic re-verification via per-proposal recheck recipes, one HTML digest, one approve/reject/defer pass, and one commit per decision. Use when the user says "review persona flags", "close persona flags", "review pending proposals", "what's pending my approval", or "/agenticos:persona-flag-closer".
---

# Persona Flag Closer

Close the loop on the agent's findings: everything pending the user's judgment, reviewed in ONE pass. Deterministic Node does collection and re-verification (zero tokens); the conversation is spent only on decisions.

Paths: `SKILL_DIR = ${CLAUDE_PLUGIN_ROOT}/skills/persona-flag-closer`. The vault is the `vault` value in `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agenticos.json`; the scripts read it themselves (`--root <vault>` overrides). Proposals live in `<vault>/persona/proposals/*.md` (README.md is not a proposal); flags are the `- [ ]` lines under `## Flags` in `<vault>/persona/STATE.md`; silent failures come from `<vault>/persona/journal/logs/duty-*-error.log` (or `PERSONA_LOG_DIR`). Review state lives in `<vault>/persona/flag-closer/`. The outcome ledger is `LEDGER = <vault>/brain/scripts/persona/ledger.js` (appends to `<vault>/persona/ledger.jsonl`, which IS tracked — include it in the commit). If `node` is not on PATH, use the `node` path recorded in `agenticos.json`.

## Workflow

1. **Collect (deterministic, run ONCE per review):**
   `node "$SKILL_DIR/scripts/collect.js" --update-state > /tmp/pfc-collect.json`
   `--update-state` consumes error-log offsets and records the pending-set hash.
2. **Re-verify (deterministic):**
   `node "$SKILL_DIR/scripts/recheck.js" /tmp/pfc-collect.json > /tmp/pfc-review.json`
   Verdicts: STILL-VALID (recipe exit 0 — finding still present) · STALE (nonzero — likely already fixed) · RECIPE-ERROR (recipe broken) · NO-RECIPE (legacy proposal — human judgment). Do NOT pass `--record` here: confirmation counters belong to the monitor duty only.
3. **Empty case:** if `proposals`, `flags`, and `logFindings` are all empty in `/tmp/pfc-review.json`, say "Nothing pending — no proposals, no flags, no new failures." and STOP.
4. **Render the digest:**
   `TODAY=$(date +%F); node "$SKILL_DIR/scripts/render-digest.js" /tmp/pfc-review.json > "<vault>/persona/flag-closer/digest-$TODAY.html"`
   Show the user the path (or publish it with the Artifact tool when that tool is available — title "Persona Flag Review", favicon "🚩"; keep the same title on every publish). The digest and the state files under `<vault>/persona/flag-closer/` are gitignored — never `git add` them.
5. **One batch decision pass** — group items 4 per AskUserQuestion call until all are covered; header = slug truncated to 12 chars; question text = kind (`self` | `vault` | `workflow` | `product`; default self), target, filed date + age, verdict, premise summary (n VERIFIED / m ASSUMED), and a one-line gist of the What. A `workflow` or `product` proposal is an idea for the user, not a change the agent applies: Approve means "keep it — I will act on it myself" (it still records `approved` and deletes the file; slice 3 of the heartbeat plan routes it to a backlog).
   - Proposal, STILL-VALID or NO-RECIPE → options: **Approve** ("apply exactly as written now") / **Reject** ("delete + record feedback memory") / **Defer** ("leave for next review").
   - Proposal, STALE → options: **Close (stale)** ("finding no longer present — delete file") / **Keep open** / **Defer**.
   - Proposal, RECIPE-ERROR → options: **Fix recipe** / **Defer**. NEVER apply a RECIPE-ERROR item.
   - Flag → options: **Close flag** ("remove the line from STATE.md") / **Keep** / **File proposal** ("draft a proposals/ entry for the underlying fix").
   Log findings are informational — digest only, no question.
6. **Execute each decision — one commit per item that touches tracked files** (only when `<vault>` is a git repository; otherwise apply the file changes and report them). `persona/STATE.md`, `persona/journal/`, `persona/answers.json`, `persona/autoapply.json`, `persona/DISABLED` and `persona/flag-closer/` are ignored by the vault's `.gitignore`: never `git add` them, and never run a pathspec-less `git commit` (it would sweep up whatever the user had staged):
   - **Approve:** read the proposal; apply its **What** EXACTLY as written (the user's option selection IS the approval for guarded targets — apply nothing beyond the written change). Verify: run `sh -c '<recheck>'; echo "exit=$?"` and require a NONZERO exit (finding gone). If it still exits 0, STOP on this item, report it, do not commit. On success, ledger it — `node "$LEDGER" append approved <slug> --kind <kind> --by user --target "<target>" --recheck '<recheck>'` (the recipe is what the watchdog re-runs for a week to mark it `verified` or `regressed`) — then `git -C <vault> add <changed paths> persona/ledger.jsonl && git -C <vault> rm -q persona/proposals/<file> && git -C <vault> commit -m "persona: apply approved proposal <slug>" -- <changed paths> persona/ledger.jsonl persona/proposals/<file>`.
   - **Reject:** record the reasoning as a feedback memory (one file in `<vault>/brain/memory/feedback/` + its one-line entry under `## Feedback (how to work)` in `<vault>/MEMORY.md`), ledger it — `node "$LEDGER" append rejected <slug> --kind <kind> --by user --target "<target>" --note "<one-line reason>"` — then `git -C <vault> add <feedback file> <vault>/MEMORY.md persona/ledger.jsonl && git -C <vault> rm -q persona/proposals/<file>` and commit `git -C <vault> commit -m "chore: reject proposal <slug> — feedback recorded" -- <feedback file> <vault>/MEMORY.md persona/ledger.jsonl persona/proposals/<file>`.
   - **Close (stale):** ledger it — `node "$LEDGER" append stale-dropped <slug> --kind <kind> --by user --target "<target>"` — then `git -C <vault> add persona/ledger.jsonl && git -C <vault> rm -q persona/proposals/<file>`; commit `git -C <vault> commit -m "chore: close stale proposal <slug>" -- persona/ledger.jsonl persona/proposals/<file>`.
   - **Close flag:** edit `<vault>/persona/STATE.md` — delete that ONE `- [ ]` line, nothing else. Do not commit: the vault ignores `persona/STATE.md` (and `persona/journal/`), so there is nothing to stage — report the edit in the wrap-up instead. The user commits duty state by hand if they want it tracked.
   - **Fix recipe:** edit only the `recheck:` frontmatter line so it re-runs the original check; commit `git -C <vault> commit -m "fix: repair recheck recipe for <slug>" -- persona/proposals/<file>`. Do not touch the proposal's What.
   - **Defer / Keep:** touch nothing.
7. **Auto-apply lane (dormant by design):** items with `autoApply.eligible: true` may be applied without a question, each as its own revertible commit — `git -C <vault> add <changed paths> && git -C <vault> commit -m "persona: auto-apply <slug> (class <autoapply_class>)" -- <changed paths>` (the `git add` matches the Approve lane: without it a newly created path is refused by the pathspec, `error: pathspec … did not match any file(s) known to git`) (never a path in step 6's never-`git add` list — skip the item, add nothing, commit nothing, report it in step 8). The shipped whitelist (`<vault>/persona/autoapply.json`) is EMPTY, so this lane does nothing until the user adds a class through an approved proposal; the gate additionally requires verdict STILL-VALID plus 2+ consecutive monitor-run confirmations.
8. **Wrap up:** report one line per decision taken, the digest path, the remaining pending count, and the last line of `node "$LEDGER" summary` (approval rate, open, unverified).

## Guardrails
- Never edit `persona/duties/`, `brain/scripts/persona/`, `persona/IDENTITY.md`, the duty schedules, hooks, or Claude Code settings except as the exact What of an approved proposal in step 6.
- If a proposal's What no longer applies cleanly to the current file state, treat it as STALE regardless of verdict: report, offer Close or Defer — never improvise a variant.
