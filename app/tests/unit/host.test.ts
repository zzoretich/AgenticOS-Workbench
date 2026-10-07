import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAppUrl } from "../../src/main/app-scheme";
import { parseAgenticosUrl, urlFromArgv } from "../../src/main/protocol";
import { trayTitle } from "../../src/main/tray";
import { accelerator } from "../../src/main/menu";
import { loadWriteSettings } from "../../src/main/write-settings";
import { SURFACES } from "../../src/main/policy/write-policy";
import * as os from "node:os";
import * as path from "node:path";
import { isIgnored } from "../../compat/src/ignore";
import { fuzzyScore } from "../../compat/src/modal";
import { normalizePath } from "../../compat/src/files";
import { opensOutside } from "../../compat/src/markdown";

test("agenticos:// links parse into an action and safe params", () => {
  assert.deepEqual(parseAgenticosUrl("agenticos://workbench?tab=proposals"), { action: "workbench", params: { tab: "proposals" } });
  assert.deepEqual(parseAgenticosUrl("agenticos://note?file=brain%2Fmemory%2Fuser%2Fprofile.md"), { action: "note", params: { file: "brain/memory/user/profile.md" } });
  assert.deepEqual(parseAgenticosUrl("agenticos:/workbench?tab=runs"), { action: "workbench", params: { tab: "runs" } });
  assert.equal(parseAgenticosUrl("obsidian://agenticos?tab=pulse"), null, "other scheme");
  assert.equal(parseAgenticosUrl("agenticos://%3Cscript%3E"), null, "bad action");
  assert.equal(parseAgenticosUrl("not a url"), null);
  assert.deepEqual(parseAgenticosUrl("agenticos://workbench?tab=x&bad%20key=1")?.params, { tab: "x" }, "odd keys dropped");
});

test("a link reaches a second instance through argv", () => {
  assert.equal(urlFromArgv(["/Applications/AgenticOS.app/Contents/MacOS/AgenticOS", "agenticos://workbench?tab=todo"]), "agenticos://workbench?tab=todo");
  assert.equal(urlFromArgv(["electron", "."]), null);
});

test("app://hud serves only the files under the renderer folder", () => {
  const root = path.join(os.tmpdir(), "out", "renderer");
  assert.equal(resolveAppUrl(root, "app://hud/index.html"), path.join(root, "index.html"));
  assert.equal(resolveAppUrl(root, "app://hud/hud.js?v=1#x"), path.join(root, "hud.js"), "query and hash ignored");
  assert.equal(resolveAppUrl(root, "app://hud/a%20b.css"), path.join(root, "a b.css"));
  assert.equal(resolveAppUrl(root, "app://hud/../main/index.js"), path.join(root, "main", "index.js"), "the URL parser drops the dot segment");
  assert.equal(resolveAppUrl(root, "app://hud/..%2Fmain%2Findex.js"), null, "an encoded way out of the folder");
  assert.equal(resolveAppUrl(root, "app://hud/%2e%2e/%2e%2e/secret"), path.join(root, "secret"));
  assert.equal(resolveAppUrl(root, "app://hud/x%00.js"), null, "NUL");
  assert.equal(resolveAppUrl(root, "app://hud/%E0%A4%A"), null, "bad escape");
  assert.equal(resolveAppUrl(root, "app://hud/"), null, "the folder itself");
  assert.equal(resolveAppUrl(root, "app://other/index.html"), null, "another host");
  assert.equal(resolveAppUrl(root, "file:///etc/passwd"), null, "another scheme");
  assert.equal(resolveAppUrl(root, "not a url"), null);
});

test("the tray title shows the two most important segments", () => {
  const seg = (text: string, tone: "violet" | "rose" | "amber" | "cyan" | "dim") => ({ text, tone, title: text });
  assert.equal(trayTitle([]), "", "the mark alone");
  assert.equal(trayTitle([seg("◆ gate site-02", "violet"), seg("1 alert", "amber"), seg("▶ builder", "cyan")]), " ◆ gate site-02 · 1 alert");
  assert.equal(trayTitle([seg("14 drafts", "dim")]), "", "dim segments stay in the menu");
  assert.equal(trayTitle([seg("◆ gate a-very-long-item-name-that-goes-on", "violet")]).length <= 30, true);
  // A build without the mark's image: a glyph stands in for it.
  assert.equal(trayTitle([], false), "◉");
  assert.equal(trayTitle([seg("1 alert", "amber")], false), "◉ 1 alert");
});

test("Obsidian hotkeys become Electron accelerators", () => {
  assert.equal(accelerator({ id: "a", name: "A", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }] }), "CmdOrCtrl+Shift+M");
  assert.equal(accelerator({ id: "a", name: "A" }), undefined);
});

test("the index and watchers skip what Obsidian skips", () => {
  assert.equal(isIgnored(".obsidian/app.json"), true);
  assert.equal(isIgnored("brain/scripts/node_modules/x/README.md"), true);
  assert.equal(isIgnored("workspaces/_worktrees/item/member/file.md"), true);
  assert.equal(isIgnored("brain/_index/.graph.lock.json"), true);
  assert.equal(isIgnored("brain/_index/statusline.json"), false);
  assert.equal(isIgnored("TODO.md"), false);
});

test("fuzzy search matches in order and prefers runs", () => {
  assert.equal(fuzzyScore("xyz", "Open Workbench"), null);
  const tight = fuzzyScore("work", "Open Workbench")!.score;
  const loose = fuzzyScore("work", "Open Worker Bench kit")!.score;
  assert.ok(tight >= loose);
  assert.ok(fuzzyScore("owb", "Open Workbench"));
});

test("a vault link to a page, PDF or image opens with its default app; notes and text open in a note", () => {
  assert.equal(opensOutside("brain/_index/daily-brief/2026-10-06.html"), true);
  assert.equal(opensOutside("brain/_index/proposals/x.HTM#top"), true, "case and a heading anchor");
  assert.equal(opensOutside("docs/spec.pdf|the spec"), true, "a wiki-link alias");
  assert.equal(opensOutside("assets/diagram.png"), true);
  assert.equal(opensOutside("brain/memory/user/profile.md"), false);
  assert.equal(opensOutside("brain/memory/user/profile"), false, "no extension is a note");
  assert.equal(opensOutside("brain/_index/routines.json"), false, "text shows in a note");
  assert.equal(opensOutside("notes/v1.2 plan"), false, "a dot inside a note name");
});

test("normalizePath matches Obsidian's", () => {
  assert.equal(normalizePath("/brain//memory\\\\user/"), "brain/memory/user");
  assert.equal(normalizePath(""), "/");
});

test("write surfaces: every verified surface by default; AOS_APP_WRITE narrows or widens a run", () => {
  const verified = SURFACES.filter((s) => s.verified).map((s) => s.id);
  assert.deepEqual(loadWriteSettings({}), { surfaces: verified, source: "default" });
  assert.ok(verified.length > 0 && verified.length === SURFACES.length, "every surface is verified today");
  assert.deepEqual(loadWriteSettings({ AOS_APP_WRITE: "todo,chat" }), { surfaces: ["todo", "chat"], source: "AOS_APP_WRITE" });
  assert.deepEqual(loadWriteSettings({ AOS_APP_WRITE: "" }), { surfaces: [], source: "AOS_APP_WRITE" });
  // A surface not verified yet (a new one starts this way) stays off by default; AOS_APP_WRITE can still turn it on
  // for its own tests.
  const fresh = SURFACES.map((s) => (s.id === "chat" ? { ...s, verified: false } : s));
  assert.deepEqual(loadWriteSettings({}, fresh).surfaces, verified.filter((id) => id !== "chat"));
  assert.deepEqual(loadWriteSettings({ AOS_APP_WRITE: "chat" }, fresh).surfaces, ["chat"]);
});
