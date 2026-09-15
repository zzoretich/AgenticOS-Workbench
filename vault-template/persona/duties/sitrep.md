# Duty: sitrep (weekday mornings)

You are {{AGENT_NAME}}. Produce one page of internal work state for {{ADDRESS_AS}}, leading with exactly ONE recommended action. Internal state only: repos, planning phases, persona flags and proposals, duty results, open daily-note threads. Never fetch external data.

## Gather
1. **State diff (deterministic, run FIRST):** `{{NODE}} {{VAULT}}/brain/scripts/persona/sitrep-state.js diff` — keep the JSON (`first_run`, `changed`, `changes`, `state`). Repos come from `{{VAULT}}/persona/repos.json` (`{ "stall_threshold_days": 4, "repos": [{ "name": "...", "path": "/abs/path" }] }`); with no such file the repo lane is empty and that is fine.
2. **Repo lane:** for each entry in `state.repos` not marked `missing`: branch, dirty count, last commit line; for each `state.planning` entry: phase and idle days.
3. **Persona lane:** read `{{VAULT}}/persona/STATE.md` and the two newest files in `{{VAULT}}/persona/journal/`: open flags, pending proposals, last duty results.
4. **Threads lane:** read today's and yesterday's daily notes (layout `{{DAILY_NOTE_LAYOUT}}` under `{{VAULT}}`): sessions that ended mid-task, questions left open.

## Synthesize
Write at most 2,500 characters in exactly this shape (the date comes from `date +%Y-%m-%d`, never guessed):
```
# Sitrep — <YYYY-MM-DD>
**Recommended action:** <ONE imperative line>
## Moved (24h)
## Stalled / blocked
## Pending your call
## Open threads
```
A stalled phase or a FAILED duty outranks new work when choosing the recommended action.

## Deliver
1. Write the sitrep to `{{VAULT}}/brain/_index/sitrep.md` (overwrite; this file is injected into new sessions while it is less than 18 hours old).
2. Append it under a `## Sitrep` heading to today's daily note (create the note from `{{VAULT}}/templates/daily-note.md` if missing).
3. Persist state only after steps 1–2: `{{NODE}} {{VAULT}}/brain/scripts/persona/sitrep-state.js update`.

## Duty contract (mandatory, in this order)
1. Append to `{{VAULT}}/persona/journal/<today>.md`:
   ```
   ## <HH:MM> — duty: sitrep
   - status: OK | ISSUES
   - did: <one line>
   - changed: <the changes keys from step 1, or "none">
   - recommended: <the one action>
   ```
2. Update `{{VAULT}}/persona/STATE.md`: refresh `updated:`; `## Sitrep` = at most 3 lines distilled from the sitrep; update the `sitrep:` line under `## Last Duty Runs`; leave `## Flags`, `## Priorities` and `## Pending Proposals` as they are unless something changed.
3. **Do not commit**: STATE.md, the journal and `brain/_index/sitrep.md` are all ignored by the vault's `.gitignore`, and a duty never runs `git commit`.
