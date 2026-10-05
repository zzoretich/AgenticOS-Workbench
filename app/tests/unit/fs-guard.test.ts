// The fs guard and the compat DataAdapter against a real temporary vault: what the policy allows reaches the disk,
// what it refuses is logged and leaves the disk as it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { guardState, setWriteGuard } from "../../compat/src/guard";
import { DataAdapter, Vault } from "../../compat/src/vault";
import { WritePolicy } from "../../src/shared/write-policy";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("../../src/renderer/guard/fs.cjs") as typeof realFs;

const VAULT = realFs.realpathSync(realFs.mkdtempSync(path.join(os.tmpdir(), "aos-fs-guard-")));
const v = (rel: string) => path.join(VAULT, rel);
const OUTSIDE = `${VAULT}-outside.md`;

process.on("exit", () => { realFs.rmSync(VAULT, { recursive: true, force: true }); realFs.rmSync(OUTSIDE, { force: true }); });

function reset(surfaces: string[]): void {
  for (const n of realFs.readdirSync(VAULT)) realFs.rmSync(v(n), { recursive: true, force: true });
  realFs.writeFileSync(v("TODO.md"), "# To-Do\n");
  realFs.writeFileSync(v("MEMORY.md"), "# Memory\n");
  realFs.mkdirSync(v("brain"));
  setWriteGuard(new WritePolicy(VAULT, surfaces));
  guardState().log.length = 0;
}

const refusedWith = (fn: () => unknown) => assert.throws(fn, (e: NodeJS.ErrnoException) => e.code === "EROFS");
const logged = () => guardState().log.map((e) => e.what);

test("with To-Do on, fs writes TODO.md and refuses everything else, leaving it untouched", async () => {
  reset(["todo"]);
  fs.writeFileSync(v("TODO.md"), "a\n");
  fs.appendFileSync(v("TODO.md"), "b\n");
  await fs.promises.writeFile(v("TODO.md"), "c\n");
  await fs.promises.appendFile(v("TODO.md"), "d\n");
  assert.equal(realFs.readFileSync(v("TODO.md"), "utf8"), "c\nd\n");

  refusedWith(() => fs.writeFileSync(v("MEMORY.md"), "x"));
  refusedWith(() => fs.writeFileSync(v("brain/new.md"), "x"));
  refusedWith(() => fs.writeFileSync(OUTSIDE, "x"));
  refusedWith(() => fs.unlinkSync(v("MEMORY.md")));
  refusedWith(() => fs.rmSync(v("brain"), { recursive: true }));
  await assert.rejects(fs.promises.writeFile(v("MEMORY.md"), "x"), { code: "EROFS" });
  await assert.rejects(fs.promises.rm(v("MEMORY.md")), { code: "EROFS" });
  assert.equal(realFs.readFileSync(v("MEMORY.md"), "utf8"), "# Memory\n");
  assert.equal(realFs.existsSync(v("brain/new.md")), false);
  assert.equal(realFs.existsSync(OUTSIDE), false);
  assert.equal(realFs.existsSync(v("brain")), true);
  assert.equal(logged().length, 7);
  assert.ok(logged().every((w) => w.startsWith("fs.")), logged().join("\n"));
});

test("with nothing on, even TODO.md is refused", async () => {
  reset([]);
  refusedWith(() => fs.writeFileSync(v("TODO.md"), "x"));
  await assert.rejects(fs.promises.writeFile(v("TODO.md"), "x"), { code: "EROFS" });
  assert.equal(realFs.readFileSync(v("TODO.md"), "utf8"), "# To-Do\n");
});

test("a rename or a copy needs every path it writes; a link also needs its target", () => {
  reset(["todo"]);
  refusedWith(() => fs.renameSync(v("TODO.md"), v("brain/TODO.md")));
  refusedWith(() => fs.renameSync(v("MEMORY.md"), v("TODO.md")));
  refusedWith(() => fs.copyFileSync(v("TODO.md"), v("MEMORY.md")));
  assert.equal(realFs.readFileSync(v("TODO.md"), "utf8"), "# To-Do\n");
  assert.equal(realFs.readFileSync(v("MEMORY.md"), "utf8"), "# Memory\n");
  fs.copyFileSync(v("MEMORY.md"), v("TODO.md"));
  assert.equal(realFs.readFileSync(v("TODO.md"), "utf8"), "# Memory\n", "the destination is what a copy writes");
  realFs.rmSync(v("TODO.md"));
  refusedWith(() => fs.symlinkSync(OUTSIDE, v("TODO.md")));
  refusedWith(() => fs.symlinkSync("MEMORY.md", v("TODO.md")));
  assert.equal(realFs.existsSync(v("TODO.md")), false);
  assert.match(logged()[0], /^fs\.renameSync .*TODO\.md → .*brain\/TODO\.md$/);
});

test("opening for writing is checked, string and numeric flags alike; descriptors from an allowed open may write", async () => {
  reset(["todo"]);
  const { O_WRONLY, O_CREAT, O_APPEND, O_RDONLY } = realFs.constants;
  refusedWith(() => fs.openSync(v("MEMORY.md"), "w"));
  refusedWith(() => fs.openSync(v("MEMORY.md"), "r+"));
  refusedWith(() => fs.openSync(v("MEMORY.md"), O_WRONLY | O_CREAT));
  refusedWith(() => fs.openSync(v("MEMORY.md"), O_APPEND));
  await assert.rejects(fs.promises.open(v("MEMORY.md"), "a"), { code: "EROFS" });
  refusedWith(() => fs.createWriteStream(v("MEMORY.md")));
  realFs.closeSync(fs.openSync(v("MEMORY.md"), "r"));
  realFs.closeSync(fs.openSync(v("MEMORY.md"), O_RDONLY));
  realFs.closeSync((fs.openSync as (p: string) => number)(v("MEMORY.md"))); // no flags: read
  const fd = fs.openSync(v("TODO.md"), "a");
  fs.writeFileSync(fd, "via fd\n");
  realFs.closeSync(fd);
  const h = await fs.promises.open(v("TODO.md"), "a");
  await fs.promises.appendFile(h, "via handle\n");
  await h.close();
  assert.equal(realFs.readFileSync(v("TODO.md"), "utf8"), "# To-Do\nvia fd\nvia handle\n");
  assert.equal(realFs.readFileSync(v("MEMORY.md"), "utf8"), "# Memory\n");
});

test("mkdir of an existing folder is a no-op and allowed; a new folder needs a surface", async () => {
  reset([]);
  fs.mkdirSync(v("brain"), { recursive: true });
  await fs.promises.mkdir(v("brain"), { recursive: true });
  refusedWith(() => fs.mkdirSync(v("brain/memory"), { recursive: true }));
  await assert.rejects(fs.promises.mkdir(v("brain/memory")), { code: "EROFS" });
  assert.equal(realFs.existsSync(v("brain/memory")), false);
});

test("callback-style writes report the refusal through the callback", async () => {
  reset(["todo"]);
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => fs.writeFile(v("MEMORY.md"), "x", (e) => resolve(e)));
  assert.equal(err?.code, "EROFS");
  const ok = await new Promise<NodeJS.ErrnoException | null>((resolve) => fs.writeFile(v("TODO.md"), "cb\n", (e) => resolve(e)));
  assert.equal(ok, null);
  assert.equal(realFs.readFileSync(v("TODO.md"), "utf8"), "cb\n");
});

test("the compat DataAdapter and Vault ask the same policy, with vault-relative paths", async () => {
  reset(["todo"]);
  const adapter = new DataAdapter(VAULT);
  await adapter.write("TODO.md", "adapter\n");
  await adapter.append("TODO.md", "more\n");
  await adapter.process("TODO.md", (t) => t.toUpperCase());
  assert.equal(realFs.readFileSync(v("TODO.md"), "utf8"), "ADAPTER\nMORE\n");
  await assert.rejects(adapter.write("MEMORY.md", "x"), { code: "EROFS" });
  await assert.rejects(adapter.write("../outside.md", "x"), { code: "EROFS" });
  await assert.rejects(adapter.write("brain/../MEMORY.md", "x"), { code: "EROFS" });
  await assert.rejects(adapter.rename("TODO.md", "MEMORY.md"), { code: "EROFS" });
  await assert.rejects(adapter.rename("MEMORY.md", "TODO.md"), { code: "EROFS" });
  await assert.rejects(adapter.mkdir("brain/memory"), { code: "EROFS" });
  assert.equal(realFs.readFileSync(v("MEMORY.md"), "utf8"), "# Memory\n");
  assert.deepEqual(guardState().log.map((e) => e.what), [
    "write MEMORY.md", "write ../outside.md", "write brain/../MEMORY.md", "rename MEMORY.md", "rename MEMORY.md", "mkdir brain/memory",
  ]);

  realFs.rmSync(v("TODO.md"));
  const vault = new Vault(VAULT);
  const f = await vault.create("TODO.md", "# fresh\n");
  assert.equal(f.path, "TODO.md");
  assert.equal(realFs.readFileSync(v("TODO.md"), "utf8"), "# fresh\n");
  await assert.rejects(vault.create("brain/x.md", "x"), { code: "EROFS" });
});
