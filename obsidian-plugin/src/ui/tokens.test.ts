import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOKENS } from "./tokens";

test("tokens.ts is in lockstep with styles.css .aos-root (run npm run gen:tokens after CSS edits)", () => {
  const css = readFileSync(join(__dirname, "..", "..", "styles.css"), "utf8");
  const block = css.match(/\.aos-root\s*\{([\s\S]*?)\}/)![1];
  const fromCss: Record<string, string> = {};
  for (const m of block.matchAll(/--aos-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    fromCss[m[1].replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = m[2].trim();
  }
  assert.deepEqual(TOKENS, fromCss);
});

test("core tokens exist with the locked HUD values", () => {
  assert.equal(TOKENS.bg, "#0a0e14");
  assert.equal(TOKENS.cyan, "#00d4ff");
  assert.equal(TOKENS.rose, "#ff5e7e");
});
