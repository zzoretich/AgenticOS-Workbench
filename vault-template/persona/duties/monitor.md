# Duty: monitor (daily)

You are {{AGENT_NAME}}. Work only inside the vault at `{{VAULT}}`. Read before you write; prepare fixes, do not execute destructive ones.

## Checklist
1. **Duty health:** list `{{LOG_DIR}}`; for every `duty-*.log` read the last line and note any duty whose last run says FAILED or "contract unmet"; for every `duty-*-error.log` that grew since yesterday, copy its last 3 lines into "found".
2. **Vault repo health:** if `{{VAULT}}` is a git repository, run `git -C {{VAULT}} status --porcelain | wc -l`; more than 40 uncommitted changes is a "vault drifting" flag.
3. **Unfinished work:** read the newest directory under `{{VAULT}}/brain/_index/agent-runs/` and today's and yesterday's daily notes (layout `{{DAILY_NOTE_LAYOUT}}` under `{{VAULT}}`); list sessions that ended mid-task.
4. **Pending review:** count files in `{{VAULT}}/persona/proposals/` other than README.md and the `- [ ]` lines under `## Flags` in `{{VAULT}}/persona/STATE.md`; carry both counts into the sitrep line.
5. **Prepare, don't just report:** for at most ONE flagged item whose fix is mechanical and safe, write the exact command or text into the journal entry. Never run it.

## Duty contract (mandatory, in this order)
1. Append to `{{VAULT}}/persona/journal/<today YYYY-MM-DD>.md` (create if missing):
   ```
   ## <HH:MM> — duty: monitor
   - status: OK | ISSUES
   - did: <one line>
   - found: <bullets, or "nothing">
   - flags: <new flags raised, or "none">
   ```
2. Rewrite `{{VAULT}}/persona/STATE.md` completely, keeping its headings: update `updated:`; `## Sitrep` = at most 3 one-liners; `## Flags` = open `- [ ]` items needing {{ADDRESS_AS}} (carry unresolved ones forward, drop resolved); `## Priorities` unchanged unless {{ADDRESS_AS}} changed them; `## Pending Proposals` = the proposal filenames or "none"; `## Last Duty Runs` = update the `monitor:` line to `<today> OK|ISSUES`. Hard limit 1,200 characters.
3. Edit STATE.md and append the journal only — **do not commit**: the vault's `.gitignore` ignores both, and a duty never runs `git commit` (it would sweep up whatever {{ADDRESS_AS}} has staged). {{ADDRESS_AS}} commits duty state by hand if they want it tracked.
