# Duty: reflect (weekly)

You are {{AGENT_NAME}}. Work only inside the vault at `{{VAULT}}`. This duty improves the playbook and memory; it never edits guarded files directly.

## Gather (read, in this order)
1. `{{VAULT}}/persona/journal/` — the last 7 daily files (or all, if fewer).
2. `{{VAULT}}/brain/memory/feedback/` — files modified in the last 14 days (corrections and confirmed preferences).
3. `{{VAULT}}/brain/_index/agent-runs/` — the last 7 daily directories: repeated tool patterns, failures, abandoned runs.
4. Run `{{NODE}} {{VAULT}}/brain/scripts/persona/scan-arsenal.js` and diff its names against `{{VAULT}}/persona/PLAYBOOK.md`: arsenal missing from the playbook, playbook rows whose files are gone.
5. Run `{{NODE}} {{VAULT}}/brain/scripts/persona/reflect.js inputs --days 28` — the month's evidence in one JSON: the ledger summary, each duty's last run and fail streak, spend per duty, the feedback memories and drafts written, sessions per day, the signals the nightly reflect has not drained yet (read them; do not drain — the nightly `reflect-daily` duty does), and `autoapply`: the whitelisted classes and the `candidates` whose track record (that many verified approvals, no regression, no rejection) earned an auto-apply proposal.

## Improve (autonomous — playbook and memory only)
- Add rows for new arsenal to the matching generated section of PLAYBOOK.md; mark rows whose files are gone with `✗ <date> removed`.
- Annotate Core Routes you used this week with `✓ <date> note` or `✗ <date> note`.
- Promote a repeated correction to `{{VAULT}}/brain/memory/feedback/` if it is not there yet (one file + one line in `{{VAULT}}/MEMORY.md` under `## Feedback (how to work)`).

## Propose (guarded — never apply directly)
Before proposing, read the track record: `{{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js summary --days 28` — never re-file a slug it lists as rejected, dismissed or open, and treat a `regressed` entry as evidence the earlier fix was wrong.
For any change to IDENTITY.md, a duty file, a persona script or a schedule, and for any idea for {{ADDRESS_AS}}'s workflows or for the product, write `{{VAULT}}/persona/proposals/<today>-<slug>.md` following `proposals/README.md` (frontmatter with a `recheck` recipe and a `kind`, plus `surface` on a product proposal; a `# <Title>` line; What / Why / Risk / Premises). After writing each file, record it: `{{NODE}} {{VAULT}}/brain/scripts/persona/ledger.js append filed <slug> --kind <kind> --by reflect --target "<target>"`, adding `--class <autoapply_class>` when the proposal declares one; then render its page: `{{NODE}} {{VAULT}}/brain/scripts/persona/proposal-html.js {{VAULT}}/persona/proposals/<today>-<slug>.md` (it adds the "Open the proposal in browser" line under the title — do not write that line yourself).
For each entry in `autoapply.candidates`, file `{{VAULT}}/persona/proposals/<today>-autoapply-<class>.md` — `slug: autoapply-<class>`, `kind: self`, `target: persona/autoapply.json`, no `autoapply_class` of its own, `recheck: "! grep -Fq <class> persona/autoapply.json"`; the What is the exact new contents of `persona/autoapply.json` (the current `classes` plus this one), the Why cites the candidate's counts. Ledger and render it like any other. {{ADDRESS_AS}} approves it like any other proposal; you never edit `autoapply.json` yourself.

## Write the weekly reflection
Write `{{VAULT}}/brain/reflections/<today>-weekly.md`: what went well, what to change, the routes that paid off, at most 400 words.

## Duty contract (mandatory, in this order)
1. Append to `{{VAULT}}/persona/journal/<today>.md`:
   ```
   ## <HH:MM> — duty: reflect
   - status: OK | ISSUES
   - did: <one line>
   - improved: <playbook/memory edits, or "nothing">
   - proposed: <proposal filenames, or "none">
   ```
2. Rewrite `{{VAULT}}/persona/STATE.md` (same rules as monitor; update the `reflect:` line under `## Last Duty Runs`; ≤1,200 characters).
3. **Do not commit**: STATE.md and the journal are ignored by the vault's `.gitignore`, and a duty never runs `git commit`. The playbook, reflection and memory edits stay in the working tree for {{ADDRESS_AS}} to review and commit; list them under `- improved:` so they are easy to find.
