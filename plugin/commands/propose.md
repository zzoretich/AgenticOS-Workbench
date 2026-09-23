---
description: File a proposal in persona/proposals (the Workbench Proposals tab) in the standard format, with its HTML page and a link to it
allowed-tools: Bash, Read, Write
argument-hint: <what you propose, or "the plan above">
---

File this as a proposal: **$ARGUMENTS**

A proposal is something for the user to decide: a change to make, or an idea to keep. When the text points at a plan or write-up earlier in this conversation ("the plan above", "that proposal"), file that one and keep its substance.

Vault: the `vault` value in `${CLAUDE_CONFIG_DIR:-~/.claude}/agenticos.json` (also visible in the injected `<brain-context>`). Proposals live in `<vault>/persona/proposals/`; its `README.md`, when present, is the format's reference. If `node` is not on PATH, use the `node` path recorded in `agenticos.json`.

1. **Classify.**
   - `kind`: `vault` for a change inside the vault that the review would apply; `self` for a change to the Chief of Staff's own files (IDENTITY.md, duties, persona scripts, schedules); `workflow` for an idea about how the user works, including a plan for another project; `product` for an idea for AgenticOS Workbench itself.
   - `surface`, on a `product` proposal only: `cli` | `plugin` | `brain` | `hud` | `vault-template` | `docs`, where most of the change lands.
   - `slug`: kebab-case, `[a-z0-9-]`, 2–61 characters, not used by a file in `persona/proposals/` or a section of `persona/backlog.md`.
2. **Recheck.** One read-only `/bin/sh` command, under 15 seconds, no network, that exits 0 while the situation behind the proposal still holds and nonzero once it is resolved (a file still lacks a line, a version is still below a number). For an idea with nothing to check, use `true`.
3. **Write** `<vault>/persona/proposals/<today>-<slug>.md` (local date; create the folder when missing) in exactly this shape:

```markdown
---
slug: <slug>
filed: <today>
kind: <kind>
surface: <surface — product proposals only; leave the line out otherwise>
target: <one line — what the change touches, or what the idea is about>
recheck: "<the recipe, with any inner double quote written as \">"
---

# <Title — one line the user recognises>

## What
<the exact change (a diff or the full replacement text), or for an idea what would be built or done. Several items: a numbered list, each led by its priority (🔺 ⏫ 🔼 🔽) when they differ, with timing in brackets.>

## Why
<the evidence: what prompted it, with sources>

## Risk
<what could go wrong, and what undoing it costs>

## Premises
| Premise | Status | Evidence |
|---|---|---|
| <a claim the proposal depends on> | VERIFIED | <how you checked it in this session, with path and date> |
| <a claim taken on trust> | ASSUMED | <why it is believed> |
```

   Mark a premise VERIFIED only when you checked it in this session. Do not write the "Open the proposal in browser" line: the renderer owns it.
4. **Ledger and render**, in the vault:
   - `node <vault>/brain/scripts/persona/ledger.js append filed <slug> --kind <kind> --by user --target "<target>"`
   - `node <vault>/brain/scripts/persona/proposal-html.js <vault>/persona/proposals/<today>-<slug>.md` — writes the page to `<vault>/brain/_index/proposals/<today>-<slug>.html` and the link line under the title.
   If either script is missing (a vault not yet upgraded), say so and leave the file in place: the next `aos upgrade` and scan render it.
5. **Reply** in two lines: the title as the page link, copied from the file's `**[Open the proposal in browser](file://…)**` line, then "Decide it in the Workbench Proposals tab, or say `review persona flags`." Commit nothing — proposals stay uncommitted until the review decides them.
