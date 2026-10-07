# UniDeX phase 2: agent sessions in the centre

**Date:** 2026-10-07
**Status:** proposed design, awaiting approval; on `docs/unidex-sessions-spec`
**Scope:** real Claude Code and Codex sessions inside UniDeX. A session belongs to a workspace (a repo under
`<vault>/workspaces/`). It runs turn by turn on the host you pick, and shows its replies, tool rows and file changes as
they happen. When the work is done you review the diff and commit it from the app. Phase 1
(`2026-10-07-unidex-redesign-design.md`) left room for this in the centre of the app (§4.1, §6).

---

## 1. Problem

- **Chat answers questions about the vault, and that is all.** `runClaudeAsk` runs `claude -p … --tools ""` in the
  vault (`obsidian-plugin/src/data/claudeAsk.ts:64-77`). There is one thread, no tools, no repo and no Codex path.
- **Coding happens in a terminal.** The app can open a shell in a workspace (Spaces ▸ terminal here), but the session in
  it is invisible to the app: no tool rows, no diff, no spend, no run record.
- **Neither host's session shows up in Runs.** Chat and terminal sessions write no `agent-runs` record. Only `ask.js`
  and team seats do.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| S1 | **One process per turn, continued by the host's own resume.** Claude: the first turn passes `--session-id <uuid>` (the app picks the uuid), later turns `--resume <uuid>`. Codex: `codex exec --json … <prompt>`, later `codex exec resume <id> <prompt>`. Both take the prompt as an argument, so nothing needs stdin (the app's spawns have none, `app/src/main/services/proc.ts:49`). | A long-lived `--input-format stream-json` process: Claude only, and a crash loses the turn. Typing into a pty: unparseable output, and the host's TUI in a view. |
| S2 | **The runtime builds the argv: a new `sessionArgs(host, opts)` in `brain/scripts/lib/headless.js`**, beside `runnerArgs`, `crossArgs` and `seatArgs`, with a test per host. The app asks the vendored runtime for argv; it never hard-codes a flag. | Flags in the app: breaks the host seam (one place per host) and drifts from routines and seats. |
| S3 | **A main-process session service, not the page's generic `proc:spawn`.** New channels `session:start`, `session:send`, `session:stop`, `session:list` and the event `session:event`, each with a zod schema, behind a new `sessions` surface. The page sends intents (workspace, host, text) and never an argv. | Widening `proc:spawn` with stdin and free argv: the page could then run any agent with any flags. |
| S4 | **Sessions run only in `<vault>/workspaces/<slug>`.** This is today's cwd rule (inside the vault, `policy/programs.ts:45-51`) narrowed to the workspace folders Spaces already lists. | Any folder on disk: widens the spawn policy for little gain. A repo elsewhere can be cloned into `workspaces/`. |
| S5 | **What an agent may do.** Claude: `--permission-mode acceptEdits` (edits are allowed; Bash is off unless the session's **Allow commands** switch adds `--allowedTools Bash`). Codex: `-s workspace-write` (edits and sandboxed commands, no network). With **Allow commands** off, Codex runs `-s read-only` plus edits through `apply_patch`; whether its sandbox allows that is checked in PR 2a, otherwise the switch stays on for Codex and the gap is shown. | Bypass or `danger-full-access` modes: an unattended agent with the network and the whole disk. Prompting for every tool: headless runs cannot answer prompts. |
| S6 | **Budgets: a new family, `sessions.perTurnUsd` (default 1.00) and `sessions.perDayUsd` (default 10.00).** The day cap is checked before each turn. Claude also gets `--max-budget-usd <perTurn>`; Codex spend is estimated from its `token_count` events, as for routines. Spend is recorded as `session:<host>` in `provider-spend.jsonl`. | The `reasoner.*` caps: Chat's per-question budget is far too small for coding. No cap: one runaway turn could spend a day's money. |
| S7 | **One event shape for both hosts, normalised in the runtime**: a new `brain/scripts/lib/session-events.js` maps Claude `stream-json` (extending `mapSdkMessage`, `sdk/lib/telemetry.js:69`) and Codex `--json` events to `{text, tool, tool_result, patch, usage, done, error}`. Tool kinds reuse `transcript.js`: edit, read, bash, mcp, other. | Parsing in the page: two parsers in TypeScript, and the page cannot read transcripts (`policy/read-scope.ts:65-70`). |
| S8 | **Threads are stored in `brain/_index/sessions/<slug>/<thread>.jsonl`**: the normalised events plus the host's session id. Each turn also writes an `agent-runs` record, so Runs shows it. The host's own transcript stays the source of truth for resume. | Files in the workspace: they would show in the repo's `git status`. Reading host transcripts from the page: forbidden today, and it should stay so. |
| S9 | **Diff and commit go through a main-side git service.** `git:status` and `git:diff` read the workspace repo (read-only). `git:commit` runs `git add -A && git commit -m <message>` only on the **Commit** button, with a message the user can edit (the agent proposes one). There is no push. | Letting the agent commit: hosts behave differently, and you lose the review gate. A push button: credentials and remotes are out of scope. |
| S10 | **Layout: the Chat tab becomes Sessions.** The list pane shows threads grouped by workspace, with **Vault** first (today's Q&A chat, unchanged). The header reads `workspace › thread title · host chip`. The timeline shows your prompts, the agent's text, and collapsed tool rows. A diff card shows `N files changed +a −b · Review · Commit`. The composer offers host (ready and enabled hosts only), model, workspace and **Allow commands**. Home stays this tab. | A new tab beside Chat: two composers with different powers is confusing. Threads inside Spaces: Spaces is about the workspace, not the work. |
| S11 | **Stop** sends SIGTERM, then SIGKILL after 10 s, as team seats do (`lib/team-run.js`). A stopped turn is recorded as `stopped`, and the thread can be resumed. | No stop: a long turn can only be killed from Activity Monitor. |
| S12 | **Three PRs: 2a runtime, 2b app service, 2c UI.** Release 1.2.0 after the last one. | One PR: an unreviewable diff across three trees. |

## 3. What already exists (verified at `462bbe7`)

- **`headless.js`**: `runnerArgs` (Claude `-p … --output-format json --no-session-persistence`; Codex `exec - --ephemeral -s workspace-write --json`, prompt on stdin), `seatArgs` (cwd via `-C`, Claude `--permission-mode auto`) and `resolveBin` / `hostEnabled`. No mode streams or resumes. The callers spawn and stop the process themselves (`team-run.js`: SIGTERM, then SIGKILL).
- **`provider.js`**: caps checked before each call (`claude.*`, `codex.*`, `reasoner.*`, `persona.*`, `routines.*`, `crossReview.*`), with spend in `brain/_index/provider-spend.jsonl` by feature family.
- **`transcript.js`**: Claude and Codex transcripts parse to one shape `{turns, toolUses, usage, prompts, meta}`, with tool kinds edit, read, bash, mcp, other. `sdk/lib/telemetry.js:69 mapSdkMessage` maps Claude stream messages but is not exported.
- **The app**: the page is sandboxed with no Node, and every call is zod-checked (`ipc/trust.ts`, `ipc/schemas.ts`). `proc:spawn` gives no stdin and refuses a cwd outside the vault. Surfaces pin exact argv (`shared/surfaces.ts`). Ptys allow a bare login shell only. Host session folders are list-only.
- **Workspaces**: Spaces lists `workspaces/*` with per-host session **counts** (`collectors/workspaces.js`, `hostSessions.js`), but not the sessions themselves.
- **Runs**: `agent-runs/runs.jsonl` and `live/<id>.ndjson` (polled by `liveRuns.ts`) come from `ask.js` and team seats only.
- **Git**: none in the app or the HUD. The runtime has diff, status and worktree helpers in `cross-review/runner.js` and `team-run.js`.

## 4. Design

### 4.1 A turn, end to end

1. **The page** calls `session:send({ thread, text })`, or `session:start({ workspace, host, model, allowCommands, text })` for a new thread.
2. **Main checks** the `sessions` surface, the workspace (it must be `workspaces/<slug>` with a real directory) and the day cap.
3. **Main gets the argv** by running the vendored `headless.js --session-args <json>`, which returns `{ bin, argv, env }` for that host, and spawns it with cwd = the workspace.
4. **Main streams the output**: it pipes stdout to the runtime's `session-events.js` (a long-lived Node child, or a require through the payload's runtime path), appends each event to the thread file and the run's `live/` file, and forwards it on `session:event`.
5. **When the process exits**, main writes `done` with usage and cost, appends the spend ledger row and the `runs.jsonl` record, and asks `git:status` to refresh the diff card.

### 4.2 The host-neutral event

`{ t, kind, text?, tool?: {name, kind, input, filePath?}, result?: {ok, summary}, patch?: {files}, usage?: {in, out, usd, estimated}, error? }`.
- **Claude** (`stream-json --verbose`): `assistant` text blocks become `text`, `tool_use` becomes `tool`, `tool_result` becomes `tool_result`, and `result` becomes `usage` and `done`.
- **Codex** (`--json`): `agent_message` becomes `text`, `exec_command_begin/end` becomes `tool`/`tool_result` with kind bash, `patch_apply_end` becomes `patch`, and `token_count` becomes `usage` (estimated).

### 4.3 Storage and runs

- **Thread file**: `brain/_index/sessions/<slug>/<thread>.jsonl` (a cache, gitignored like the rest of `_index`). Its first line is `{schema, host, hostSessionId, model, created, title}`, and the events follow.
- **Runs**: each turn is a run, `{feature: "session", host, workspace, thread, usd, status}`, so the Runs tab and its drawer list it with no change to the tab.

### 4.4 Diff and commit

- **Reads**: `git:status` and `git:diff` run `git -C <workspace> status --porcelain=v2` and `git diff --stat` / `git diff <file>` in main, capped at 2 MB. The page shows the stat in the card and a file's diff in the reading pane.
- **Commit**: `git:commit({ workspace, message })` refuses an empty message, a detached HEAD, or a repo with a merge in progress.

### 4.5 The UI (`obsidian-plugin/src/views/SessionsTab.ts`, replacing `ChatTab.ts`)

It is built on `.aos-split` with the phase 1 tokens. The reader is the timeline and the composer sits at its foot. Tool rows are collapsed to one line (`kind · name · file`) and open to their input and result. Live turns stream into the open thread, and other threads show a running dot in the list.

## 5. Host parity

1. **Entry point.** The Sessions tab in the app; no new command, skill or verb. Both hosts are offered when ready and enabled.
2. **Hooks.** None new. A session runs with the host's hooks off (`AOS_HEADLESS=1`, Codex `-c features.hooks=false`), as routines do, so the brain hooks do not capture the app's own turns twice.
3. **Model calls.** Through `headless.js` `sessionArgs` only, with the cap of §S6.
4. **Session data.** Only the thread file the app writes. Host transcripts are still never read by the page.
5. **MCP.** Claude runs `--strict-mcp-config` with the vault's agenticos server; Codex uses `codexMcpServers`. Both get the same tools.
6. **Degradation.** A host that is not ready is greyed out in the composer with the reason. With no ready host, the tab shows Vault chat only, with the setup hint.
7. **Docs.** README (Sessions), `app/README.md`, `SECURITY.md` (an agent edits files in a workspace repo; the `sessions` surface; budgets), and app-smoke items per host with their `COVERAGE.md` rows.

| Mode | How the user invokes it | What runs | What they see if it can't |
|---|---|---|---|
| Claude Code only | Sessions ▸ new thread in a workspace | `claude -p --session-id/--resume --output-format stream-json --permission-mode acceptEdits` | the Codex chip disabled ("Codex is off on this machine") |
| Codex only (plugin · direct) | the same | `codex exec --json -C <ws> -s workspace-write` / `exec resume` | the Claude chip disabled; Vault chat routes as today |
| Both | the same, with a host chip per thread | the chosen host, fixed for the thread | — |

**Gap (S5):** with **Allow commands** off, Codex may not be able to edit under `read-only`. If PR 2a confirms that, Codex threads keep commands on in its sandbox, and the switch shows "Codex runs commands in its sandbox".

## 6. Testing

- **Runtime**: `sessionArgs` and `session-events` have a test per host, with fixtures from recorded `stream-json` and `--json` runs (no network).
- **App**: the session service against fake `claude`/`codex` scripts that replay those fixtures (the `installSetupStubs` precedent). Git ops are tested on a temp repo. e2e covers a full turn, Stop, the diff card, Commit, the day cap and a Codex-only vault.
- **Live**: before release, one turn per host on a real workspace (it spends; ask first).

## 7. Out of scope

- Repos outside `workspaces/`, push and PR creation, several turns at once in one thread, approving each tool call, and a worktree per thread (team seats have one; later).
- Showing sessions that ran in a terminal or another app: their transcripts stay unread.
