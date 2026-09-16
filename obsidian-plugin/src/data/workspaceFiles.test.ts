import { test } from "node:test";
import assert from "node:assert";
import { isIgnored } from "./workspaceFiles";
import { sortEntries, type DirEntry } from "./workspaceFiles";

test("isIgnored drops .git, node_modules, .DS_Store", () => {
  assert.equal(isIgnored(".git"), true);
  assert.equal(isIgnored("node_modules"), true);
  assert.equal(isIgnored(".DS_Store"), true);
  assert.equal(isIgnored("src"), false);
  assert.equal(isIgnored("README.md"), false);
});

test("sortEntries puts folders first, then alpha within each group", () => {
  const input: DirEntry[] = [
    { name: "zebra.md", isDir: false },
    { name: "src", isDir: true },
    { name: "alpha.md", isDir: false },
    { name: "Brain", isDir: true },
  ];
  const out = sortEntries(input).map((e) => e.name);
  assert.deepEqual(out, ["Brain", "src", "alpha.md", "zebra.md"]);
});

import { looksTextual, listDir } from "./workspaceFiles";
import { promises as fs } from "fs";
import * as os from "os";
import * as nodePath from "path";

test("looksTextual: known text extension passes", () => {
  assert.equal(looksTextual("main.ts", Buffer.from("export const x = 1")), true);
});

test("looksTextual: dotfile basename passes", () => {
  assert.equal(looksTextual(".gitignore", Buffer.from("node_modules\n")), true);
});

test("looksTextual: NUL byte in sample ⇒ binary", () => {
  assert.equal(looksTextual("mystery.dat", Buffer.from([0x41, 0x00, 0x42])), false);
});

test("looksTextual: unknown ext, clean sample ⇒ text", () => {
  assert.equal(looksTextual("notes.weird", Buffer.from("plain text")), true);
});

test("looksTextual: unknown ext, empty sample ⇒ not text", () => {
  assert.equal(looksTextual("mystery.dat", Buffer.alloc(0)), false);
});

test("looksTextual: known text ext, empty sample ⇒ still text", () => {
  assert.equal(looksTextual("empty.ts", Buffer.alloc(0)), true);
});

import { truncate, MAX_PREVIEW_LINES, MAX_PREVIEW_BYTES } from "./workspaceFiles";

test("truncate: short text is untouched", () => {
  const r = truncate("hello\nworld");
  assert.equal(r.text, "hello\nworld");
  assert.equal(r.truncated, false);
});

test("truncate: over the line cap is flagged and cut", () => {
  const big = Array.from({ length: MAX_PREVIEW_LINES + 100 }, (_, i) => `line ${i}`).join("\n");
  const r = truncate(big);
  assert.equal(r.truncated, true);
  assert.equal(r.text.split("\n").length, MAX_PREVIEW_LINES);
});

test("truncate: over the byte cap is flagged and cut within the cap", () => {
  const big = "a".repeat(MAX_PREVIEW_BYTES + 500);
  const r = truncate(big);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= MAX_PREVIEW_BYTES);
});

test("truncate: byte cap respects multibyte boundaries", () => {
  const big = "あ".repeat(MAX_PREVIEW_BYTES); // 3 bytes each ⇒ well over the cap
  const r = truncate(big);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= MAX_PREVIEW_BYTES);
});

test("listDir: filters IGNORED, returns sorted folders-then-files", async () => {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "wsfiles-"));
  try {
    await fs.mkdir(nodePath.join(dir, "src"));
    await fs.mkdir(nodePath.join(dir, ".git"));
    await fs.mkdir(nodePath.join(dir, "node_modules"));
    await fs.writeFile(nodePath.join(dir, "README.md"), "hi");
    await fs.writeFile(nodePath.join(dir, ".DS_Store"), "x");

    const entries = await listDir(dir);
    assert.deepEqual(
      entries.map((e) => `${e.isDir ? "d" : "f"}:${e.name}`),
      ["d:src", "f:README.md"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

import { readPreview } from "./workspaceFiles";

test("readPreview: text / empty / binary classification", async () => {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "wsprev-"));
  try {
    const txt = nodePath.join(dir, "a.txt");
    await fs.writeFile(txt, "hello world");
    const rTxt = await readPreview(txt);
    assert.equal(rTxt.kind, "text");
    assert.equal(rTxt.text, "hello world");
    assert.equal(rTxt.truncated, false);

    const empty = nodePath.join(dir, "empty.txt");
    await fs.writeFile(empty, "");
    assert.equal((await readPreview(empty)).kind, "empty");

    const bin = nodePath.join(dir, "blob.bin");
    await fs.writeFile(bin, Buffer.from([0x00, 0x01, 0x02, 0x00]));
    assert.equal((await readPreview(bin)).kind, "binary");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("readPreview: large file is flagged truncated and capped", async () => {
  const dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "wsprev2-"));
  try {
    const big = nodePath.join(dir, "big.txt");
    await fs.writeFile(big, "a".repeat(MAX_PREVIEW_BYTES + 1000));
    const r = await readPreview(big);
    assert.equal(r.kind, "text");
    assert.equal(r.truncated, true);
    assert.ok(Buffer.byteLength(r.text ?? "", "utf8") <= MAX_PREVIEW_BYTES);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
