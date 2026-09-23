'use strict';
/**
 * export-scrubs.example.js — the shape of tools/export-scrubs.local.js, the table export-from-vault.js reads.
 * The real table names the private identifiers it rewrites, so it is gitignored (tools/*.local.*) and never
 * committed; the privacy gate fails if it ever becomes visible to git. To start one, copy this file to
 * tools/export-scrubs.local.js and replace the examples. `--scrubs <file>` points the export at another table.
 *   ALLOWLIST: [{from: <vault-relative>, to: <repo-relative>}] — the ONLY things copied. A directory is walked;
 *              a file is copied as-is.
 *   EXCLUDE:   regexes tested against the path relative to each allowlisted root.
 *   SCRUBS:    rewrites applied to the copied text; `from` is a literal string or a RegExp, `file` is the
 *              repo-relative destination path (string or array). Every scrub must match at least once per export
 *              or the tool reports it as unmatched (exit 3), so drift is visible. Prefer a pattern over the literal
 *              identifier where one fits, so the table stays readable if it is ever shown.
 */
const ALLOWLIST = [
  { from: 'brain/scripts', to: 'brain/scripts' },
  { from: 'skills/example-skill/scripts', to: 'plugin/skills/example-skill/scripts' },
];

const EXCLUDE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)package-lock\.json$/,
];

const SCRUBS = [
  { file: 'brain/scripts/lib/example.js', from: /awaiting [A-Z][a-z]+'s approval/, to: "awaiting the owner's approval" },
  { file: ['plugin/skills/example-skill/scripts/a.js', 'plugin/skills/example-skill/scripts/b.js'],
    from: /Example Agent Review/g, to: 'Persona Review' },
];

module.exports = { ALLOWLIST, EXCLUDE, SCRUBS };
