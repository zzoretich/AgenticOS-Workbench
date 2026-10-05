// The sandboxed page's `path` (src/renderer/shims/path.ts) must agree with Node's POSIX path on every input the HUD
// could give it: a disagreement would put a file somewhere other than where the HUD meant.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as node from "node:path";
import * as shim from "../../src/renderer/shims/path";

const SAMPLES = [
  "", ".", "..", "/", "//", "///", "a", "a/", "/a", "/a/", "a/b", "a//b", "/a/b/c", "/a/b/c/", "a/./b", "a/../b", "../a", "../../a/b",
  "/a/../../b", "/..", "/../a", "a/b/..", "a/b/../..", "a/b/../../..", ".hidden", "/x/.hidden", "file.md", "/v/brain/memory/x.md",
  "/v/brain/../TODO.md", "x.tar.gz", "/a/b.c/d", "..md", "a..", "a.", ".a.", "/a/b/.", "/a/b/..", "/home/x y/é.md", "c:/win",
];

test("normalize, isAbsolute, dirname, basename and extname agree with node:path.posix", () => {
  for (const p of SAMPLES) {
    assert.equal(shim.normalize(p), node.posix.normalize(p), `normalize ${JSON.stringify(p)}`);
    assert.equal(shim.isAbsolute(p), node.posix.isAbsolute(p), `isAbsolute ${JSON.stringify(p)}`);
    assert.equal(shim.dirname(p), node.posix.dirname(p), `dirname ${JSON.stringify(p)}`);
    assert.equal(shim.basename(p), node.posix.basename(p), `basename ${JSON.stringify(p)}`);
    assert.equal(shim.extname(p), node.posix.extname(p), `extname ${JSON.stringify(p)}`);
    for (const ext of [".md", "md", "x.md", ".gz"]) assert.equal(shim.basename(p, ext), node.posix.basename(p, ext), `basename ${JSON.stringify([p, ext])}`);
  }
});

test("join, resolve (from /) and relative agree with node:path.posix", () => {
  for (const a of SAMPLES) {
    for (const b of SAMPLES.slice(0, 24)) {
      assert.equal(shim.join(a, b), node.posix.join(a, b), `join ${JSON.stringify([a, b])}`);
      assert.equal(shim.resolve("/", a, b), node.posix.resolve("/", a, b), `resolve ${JSON.stringify([a, b])}`);
      if (node.posix.isAbsolute(a) && node.posix.isAbsolute(b)) assert.equal(shim.relative(a, b), node.posix.relative(a, b), `relative ${JSON.stringify([a, b])}`);
    }
  }
  assert.equal(shim.join(), node.posix.join());
  assert.equal(shim.join("/v", "brain", "scripts", "cli/aos.js"), "/v/brain/scripts/cli/aos.js");
  assert.equal(shim.resolve("/v", "/abs"), "/abs");
  assert.equal(shim.sep, "/");
  assert.equal(shim.default.join, shim.join);
  assert.equal(shim.posix.relative, shim.relative);
});
