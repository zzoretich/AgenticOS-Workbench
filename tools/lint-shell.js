#!/usr/bin/env node
'use strict';
/**
 * lint-shell.js — shellcheck over every tracked shell script (spec 2026-09-23-ci-safety-net-design D3): `*.sh` plus any
 * file whose first line is a sh/bash/dash shebang, from `git ls-files`, skipping the generated codex-plugin/ (its
 * launcher is a byte copy of plugin/bin/aos). Severity `warning` and above.
 *
 *   node tools/lint-shell.js          lint (npm run lint:sh)
 *   node tools/lint-shell.js --list   print the scripts it would lint
 *
 * Without shellcheck on PATH it says how to install it and exits 0, except under CI, where a missing linter fails.
 * Exit: 0 clean or skipped locally · 1 findings, or no shellcheck under CI.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\/\S*\/)?(?:ba|da)?sh(?:\s|$)/;
const SKIP = [/^codex-plugin\//, /(^|\/)node_modules\//];

function firstLine(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(128);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8').split('\n')[0];
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

/** The tracked shell scripts, repo-relative and sorted. `ls` returns `git ls-files` output (injected by tests). */
function shellFiles({ root = ROOT, ls = () => execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }) } = {}) {
  return ls().split('\n').filter(Boolean)
    .filter((f) => !SKIP.some((re) => re.test(f)))
    .filter((f) => f.endsWith('.sh') || SHEBANG.test(firstLine(path.join(root, f))))
    .sort();
}

/** deps: { files, env, run, log, err } for tests; `run(args)` returns spawnSync's result. */
function main(argv = process.argv.slice(2), deps = {}) {
  const files = deps.files || shellFiles();
  const log = deps.log || ((s) => process.stdout.write(s + '\n'));
  const err = deps.err || ((s) => process.stderr.write(s + '\n'));
  if (argv.includes('--list')) { log(files.join('\n')); return 0; }
  const env = deps.env || process.env;
  const run = deps.run || ((args) => spawnSync('shellcheck', args, { cwd: ROOT, stdio: 'inherit' }));
  const r = run(['-S', 'warning', ...files]);
  if (r.error && r.error.code === 'ENOENT') {
    const msg = 'lint-shell: shellcheck is not installed (macOS: brew install shellcheck · Debian/Ubuntu: apt-get install shellcheck)';
    if (env.CI) { err(msg); return 1; }
    log(`${msg}; skipped ${files.length} script(s)`);
    return 0;
  }
  if (r.status === 0) log(`lint-shell: ${files.length} script(s) clean at severity warning`);
  return r.status === 0 ? 0 : 1;
}

if (require.main === module) process.exit(main());

module.exports = { shellFiles, main, SHEBANG };
