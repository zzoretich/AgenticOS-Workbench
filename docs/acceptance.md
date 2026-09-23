# Release acceptance (manual, per release)

Run on a **fresh macOS user account** (System Settings → Users & Groups → Add Account; log in as
that user). Nothing below may rely on the developer's own account. Tick every box and paste the
filled list into the release PR — quote paths only in their `$HOME`-relative form, never the
absolute home path the installer prints. Criteria are spec §1; each block names the one it proves.

## 0. Prerequisites (10 min)
- [ ] Node 20+ from the nodejs.org installer: `node -v` prints `v20` or `v22`.
- [ ] Claude Code installed and logged in: `claude --version`; `claude -p "Reply with the word ok." --tools "" --max-budget-usd 0.01` prints `ok`.
- [ ] Obsidian installed (drag to Applications); opened once. `aos init` refuses to run without it.
- [ ] Ollama installed (`ollama --version` prints a version). `aos init` refuses to run without it; it need not be serving.
- [ ] `ls ~/.claude` shows no `agenticos.json`.
- [ ] uv installed (`uv --version` prints a version) — `aos init` refuses to run without it; it installs the pinned graphify.
- [ ] python3 present (`python3 --version` ≥ 3.9) — `aos init` refuses to run without it. `git` and `python3` come with the Command Line Tools; accept the install dialog if it appears.

## 1. Install in under ten minutes (criterion 1)
Start a timer.
- [ ] `git clone https://github.com/zzoretich/AgenticOS-Workbench ~/AgenticOS-Workbench && cd ~/AgenticOS-Workbench`
- [ ] `npm ci --ignore-scripts` finishes without error (the command `docs/install.md` and CI use; the terminal's native module is built only by `--terminal` / `aos terminal install`).
- [ ] `npm run setup` — accept the default vault `~/AgenticOS`; answer the interview: name `Atlas`, address `boss`, voice `dry`, priorities `tests`, model default, effort default, schedule `yes`.
- [ ] The final checklist lists every file written and prints an `@…/AgenticOS/AGENTICOS.md` line carrying the **absolute** vault path — that exact line is what goes into `~/.claude/CLAUDE.md` below; do not paste it into the release PR.
- [ ] `export PATH="$HOME/.local/bin:$PATH"` (append the same line to `~/.zprofile`); `which aos` prints the `.local/bin/aos` symlink under your home; `aos doctor` exits 0.
- [ ] Timer under 10:00 → record the time: ______
- [ ] `ls ~/AgenticOS/persona` shows `IDENTITY.md STATE.md PLAYBOOK.md duties proposals journal answers.json autoapply.json` — and no `identity.template.md` or `STATE.template.md`; `grep -c Atlas ~/AgenticOS/persona/IDENTITY.md` ≥ 1.
- [ ] `ls ~/Library/LaunchAgents | grep agenticos` lists the three plists; `launchctl list | grep com.agenticos` shows them loaded.
- [ ] Add the printed `@…/AGENTICOS.md` line to `~/.claude/CLAUDE.md` (create the file if missing).
- [ ] `cd ~ && claude`, first prompt `what do you know about me?` → the reply shows it received `<persona>` (mentions Atlas) and `<brain-context>`.
- [ ] `/wrap` in that session → `~/AgenticOS/brain/memory/` gains at least one file and `MEMORY.md` one line.
- [ ] In a new session: `use the agenticos recall tool to search for "Atlas"` → the `recall` tool of the `agenticos` MCP server — exposed to Claude Code as `mcp__plugin_agenticos_agenticos__recall` (contract §0) — answers (hits or an empty result, no error).
- [ ] Open `~/AgenticOS` in Obsidian (File → Open vault → Open folder as vault); enable community plugins when asked; the Agentic OS HUD opens; no Pulse LED is red. Gray "disabled" for auto-cost and embeddings is correct, and amber `stale` is expected for any stage whose last run has aged out — `scan-vault`, `build-brain-md` and the heartbeat go stale 45 minutes after they ran, so any pause between §1 and this box turns them amber. Only red is a failure.

## 2. Ollama auto-switch (criterion 2)
`aos status` only reads the cached `brain/_index/provider-state.json` and never probes; `aos scan-vault --quiet` resolves the provider and rewrites that file, so run it before every status check below.
- [ ] Install Ollama (ollama.com), then pull the two default tags — `ollama pull qwen3.5:9b && ollama pull qwen3-embedding:0.6b` (workhorse, embedder; `brain/scripts/sdk/lib/models.js` is the source of truth if they change) — and keep `ollama serve` running. The reasoner is a Claude model and needs only the Claude login.
- [ ] Without editing any file: `aos scan-vault --quiet && aos status` shows provider `ollama`.
- [ ] End a Claude Code session; within a minute `~/AgenticOS/brain/_index/pipelines.json` shows `auto-wrap` with `"provider": "ollama"` and status `ok`.
- [ ] Stop Ollama; after 60 s, `aos scan-vault --quiet && aos status` shows `claude` (or `none` if not logged in).

## 3. Privacy gate (criterion 3)
- [ ] `cd ~/AgenticOS-Workbench && npm run gate` → `privacy-gate: 0 violation(s)`, and `node tools/privacy-gate.js --json` prints `[]`. This is the pass condition: the gate scans every tracked and untracked-not-ignored file for every term `tools/privacy-terms.js` loads (the public `tools/privacy-terms.json` plus the maintainer's private list; `npm run gate -- --require-private` fails when the private list is missing).
- [ ] Cross-check the exception table: `cat tools/privacy-exceptions.json` shows exactly five rows — the three gate data files (term `*`) plus the two example-agent-name exceptions spec §8.3 allows, for `cli/aos.js` and `docs/chief-of-staff.md` — and nothing else; a sixth row blocks the release. (The launcher and the CLI probe `$HOME`-relative node paths, and the GitHub source `zzoretich/AgenticOS-Workbench` — in `plugin/.claude-plugin/plugin.json`, `cli/aos.js`, `cli/aos.test.js`, `docs/install.md` and this file — is not a term, so none of those needs a row.)
- [ ] GitHub Actions: the `ci` run for the release commit (it runs on every push to `main` and every pull request, on Ubuntu and macOS) shows its gate step green on both OSes; the `release` run for the `v*` tag (Ubuntu only) shows its own gate step green.

## 4. Test suites offline (criterion 4)
- [ ] Turn Wi-Fi off. `npm test` → three aggregates, each `ℹ fail 0`: tools+cli, brain (`brain/scripts`), plugin (`obsidian-plugin`).
- [ ] Note: `cli/plugin-manifests.test.js` skips its `claude plugin validate` case whenever `claude` is not on PATH (this is what every hosted CI runner does, so the same case shows as skipped in Actions). §0 installed Claude Code here, so on this account the case runs instead of skipping; a `skipped` line for it means PATH, not a failure.
- [ ] `(cd extras/cost && python3 -m unittest 2>&1 | /usr/bin/grep -E "^(Ran|OK|FAILED)")` → `Ran <n> tests` with **n ≥ 1** and `OK` (the exact `<n>` drifts between releases; `Ran 0 tests` also prints `OK` on macOS system python, so a zero count means discovery broke and is a failure; `FAILED` is the other failure).
- [ ] Turn Wi-Fi on.

## 5. Uninstall (criterion 5)
- [ ] `node ~/AgenticOS-Workbench/cli/aos.js uninstall --keep-vault` (no prompt — `--keep-vault` never asks; it prints `kept vault …`).
- [ ] `ls ~/.claude` shows no `agenticos.json`; `plugins/` survives (Claude Code's own plugin cache — the plugin install created it, and uninstall removes the plugin through `claude` but never that directory); `claude plugin list` no longer lists `agenticos`; `ls ~/Library/LaunchAgents | grep agenticos` prints nothing; `launchctl list | grep com.agenticos` prints nothing. (Claude Code's own per-session folders — `session-env/`, `file-history/`, `projects/` — are not AgenticOS's and stay.)
- [ ] `~/AgenticOS` is intact (memory, persona, notes present).
- [ ] `cd ~/AgenticOS-Workbench && npm run setup -- --yes` (no prompts: with `--yes` the interview reuses the kept vault's `persona/answers.json`, so the persona — and its schedules — come back without questions), then `aos uninstall` **without** `--keep-vault`. The prompt reads `Type the vault path to DELETE it, anything else keeps it (<vault>): ` and shows the **absolute** path — type that back exactly as printed (typed at the prompt only — never pasted into the release PR), not the `~/AgenticOS` form used elsewhere in this runbook; anything else keeps the vault. Afterwards `~/AgenticOS` is gone.

## 6. Cost module and persona commands (spec §10–11)
§5 removed the vault, so re-install first: `cd ~/AgenticOS-Workbench && npm run setup`, answering the interview exactly as in §1 (schedule `yes`); `aos doctor` exits 0.
- [ ] `aos cost enable --budget 100` → prints `cost: enabled (python3 <version>); analyzer installed at <vault>/brain/scripts/cost; monthly budget $100`; `ls ~/AgenticOS/brain/scripts/cost` shows exactly the three files `analyze_transcript.py pricing.json report-template.html`; `grep monthlyBudget ~/AgenticOS/brain/config.json` shows 100.
- [ ] End a Claude Code session; `pipelines.json` shows `auto-cost` status `ok`; `node ~/AgenticOS/brain/scripts/cost-budget.js` prints a MONTH-TO-DATE line with `/ $100.00`.
- [ ] `aos cost disable` → next session end shows `auto-cost` status `disabled`.
- [ ] `sh ~/AgenticOS/brain/scripts/persona/run-duty.sh monitor --dry-run` prints the invocation one argv element per line, including `--model`, `--effort` followed by `medium` on the next line, and `--max-budget-usd`.
- [ ] `sh ~/AgenticOS/brain/scripts/persona/run-duty.sh monitor` (real run, costs a few cents — the repo's `cli/fixtures/fake-claude.sh` prints nothing for `-p`, so this live run is the only end-to-end proof of a duty): the journal `~/AgenticOS/persona/journal/<today>.md` gains a `duty: monitor` entry; `~/AgenticOS/brain/_index/provider-spend.jsonl` gains a row with `"feature":"duty:monitor"`; `STATE.md` `## Last Duty Runs` shows `monitor: <today>`; `node ~/AgenticOS/brain/scripts/persona/record-spend.js --check` prints `"allowed":true` with `"perDayUsd":6`.
- [ ] `aos persona rename Beacon` → `head -8 ~/AgenticOS/persona/IDENTITY.md` shows `# Beacon`; `grep -c Beacon ~/Library/LaunchAgents/com.agenticos.monitor.plist` = 1.
- [ ] `aos persona off` → a new Claude session shows no `<persona>` block; `aos persona on` restores it.
- [ ] In Claude Code: say `sitrep` (the `persona-sitrep` skill — also reachable as `/agenticos:persona-sitrep`; there is no `/sitrep` command) → it renders the Output shape with one recommended action; `review persona flags` (the `persona-flag-closer` skill) either reports `Nothing pending — no proposals, no flags, no new failures.` or lists whatever the monitor duty flagged. Both pass: the live run in the box above rewrote `STATE.md`, so its `## Flags` may legitimately hold open items (a duty that failed leaves a FAILED flag there).

## 7. Obsidian smoke under each provider
- [ ] With Ollama running: Pulse, Spaces, Memory, Runs, Chat (answers), Term (shows "Terminal unavailable" unless `--terminal` was used) all render.
- [ ] With Claude logged in (Ollama running or not): Chat's header names the reasoner — `claude (claude-opus-5, capped)` — each answer shows a per-message cost, and `aos status` counts it on the `(reasoner)` line.
- [ ] `aos provider none`: Chat tab hidden with the hint; nothing red.

Result: ______ (pass / fail with the failing box numbers). Tester: ______ Date: ______
