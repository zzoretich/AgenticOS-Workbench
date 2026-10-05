# Security

## Reporting a vulnerability

Please do not put the details of a vulnerability in a public issue. Open an issue titled "Security contact", with no
details, and the maintainer will reply with a private way to send the report.

AgenticOS runs on your own Mac, with your own permissions: the runtime and its hooks run as you, the AgenticOS
Workbench app reads and writes your vault, and the agents it starts (Claude Code, Codex) act as you within their own
permission settings. What follows is how the app keeps what it displays from becoming what it runs.

## The app: how it is built to be safe

The Workbench shows text it did not write: notes, proposals, notifications whose stories come from the web, and agents'
output. The design treats the page that shows them as untrusted (design D7,
`docs/superpowers/specs/2026-10-05-workbench-app-design.md`; plan `docs/superpowers/plans/2026-10-05-sandbox-renderer.md`).

- **Nothing in the page can run code it was handed.** The page loads only the app's own files from `app://hud`, under a
  Content Security Policy that allows only those scripts (`script-src 'self'`, no inline script, no `eval`). Markdown is
  rendered with raw HTML off and sanitized by DOMPurify.
- **The page has no access to your Mac.** It runs in Chromium's sandbox with context isolation and no Node. Its only way
  out is `window.aos`, a short list of named functions (`app/src/preload/index.ts`). Main answers only the main window's
  own page, checks every argument against a schema, and answers each call with a result rather than an error.
- **Main decides every call** (`app/src/main/policy/`):
  - *Reads:* the vault, `~/.agents`, `~/Library/LaunchAgents`, `/etc/shells`, the app's own data, and of the Claude
    Code and Codex folders that `agenticos.json` and the environment name only what the Workbench shows:
    `agenticos.json`, skills, agents, commands and prompts. The session folders may be listed, to find out whether a
    transcript exists, but no transcript is read. Never a credential file (`auth.json`, `.credentials.json`, `.env`,
    keys), wherever it is. Whether a program exists may be asked by its well-known name (`node`, `claude`, a shell)
    anywhere, for the pickers that look for them.
  - *Writes:* only what a Workbench surface writes (`app/src/shared/surfaces.ts`): To-Do writes `TODO.md`, Capture writes
    memories, and so on. Files and the note editor write anywhere in the vault except the runtime's folders
    (`brain/_index`, `brain/scripts`), dependency folders and every dot-path, so no page can plant a host's project
    configuration (`.claude/settings.json` hooks, `.mcp.json`, `.codex/`, `.git/hooks`). The page cannot create links or
    change a file's permissions.
  - *Processes:* only the runtime's own commands, each with an argument rule (a background refresh, or a command of a
    surface that is on), never through a shell. The program is a bare name main finds on its own `PATH`, or an
    executable outside the vault and the app's data, which the page cannot create. The child's environment is main's,
    plus a few named variables with fixed or trusted values: never `NODE_OPTIONS`, `PATH` or `DYLD_*`, and a Claude
    or Codex folder only when it is one main trusts.
  - *Terminals:* a shell listed in `/etc/shells` (or your `$SHELL`), with no arguments.
  - *The OS:* links open in the browser over https only. A document or a folder opens with its app; a file that would
    run when opened (a script, a `.terminal` or `.command` file, an app or other bundle), or a web page anywhere but the
    runtime's own proposal pages, is shown in Finder instead. A folder is never deleted for good: it goes to the
    Trash, and the runtime's folders (`brain/_index`, `brain/scripts`) are never moved, trashed or removed.
- **Packaged builds cannot be driven from outside.** The fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and
  `--inspect`, and the archive is integrity-checked. Chromium's remote debugging has no fuse, so a release build refuses
  to start with `--remote-debugging-*`, `--inspect*` or `--js-flags` (`app/src/main/policy/debug.ts`;
  `npm run dist:verify` checks it). Releases are signed with a Developer ID under the hardened runtime and notarized.

## What the design accepts

| Risk | Why it stays | What limits it |
|---|---|---|
| The Terminal tab is a shell | It is the feature: what you type runs as you. A compromised page could type into a terminal it opens | Nothing in the page can run code (CSP, sanitized Markdown, no remote content), so a page must first be compromised; the terminal starts only a listed shell |
| The page can do what the Workbench's buttons do | Routines run agent prompts, Settings changes settings, Agent Teams approves gates | Each is a named command with an argument rule; nothing outside the surfaces runs |
| Links you made inside the vault are followed | Checks are on the vault's paths; a workspace linked to a code folder is read and written through the link, as you set it up | The page cannot create links |
| An https link can carry data out | Notifications link to the web; the browser shows every link it opens | Opening is visible; the page has no network access of its own (`connect-src 'self'`) |

## Review: phase 4 (Electron hardening checklist)

Done for phase 4 against Electron's security checklist (the Dev team's `dev-electron-hardening` audit and its
`dev-electron-ipc` pattern), then by an independent reviewer with no part in building it, who attacked the bridge as a
page with script running in it would. Evidence is from the branch that sandboxed the page; packaged checks ran on a
release-configured build (`npm run dist:verify`) and the smoke build (`npm run smoke:packaged`).

| # | Check | Status | Evidence |
|---|---|---|---|
| 1 | Only secure content | pass | `app/src/main/index.ts:231` loads `app://hud/index.html`; `app-scheme.ts` serves only `out/renderer` |
| 2 | No Node integration | pass | `index.ts:193-194` `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`; `sandbox.spec.ts` finds no `require`, `process`, `Buffer` |
| 3 | Context isolation | pass | `index.ts:195` |
| 4 | Sandbox | pass | `index.ts:196`; `sandbox.spec.ts` reads the page's live preferences |
| 5 | Permission requests | pass | `index.ts:225` grants only `clipboard-sanitized-write` |
| 6 | `webSecurity` | pass | on, set explicitly |
| 7 | Content Security Policy | pass | built `out/renderer/index.html`: `script-src 'self'`, no inline script, no `unsafe-eval`, `object-src 'none'`, `connect-src 'self'` |
| 8 | No insecure content | pass | `allowRunningInsecureContent: false` |
| 9, 10 | No experimental or Blink features | pass | not set |
| 11, 12 | `<webview>` | n.a. | `webviewTag: false` |
| 13 | Navigation | pass | `index.ts:218, 223`: every navigation is prevented (an https link goes to the browser) |
| 14 | New windows | pass | `index.ts:209-217`: only the blank tray popover; anything else is denied |
| 15 | `openExternal` | pass | https only (`policy/shell.ts` `externalAllowed`); the menu's one fixed link |
| 16 | A current Electron | pass | 44.4.5, the current major (44.5.1 is out: note, take it with the next release) |
| 17 | IPC sender and arguments | pass | every handler goes through `ipc/trust.ts:33-48`: main window, main frame, `app://hud`, then a zod schema (`ipc/schemas.ts`) |
| 18 | Custom protocol | pass | `app-scheme.ts:39-44`, `protocol.handle` |
| 19 | Fuses | pass | `dist:verify` reads them from the packaged app: `runAsNode` off, `NODE_OPTIONS` off, `--inspect` off, archive integrity on, only from the archive, no `file:` privileges |
| 20 | No Electron APIs exposed | pass | `preload/index.ts:64` exposes named functions only; `sandbox.spec.ts` checks the shape |
| | Secrets in code or history | pass | the repository's privacy gate on every commit and in CI |
| | Injection sinks | pass | no `innerHTML`, `eval` or `new Function` in the page's code; Markdown with raw HTML off, then DOMPurify |
| | Entitlements | pass | `allow-jit`, and `apple-events` with its reason (`electron-builder.yml:44`: a command in the terminal may control another app) |
| | Production dependencies | pass | `npm audit --omit=dev`: 0 vulnerabilities |
| | Remote debugging of a release | pass | `policy/debug.ts`; `dist:verify` starts the release with `--remote-debugging-port`: it exits 1 before anything listens |

The independent review found no critical or high issue. Its findings, and what became of them:

| Finding | Severity | Outcome |
|---|---|---|
| A recursive remove of a writable folder (`brain`) took the runtime's folders with it | medium | fixed: main never removes a folder (the Files tab sends folders to the Trash), and never moves or trashes `brain/_index`, `brain/scripts` or a folder above them |
| Credential files were refused by name only, inside whole host folders (an IDE lock file there carries a token) | medium | fixed: of the hosts' folders the page reads only `agenticos.json`, skills, agents, commands and prompts; it may list the session folders to find a transcript, never read one |
| Whether a program exists can be asked anywhere by its name (`…/node`) | low | accepted: the node, claude and shell pickers need it, and the answer is one bit about a path ending in a program's name |
| Chat's `claude -p` takes the page's question and per-call cap | low | accepted: what the Chat tab's button does; the cap is the user's setting, which the Settings tab can change too |
| A web page the page wrote could open in the browser | low | fixed: `.html` and `.svg` open only from `brain/_index` (the runtime's proposal pages), else Finder shows them |
| Links already in the vault are followed | note | accepted (above) |
| The debugging switches are a list | note | fixed: `--inspect-wait` added; the inspector fuse is off, which `dist:verify` checks |

**Verdict: SECURED with notes** — 0 critical, 0 high, 0 medium open; 2 low and 1 note accepted, as recorded above.
