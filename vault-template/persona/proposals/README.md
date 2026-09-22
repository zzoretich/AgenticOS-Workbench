# Proposals

Guarded changes wait here for the user's sign-off. One file per proposal, `YYYY-MM-DD-<slug>.md`, with YAML frontmatter:

    ---
    slug: <kebab-case; must match the filename after the date prefix>
    filed: YYYY-MM-DD
    target: <one line — what the change touches; mark guarded targets "(guarded)">
    recheck: <ONE /bin/sh command. Exit 0 = the finding is still present (proposal
              still valid). Nonzero = stale. Under 15 s, read-only, no network. It
              re-runs the ORIGINAL check that found the problem.>
    kind: <optional; self (default) | vault | workflow | product — self and vault are applied on
          approval; workflow and product are ideas for the user and go to the backlog when accepted>
    autoapply_class: <optional; meaningful only once the class is listed in persona/autoapply.json>
    ---

Body sections, in order: **What** (the exact change, as a diff or full replacement text), **Why** (evidence from the journal or feedback memories), **Risk** (what could go wrong), and **Premises** — what was verified versus assumed:

    ## Premises
    | Premise | Status | Evidence |
    |---|---|---|
    | <claim the fix depends on> | VERIFIED | <how checked, with path/date> |
    | <claim taken on faith> | ASSUMED | <why it is believed> |

Approval flow: the user says "approve <slug>" or "reject <slug>" in any session, or answers the batch review run by the `persona-flag-closer` skill. On approval the agent applies the change exactly as written, re-runs `recheck` expecting a NONZERO exit (finding gone), commits with `persona: apply approved proposal <slug>` — naming the changed paths and this proposal file, never a pathspec-less commit — and deletes the proposal file. If recheck still exits 0 after applying, it stops and reports — no commit. On rejection it deletes the file and records the reasoning as a feedback memory so the idea is not proposed again.

Every outcome is appended to `persona/ledger.jsonl` through `brain/scripts/persona/ledger.js` (`filed` by the duty that wrote the proposal, `approved` / `rejected` / `stale-dropped` by the review, `verified` / `regressed` by the watchdog once it has re-run an approved proposal's `recheck` for a week). `ledger.js summary` is the agent's track record; reflect reads it before proposing.

Guarded territory (proposal required): IDENTITY.md, duties/*.md, brain/scripts/persona/*, the duty schedules, and anything outside `persona/`.
