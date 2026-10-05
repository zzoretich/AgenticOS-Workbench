import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { SURFACES, SURFACE_IDS, WritePolicy, globToRegExp, parseSurfaces } from "../../src/main/policy/write-policy";

const VAULT = "/vaults/demo";
const v = (rel: string) => `${VAULT}/${rel}`;

test("globs: * stays in one segment, /** is the folder and everything below it", () => {
  const g = (glob: string, p: string) => globToRegExp(glob).test(p);
  assert.equal(g("TODO.md", "TODO.md"), true);
  assert.equal(g("TODO.md", "TODOxmd"), false, "the dot is literal");
  assert.equal(g("brain/routines/*.md", "brain/routines/tick.md"), true);
  assert.equal(g("brain/routines/*.md", "brain/routines/sub/tick.md"), false);
  assert.equal(g("brain/memory/**", "brain/memory"), true);
  assert.equal(g("brain/memory/**", "brain/memory/user/profile.md"), true);
  assert.equal(g("brain/memory/**", "brain/memoryx/a.md"), false);
  assert.equal(g("**/x.json", "x.json"), true);
  assert.equal(g("**/x.json", "a/b/x.json"), true);
  assert.equal(g("a?.md", "ab.md"), true);
  assert.equal(g("a?.md", "a/.md"), false);
});

test("every surface cites its HUD module and names at least one write or command", () => {
  assert.ok(SURFACES.length > 0);
  for (const s of SURFACES) {
    assert.match(s.id, /^[a-z]+$/, s.id);
    assert.ok(s.label && s.source, s.id);
    assert.ok(s.writes.length + s.spawns.length > 0, s.id);
    for (const r of s.spawns) assert.ok(!!r.script !== !!r.bin, `${s.id}: a rule names a script or a program, not both`);
    for (const w of [...s.writes, ...(s.except ?? [])]) assert.ok(!w.startsWith("/") && !w.split("/").includes(".."), `${s.id}: ${w} is vault-relative`);
    if (s.scope === "editor") assert.equal(s.spawns.length, 0, `${s.id}: the editor runs nothing`);
  }
  assert.equal(new Set(SURFACE_IDS).size, SURFACE_IDS.length, "ids are unique");
});

test("AOS_APP_WRITE parses into known surfaces; all means every one; unknown ids are reported", () => {
  assert.deepEqual(parseSurfaces("todo"), { ids: ["todo"], unknown: [] });
  assert.deepEqual(parseSurfaces(" todo , nope ,"), { ids: ["todo"], unknown: ["nope"] });
  assert.deepEqual(parseSurfaces(""), { ids: [], unknown: [] });
  assert.deepEqual(parseSurfaces(undefined), { ids: [], unknown: [] });
  assert.deepEqual(parseSurfaces("all").ids, [...SURFACE_IDS]);
  assert.deepEqual(parseSurfaces(["todo", "todo"]).ids, ["todo"]);
});

test("with no surface on, nothing in the vault may be written", () => {
  const p = new WritePolicy(VAULT, []);
  assert.deepEqual(p.ids, []);
  for (const rel of ["TODO.md", "MEMORY.md", "brain/config.json", "brain/notifications/state.json"]) assert.equal(p.canWrite(v(rel)), false, rel);
});

test("To-Do may write TODO.md and nothing that only looks like it", () => {
  const p = new WritePolicy(VAULT, ["todo"]);
  assert.equal(p.canWrite(v("TODO.md")), true);
  assert.equal(p.canWrite(`${VAULT}/brain/../TODO.md`), true, "the same file, spelled with ..");
  assert.equal(p.canWrite(`${VAULT}//TODO.md`), true);
  for (const target of [
    v("TODO.md.bak"), v("TODO.mdx"), v("todo.md"), v("sub/TODO.md"), v("TODO.md/x"),
    `${VAULT}-evil/TODO.md`, "/vaults/demox/TODO.md", `${VAULT}/../demo-evil/TODO.md`, "/TODO.md",
    `${VAULT}/TODO.md/../brain/config.json`, `${VAULT}/brain/../../TODO.md`,
    "TODO.md", "./TODO.md", "", VAULT, `${VAULT}/`, `${VAULT}/TODO.md\0.png`,
  ]) assert.equal(p.canWrite(target), false, JSON.stringify(target));
  assert.equal(p.canWrite(undefined), false);
  assert.equal(p.canWrite(3), false, "a descriptor is not a path");
});

test("paths as Buffers and file: URLs are checked like strings", () => {
  const p = new WritePolicy(VAULT, ["todo"]);
  assert.equal(p.canWrite(Buffer.from(v("TODO.md"))), true);
  assert.equal(p.canWrite(Buffer.from(v("MEMORY.md"))), false);
  assert.equal(p.canWrite(pathToFileURL(v("TODO.md"))), true);
  assert.equal(p.canWrite(new URL("https://example.com/TODO.md")), false);
});

test("a vault reached through a symlink is the same vault under either spelling", () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "aos-policy-"));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  try {
    const p = new WritePolicy(link, ["todo"]);
    assert.equal(p.canWrite(path.join(link, "TODO.md")), true);
    assert.equal(p.canWrite(path.join(fs.realpathSync(real), "TODO.md")), true);
    assert.equal(p.canWrite(path.join(link, "MEMORY.md")), false);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("no vault, or a relative one, allows nothing", () => {
  assert.equal(new WritePolicy(null, ["todo"]).canWrite("/TODO.md"), false);
  assert.equal(new WritePolicy("vault", ["todo"]).canWrite(path.resolve("vault/TODO.md")), false);
});

test("unknown surface names enable nothing", () => {
  const p = new WritePolicy(VAULT, ["nope", "TODO"]);
  assert.deepEqual(p.ids, []);
  assert.equal(p.canWrite(v("TODO.md")), false);
});

test("a folder may be created where an allowed file could live, and nowhere else", () => {
  const p = new WritePolicy(VAULT, ["capture", "notifications", "routines"]);
  for (const rel of ["brain", "brain/memory", "brain/memory/user", "brain/memory/feedback/_drafts", "brain/patterns", "brain/_index", "brain/notifications", "brain/routines"]) {
    assert.equal(p.canMakeFolder(v(rel)), true, rel);
  }
  for (const rel of ["persona", "brain/routines/sub", "brain/notifications/x", "brain/_index/agent-runs", "brain/memoryx"]) {
    assert.equal(p.canMakeFolder(v(rel)), false, rel);
  }
  assert.equal(p.canWrite(v("brain/memory/user")), false, "a folder it may create is not one it may remove");
  assert.equal(new WritePolicy(VAULT, ["todo"]).canMakeFolder(v("brain")), false);
});

test("capture writes Markdown under brain/memory only, whatever the typed slug", () => {
  const p = new WritePolicy(VAULT, ["capture"]);
  assert.equal(p.canWrite(v("brain/memory/user/tide-tables.md")), true);
  assert.equal(p.canWrite(v("brain/memory/user/sub/deep.md")), true);
  assert.equal(p.canWrite(v("brain/patterns/testing.md")), true);
  assert.equal(p.canWrite(v("brain/_index/SESSION.md")), true);
  assert.equal(p.canWrite(`${VAULT}/brain/memory/user/../../../TODO.md`), false, "a slug of ../../../TODO");
  assert.equal(p.canWrite(`${VAULT}/brain/memory/user/../../config.json`), false);
  assert.equal(p.canWrite(v("brain/memory/user/x.json")), false);
  assert.equal(p.canWrite(v("brain/_index/BRAIN.md")), false);
});

const NODE = "/usr/local/bin/node";
const S = `${VAULT}/brain/scripts`;
const expect = JSON.stringify({ ts: "2026-09-29T10:00:00Z", id: "harbor-01" });

/** A command each surface runs, and one it must never run. */
const COMMANDS: Record<string, { ok: Array<[string, string[]]>; no: Array<[string, string[]]> }> = {
  notifications: { ok: [], no: [] },
  settings: {
    ok: [[NODE, [`${S}/cli/aos.js`, "config", "set", "claude.model", "opus", "--json"]], [NODE, [`${S}/cli/aos.js`, "config", "set", "recallRoots", '["a","b"]', "--json"]],
      [NODE, [`${S}/cli/aos.js`, "config", "unset", "cost.monthlyBudget", "--json"]], [NODE, [`${S}/cli/aos.js`, "routines", "sync"]],
      [NODE, [`${S}/cli/aos.js`, "statusline", "install"]], ["/bin/zsh", ["-lic", "command -v node"]]],
    no: [[NODE, [`${S}/cli/aos.js`, "config", "set", "--vault", "x", "--json"]], [NODE, [`${S}/cli/aos.js`, "config", "set", "a", "b"]],
      [NODE, [`${S}/cli/aos.js`, "uninstall"]], [NODE, [`${S}/cli/aos.js`, "upgrade"]], ["/bin/zsh", ["-lic", "rm -rf ~"]], ["/bin/zsh", ["-c", "command -v node"]]],
  },
  routines: {
    ok: [[NODE, [`${S}/cli/aos.js`, "routines", "sync"]], [NODE, [`${S}/routines/run-routine.js`, "morning-brief", "--manual"]]],
    no: [[NODE, [`${S}/routines/run-routine.js`, "../x", "--manual"]], [NODE, [`${S}/routines/run-routine.js`, "tick"]], [NODE, [`${S}/cli/aos.js`, "routines", "uninstall"]]],
  },
  sharing: {
    ok: [[NODE, [`${S}/cli/aos.js`, "skills", "exclude", "agenticos:wrap"]], [NODE, [`${S}/cli/aos.js`, "agents", "include", "dev-linus"]]],
    no: [[NODE, [`${S}/cli/aos.js`, "skills", "exclude", "--all"]], [NODE, [`${S}/cli/aos.js`, "skills", "remove", "x"]]],
  },
  pulse: {
    ok: [[NODE, [`${S}/auto-cost.js`, "--backfill"]], [NODE, [`${S}/heartbeat-writer.js`]], [NODE, [`${S}/graph-build.js`, "--quiet"]], [NODE, [`${S}/build-brain-md.js`]],
      [NODE, [`${S}/cost-budget.js`, "--anchor", "12.5"]], [NODE, [`${S}/sdk/reflect-week.js`, "--local"]], [NODE, [`${S}/map-workspace.js`, "harbor app"]]],
    no: [[NODE, [`${S}/cost-budget.js`, "--anchor", "-3"]], [NODE, [`${S}/cost-budget.js`, "--reset"]], [NODE, [`${S}/sdk/reflect-week.js`]]],
  },
  spaces: {
    ok: [[NODE, [`${S}/map-workspace.js`, "harbor"]], [NODE, [`${S}/map-workspace.js`, "harbor", "--file", "src/tide.ts"]], [NODE, [`${S}/regen-workspace-insight.js`, "harbor"]]],
    no: [[NODE, [`${S}/map-workspace.js`, "--all"]], [NODE, [`${S}/map-workspace.js`, "../../etc"]]],
  },
  teams: {
    ok: [[NODE, [`${S}/team.js`, "init"]], [NODE, [`${S}/team.js`, "gate", "approve", "example", "harbor-01", "--expect", expect]],
      [NODE, [`${S}/team.js`, "gate", "approve", "example", "harbor-01", "--expect", expect, "--usd", "5"]],
      [NODE, [`${S}/team.js`, "budget", "example", "harbor-01", "12", "--expect", expect]], [NODE, [`${S}/team.js`, "pause", "example"]],
      [NODE, [`${S}/team.js`, "resume", "example", "dev-woz"]], [NODE, [`${S}/team.js`, "set", "example", "dev-woz", "model", "claude-opus-5-5[1m]"]],
      [NODE, [`${S}/team.js`, "member", "remove", "example", "dev-woz"]], [NODE, [`${S}/team.js`, "post", "example", "--from", "user", "--kind", "note", "@lead ship it"]]],
    no: [[NODE, [`${S}/team.js`, "gate", "approve", "example", "harbor-01"]], [NODE, [`${S}/team.js`, "budget", "example", "harbor-01", "12"]],
      // A message that merely contains the flag is not the flag.
      [NODE, [`${S}/team.js`, "gate", "approve", "example", "harbor-01", `note --expect ${expect}`]],
      [NODE, [`${S}/team.js`, "post", "example", "--from", "lead", "--kind", "note", "hi"]], [NODE, [`${S}/team.js`, "gate", "redirect", "example", "harbor-01", "--expect", expect]],
      [NODE, [`${S}/team.js`, "disband", "example"]]],
  },
  chat: {
    ok: [[NODE, [`${S}/sdk/recall-cli.js`, "where are the tide notes?"]],
      // One leading dash is text to both scripts, as in Obsidian: a question typed as a bullet.
      [NODE, [`${S}/sdk/recall-cli.js`, "- what is due?"]], [NODE, [`${S}/sdk/ask.js`, "--local", "-v means verbose?"]],
      ["/opt/me/.local/bin/claude", ["-p", "QUESTION: hi", "--model", "sonnet", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "You answer.", "--max-budget-usd", "0.25", "--output-format", "json"]],
      ["claude", ["-p", "QUESTION: hi", "--model", "sonnet", "--effort", "high", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "You answer.", "--max-budget-usd", "0.25", "--output-format", "json"]]],
    no: [["claude", ["-p", "hi"]], ["claude", ["-p", "QUESTION: hi", "--model", "sonnet", "--tools", "Bash", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "x", "--max-budget-usd", "0.25", "--output-format", "json"]],
      ["claude", ["-p", "QUESTION: hi", "--model", "sonnet", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--system-prompt", "x", "--max-budget-usd", "0.25", "--output-format", "json", "--dangerously-skip-permissions"]],
      [NODE, [`${S}/sdk/ask.js`, "hi"]], [NODE, [`${S}/sdk/recall-cli.js`, "--dump"]],
      // Whole `--…` arguments are the scripts' flags: a rebuild, or ask.js printing a file as its answer.
      [NODE, [`${S}/sdk/recall-cli.js`, "--warm"]], [NODE, [`${S}/sdk/ask.js`, "--local", "--write=/etc/hosts"]], [NODE, [`${S}/sdk/ask.js`, "--local", ""]],
      [NODE, [`${S}/sdk/recall-cli.js`, "tides", "--limit", "50"]]],
  },
};

test("each surface's commands run only while it is on; its look-alikes never", () => {
  const none = new WritePolicy(VAULT, []);
  const all = new WritePolicy(VAULT, [...SURFACE_IDS]);
  for (const [id, { ok, no }] of Object.entries(COMMANDS)) {
    assert.ok(SURFACE_IDS.includes(id), id);
    const on = new WritePolicy(VAULT, [id]);
    for (const [cmd, args] of ok) {
      assert.equal(on.canSpawn(cmd, args), true, `${id} on: ${cmd} ${args.join(" ")}`);
      assert.equal(none.canSpawn(cmd, args), false, `nothing on: ${cmd} ${args.join(" ")}`);
    }
    for (const [cmd, args] of no) assert.equal(all.canSpawn(cmd, args), false, `never: ${cmd} ${args.join(" ")}`);
  }
});

test("a relative script runs only against the vault it resolves into", () => {
  const p = new WritePolicy(VAULT, ["chat"]);
  assert.equal(p.canSpawn(NODE, ["brain/scripts/sdk/ask.js", "--local", "hi"], VAULT), true, "askSpawner: relative, cwd = the vault");
  assert.equal(p.canSpawn(NODE, ["brain/scripts/sdk/ask.js", "--local", "hi"]), false, "no cwd");
  assert.equal(p.canSpawn(NODE, ["brain/scripts/sdk/ask.js", "--local", "hi"], "/elsewhere"), false);
  assert.equal(p.canSpawn(NODE, ["../brain/scripts/sdk/ask.js", "--local", "hi"], `${VAULT}/persona`), true, "resolves into this vault");
  assert.equal(p.canSpawn(NODE, ["brain/scripts/sdk/ask.js", "--local", "hi"], "relative/cwd"), false);
});

test("settings may create the live-runs folder and summary log, and nothing else under agent-runs", () => {
  const p = new WritePolicy(VAULT, ["settings"]);
  assert.equal(p.canMakeFolder(v("brain/_index/agent-runs/live")), true);
  assert.equal(p.canMakeFolder(v("brain/_index/agent-runs")), true);
  assert.equal(p.canWrite(v("brain/_index/agent-runs/runs.jsonl")), true);
  assert.equal(p.canWrite(v("brain/_index/agent-runs/live")), false, "creating is not removing");
  assert.equal(p.canWrite(v("brain/_index/agent-runs/live/run-1.jsonl")), false);
  assert.equal(p.canMakeFolder(v("brain/_index/agent-runs/other")), false);
  assert.equal(new WritePolicy(VAULT, []).canMakeFolder(v("brain/_index/agent-runs/live")), false);
});

test("Notes lets the note editor save Markdown notes, never the runtime's or vendored files, and nothing else", () => {
  const p = new WritePolicy(VAULT, ["notes"]);
  for (const rel of ["TODO.md", "MEMORY.md", "brain/memory/projects/harbor-map.md", "persona/IDENTITY.md", "2026/2026-09-September/2026-09-29.md"]) {
    assert.equal(p.canSave(v(rel)), true, rel);
  }
  assert.equal(p.canSave(`${VAULT}/brain/_index/../../TODO.md`), true, "resolved before matching");
  for (const target of [
    v("brain/_index/BRAIN.md"), v("brain/_index/proposals/x.md"), v("brain/scripts/README.md"), v(".obsidian/x.md"), v(".git/x.md"),
    v("tools/node_modules/pkg/README.md"), v("TODO.md.bak"), v("brain/config.json"), v("TODO.mdx"), "/elsewhere/TODO.md",
    `${VAULT}/../TODO.md`, "TODO.md", `${VAULT}/brain/memory/../_index/BRAIN.md`,
    // Every dot-path (S7): hidden from the tree, and where the hosts read project config.
    v("notes/.hidden.md"), v(".claude/agents/x.md"), v("workspaces/app/.claude/commands/x.md"), v(".codex/AGENTS.md"),
  ]) assert.equal(p.canSave(target), false, target);
});

test("Files never writes or creates a dot-path: a compromised page cannot plant a host's project config", () => {
  const p = new WritePolicy(VAULT, ["files"]);
  for (const rel of ["workspaces/app/PLAN.md", "notes/a.md", "a/b/c/d.txt", "x.y/z.md"]) assert.equal(p.canWrite(v(rel)), true, rel);
  for (const rel of [".claude/settings.json", ".claude/settings.local.json", ".mcp.json", "workspaces/app/.mcp.json", "workspaces/app/.claude/settings.json",
    ".codex/config.toml", ".git/hooks/pre-commit", ".envrc", "a/.vscode/tasks.json", ".obsidian/app.json"]) assert.equal(p.canWrite(v(rel)), false, rel);
  for (const rel of [".claude", "workspaces/app/.claude", ".git/hooks"]) assert.equal(p.canMakeFolder(v(rel)), false, rel);
  assert.equal(p.canMakeFolder(v("workspaces/new")), true);
});

test("switching Notes on never widens what the HUD may write, and a HUD surface never lets the editor save", () => {
  const notes = new WritePolicy(VAULT, ["notes"]);
  for (const rel of ["TODO.md", "MEMORY.md", "brain/memory/user/x.md", "brain/routines/tick.md"]) assert.equal(notes.canWrite(v(rel)), false, rel);
  assert.equal(notes.canMakeFolder(v("brain/memory/new")), false);
  assert.deepEqual(notes.ids, ["notes"], "the status bar still names it");
  const hud = new WritePolicy(VAULT, SURFACE_IDS.filter((id) => id !== "notes"));
  assert.equal(hud.canWrite(v("TODO.md")), true);
  assert.equal(hud.canSave(v("TODO.md")), false);
});

test("a surface's except globs win over its writes, for the HUD's writes too", () => {
  const table = [{ id: "demo", label: "Demo", source: "test", writes: ["brain/**/*.md"], except: ["brain/_index/**"], spawns: [], verified: true }];
  const p = new WritePolicy(VAULT, ["demo"], table);
  assert.equal(p.canWrite(v("brain/memory/a.md")), true);
  assert.equal(p.canWrite(v("brain/_index/BRAIN.md")), false);
  assert.equal(p.canSave(v("brain/memory/a.md")), false, "a HUD surface");
});
