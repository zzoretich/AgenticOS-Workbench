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
          approval; workflow and product are ideas for the user and go to persona/backlog.md when accepted>
    surface: <product proposals only: cli | plugin | brain | hud | vault-template | docs — where the
          change would live, so a feature run can start from the backlog entry>
    autoapply_class: <optional; a kebab-case class of change (say doc-typo). The ledger counts approvals,
          verifications, regressions and rejections per class; once a class has persona.autoapply.minVerified
          (3) verified approvals and neither a regression nor a rejection, a reflect files an
          `autoapply-<class>` proposal whose What is the exact new persona/autoapply.json. Only that approval
          whitelists the class; a whitelisted proposal that stays STILL-VALID for two daily confirmations is
          then applied by the review without a question and ledgered `auto-applied`.>
    ---

Body sections, in order: **What** (the exact change, as a diff or full replacement text), **Why** (evidence from the journal or feedback memories), **Risk** (what could go wrong), and **Premises** — what was verified versus assumed:

    ## Premises
    | Premise | Status | Evidence |
    |---|---|---|
    | <claim the fix depends on> | VERIFIED | <how checked, with path/date> |
    | <claim taken on faith> | ASSUMED | <why it is believed> |

Approval flow: the user says "approve <slug>" or "reject <slug>" in any session, or answers the batch review run by the `persona-flag-closer` skill. On approval the agent applies the change exactly as written, re-runs `recheck` expecting a NONZERO exit (finding gone), commits with `persona: apply approved proposal <slug>` — naming the changed paths and this proposal file, never a pathspec-less commit — and deletes the proposal file. If recheck still exits 0 after applying, it stops and reports — no commit. On rejection it deletes the file and records the reasoning as a feedback memory so the idea is not proposed again.

A `workflow` or `product` proposal is an idea, not a change the agent applies, so the review offers **accept** and **dismiss** instead: accept appends the proposal's What and Why to `persona/backlog.md` (through `brain/scripts/persona/backlog.js`, tracked) and deletes the file; dismiss deletes the file and records a `dismissed` ledger line, so the idea is not filed again.

Every outcome is appended to `persona/ledger.jsonl` through `brain/scripts/persona/ledger.js` (`filed` by the duty that wrote the proposal, `approved` / `rejected` / `stale-dropped` / `accepted` / `dismissed` / `auto-applied` by the review, `verified` / `regressed` by the watchdog once it has re-run an approved or auto-applied proposal's `recheck` for a week); each line carries the proposal's `autoapply_class` as `class` when it has one. `ledger.js summary` is the agent's track record, per kind and per class; both reflects read it before proposing.

Guarded territory (proposal required): IDENTITY.md, duties/*.md, brain/scripts/persona/*, the duty schedules, and anything outside `persona/`.
