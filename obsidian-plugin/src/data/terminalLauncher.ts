// terminalLauncher.ts — starting terminals from the Term tab (spec 2026-10-08-term-agent-deck T2–T11). The decisions are
// pure, in terminalLaunch.ts; this does the rest through the HudHost: it lists the workspaces and their linked code
// folders, makes Scratch and new workspaces (the folder and the stubs through HostFs, which the Files surface admits),
// starts the terminal, types the agent's line into it, remembers the choice, and tells the panel what it started.
import * as path from "path";
import type AgenticOSPlugin from "../../main";
import { env, fs } from "../host";
import { claudeConfigDir as envClaudeConfigDir, readAgenticosJson, readProviderState } from "./aosConfig";
import { modelArg, workspaceNames } from "./agentSessions";
import { envPrefix } from "./teams";
import { shq } from "./skills";
import type { TerminalSession } from "./terminalSession";
import {
  SCRATCH, TERM_HOST_LABEL, gitInitWanted, homePlace, launchLine, parseRepoLink, placeOf, previewLine, quickHost,
  repoValue, resolvePlace, scratchStubs, slugify, stubWrites, termHostChoices, vaultPlace, withRepoLink, workspaceNameProblem,
  workspacePlace, workspaceStubs,
} from "./terminalLaunch";
import type { LaunchSpec, Place, PlaceWhy, PlaceWorld, TermAccess, TermHost, TermHostChoice } from "./terminalLaunch";
import { rememberTerminalChoice, sanitizeSessionChoice, sanitizeTerminalChoice } from "../settingsDefaults";
import type { TerminalChoice } from "../settingsDefaults";

/** What a launch asks for: the host, and a place when one was picked; otherwise the context or the default decides. */
export interface LaunchRequest {
  host: TermHost;
  picked?: Place | null;
  context?: Place | null;
  /** Continue the last conversation in that place instead of starting one (⇧Enter in the menu). */
  resume?: "last" | null;
  /** Type `git init` first (a new workspace whose box is ticked). */
  gitInit?: boolean;
  /** What started it when it was not the deck (a skill's button…): such launches never change the remembered host. */
  origin?: string | null;
}

export interface Launched {
  session: TerminalSession;
  place: Place;
  why: PlaceWhy;
}

/** What the panel shows for six seconds after a launch: "Started Claude Code in Scratch · Change". */
export interface LaunchNote { id: string; text: string; why: PlaceWhy; host: TermHost }

export class TerminalLauncher {
  constructor(private plugin: AgenticOSPlugin) {}

  private vault(): string { return this.plugin.vaultRoot(); }
  private home(): string { return env.homedir(); }
  private workspacesDir(): string { return path.join(this.vault(), "workspaces"); }

  /** The workspaces a terminal may start in, and their linked code folders, read from disk each time (cheap). */
  world(): PlaceWorld {
    const vault = this.vault();
    let names: string[] = [];
    try {
      names = workspaceNames(fs.readdirSync(this.workspacesDir(), { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name));
    } catch { /* no workspaces/ yet */ }
    const links: Record<string, string> = {};
    for (const n of names) {
      try {
        const repo = parseRepoLink(fs.readFileSync(path.join(this.workspacesDir(), n, "workspace.md"), "utf8"), this.home(), vault);
        if (repo) links[n] = repo;
      } catch { /* no workspace.md */ }
    }
    return { vault, home: this.home(), workspaces: names, links };
  }

  /** The remembered Term choice, sanitized. */
  choice(): TerminalChoice { return sanitizeTerminalChoice(this.plugin.settings.terminalChoice); }

  /** Remembers an access level or a default place picked in the menu. */
  remember(patch: { access?: TermAccess; agentPlace?: TerminalChoice["agentPlace"] }): void {
    this.plugin.settings.terminalChoice = rememberTerminalChoice(this.plugin.settings.terminalChoice, patch);
    void this.plugin.saveSettings();
  }

  /** The model a launch of `host` passes, in words: the one remembered from Sessions, else the host's default. */
  modelLabel(host: "claude" | "codex"): string {
    return modelArg(host, sanitizeSessionChoice(this.plugin.settings.sessionChoice).models[host]) ?? (host === "claude" ? "Default model" : "Codex default");
  }

  /** The hosts a launch may use, read fresh (a login or `aos init --host` while the app runs shows up at once). */
  choices(): TermHostChoice[] {
    return termHostChoices(readAgenticosJson(this.plugin.claudeConfigDir()), readProviderState(this.vault()));
  }

  /** The host ⌘T starts, or why it cannot (the menu then opens with the reason). */
  quickHost(): { host: TermHost | null; reason: string | null } {
    return quickHost(sanitizeTerminalChoice(this.plugin.settings.terminalChoice).host, this.choices());
  }

  /** Where shells start when nothing is picked: the Working directory setting, else the vault. */
  shellDefault(w = this.world()): Place {
    const cwd = this.plugin.settings.terminalCwd;
    if (!cwd) return vaultPlace(w);
    return path.resolve(cwd) === path.resolve(w.home) ? homePlace(w) : placeOf(cwd, w);
  }

  /** Where a launch of `host` lands, and why. */
  resolve(host: TermHost, picked?: Place | null, context?: Place | null): { place: Place; why: PlaceWhy } {
    const w = this.world();
    const choice = sanitizeTerminalChoice(this.plugin.settings.terminalChoice);
    const last = choice.recent.find((n) => w.workspaces.includes(n));
    return resolvePlace({
      host, picked, context, agentPlace: choice.agentPlace,
      lastWorkspace: last ? workspacePlace(last, w) : null,
      scratch: workspacePlace(SCRATCH, w), vault: vaultPlace(w), shellDefault: this.shellDefault(w),
    });
  }

  /** The agent line a launch would type, before the session id is known (the menu's preview). */
  spec(host: "claude" | "codex", opts: { resume?: "last" | null; gitInit?: boolean; sessionId?: string | null } = {}): LaunchSpec {
    const cfg = readAgenticosJson(this.plugin.claudeConfigDir());
    const bin = this.choices().find((c) => c.host === host)?.bin ?? null;
    const model = modelArg(host, sanitizeSessionChoice(this.plugin.settings.sessionChoice).models[host]);
    const access = sanitizeTerminalChoice(this.plugin.settings.terminalChoice).access as TermAccess;
    // The folder each host uses, set on the line only when a new terminal would find another (AgentTeamsTab.hostEnv).
    const envCodex = path.resolve(env.get("CODEX_HOME") || path.join(this.home(), ".codex"));
    const prefix = host === "claude"
      ? envPrefix("CLAUDE_CONFIG_DIR", this.plugin.claudeConfigDir(), envClaudeConfigDir())
      : envPrefix("CODEX_HOME", cfg?.hosts?.codex?.home || envCodex, envCodex);
    return { host, bin, model, access, resume: opts.resume ?? null, gitInit: opts.gitInit, sessionId: opts.sessionId ?? null, envPrefix: prefix };
  }

  /** What the menu previews for a launch of `host`: the short command, or a shell's note. */
  preview(host: TermHost, opts: { resume?: "last" | null; gitInit?: boolean } = {}): string {
    if (host === "shell") return opts.gitInit ? "git init -q (then your shell)" : "a new shell: nothing is typed";
    return previewLine(this.spec(host, { ...opts, sessionId: host === "claude" && !opts.resume ? "new-id" : null }));
  }

  // ── folders ──

  /** Whether a new workspace (or Scratch) gets its own git repo by default (T7). */
  gitDefault(slug: string): boolean {
    const vault = this.vault();
    let gitignore: string | null = null;
    try { gitignore = fs.readFileSync(path.join(vault, ".gitignore"), "utf8"); } catch { /* none */ }
    return gitInitWanted(fs.existsSync(path.join(vault, ".git")), gitignore, slug);
  }

  /** Makes workspaces/<slug> with its stubs (or adds the missing ones). Throws when file writes are off. */
  private ensureFolder(slug: string, stubs: Record<string, string>): { dir: string; created: boolean } {
    const dir = path.join(this.workspacesDir(), slug);
    const created = !fs.existsSync(dir);
    if (created) fs.mkdirSync(dir, { recursive: true });
    for (const w of stubWrites(stubs, (n) => fs.existsSync(path.join(dir, n)), (n) => fs.readFileSync(path.join(dir, n), "utf8"))) {
      fs.writeFileSync(path.join(dir, w.name), w.data);
    }
    if (created) this.refreshSpaces();
    return { dir, created };
  }

  /** Scratch, made on first use; whether its first agent should start a repo there. */
  private ensureScratch(): { gitInit: boolean } {
    const { dir } = this.ensureFolder(SCRATCH, scratchStubs());
    return { gitInit: !fs.existsSync(path.join(dir, ".git")) && this.gitDefault(SCRATCH) };
  }

  /** Spaces lists workspaces from the snapshot: rebuild it so a new one appears there (Sessions reads the disk). */
  private refreshSpaces(): void {
    this.plugin.runBrainScript("brain/scripts/scan-vault.js", ["--quiet"], undefined, { quiet: true });
  }

  /** Why `name` cannot be a new workspace, or null; an existing one is not a problem (the sheet offers to open it). */
  nameProblem(name: string): string | null { return workspaceNameProblem(name); }
  exists(name: string): boolean { const s = slugify(name); return !!s && fs.existsSync(path.join(this.workspacesDir(), s)); }

  // ── launching ──

  /** Starts a terminal: makes Scratch when it lands there, types the agent's line, selects it and shows Term. */
  async launch(req: LaunchRequest): Promise<Launched> {
    let { place, why } = this.resolve(req.host, req.picked, req.context);
    let gitInit = !!req.gitInit;
    let aside: string | null = null;
    if (place.kind === "scratch" && req.host !== "shell") {
      try { gitInit = this.ensureScratch().gitInit || gitInit; }
      catch {
        // File writes are off and Scratch was never made: start in the vault instead, and say so (spec §5 degradation).
        if (!fs.existsSync(place.dir)) { place = vaultPlace(this.world()); why = "default"; aside = "Scratch needs file writes"; }
      }
    }
    const session = this.start(req.host, place, { resume: req.resume ?? null, gitInit, origin: req.origin ?? null });
    if (!req.origin) {
      this.plugin.settings.terminalChoice = rememberTerminalChoice(this.plugin.settings.terminalChoice, { host: req.host, workspace: place.workspace ?? null });
      void this.plugin.saveSettings();
    }
    this.announce(session, place, why, req.host, aside);
    return { session, place, why };
  }

  /** Makes a new workspace and starts `host` there in the same step (T6). Throws on a bad name. */
  async createAndLaunch(name: string, host: TermHost, gitInit: boolean): Promise<Launched> {
    const problem = workspaceNameProblem(name);
    const slug = slugify(name);
    if (problem || !slug) throw new Error(problem ?? "Use a letter or digit");
    try {
      this.ensureFolder(slug, workspaceStubs(slug));
    } catch (e) {
      // File writes are off (AOS_APP_WRITE): let the CLI make it, in a shell the user can see.
      const s = this.start("shell", vaultPlace(this.world()), { resume: null, gitInit: false, origin: "New workspace" });
      s.write(` aos workspace new ${shq(name)}\r`);
      this.announce(s, vaultPlace(this.world()), "picked", "shell");
      throw new Error(`File writes are off, so the workspace is being made with aos workspace new in a shell (${e instanceof Error ? e.message : String(e)})`);
    }
    return this.launch({ host, picked: workspacePlace(slug, this.world()), gitInit });
  }

  /** Writes `repo:` into a workspace's workspace.md (T8): a path typed by the user, `~/…` or absolute. */
  linkRepo(workspace: string, typed: string | null): string | null {
    const file = path.join(this.workspacesDir(), workspace, "workspace.md");
    let text: string | null = null;
    try { text = fs.readFileSync(file, "utf8"); } catch { /* none yet */ }
    if (typed === null || !typed.trim()) { if (text !== null) fs.writeFileSync(file, withRepoLink(text, null)); return null; }
    const home = this.home();
    const abs = parseRepoLink(withRepoLink(null, typed.trim()), home, this.vault());
    if (!abs) throw new Error("Give a folder outside the vault, as ~/… or a full path");
    fs.writeFileSync(file, withRepoLink(text, repoValue(abs, home)));
    return abs;
  }

  /** The terminal itself: a fresh shell in the place, with the agent's line typed when it is an agent. */
  private start(host: TermHost, place: Place, o: { resume: "last" | null; gitInit: boolean; origin: string | null }): TerminalSession {
    const pool = this.plugin.terminalPool;
    const shell = this.plugin.settings.terminalShell || pool.defaults.shell;
    const sessionId = host === "claude" && !o.resume ? newId() : null;
    const spec = host === "shell" ? null : this.spec(host, { resume: o.resume, gitInit: o.gitInit, sessionId });
    const session = pool.create({
      shell, cwd: place.dir,
      meta: { host, place, origin: o.origin, label: null, model: spec?.model ?? null, access: spec?.access ?? null, claudeSessionId: sessionId, startedAt: Date.now() },
    });
    if (spec) session.write(`${launchLine(spec)}\r`);
    else if (o.gitInit) session.write(" [ -e .git ] || git init -q\r");
    pool.select(session.id);
    return session;
  }

  private announce(session: TerminalSession, place: Place, why: PlaceWhy, host: TermHost, aside: string | null = null): void {
    const note: LaunchNote = { id: session.id, text: `Started ${TERM_HOST_LABEL[host]} in ${place.label}${aside ? ` (${aside})` : ""}`, why, host };
    this.plugin.terminalPool.lastLaunch = { ...note, at: Date.now() };
    this.plugin.terminalPool.trigger("session-launched", note);
  }
}

/** A new conversation id: the deck names Claude Code's so Resume can find it again. */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}
