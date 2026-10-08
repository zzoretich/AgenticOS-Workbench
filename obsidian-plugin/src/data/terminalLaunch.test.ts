import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { createRequire } from "module";
import {
  slugify, isReserved, workspaceStubs, scratchStubs, stubWrites, workspaceNameProblem, gitInitWanted,
  workspacePlace, placeOf, resolvePlace, isContextPlace, vaultPlace, homePlace, parseRepoLink, withRepoLink, repoValue,
  termHostChoices, quickHost, launchLine, launchArgs, previewLine, SCRATCH, menuRows, firstActionable,
} from "./terminalLaunch";
import type { PlaceWorld } from "./terminalLaunch";
import type { AgenticosJson, ProviderState } from "./aosConfig";

const req = createRequire(__filename);
const cli = req(path.resolve(__dirname, "../../../cli/workspace.js")) as {
  slugify(n: string): string; stubs(s: string): Record<string, string>; RESERVED: Set<string>;
};

// ── the port of cli/workspace.js ──

test("slugify matches the CLI", () => {
  for (const name of ["Tide chart", "  My Project!! ", "a/b\\c", "ÜBER app", "---", "", "x_y.z", "2026 plan"]) {
    assert.equal(slugify(name), cli.slugify(name), name);
  }
});

test("the stubs are byte-identical to aos workspace new", () => {
  for (const slug of ["tide-chart", "a", "bz-wedding"]) assert.deepEqual(workspaceStubs(slug), cli.stubs(slug));
});

test("reserved names match the CLI's list and rules", () => {
  assert.deepEqual([...cli.RESERVED].sort(), ["_archive", "research"]);
  assert.equal(isReserved("research", "research"), true);
  assert.equal(isReserved("Archive", "archive"), true); // '_' + slug
  assert.equal(isReserved("_archive", "archive"), true);
  assert.equal(isReserved("research notes", "research-notes"), false);
});

test("workspaceNameProblem: empty is fine (nothing typed yet), symbols only and reserved are refused", () => {
  assert.equal(workspaceNameProblem(""), null);
  assert.equal(workspaceNameProblem("!!"), "Use a letter or digit");
  assert.match(workspaceNameProblem("Research") ?? "", /reserved: try research-notes/);
  assert.equal(workspaceNameProblem("Tide chart"), null);
});

test("scratch's stubs explain Scratch and keep both instruction files identical", () => {
  const s = scratchStubs();
  assert.match(s["README.md"], /^# Scratch/);
  assert.equal(s["CLAUDE.md"], s["AGENTS.md"]);
  assert.match(s["CLAUDE.md"], /Make this a workspace/);
  assert.match(s["CLAUDE.md"], /workspaces\/scratch\//);
});

test("stubWrites follows completeStubs: mirror a lone instruction file, then write what is missing", () => {
  const stubs = workspaceStubs("kite");
  const all = stubWrites(stubs, () => false, () => "");
  assert.deepEqual(all.map((w) => w.name), ["README.md", "CLAUDE.md", "AGENTS.md"]);
  const mirror = stubWrites(stubs, (n) => n === "CLAUDE.md", () => "mine\n");
  assert.deepEqual(mirror, [{ name: "AGENTS.md", data: "mine\n" }, { name: "README.md", data: stubs["README.md"] }]);
  assert.deepEqual(stubWrites(stubs, () => true, () => ""), []);
});

// ── git (T7) ──

test("gitInitWanted: always outside a git vault; inside one only when workspaces/* is ignored and not taken back", () => {
  assert.equal(gitInitWanted(false, null, "kite"), true);
  assert.equal(gitInitWanted(true, null, "kite"), false);
  assert.equal(gitInitWanted(true, "brain/_index/\n", "kite"), false);
  assert.equal(gitInitWanted(true, "# projects\n/workspaces/*\n", "kite"), true);
  assert.equal(gitInitWanted(true, "workspaces/\n", "kite"), true);
  assert.equal(gitInitWanted(true, "/workspaces/*\n!/workspaces/kite\n", "kite"), false);
  assert.equal(gitInitWanted(true, "/workspaces/*\n!/workspaces/kite/\n", "kite"), false);
  assert.equal(gitInitWanted(true, "/workspaces/*\n!/workspaces/kites\n", "kite"), true);
  assert.equal(gitInitWanted(true, "/workspaces/notes.md\n", "kite"), false);
});

// ── places (T4) ──

const home = path.join(path.sep, "h");
const vault = path.join(home, "Vault");
const world: PlaceWorld = { vault, home, workspaces: ["bz-wedding", "notes-only", SCRATCH], links: { "notes-only": path.join(home, "Code", "app") } };

test("workspacePlace uses a linked code folder, and Scratch is its own kind", () => {
  assert.deepEqual(workspacePlace("bz-wedding", world), { kind: "workspace", label: "bz-wedding", dir: path.join(vault, "workspaces", "bz-wedding"), workspace: "bz-wedding" });
  assert.deepEqual(workspacePlace("notes-only", world), { kind: "workspace", label: "notes-only", dir: path.join(home, "Code", "app"), workspace: "notes-only", linked: true });
  assert.equal(workspacePlace(SCRATCH, world).kind, "scratch");
  assert.equal(workspacePlace(SCRATCH, world).label, "Scratch");
});

test("placeOf finds the longest match: a linked folder, a workspace, the vault, home, elsewhere", () => {
  assert.equal(placeOf(path.join(home, "Code", "app", "src"), world).workspace, "notes-only");
  assert.equal(placeOf(path.join(home, "Code", "app"), world).linked, true);
  assert.equal(placeOf(path.join(vault, "workspaces", "bz-wedding", "sub"), world).label, "bz-wedding");
  assert.equal(placeOf(path.join(vault, "workspaces", "notes-only"), world).workspace, "notes-only");
  assert.equal(placeOf(path.join(vault, "workspaces", SCRATCH), world).kind, "scratch");
  assert.equal(placeOf(path.join(vault, "workspaces", "_worktrees", "x"), world).kind, "vault");
  assert.equal(placeOf(vault, world).kind, "vault");
  assert.equal(placeOf(home, world).kind, "home");
  const other = placeOf(path.join(home, "elsewhere", "proj"), world);
  assert.deepEqual([other.kind, other.label], ["other", "proj"]);
});

test("only a workspace counts as context: never Scratch, the vault or home", () => {
  assert.equal(isContextPlace(workspacePlace("bz-wedding", world)), true);
  assert.equal(isContextPlace(workspacePlace(SCRATCH, world)), false);
  assert.equal(isContextPlace(vaultPlace(world)), false);
  assert.equal(isContextPlace(homePlace(world)), false);
  assert.equal(isContextPlace(null), false);
});

test("resolvePlace: picked, then a workspace in view, then the vault (or the choice) per host", () => {
  const base = { scratch: workspacePlace(SCRATCH, world), vault: vaultPlace(world), shellDefault: vaultPlace(world), agentPlace: "vault" as const };
  const ws = workspacePlace("bz-wedding", world);
  assert.deepEqual(resolvePlace({ ...base, host: "claude", picked: ws, context: base.scratch }), { place: ws, why: "picked" });
  assert.deepEqual(resolvePlace({ ...base, host: "codex", context: ws }), { place: ws, why: "context" });
  assert.deepEqual(resolvePlace({ ...base, host: "shell", context: ws }), { place: ws, why: "context" });
  // a selected Vault row (a skill run) never pulls an agent into the vault root
  assert.deepEqual(resolvePlace({ ...base, host: "claude", context: vaultPlace(world) }), { place: base.vault, why: "default" });
  // A selected Scratch terminal does not pull the next one into Scratch.
  assert.deepEqual(resolvePlace({ ...base, host: "codex", context: base.scratch }), { place: base.vault, why: "default" });
  assert.deepEqual(resolvePlace({ ...base, host: "shell", context: base.scratch }), { place: base.shellDefault, why: "default" });
  assert.deepEqual(resolvePlace({ ...base, host: "shell" }), { place: base.shellDefault, why: "default" });
  assert.deepEqual(resolvePlace({ ...base, host: "claude" }).place, base.vault);
  assert.deepEqual(resolvePlace({ ...base, host: "claude", agentPlace: "scratch" }).place, base.scratch);
  assert.deepEqual(resolvePlace({ ...base, host: "claude", agentPlace: "last", lastWorkspace: ws }).place, ws);
  assert.deepEqual(resolvePlace({ ...base, host: "claude", agentPlace: "last", lastWorkspace: null }).place, base.vault);
});

// ── linked code folders (T8) ──

test("parseRepoLink reads repo: from the frontmatter, expands ~, and refuses relative or in-vault paths", () => {
  assert.equal(parseRepoLink("---\nstatus: active\nrepo: ~/Code/app\n---\n# x\n", home, vault), path.join(home, "Code", "app"));
  assert.equal(parseRepoLink('---\nrepo: "/opt/src/app"\n---\n', home, vault), path.resolve("/opt/src/app"));
  assert.equal(parseRepoLink("---\nrepo: Code/app\n---\n", home, vault), null);
  assert.equal(parseRepoLink(`---\nrepo: ${path.join(vault, "workspaces", "x")}\n---\n`, home, vault), null);
  assert.equal(parseRepoLink("# no frontmatter\nrepo: ~/x\n", home, vault), null);
  assert.equal(parseRepoLink(null, home, vault), null);
});

test("withRepoLink adds, replaces and removes the key and keeps the rest", () => {
  assert.equal(withRepoLink(null, "~/Code/app"), '---\nrepo: "~/Code/app"\n---\n');
  assert.equal(withRepoLink("# Notes\n", "~/x"), '---\nrepo: "~/x"\n---\n# Notes\n');
  assert.equal(withRepoLink("---\nstatus: active\nrepo: ~/old\n---\nbody\n", "~/new"), '---\nstatus: active\nrepo: "~/new"\n---\nbody\n');
  assert.equal(withRepoLink("---\nstatus: active\nrepo: ~/old\n---\nbody\n", null), "---\nstatus: active\n---\nbody\n");
  assert.equal(withRepoLink("---\nrepo: ~/old\n---\nbody\n", null), "body\n");
  assert.equal(parseRepoLink(withRepoLink("x", repoValue(path.join(home, "Code", "app"), home)), home, vault), path.join(home, "Code", "app"));
});

test("repoValue writes ~ under home and the absolute path elsewhere", () => {
  assert.equal(repoValue(path.join(home, "Code", "app"), home), "~/Code/app");
  assert.equal(repoValue(path.resolve("/opt/src"), home), path.resolve("/opt/src"));
});

// ── hosts (T2) ──

const both: AgenticosJson = { hosts: { claude: { enabled: true, bin: "/opt/bin/claude" }, codex: { enabled: true } }, codex: { bin: "/opt/bin/codex" } };
const codexOnly: AgenticosJson = { hosts: { claude: { enabled: false }, codex: { enabled: true } } };
const claudeOut: ProviderState = { checkedAt: "", name: "codex", reason: "", claude: { loggedIn: false, checkedAt: "" } };

test("termHostChoices: hides hosts that are off, keeps logged-out ones with why, records the binary, always has Shell", () => {
  const all = termHostChoices(both, null);
  assert.deepEqual(all.map((c) => [c.host, c.hidden, c.ready, c.bin]), [["claude", false, true, "/opt/bin/claude"], ["codex", false, true, "/opt/bin/codex"], ["shell", false, true, null]]);
  const co = termHostChoices(codexOnly, null);
  assert.equal(co[0].hidden, true);
  const out = termHostChoices(both, claudeOut);
  assert.deepEqual([out[0].ready, out[0].reason], [false, "Claude Code is not logged in"]);
});

test("quickHost: the remembered host; else the first ready agent; never another host when the remembered one is not ready", () => {
  assert.deepEqual(quickHost("codex", termHostChoices(both, null)), { host: "codex", reason: null });
  assert.deepEqual(quickHost(null, termHostChoices(both, null)), { host: "claude", reason: null });
  assert.deepEqual(quickHost(null, termHostChoices(codexOnly, null)), { host: "codex", reason: null });
  assert.deepEqual(quickHost("claude", termHostChoices(both, claudeOut)), { host: null, reason: "Claude Code is not logged in" });
  assert.deepEqual(quickHost("shell", termHostChoices(both, claudeOut)), { host: "shell", reason: null });
  // a remembered host that was switched off since: back to the first ready one
  assert.deepEqual(quickHost("claude", termHostChoices(codexOnly, null)), { host: "codex", reason: null });
  assert.deepEqual(quickHost(null, termHostChoices({ hosts: {} }, null)), { host: "shell", reason: null });
});

// ── the launch line (T10, T11) ──

test("launchArgs per host and access level; Host default passes no flags", () => {
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "host", sessionId: "u1" }), ["--session-id", "u1"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: "opus", access: "read" }), ["--model", "opus", "--permission-mode", "plan"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "edit" }), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "run" }), ["--permission-mode", "acceptEdits", "--allowedTools", "Bash"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "host", resume: "last" }), ["--continue"]);
  assert.deepEqual(launchArgs({ host: "claude", bin: null, model: null, access: "host", resume: { id: "u2" }, sessionId: "u3" }), ["--resume", "u2"]);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: null, access: "host" }), []);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: "gpt-6-sol", access: "read" }), ["-m", "gpt-6-sol", "-s", "read-only", "-a", "on-request"]);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: null, access: "edit" }), ["-s", "workspace-write", "-a", "on-request"]);
  assert.deepEqual(launchArgs({ host: "codex", bin: null, model: "x", access: "edit", resume: "last" }), ["resume", "--last"]);
});

test("launchLine: leading space, the not-found guard, exec, quoting of the binary and of glob-like ids", () => {
  const line = launchLine({ host: "claude", bin: "/opt/my apps/claude", model: "claude-opus-5[1m]", access: "host", sessionId: "3f2c-1" });
  assert.equal(line, " command -v '/opt/my apps/claude' >/dev/null 2>&1 && exec '/opt/my apps/claude' --model 'claude-opus-5[1m]' --session-id 3f2c-1 || echo 'Claude Code was not found: run aos doctor'");
  const codex = launchLine({ host: "codex", bin: null, model: null, access: "host", gitInit: true, envPrefix: "CODEX_HOME='/x' " });
  assert.equal(codex, " [ -e .git ] || git init -q; command -v 'codex' >/dev/null 2>&1 && CODEX_HOME='/x' exec 'codex' || echo 'Codex was not found: run aos doctor'");
});

test("previewLine is the short form the menu shows", () => {
  assert.equal(previewLine({ host: "claude", bin: "/a/claude", model: "opus", access: "host", sessionId: "3f2c9d" }), "exec claude --model opus --session-id 3f2c…");
  assert.equal(previewLine({ host: "codex", bin: null, model: null, access: "edit", gitInit: true }), "git init -q; exec codex -s workspace-write -a on-request");
});

// ── the New menu (T3, T6) ──

test("menuRows with no query: Start now per host that is on, then the places, recent, workspaces, New workspace", () => {
  const rows = menuRows({ query: "", host: "claude", choices: termHostChoices(codexOnly, null), world, context: workspacePlace("bz-wedding", world), recent: ["notes-only", "gone"], nowSub: (h) => `sub ${h}` });
  assert.deepEqual(rows.filter((r) => r.kind === "now").map((r) => [r.host, r.kbd, r.sub]), [["codex", "⌥⌘2", "sub codex"], ["shell", "⌥⌘3", "sub shell"]]);
  assert.deepEqual(rows.filter((r) => r.kind !== "now").map((r) => r.key),
    ["h-now", "h-in", "same", "vault", "scratch", "h-recent", "recent-notes-only", "h-ws", "ws-bz-wedding", "ws-notes-only", "new"]);
  assert.match(rows.find((r) => r.key === "vault")?.sub ?? "", /when nothing is picked/);
  // A selected Scratch terminal is not "Same as selected": Scratch is in the list already.
  assert.equal(menuRows({ query: "", host: "claude", choices: termHostChoices(codexOnly, null), world, context: workspacePlace(SCRATCH, world), recent: [], nowSub: () => "" }).some((r) => r.key === "same"), false);
  assert.equal(rows.find((r) => r.key === "ws-notes-only")?.sub, `code: ${path.join(home, "Code", "app")}`);
  assert.equal(firstActionable(rows)?.key, "now-codex");
  // Home is a shell's place only; a logged-out host is listed but cannot be picked
  assert.ok(menuRows({ query: "", host: "shell", choices: termHostChoices(both, claudeOut), world, context: null, recent: [], nowSub: () => "" }).some((r) => r.key === "home"));
  assert.equal(menuRows({ query: "", host: "codex", choices: termHostChoices(both, claudeOut), world, context: null, recent: [], nowSub: () => "" }).find((r) => r.key === "now-claude")?.disabled, true);
});

test("menuRows with a query: an exact name starts there; anything else creates first, with near misses below", () => {
  const base = { host: "codex" as const, choices: termHostChoices(both, null), world, context: null, recent: [], nowSub: () => "" };
  const exact = menuRows({ ...base, query: "BZ Wedding" });
  assert.equal(firstActionable(exact)?.key, "ws-bz-wedding");
  const near = menuRows({ ...base, query: "wedding" });
  assert.equal(firstActionable(near)?.kind, "create");
  assert.equal(firstActionable(near)?.label, "Create workspaces/wedding and start Codex");
  assert.ok(near.some((r) => r.key === "ws-bz-wedding"));
  assert.equal(firstActionable(menuRows({ ...base, query: "scratch" }))?.key, "scratch");
  const reserved = menuRows({ ...base, query: "research" });
  assert.deepEqual([reserved[0].kind, reserved[0].disabled], ["create", true]);
  assert.equal(menuRows({ ...base, host: "shell", query: "kite" })[0].label, "Create workspaces/kite and open a shell");
});
