#!/usr/bin/env node
// Generates src/ui/tokens.ts from styles.css's .aos-root custom properties.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "styles.css"), "utf8");
const blockMatch = css.match(/\.aos-root\s*\{([\s\S]*?)\}/);
if (!blockMatch) { console.error("gen-tokens: no .aos-root block found"); process.exit(1); }
const vars = {};
for (const m of blockMatch[1].matchAll(/--aos-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  const key = m[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
  vars[key] = m[2].trim();
}
if (Object.keys(vars).length === 0) { console.error("gen-tokens: zero vars parsed"); process.exit(1); }
const entries = Object.keys(vars).sort().map((k) => `  ${k}: ${JSON.stringify(vars[k])},`).join("\n");
const out = `// AUTO-GENERATED from styles.css \`.aos-root\` by scripts/gen-tokens.mjs — DO NOT EDIT.
// Regenerate: npm run gen:tokens
export const TOKENS = {
${entries}
} as const;
export type TokenName = keyof typeof TOKENS;
`;
writeFileSync(join(root, "src", "ui", "tokens.ts"), out);
console.log(`gen-tokens: wrote ${Object.keys(vars).length} tokens`);
