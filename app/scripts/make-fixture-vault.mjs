#!/usr/bin/env node
// Builds a synthetic AgenticOS install for the end-to-end suite: a vault made the way `aos init` makes one, a fake
// HOME with its own ~/.claude, and a shim bin folder. Every name, path and note in it is made up here. The real
// runtime from this repo (brain/scripts, cli, plugin) produces the caches (snapshot, pipelines, skills, agents, routines, status line,
// proposal pages…); only content a user or an agent would write by hand is written by this script.
//
//   node scripts/make-fixture-vault.mjs [--out tests/.fixture] [--cache tests/.cache] [--quiet]
//
// Output (<out>):
//   vault/          the vault (AOS_APP_VAULT / AOS_VAULT)
//   home/           the fake HOME: .claude/agenticos.json, settings.json, skills, agents, projects…, .codex/sessions
//   bin/            node, plus stubs for launchctl / osascript / crontab / open that only log (stub-calls.log)
//   term-bin/       `claude` and `codex` stubs that only echo: the PATH of the Term tab's shell (home/.zshrc)
//   env.json        the environment every runtime run used; the e2e harness launches the app with the same one
//   expected.json   values the specs assert on, read back from the runtime's own output where it has one
//   stages.json     each runtime stage, whether it succeeded, and why not
//
// Isolation: every child process gets a clean environment built here (HOME, CFFIXED_USER_HOME, CLAUDE_CONFIG_DIR,
// CODEX_HOME, AOS_CONFIG, AOS_VAULT pointing into <out>; PATH = <out>/bin + the system folders, so no claude, codex
// or ollama is found). Nothing outside <out> and <cache> is written. The runtime's npm dependencies are installed
// once into <cache>/runtime-deps/<hash> (network on the first run only) and copied into each new vault.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WB = path.resolve(repo, ".."); // the repository root: the app lives in <repo>/app

// ── arguments ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const OUT = path.resolve(flag("--out", path.join(repo, "tests", ".fixture")));
const CACHE = path.resolve(flag("--cache", path.join(repo, "tests", ".cache")));
const QUIET = argv.includes("--quiet");
const log = (...a) => { if (!QUIET) console.log(...a); };

if (!fs.existsSync(path.join(WB, "brain", "scripts", "package.json"))) {
  console.error(`no Workbench runtime at ${WB}: run this from the app folder of a full checkout`);
  process.exit(2);
}

const VAULT = path.join(OUT, "vault");
const HOME = path.join(OUT, "home");
const BIN = path.join(OUT, "bin");
const CLAUDE = path.join(HOME, ".claude");
const CODEX = path.join(HOME, ".codex");
const AOS_CONFIG = path.join(CLAUDE, "agenticos.json");
const SCRIPTS = path.join(VAULT, "brain", "scripts");
const STUB_LOG = path.join(OUT, "stub-calls.log");
const NODE = process.execPath;

// ── time: everything is relative to now, so the dates always read "today", "3d late", "1d ago" ──

const NOW = new Date();
const pad = (n) => String(n).padStart(2, "0");
const day = (offset = 0) => { const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ago = (ms) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TODAY = day(0);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// ── helpers ───────────────────────────────────────────────────────────

const stages = [];
function stage(name, fn, { optional = false } = {}) {
  const t0 = Date.now();
  try {
    const note = fn();
    stages.push({ stage: name, ok: true, ms: Date.now() - t0, ...(note ? { note: String(note).slice(0, 400) } : {}) });
    log(`  ✓ ${name}${note ? ` — ${String(note).split("\n")[0].slice(0, 120)}` : ""}`);
  } catch (e) {
    const why = (e && (e.stderr || e.message)) ? String(e.stderr || e.message).trim().split("\n").slice(-3).join(" | ") : String(e);
    stages.push({ stage: name, ok: false, optional, ms: Date.now() - t0, error: why.slice(0, 600) });
    log(`  ${optional ? "·" : "✗"} ${name} — ${why.slice(0, 200)}`);
    if (!optional) throw e;
  }
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const writeJson = (file, obj) => write(file, `${JSON.stringify(obj, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const v = (rel) => path.join(VAULT, rel);

/** cli/aos.js copyTree: recursive copy; `exclude` tests the source-relative path; `rename` maps source → dest. */
function copyTree(src, dest, { exclude = null, rename = {} } = {}) {
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (exclude && exclude.test(childRel)) continue;
      if (e.isDirectory()) { walk(childRel); continue; }
      if (!e.isFile()) continue;
      const target = path.join(dest, rename[childRel] || childRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(src, childRel), target);
    }
  };
  walk("");
}

/** The environment every child gets: nothing inherited but TMPDIR, the user name and the locale. */
function baseEnv() {
  const keep = ["TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ"];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    HOME,
    CFFIXED_USER_HOME: HOME,            // macOS: redirects NSHomeDirectory (Electron's appData/userData) as well
    CLAUDE_CONFIG_DIR: CLAUDE,
    CODEX_HOME: CODEX,
    AOS_CONFIG,
    AOS_VAULT: VAULT,
    AOS_HEADLESS: "1",                  // hooks stay inert; nothing calls a model
    AOS_NO_CLAUDE: "1",
    AOS_NO_CODEX: "1",
    AOS_SKIP_OLLAMA_PROBE: "1",
    AOS_UV_BIN: "",
    AOS_LAUNCHCTL_BIN: path.join(BIN, "launchctl"),
    AOS_CRONTAB_BIN: path.join(BIN, "crontab"),
    AOS_FIXTURE_STUB_LOG: STUB_LOG,
    PATH: [BIN, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    SHELL: "/bin/zsh",
    XDG_CONFIG_HOME: path.join(HOME, ".config"),
    XDG_CACHE_HOME: path.join(HOME, ".cache"),
    XDG_DATA_HOME: path.join(HOME, ".local", "share"),
    NO_COLOR: "1",
  });
  return env;
}
const ENV = () => baseEnv();
/** Hook scripts exit at once under AOS_HEADLESS=1; the ones a session's hooks would run are called without it. */
const HOOK_ENV = () => { const e = baseEnv(); delete e.AOS_HEADLESS; e.AOS_HOST = "claude"; return e; };
/** What the user types in a terminal: `aos config set` and the like refuse a headless run. */
const USER_ENV = () => { const e = baseEnv(); delete e.AOS_HEADLESS; return e; };

function run(cmd, args, { cwd = VAULT, env = ENV(), input, timeout = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd, env, input, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error(`${path.basename(cmd)} ${args.map(String).map((a) => path.basename(a)).join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
    e.stdout = r.stdout; e.stderr = r.stderr;
    throw e;
  }
  return r.stdout;
}
/** The vault's own launcher, as a user types `aos <name> …`. */
const aos = (args, opts) => run("/bin/sh", [path.join(SCRIPTS, "bin", "aos"), ...args], opts);
const brainScript = (rel, args = [], opts) => run(NODE, [path.join(SCRIPTS, rel), ...args], opts);

// ── 0. clean ──────────────────────────────────────────────────────────

log(`fixture → ${OUT}`);
// The output folder is wiped: refuse one that holds anything but an earlier fixture.
const MARKER = path.join(OUT, ".aos-e2e-fixture");
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length && !fs.existsSync(MARKER)) {
  console.error(`refusing to replace ${OUT}: it is not empty and holds no earlier fixture (${path.basename(MARKER)})`);
  process.exit(2);
}
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(MARKER, "generated by scripts/make-fixture-vault.mjs; safe to delete\n");
for (const d of [VAULT, CLAUDE, CODEX, BIN]) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

// ── 1. shim bin: node, and stubs that record instead of acting ────────

stage("shim bin", () => {
  fs.symlinkSync(NODE, path.join(BIN, "node"));
  const stub = (name, body = "exit 0") => {
    write(path.join(BIN, name), `#!/bin/sh\n# fixture stub: never reaches the real ${name}\necho "${name} $*" >> "\${AOS_FIXTURE_STUB_LOG:-/dev/null}"\n${body}\n`);
    fs.chmodSync(path.join(BIN, name), 0o755);
  };
  for (const s of ["launchctl", "osascript", "open", "terminal-notifier", "notify-send", "say"]) stub(s);
  stub("crontab", '[ "$1" = "-l" ] && exit 0\ncat >/dev/null\nexit 0');
  return `node → ${NODE}`;
});

// ── 2. fake HOME ──────────────────────────────────────────────────────

stage("fake home", () => {
  // The Term tab's shell reads this: a fixed PATH whose `claude` and `codex` are stubs that only echo, so a button that
  // types `claude '/…'` into a session can be checked without ever reaching a real CLI.
  const termBin = path.join(OUT, "term-bin");
  for (const cli of ["claude", "codex"]) {
    write(path.join(termBin, cli), `#!/bin/sh\necho "[fixture ${cli} stub] $*"\n`);
    fs.chmodSync(path.join(termBin, cli), 0o755);
  }
  // ~/.local/bin is where `aos init` links the launcher, and its checklist says to put it on PATH.
  write(path.join(HOME, ".zshrc"), `# fixture home: an interactive shell with a fixed PATH\nexport PATH="${termBin}:${path.join(HOME, ".local", "bin")}:${BIN}:/usr/bin:/bin:/usr/sbin:/sbin"\nPROMPT='fixture %# '\n`);
  write(path.join(HOME, ".zshenv"), "");
  // Claude Code's own settings: model and effort show in the sidebar HUD; one plugin enabled.
  writeJson(path.join(CLAUDE, "settings.json"), {
    model: "sonnet",
    effortLevel: "medium",
    enabledPlugins: { "agenticos@agenticos-workbench": true, "logbook@sample-market": true },
    permissions: { allow: ["Read", "Grep", "Glob"], defaultMode: "default" },
  });
  // Skills in Claude Code's folder.
  const skill = (name, description, body) => write(path.join(CLAUDE, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`);
  skill("tide-report", "Summarise the week's tide readings for the harbor map workspace.", "Read the tide tables and write a five-line summary.");
  skill("chart-check", "Check a nautical chart tile set for missing zoom levels.", "List the zoom levels present and the ones missing.");
  skill("release-notes", "Draft release notes from the merged pull requests since the last tag.", "Group changes by area; keep each line under 90 characters.");
  // Agents in Claude Code's folder: the example team's three seats, a lead for the sub-team, and a read-only researcher.
  const agent = (name, description, tools) => write(path.join(CLAUDE, "agents", `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n${tools ? `tools: ${tools}\n` : ""}model: inherit\n---\n\nYou are ${name}. ${description}\n`);
  agent("team-lead", "Leads the example team: moves the board and dispatches seats.");
  agent("team-builder", "Builds the work item it is handed and commits it.");
  agent("team-reviewer", "Reviews a finished item on the other provider and names each finding.");
  agent("survey-lead", "Leads the survey sub-team.");
  agent("field-researcher", "Reads sources and reports findings without changing files.", "Read, Grep, Glob");
  // One slash command.
  write(path.join(CLAUDE, "commands", "standup-lite.md"), "---\ndescription: A three-line standup from today's daily note.\n---\n\nRead today's daily note and write Did / Doing / Blockers.\n");
  // Installed plugins: the real agenticos plugin from this repo (what `claude plugin install` leaves), and a
  // small made-up one.
  const agenticosRoot = path.join(CLAUDE, "plugins", "cache", "agenticos-workbench", "agenticos", "0.21.0");
  copyTree(path.join(WB, "plugin"), agenticosRoot);
  const logbookRoot = path.join(CLAUDE, "plugins", "cache", "sample-market", "logbook", "1.2.0");
  write(path.join(logbookRoot, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "logbook", version: "1.2.0", description: "A sample plugin" }, null, 2)}\n`);
  write(path.join(logbookRoot, "skills", "log-entry", "SKILL.md"), "---\nname: log-entry\ndescription: Append a dated entry to the ship's log.\n---\n\nAppend one line.\n");
  writeJson(path.join(CLAUDE, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "agenticos@agenticos-workbench": [{ scope: "user", installPath: agenticosRoot, version: "0.21.0", installedAt: ago(10 * DAY).toISOString() }],
      "logbook@sample-market": [{ scope: "user", installPath: logbookRoot, version: "1.2.0", installedAt: ago(20 * DAY).toISOString() }],
    },
  });
  // A launchd job the user owns, named in routines.externalLabels ("OUTSIDE THE RUNTIME").
  write(path.join(HOME, "Library", "LaunchAgents", "com.sample.nightly-backup.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.sample.nightly-backup</string>\n  <key>ProgramArguments</key><array><string>/usr/bin/true</string></array>\n  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>\n</dict>\n</plist>\n`);
});

// ── 3. the seed vault, as `aos init` step 3 copies it ─────────────────

stage("seed vault (aos init step 3)", () => {
  copyTree(path.join(WB, "vault-template"), VAULT, { exclude: /(^|\/)persona(\/|$)/, rename: { _gitignore: ".gitignore" } });
  const session = v("brain/_index/SESSION.md");
  fs.writeFileSync(session, fs.readFileSync(session, "utf8").replace(/^updated: .*$/m, `updated: ${TODAY}`));
  const defaults = readJson(path.join(WB, "brain", "scripts", "config.default.json"));
  writeJson(v("brain/config.json"), defaults);
  const layout = defaults.dailyNote.layout;
  writeJson(v(".obsidian/daily-notes.json"), { folder: String(layout).split("/")[0].replace(/\{yyyy\}/g, String(NOW.getFullYear())), format: "YYYY-MM-DD" });
  // The Obsidian Git plugin's settings, with its backup timer on (Routines lists it under OUTSIDE THE RUNTIME).
  writeJson(v(".obsidian/plugins/obsidian-git/data.json"), { autoSaveInterval: 30, autoPushInterval: 0, autoPullInterval: 60, autoBackupAfterFileChange: true });
});

// ── 4. vendor the runtime (aos init step 4, cli/aos.js vendorRuntime) ──

stage("vendor runtime (aos init step 4)", () => {
  copyTree(path.join(WB, "brain", "scripts"), SCRIPTS, { exclude: /(^|\/)(node_modules|test|package-lock\.json)(\/|$)/ });
  copyTree(path.join(WB, "cli"), path.join(SCRIPTS, "cli"), { exclude: /(^|\/)(fixtures|rehearsal)(\/|$)|\.test\.js$/ });
  copyTree(path.join(WB, "vault-template", "persona"), path.join(SCRIPTS, "persona", "templates"));
  for (const x of ["schedule", "cost"]) {
    if (fs.existsSync(path.join(WB, "extras", x))) copyTree(path.join(WB, "extras", x), path.join(SCRIPTS, "extras", x), { exclude: /(^|\/)test_[^/]*\.py$/ });
  }
  fs.mkdirSync(path.join(SCRIPTS, "bin"), { recursive: true });
  fs.copyFileSync(path.join(WB, "plugin", "bin", "aos"), path.join(SCRIPTS, "bin", "aos"));
  fs.chmodSync(path.join(SCRIPTS, "bin", "aos"), 0o755);
  for (const x of ["commands", "skills"]) copyTree(path.join(WB, "plugin", x), path.join(SCRIPTS, "plugin", x));
  // ~/.local/bin/aos → the vault's launcher (linkLauncher).
  fs.mkdirSync(path.join(HOME, ".local", "bin"), { recursive: true });
  fs.symlinkSync(path.join(SCRIPTS, "bin", "aos"), path.join(HOME, ".local", "bin", "aos"));
});

stage("runtime npm dependencies (npm install --omit=dev, cached)", () => {
  const pkg = fs.readFileSync(path.join(WB, "brain", "scripts", "package.json"), "utf8");
  const key = createHash("sha256").update(pkg).update(process.versions.node.split(".")[0]).update(process.platform).digest("hex").slice(0, 16);
  const cached = path.join(CACHE, "runtime-deps", key);
  let how = `cache hit ${key}`;
  if (!fs.existsSync(path.join(cached, "node_modules"))) {
    const staging = `${cached}.tmp-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "package.json"), pkg);
    // npm with the fake HOME (no user .npmrc) and a cache of our own; the real vendorRuntime runs the same command.
    // The npm next to this node when there is one (Homebrew, nodejs.org, setup-node), else the first on PATH.
    const sibling = path.join(path.dirname(NODE), "npm");
    const npmBin = fs.existsSync(sibling) ? sibling : "npm";
    const npmEnv = { ...ENV(), PATH: [BIN, path.dirname(NODE), "/usr/bin", "/bin", ...(npmBin === "npm" ? [process.env.PATH ?? ""] : [])].join(":"), npm_config_cache: path.join(CACHE, "npm"), npm_config_update_notifier: "false" };
    const npm = spawnSync(npmBin, ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: staging, env: npmEnv, encoding: "utf8", timeout: 300_000 });
    if (npm.status !== 0) throw new Error(`npm install failed: ${(npm.stderr || npm.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
    fs.rmSync(cached, { recursive: true, force: true });
    fs.renameSync(staging, cached);
    how = `installed into cache ${key}`;
  }
  fs.cpSync(path.join(cached, "node_modules"), path.join(SCRIPTS, "node_modules"), { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  return how;
});

// ── 5. agenticos.json (aos init step 5, cli/aos.js buildUserConfig) ──

stage("agenticos.json (aos init step 5)", () => {
  const version = readJson(path.join(WB, "package.json")).version;
  writeJson(AOS_CONFIG, {
    version, vault: VAULT, node: NODE, claudeConfigDir: CLAUDE,
    // `aos init --provider none`: no background model calls; the Chat tab is hidden (a variant flips provider-state).
    provider: "none",
    claude: { model: "haiku", perCallUsd: 0.05, perDayUsd: 0.5 },
    ollama: { host: "127.0.0.1", port: 11434 },
    telemetry: { enabled: true, redact: true, retentionDays: 30 },
    cost: { enabled: false },
    persona: { enabled: true },
    graph: { enabled: true },
    hosts: { claude: { enabled: true, configDir: CLAUDE }, codex: { enabled: false, home: CODEX } },
  });
  return `provider none · hosts claude`;
});

// ── 6. the Chief of Staff interview (aos init step 8), from an answers file ──

const PERSONA = "Nimbus";
stage("persona interview (aos init step 8)", () => {
  const answers = path.join(OUT, "persona-answers.json");
  writeJson(answers, { name: PERSONA, addressAs: "the operator", voice: "brief, plain, a little dry", priorities: "fixture checks, tidy vault", dutyModel: "haiku", dutyEffort: "low", schedule: "no" });
  const out = brainScript("persona/interview.js", ["--vault", VAULT, "--config-dir", CLAUDE, "--answers", answers, "--node", NODE]);
  fs.rmSync(answers);
  return out.trim().split("\n").pop();
});

// ── 7. settings a user would have changed with `aos config set` / `aos cost enable` ──

stage("aos config set (user choices)", () => {
  const sets = [
    ["notifications.osAlert", "false"],
    ["persona.watchdog.notify", "false"],
    ["routines.externalLabels", '["com.sample.nightly-backup"]'],
    ["cost.monthlyBudget", "175"],        // outside the presets: the picker shows "(custom)"
  ];
  const done = [];
  for (const [k, val] of sets) { aos(["config", "set", k, val], { env: USER_ENV() }); done.push(k); }
  return done.join(", ");
});

stage("aos cost enable --budget 175", () => aos(["cost", "enable", "--budget", "175", "--yes"], { env: USER_ENV() }).trim().split("\n")[0], { optional: true });

// Some stages above may fail on a machine without python3; the COST row only needs the switch and the budget.
stage("cost switch (fallback when cost enable did not run)", () => {
  const cfg = readJson(AOS_CONFIG);
  if (cfg.cost && cfg.cost.enabled === true) return "already on";
  cfg.cost = { ...(cfg.cost || {}), enabled: true };
  writeJson(AOS_CONFIG, cfg);
  return "cost.enabled set in agenticos.json";
});

// ── 8. content a user and their agents write ───────────────────────────

stage("memories, patterns, MEMORY.md", () => {
  const mem = (type, slug, title, { created, updated, reviewed, tags = [], body }) => write(v(`brain/memory/${type}/${slug}.md`),
    `---\ntype: memory\ntags: [memory/${type}${tags.map((t) => `, ${t}`).join("")}]\ncreated: ${created}\nupdated: ${updated}\n${reviewed === undefined ? "" : `reviewed: ${reviewed}\n`}---\n\n# ${title}\n\n${body}\n`);
  mem("user", "working-hours", "Working Hours", { created: day(-40), updated: day(-12), body: "Deep work before noon; reviews after lunch. No meetings on Fridays." });
  mem("feedback", "prefer-small-diffs", "Prefer small diffs", { created: day(-30), updated: day(-2), tags: ["status/active"], body: "Keep each change reviewable in one sitting.\n\n**Why:** large diffs hid a regression in [[Harbor Map]].\n\n**How to apply:** split refactors from behaviour changes; one commit each." });
  mem("feedback", "confirm-before-deleting", "Confirm before deleting", { created: day(-25), updated: day(-25), body: "Ask before removing files outside `workspaces/`.\n\n**Why:** a cleanup once removed a note that was still linked.\n\n**How to apply:** list what would go, then wait." });
  mem("projects", "harbor-map", "Harbor Map", { created: day(-60), updated: day(-1), tags: ["status/active"], body: "An offline harbor chart viewer. Status: the tide parser is in review; chart tiles cache next.\n\nSee [[Tide API notes]] and [[Prefer small diffs]]." });
  mem("projects", "field-notes-app", "Field Notes App", { created: day(-90), updated: day(-45), body: "A notebook for survey trips. Paused until the harbor map ships.\n\nRelated: [[Harbor Map]]." });
  mem("reference", "tide-api-notes", "Tide API notes", { created: day(-50), updated: day(-7), body: "The sample tide service returns readings in six-minute steps; times are UTC.\n\n- Rate limit: 60 requests a minute.\n- Station ids are five digits.\n\nUsed by [[Harbor Map]]." });
  mem("reference", "release-checklist", "Release checklist", { created: day(-1), updated: day(-1), reviewed: false, body: "Auto-promoted from a session: tag, build, smoke-test the chart viewer, then publish the notes." });

  write(v("brain/patterns/debugging.md"), `---\ntype: pattern\ntags: [pattern/debugging]\ncreated: ${day(-35)}\nupdated: ${day(-6)}\n---\n\n# Debugging Patterns\n\n### Bisect before theorising\n\nWhen a regression has a known good commit, bisect first; theories come after the first bad commit is known.\n\n### Read the log you have\n\nBefore adding logging, read the output that already exists end to end.\n`);

  const index = fs.readFileSync(v("MEMORY.md"), "utf8")
    .replace("## User\n", `## User\n\n- [Profile](brain/memory/user/profile.md) — who the vault belongs to and how they work\n- [Working Hours](brain/memory/user/working-hours.md) — deep work before noon\n`)
    .replace("## Feedback (how to work)\n", `## Feedback (how to work)\n\n- [Prefer small diffs](brain/memory/feedback/prefer-small-diffs.md) — one reviewable change at a time\n- [Confirm before deleting](brain/memory/feedback/confirm-before-deleting.md) — list first, then wait\n`)
    .replace("## Project\n", `## Project\n\n- [Harbor Map](brain/memory/projects/harbor-map.md) — offline harbor chart viewer, tide parser in review\n- [Field Notes App](brain/memory/projects/field-notes-app.md) — survey notebook, paused\n`)
    .replace("## Reference\n", `## Reference\n\n- [Tide API notes](brain/memory/reference/tide-api-notes.md) — six-minute readings, UTC\n- [Release checklist](brain/memory/reference/release-checklist.md) — tag, build, smoke-test, publish\n`)
    .replace("## Patterns\n", `## Patterns\n\n- [Debugging Patterns](brain/patterns/debugging.md) — bisect before theorising\n`);
  write(v("MEMORY.md"), index);
});

stage("SESSION.md and daily notes", () => {
  const s = fs.readFileSync(v("brain/_index/SESSION.md"), "utf8")
    .replace("## Active Task\n", "## Active Task\n\n- Wire the tide parser into the chart view\n")
    .replace("## Things to Remember\n", "## Things to Remember\n\n- The sample tide service times are UTC #promote\n");
  write(v("brain/_index/SESSION.md"), s);
  const note = (offset, body) => {
    const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + offset);
    const date = day(offset);
    const rel = `${d.getFullYear()}/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${MONTHS[d.getMonth()]}/${date}.md`;
    write(v(rel), `---\ntype: daily-note\ndate: ${date}\ntags: [daily-note]\n---\n\n# ${date}\n\n## Claude Code Sessions\n\n## Summary\n\n${body}\n\n## Decisions Made\n\n## Follow-up\n\n- [ ] Check the tide parser review\n`);
    return rel;
  };
  const a = note(-1, "Reviewed the chart tile cache design. See [[Harbor Map]].");
  const b = note(0, "Started on the fixture checks. See [[Tide API notes]].");
  return `${a}, ${b}`;
});

const TODO = {
  overdue: [["Renew the sample domain", "⏫", day(-3), "admin"], ["File the quarterly notes", null, day(-1), "admin"]],
  today: [["Review the tide parser PR", "🔼", TODAY, "harbor"], ["Call the chart vendor", null, TODAY, "harbor"]],
  upcoming: [["Draft the release notes", null, day(1), "harbor"], ["Plan the offline sync spike", "🔽", day(9), null]],
  someday: [["Read the field guide", null, null, "reading"], ["Sort the old survey photos", "🔽", null, null]],
};
stage("TODO.md (Obsidian Tasks syntax)", () => {
  const line = ([text, prio, due, tag]) => `- [ ] ${[text, prio, due ? `📅 ${due}` : null, tag ? `#${tag}` : null].filter(Boolean).join(" ")}`;
  const open = [...TODO.overdue, ...TODO.today, ...TODO.upcoming, ...TODO.someday].map(line);
  open.splice(3, 0, "    - bring the three open review comments");   // an indented child under the today item
  const text = fs.readFileSync(v("TODO.md"), "utf8")
    .replace("## Open\n", `## Open\n\n${open.join("\n")}\n`)
    .replace("## Done\n", `## Done\n\n- [x] Set up the fixture vault ✅ ${day(-1)} #admin\n- [x] Archive last quarter's charts ✅ ${day(-20)}\n`);
  write(v("TODO.md"), text);
});

const PROPOSALS = [
  { name: `${day(-5)}-trim-playbook.md`, slug: "trim-playbook", kind: "self", target: "persona/PLAYBOOK.md", confirmations: 2 },
  { name: `${day(-3)}-todo-in-sitrep.md`, slug: "todo-in-sitrep", kind: "product", surface: "hud", target: "the morning sitrep", confirmations: 1 },
  { name: `${day(-1)}-no-surface.md`, slug: "no-surface", kind: "product", target: "somewhere in the HUD", lint: 3 },
];
stage("persona proposals, ledger, backlog, confirmations", () => {
  const dir = v("persona/proposals");
  write(path.join(dir, PROPOSALS[0].name), `---\nslug: trim-playbook\nfiled: ${day(-5)}\ntarget: persona/PLAYBOOK.md\nrecheck: "grep -q 'Old heading' persona/PLAYBOOK.md"\nautoapply_class: playbook-trim\n---\n# Trim the playbook\n\n## What\nRemove the \`## Old heading\` section from \`persona/PLAYBOOK.md\`.\n\n## Why\nThe section names a skill that no longer exists (journal ${day(-6)}).\n\n## Risk\nNone beyond losing a stale line.\n\n## Premises\n| Premise | Status | Evidence |\n|---|---|---|\n| the section exists | VERIFIED | grep, ${day(-5)} |\n| nothing links to it | ASSUMED | no wiki-links found by search |\n`);
  write(path.join(dir, PROPOSALS[1].name), `---\nslug: todo-in-sitrep\nfiled: ${day(-3)}\ntarget: the morning sitrep\nkind: product\nsurface: hud\nrecheck: "test -f TODO.md"\n---\n# To-dos in the sitrep\n\n## What\nList the to-dos due today in the morning sitrep.\n\n## Why\nThe operator asked for it twice this week.\n\n## Risk\nA longer sitrep.\n\n## Premises\n| Premise | Status | Evidence |\n|---|---|---|\n| TODO.md exists | VERIFIED | test -f |\n`);
  // Ledger events, with ts relative to now: two decisions and two ideas inside the 28-day window, one outside it.
  const ev = (ms, event, slug, kind, target, extra = {}) => JSON.stringify({ schema: 1, ts: ago(ms).toISOString(), event, slug, kind, target, by: event === "filed" ? "reflect" : event === "verified" ? "watchdog" : "user", ...extra });
  write(v("persona/ledger.jsonl"), [
    ev(60 * DAY, "filed", "ancient-idea", "self", "hooks"),
    ev(59 * DAY, "rejected", "ancient-idea", "self", "hooks", { note: "outside the 28-day window" }),
    ev(20 * DAY, "filed", "quiet-hooks", "self", "hooks"),
    ev(19 * DAY, "approved", "quiet-hooks", "self", "hooks", { recheck: "true", commit: "abc1234" }),
    ev(15 * DAY, "filed", "loud-wrap", "vault", "wrap"),
    ev(14 * DAY, "rejected", "loud-wrap", "vault", "wrap", { note: "too noisy" }),
    ev(12 * DAY, "filed", "weekly-digest-idea", "workflow", "standup"),
    ev(11 * DAY, "accepted", "weekly-digest-idea", "workflow", "standup"),
    ev(10 * DAY, "filed", "tile-preview", "product", "hud"),
    ev(9 * DAY, "dismissed", "tile-preview", "product", "hud", { note: "duplicate" }),
    ev(8 * DAY, "verified", "quiet-hooks", "self", "hooks"),
    ev(5 * DAY, "filed", "trim-playbook", "self", "persona/PLAYBOOK.md"),
    ev(3 * DAY, "filed", "todo-in-sitrep", "product", "the morning sitrep"),
  ].join("\n") + "\n");
  writeJson(v("persona/flag-closer/confirmations.json"), { schema: 1, recordedDay: TODAY, slugs: { "trim-playbook": 2, "todo-in-sitrep": 1 } });
});

stage("backlog.js append (accepted ideas)", () => {
  const tmp = path.join(OUT, "tmp-accepted");
  const idea = (file, slug, kind, surface, target, what, why, filed) => {
    write(path.join(tmp, file), `---\nslug: ${slug}\nfiled: ${filed}\ntarget: ${target}\nkind: ${kind}\n${surface ? `surface: ${surface}\n` : ""}recheck: "true"\n---\n# ${slug}\n\n## What\n${what}\n\n## Why\n${why}\n\n## Premises\n| Premise | Status | Evidence |\n|---|---|---|\n| it helps | ASSUMED | the operator said so |\n`);
    return path.join(tmp, file);
  };
  const a = idea(`${day(-12)}-weekly-digest-idea.md`, "weekly-digest-idea", "workflow", null, "standup", "A Friday digest of the week's sessions.", "Mondays start without context.", day(-12));
  const out = [brainScript("persona/backlog.js", ["append", a, "--by", "user", "--root", VAULT]).trim()];
  fs.rmSync(tmp, { recursive: true, force: true });
  // chart-legend the way the persona-flag-closer review moves one: filed in persona/proposals, its page rendered,
  // accepted into the backlog, the proposal file removed. The page outlives the file, so Backlog and History link it.
  const filed = v(`persona/proposals/${day(-6)}-chart-legend.md`);
  write(filed, `---\nslug: chart-legend\nfiled: ${day(-6)}\ntarget: the chart viewer\nkind: product\nsurface: hud\nrecheck: "true"\n---\n# A legend for chart symbols\n\n## What\nA legend for chart symbols.\n\n## Why\nNew users ask what the symbols mean.\n\n## Premises\n| Premise | Status | Evidence |\n|---|---|---|\n| it helps | ASSUMED | the operator said so |\n`);
  out.push(brainScript("persona/proposal-html.js", ["--root", VAULT, filed]).trim());
  out.push(brainScript("persona/backlog.js", ["append", filed, "--by", "user", "--root", VAULT]).trim());
  fs.rmSync(filed);
  const ev = (ms, event) => JSON.stringify({ schema: 1, ts: ago(ms).toISOString(), event, slug: "chart-legend", kind: "product", target: "the chart viewer", by: event === "filed" ? "reflect" : "user" });
  fs.appendFileSync(v("persona/ledger.jsonl"), `${ev(6 * DAY, "filed")}\n${ev(4 * DAY, "accepted")}\n`);
  return out.map((o) => o.split("\n").pop()).join(" ");
});

const NOTES = [];
stage("notifications (lib/notifications.js post + mark, synthetic clock)", () => {
  const req = createRequire(import.meta.url);
  const N = req(path.join(SCRIPTS, "lib", "notifications.js"));
  const cfg = { notifications: { osAlert: false } };
  const post = (ms, p) => { const r = N.post(p, { vault: VAULT, now: ago(ms), cfg, notify: null }); NOTES.push({ id: r.id, ...p, ageMs: ms }); return r.id; };
  const edition = post(2 * HOUR, {
    from: "harbor-desk", level: "edition", title: "The Morning Edition", tags: ["news"],
    body: "Good morning from the harbor desk.\n\n## Tides and Weather\n\nHigh water at 11:40; light winds from the west.\n\n## Chart Updates\n\nTwo tiles were redrawn overnight.\n",
    actions: [
      { kind: "ask", label: "Deep dive", skill: "agenticos:ask-brain", arg: "tide tables", anchor: "tides-and-weather" },
      { kind: "react", label: "More like this", value: 1, ref: "tides", anchor: "tides-and-weather" },
      { kind: "react", label: "Less like this", value: -1, ref: "tides", anchor: "tides-and-weather" },
      { kind: "ask", label: "Weekly outlook", skill: "agenticos:ask-brain", arg: "the week ahead" },
    ],
  });
  const breaking = post(30 * MIN, { from: "harbor-desk", level: "breaking", title: "Breaking: tide gauge offline", body: "Station 10001 stopped reporting at the top of the hour." });
  const alert = post(5 * HOUR, { from: "monitor", level: "alert", title: "Disk usage above 80%", body: "The vault volume is at 81%." });
  const weekly = post(3 * DAY, { from: "monitor", level: "info", title: "Weekly health", body: "All green." });
  const nightly = post(1 * DAY + HOUR, { from: "routines", level: "info", title: "Nightly scan finished", body: "scan-vault ran in 2.1 s." });
  const oldAlert = post(9 * DAY, { from: "monitor", level: "alert", title: "Backup missed", body: "The nightly backup did not run." });
  N.mark(VAULT, { ids: [weekly, nightly], key: "read", value: true });
  N.mark(VAULT, { ids: [nightly, oldAlert], key: "archived", value: true });
  // One vote from the tab, and one file with no frontmatter (the "unreadable" footer).
  fs.appendFileSync(v("brain/notifications/reactions.jsonl"), `${JSON.stringify({ schema: 1, at: ago(HOUR).toISOString(), id: edition, ref: "tides", value: 1 })}\n`);
  write(v(`brain/notifications/${NOW.getFullYear()}/${day(-2)}T0800-sample-broken-no-frontmatter.md`), "This file has no frontmatter and is skipped.\n");
  // An item whose frontmatter was edited by hand to carry a command: the tab re-checks the allow-list and shows no button.
  const edited = post(2 * DAY + 2 * HOUR, { from: "routines", level: "info", title: "Cache cleaned", body: "Removed 12 stale files." });
  const file = v(`brain/notifications/${String(NOW.getFullYear())}/${edited}.md`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^created: (.*)$/m, `created: $1\nactions: [{"kind":"run","label":"x","command":"echo hi"}]`));
  N.mark(VAULT, { ids: [edited], key: "read", value: true });
  return `${NOTES.length} items (${[edition, breaking, alert].length} unread)`;
});

stage("workspaces", () => {
  write(v("workspaces/harbor-map/workspace.md"), `---\nstatus: active\nsummary: An offline harbor chart viewer with tide overlays.\nobjectives:\n  - Parse the sample tide tables\n  - Cache chart tiles for offline use\nnext: Wire the tide parser into the chart view\n---\n\n# Harbor Map\n`);
  write(v("workspaces/harbor-map/README.md"), "# Harbor Map\n\nAn offline harbor chart viewer.\n\n## Objectives\n\n- Parse the sample tide tables\n");
  write(v("workspaces/harbor-map/PLAN.md"), "# Plan\n\n## Next\n\n- Wire the tide parser into the chart view\n");
  write(v("workspaces/harbor-map/src/tides.js"), "// Parses the sample tide tables.\nexport function parseTides(text) {\n  return text.split(\"\\n\").filter(Boolean).map((l) => l.split(\",\"));\n}\n");
  write(v("workspaces/harbor-map/src/tiles.js"), "// Chart tile cache (next).\nexport const TILE_SIZE = 256;\n");
  write(v("workspaces/field-notes/README.md"), "# Field Notes\n\nA notebook for survey trips.\n\n## Next\n\n- Pick a sync format\n");
});

stage("host sessions (Codex rollouts and Claude Code transcripts)", () => {
  const rollout = (ms, id, cwd) => {
    const d = ago(ms);
    const file = path.join(CODEX, "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()), `rollout-${d.toISOString().slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`);
    write(file, `${JSON.stringify({ timestamp: d.toISOString(), type: "session_meta", payload: { id, cwd, timestamp: d.toISOString(), originator: "codex_cli_rs" } })}\n`);
    fs.utimesSync(file, d, d);
  };
  rollout(1 * DAY + 2 * HOUR, "0199a1b2-0000-4000-8000-000000000001", v("workspaces/harbor-map"));
  rollout(3 * DAY, "0199a1b2-0000-4000-8000-000000000002", v("workspaces/harbor-map/src"));
  rollout(2 * DAY, "0199a1b2-0000-4000-8000-000000000003", "/opt/sample/sandbox");
  rollout(5 * DAY, "0199a1b2-0000-4000-8000-000000000004", path.join(HOME, "sketches"));   // under HOME: shown as ~/sketches
  // Claude Code transcripts under an encoded cwd outside every workspace (projects/<slug>/<session>.jsonl).
  const slugDir = path.join(CLAUDE, "projects", "-opt-sample-scratchpad");
  for (const [sid, ms] of [["5e55a0a0-0000-4000-8000-00000000000a", 26 * HOUR], ["5e55a0a0-0000-4000-8000-00000000000b", 4 * HOUR]]) {
    const file = path.join(slugDir, `${sid}.jsonl`);
    write(file, `${JSON.stringify({ type: "user", sessionId: sid, cwd: "/opt/sample/scratchpad", timestamp: ago(ms).toISOString(), message: { role: "user", content: "sample prompt" } })}\n`);
    fs.utimesSync(file, ago(ms), ago(ms));
  }
});

const TEAM_ITEMS = [];
stage("agent teams (aos team init / put / post)", () => {
  const team = (...a) => aos(["team", ...a]).trim();
  team("init");
  const put = (json) => { team("put", "example", "--from", "lead", JSON.stringify(json)); TEAM_ITEMS.push(json); };
  put({ id: "harbor-00", title: "Scaffold the viewer", stage: "ship", status: "done", owner: "lead", project: "harbor-map", phase: "00", path: "workspaces/harbor-map" });
  put({ id: "harbor-02", title: "Chart tile cache", stage: "execute", status: "working", owner: "builder", project: "harbor-map", phase: "02", path: "workspaces/harbor-map" });
  put({ id: "harbor-03", title: "Offline sync", stage: "verify", status: "blocked", owner: "reviewer", project: "harbor-map", phase: "03", path: "workspaces/harbor-map" });
  put({ id: "harbor-04", title: "Offline tiles", stage: "plan", status: "paused", owner: "lead", project: "harbor-map", phase: "04", path: "workspaces/harbor-map" });
  put({ id: "harbor-01", title: "Tide table parser", stage: "discuss", status: "gate", owner: "lead", gate: { name: "discuss", state: "pending" }, project: "harbor-map", phase: "01", path: "workspaces/harbor-map" });
  // Dispatch records a seat's spend on the board (put may not): the builder spent $6 on harbor-01's discuss work.
  const board = v("persona/teams/example/board.jsonl");
  const rows = fs.readFileSync(board, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const gateRow = rows.filter((r) => r.id === "harbor-01").pop();
  fs.appendFileSync(board, `${JSON.stringify({ ...gateRow, budget: { ...gateRow.budget, spentUsd: 6 }, ts: new Date(Date.parse(gateRow.ts) + 1).toISOString(), by: "dispatch" })}\n`);
  team("post", "example", "--from", "lead", "--item", "harbor-02", "--kind", "assign", "@builder takes harbor-02 in execute.");
  team("post", "example", "--from", "builder", "--item", "harbor-02", "--kind", "handoff", "Tile cache written; 3 commits. Back to @lead.");
  team("post", "example", "--from", "reviewer", "--item", "harbor-03", "--kind", "blocker", "Offline sync fails on an empty cache; @builder should add a guard.");
  team("post", "example", "--from", "lead", "--item", "harbor-01", "--kind", "gate", "Discuss gate open on harbor-01: scope is the tide parser; I propose $10. See notes, or ask @user.");
  // A sub-team (parent: example) with its own pending gate, written by hand the way a user copies the example folder.
  write(v("persona/teams/survey/TEAM.md"), `---\ntype: team\nid: survey\nname: Survey\nlead: surveylead\nparent: example\nreportsTo: lead\nstages: [plan, build, ship]\ngates: [plan]\nbudget: {mode: per-phase, default: 5}\nupdated: ${TODAY}\nmembers:\n  - id: surveylead\n    name: Survey Lead\n    role: Leads the survey\n    agent: survey-lead\n    provider: claude\n    model: inherit\n    effort: medium\n    stage: [all]\n  - id: researcher\n    name: Researcher\n    role: Reads sources\n    agent: field-researcher\n    provider: claude\n    model: inherit\n    effort: low\n    stage: [plan]\n---\n\n# Survey team\n`);
  aos(["team", "put", "survey", "--from", "surveylead", JSON.stringify({ id: "survey-01", title: "Pick survey sites", stage: "plan", status: "gate", owner: "surveylead", gate: { name: "plan", state: "pending" } })]);
  // A team whose TEAM.md uses a line the reader does not support (a nested list): shown with a rose "!".
  write(v("persona/teams/broken/TEAM.md"), "---\nid: broken\nlead: x\ntags:\n  - one\n---\n");
  // Two finished runs of the example team (dispatch writes these; no seat is dispatched here).
  const runs = [
    { schema: 1, ts: ago(26 * HOUR).toISOString(), team: "example", member: "builder", item: "harbor-02", provider: "claude", model: "claude-sonnet-5", effort: "high", run: "example-harbor-02-builder-a", startedAt: ago(27 * HOUR).toISOString(), ms: 1_800_000, usd: 2.4, status: "ok", commits: 3, merged: true },
    { schema: 1, ts: ago(5 * HOUR).toISOString(), team: "example", member: "reviewer", item: "harbor-03", provider: "codex", model: null, effort: "high", run: "example-harbor-03-reviewer-b", startedAt: ago(6 * HOUR).toISOString(), ms: 900_000, usd: null, status: "failed", error: "tests failed on an empty cache" },
  ];
  fs.appendFileSync(v("persona/teams/example/runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return team("list").split("\n").slice(0, 4).join(" / ");
});

stage("routines (a command routine and a disabled prompt routine)", () => {
  write(v("brain/routines/nightly-scan.md"), `---\nschema: 1\nname: Nightly scan\nkind: command\nschedule: "15 2 * * *"\nenabled: true\nguarded: false\nargv: ["{{NODE}}", "{{VAULT}}/brain/scripts/scan-vault.js", "--quiet"]\ntimeoutSec: 300\ntags: [maintenance]\n---\nRefreshes the snapshot every night.\n`);
  write(v("brain/routines/weekly-digest.md"), `---\nschema: 1\nname: Weekly digest\nkind: prompt\nschedule: "0 17 * * 5"\nenabled: false\nguarded: false\ntags: [digest]\n---\nSummarise the week's sessions in five bullets.\n`);
});

stage("telemetry: sessions through the real telemetry hook", () => {
  const hook = (payload) => run(NODE, [path.join(SCRIPTS, "telemetry-hook.js")], { env: HOOK_ENV(), input: JSON.stringify(payload) });
  const session = (sid, tools) => {
    const base = { session_id: sid, cwd: VAULT, transcript_path: path.join(CLAUDE, "projects", "-opt-sample-scratchpad", `${sid}.jsonl`) };
    hook({ ...base, hook_event_name: "SessionStart", source: "startup" });
    for (const [name, input] of tools) hook({ ...base, hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_response: { ok: true } });
    hook({ ...base, hook_event_name: "SessionEnd", reason: "exit" });
  };
  session("5e55a0a0-0000-4000-8000-00000000000a", [["Read", { file_path: "MEMORY.md" }], ["Grep", { pattern: "tide" }], ["Task", { subagent_type: "field-researcher", prompt: "find the tide notes" }]]);
  session("5e55a0a0-0000-4000-8000-00000000000b", [["Read", { file_path: "TODO.md" }], ["Edit", { file_path: "TODO.md" }]]);
  const rows = fs.readFileSync(v("brain/_index/agent-runs/runs.jsonl"), "utf8").trim().split("\n").length;
  return `${rows} runs.jsonl rows`;
});

const RUNS = [];
stage("telemetry: earlier runs (runs.jsonl / costs.jsonl rows per lib/runs-log.js)", () => {
  // Older history the hook would have written on other days, and headless runs with their own cost.
  const runsDir = v("brain/_index/agent-runs");
  const add = (row, events = []) => {
    RUNS.push(row);
    fs.appendFileSync(path.join(runsDir, "runs.jsonl"), `${JSON.stringify(row)}\n`);
    const dir = path.join(runsDir, row.started_at.slice(0, 10));
    write(path.join(dir, `${row.id}.json`), `${JSON.stringify({ id: row.id, summary: row, events }, null, 2)}\n`);
  };
  const t = (ms) => ago(ms).toISOString();
  const sess = (id, startMs, durMs, extra = {}) => ({ id: `sess-${id}`, script: "session", session_id: id, started_at: t(startMs), ended_at: t(startMs - durMs), duration_ms: durMs, cost_usd: null, turns: null, status: "ok", tool_count: 4, subagents: [], end_reason: "exit", host: "claude", model: "claude-sonnet-5", segment: 1, ...extra });
  const evs = (startMs) => [
    { type: "tool_use_batch", ts: ago(startMs).getTime() + 1000, tools: [{ name: "Read", input_summary: null, input_length: 40 }] },
    { type: "tool_result_batch", ts: ago(startMs).getTime() + 2000, results: [{ tool: "Read", is_error: false, output_summary: null }] },
    { type: "tool_use_batch", ts: ago(startMs).getTime() + 5000, tools: [{ name: "Bash", input_summary: null, input_length: 22 }] },
  ];
  add(sess("0c0ffee0-0000-4000-8000-000000000001", 3 * DAY, 40 * MIN), evs(3 * DAY));
  add(sess("0c0ffee0-0000-4000-8000-000000000002", 2 * DAY, 25 * MIN, { host: "codex", model: "gpt-5-codex" }), evs(2 * DAY));
  add({ id: "ask-20260901-aaaa", script: "ask", started_at: t(2 * DAY + 3 * HOUR), ended_at: t(2 * DAY + 3 * HOUR - 8000), duration_ms: 8000, cost_usd: 0.0123, turns: 1, status: "ok", prompt: "What changed in the tide parser?", reply: "The parser now reads six-minute steps." }, evs(2 * DAY + 3 * HOUR));
  add({ id: "reflect-week-bbbb", script: "reflect-week", started_at: t(26 * HOUR), ended_at: t(26 * HOUR - 42000), duration_ms: 42000, cost_usd: 0.0871, turns: 3, status: "ok", prompt: "Reflect on the week.", reply: "Three themes: tides, tiles, tests." }, evs(26 * HOUR));
  add({ id: "standup-cccc", script: "standup", started_at: t(7 * HOUR), ended_at: t(7 * HOUR - 3000), duration_ms: 3000, cost_usd: 0, turns: 1, status: "error", error: "no provider: set one with aos provider", prompt: "Standup", reply: "" }, evs(7 * HOUR));
  // cost-sync's record for the first session (laid over its row by applyCosts).
  fs.appendFileSync(path.join(runsDir, "costs.jsonl"), `${JSON.stringify({ schema: 1, session_id: "0c0ffee0-0000-4000-8000-000000000001", cost_usd: 1.25, cost_source: "transcript", tokens: 48000, at: t(3 * DAY - HOUR) })}\n`);
  return `${RUNS.length} rows`;
});

stage("promote trail (lib/promote-log.js appendTrail)", () => {
  const req = createRequire(import.meta.url);
  const env = { ...process.env };
  process.env.AOS_VAULT = VAULT; process.env.AOS_CONFIG = AOS_CONFIG; process.env.CLAUDE_CONFIG_DIR = CLAUDE; process.env.HOME = HOME;
  try {
    const P = req(path.join(SCRIPTS, "lib", "promote-log.js"));
    P.appendTrail({ session: "0c0ffee0-0000-4000-8000-000000000001", action: "written", slug: "tide-api-notes", type: "reference", title: "Tide API notes" });
    P.appendTrail({ session: "0c0ffee0-0000-4000-8000-000000000001", action: "kept", slug: "tide-api-notes", type: "reference", title: "Tide API notes" });
    P.appendTrail({ session: "5e55a0a0-0000-4000-8000-00000000000b", action: "written", slug: "release-checklist", type: "reference", title: "Release checklist" });
  } finally {
    for (const k of ["AOS_VAULT", "AOS_CONFIG", "CLAUDE_CONFIG_DIR", "HOME"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  }
});

// ── 9. the runtime builds the caches ──────────────────────────────────

stage("aos skills sync", () => aos(["skills", "sync"]).trim().split("\n")[0]);
stage("aos agents sync", () => aos(["agents", "sync"]).trim().split("\n")[0]);
stage("aos routines sync (launchctl stubbed)", () => aos(["routines", "sync"]).trim().split("\n").slice(0, 2).join(" / "));
// launchd and the session hooks run these without AOS_HEADLESS (hook-entry scripts exit at once under it).
stage("aos routines run nightly-scan", () => aos(["routines", "run", "nightly-scan"], { env: USER_ENV(), timeout: 180_000 }).trim().split("\n").pop(), { optional: true });
stage("aos routines run heartbeat (persona watchdog)", () => aos(["routines", "run", "heartbeat"], { env: USER_ENV() }).trim().split("\n").pop(), { optional: true });
stage("aos routines import-cloud (a Claude Code cloud routines snapshot)", () => {
  const file = path.join(OUT, "cloud-routines.json");
  writeJson(file, {
    data: [
      { id: "trig_sample_01", name: "Weekly chart digest", cron_expression: "0 13 * * 1", enabled: true, next_run_at: new Date(NOW.getTime() + 3 * DAY).toISOString(), last_fired_at: ago(4 * DAY).toISOString(), ended_reason: "", derived_state: { model: "claude-sonnet-5", prompt: "Summarise the chart changes.\nMore." }, job_config: { ccr: { session_context: { model: "claude-sonnet-5", sources: [{ git_repository: { url: "https://github.com/example/harbor-map" } }] } } } },
      { id: "trig_sample_02", name: "Launch-day check", run_once_at: ago(10 * DAY).toISOString(), enabled: false, last_fired_at: ago(10 * DAY).toISOString(), ended_reason: "run_once_fired", derived_state: { model: "claude-sonnet-5" }, job_config: { ccr: { session_context: { sources: [] } } } },
    ],
    has_more: false,
  });
  const out = aos(["routines", "import-cloud", file]).trim();
  fs.rmSync(file);
  return out;
});
stage("aos routines hosts --refresh", () => aos(["routines", "hosts", "--refresh"]).trim().split("\n")[0], { optional: true });
stage("heartbeat-writer.js (staff heartbeats)", () => run(NODE, [path.join(SCRIPTS, "heartbeat-writer.js")], { env: HOOK_ENV() }).trim().split("\n")[0], { optional: true });
stage("proposal-html.js (proposal pages)", () => brainScript("persona/proposal-html.js").trim().split("\n").slice(-1)[0], { optional: true });
stage("scan-vault.js --quiet", () => brainScript("scan-vault.js", ["--quiet"], { env: USER_ENV(), timeout: 300_000 }).trim().split("\n").slice(-1)[0]);
stage("build-brain-md.js", () => brainScript("build-brain-md.js").trim().split("\n").slice(-1)[0]);
stage("recall --warm", () => brainScript("sdk/recall-cli.js", ["--warm"], { timeout: 120_000 }).trim().split("\n").slice(-1)[0], { optional: true });

// A proposal filed after the last scan: its row says the page appears after the next one.
stage("a proposal filed after the scan", () => {
  write(v(`persona/proposals/${PROPOSALS[2].name}`), `---\nfiled: ${day(-1)}\ntarget: somewhere in the HUD\nkind: product\n---\n# An idea with loose ends\n\n## What\nAn idea with no surface, no recipe and no premises.\n`);
});

// A flag the monitor duty would leave in STATE.md (the status bar's "1 flag" opens it).
stage("persona STATE.md flag", () => {
  const f = v("persona/STATE.md");
  const text = fs.readFileSync(f, "utf8");
  if (!/^## Flags[ \t]*$/m.test(text)) throw new Error("STATE.md has no ## Flags section");
  fs.writeFileSync(f, text.replace(/^## Flags[ \t]*$/m, `## Flags\n- [ ] The nightly backup has not reported for two days (monitor, ${day(-1)})`));
});

stage("statusline.js refresh", () => brainScript("statusline.js", ["refresh"]).trim().split("\n").slice(-1)[0]);

// ── 10. what the specs assert, read back from the runtime where it has an answer ──

const expected = {};
stage("expected values", () => {
  const parse = (s) => JSON.parse(s);
  expected.generatedAt = NOW.toISOString();
  expected.today = TODAY;
  expected.vault = VAULT;
  expected.home = HOME;
  expected.persona = PERSONA;
  expected.todo = {
    open: Object.values(TODO).flat().length,
    overdue: TODO.overdue.length, today: TODO.today.length, upcoming: TODO.upcoming.length, someday: TODO.someday.length,
    badge: TODO.overdue.length + TODO.today.length,
    doneThisWeek: 1,
    tags: [...new Set(Object.values(TODO).flat().map((x) => x[3]).filter(Boolean))].sort(),
    items: TODO,
  };
  expected.proposals = { pending: PROPOSALS.map((p) => ({ ...p })) };
  try { expected.proposals.ledger = parse(brainScript("persona/ledger.js", ["summary", "--json"])); } catch (e) { expected.proposals.ledgerError = String(e.message).slice(0, 200); }
  const pages = fs.existsSync(v("brain/_index/proposals")) ? fs.readdirSync(v("brain/_index/proposals")).filter((f) => f.endsWith(".html")) : [];
  expected.proposals.pages = pages;
  const backlog = fs.readFileSync(v("persona/backlog.md"), "utf8");
  expected.proposals.backlog = [...backlog.matchAll(/^## (\S+) · (\S+) · (\S+)\s*$/gm)].map((m) => ({ filed: m[1], kind: m[2], slug: m[3] }));
  const req = createRequire(import.meta.url);
  const N = req(path.join(SCRIPTS, "lib", "notifications.js"));
  const all = N.list(VAULT, { archived: true });
  expected.notifications = {
    items: all.items.map(({ id, from, level, title, created, read, archived }) => ({ id, from, level, title, created, read, archived })),
    unread: all.items.filter((i) => !i.read && !i.archived).length,
    total: all.items.filter((i) => !i.archived).length,
    archived: all.items.filter((i) => i.archived).length,
    unreadable: all.unreadable,
    senders: [...new Set(all.items.map((i) => i.from))].sort(),
  };
  try { expected.config = parse(aos(["config", "list", "--json"])); } catch (e) { expected.configError = String(e.message).slice(0, 200); }
  try { expected.teams = parse(aos(["team", "list", "--json"])); } catch (e) { expected.teamsError = String(e.message).slice(0, 200); }
  expected.teamItems = TEAM_ITEMS;
  expected.runs = RUNS.map((r) => r.id);
  expected.snapshot = parse(fs.readFileSync(v("brain/_index/snapshot.json"), "utf8")).scannedAt;
});

writeJson(path.join(OUT, "expected.json"), expected);
writeJson(path.join(OUT, "env.json"), ENV());
writeJson(path.join(OUT, "stages.json"), stages);

const failed = stages.filter((s) => !s.ok);
log(`\n${stages.length - failed.length}/${stages.length} stages ok${failed.length ? `; tolerated: ${failed.map((s) => s.stage).join(", ")}` : ""}`);
log(`vault ${VAULT}\nhome  ${HOME}`);
