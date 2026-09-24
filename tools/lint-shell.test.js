'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellFiles, main, SHEBANG } = require('./lint-shell.js');

test('shellFiles: *.sh and sh/bash/dash shebangs, never the generated codex-plugin/ or node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-sh-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  put('run.sh', 'echo hi\n');
  put('bin/tool', '#!/bin/sh\necho hi\n');
  put('bin/envbash', '#!/usr/bin/env bash\necho hi\n');
  put('bin/node-tool', '#!/usr/bin/env node\n');
  put('bin/zsh-tool', '#!/bin/zsh\n');
  put('bin/shx', '#!/usr/bin/env shx\n');
  put('codex-plugin/bin/aos', '#!/bin/sh\n');
  put('pkg/node_modules/x/y.sh', 'echo\n');
  put('README.md', '# hi\n');
  const ls = () => ['run.sh', 'bin/tool', 'bin/envbash', 'bin/node-tool', 'bin/zsh-tool', 'bin/shx', 'codex-plugin/bin/aos', 'pkg/node_modules/x/y.sh', 'README.md', 'gone.sh'].join('\n');
  assert.deepEqual(shellFiles({ root, ls }), ['bin/envbash', 'bin/tool', 'gone.sh', 'run.sh']);
  assert.ok(SHEBANG.test('#!/bin/dash') && !SHEBANG.test('#!/usr/bin/env python3'));
});

test('shellFiles over this repo finds the launcher and the rehearsals, not the generated copy', () => {
  const files = shellFiles();
  for (const f of ['plugin/bin/aos', 'cli/rehearsal/first-run.sh', 'cli/rehearsal/codex-host.sh', 'brain/scripts/persona/run-duty.sh']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith('codex-plugin/')));
});

test('main: warning severity over the list; findings exit 1; no shellcheck skips locally and fails under CI', () => {
  const logs = []; const errs = [];
  const io = { log: (s) => logs.push(s), err: (s) => errs.push(s), files: ['a.sh', 'b'] };
  let args = null;
  assert.equal(main([], { ...io, env: {}, run: (a) => { args = a; return { status: 0 }; } }), 0);
  assert.deepEqual(args, ['-S', 'warning', 'a.sh', 'b']);
  assert.match(logs.pop(), /2 script\(s\) clean/);
  assert.equal(main([], { ...io, env: {}, run: () => ({ status: 1 }) }), 1);
  const missing = () => ({ error: Object.assign(new Error('spawn shellcheck ENOENT'), { code: 'ENOENT' }) });
  assert.equal(main([], { ...io, env: {}, run: missing }), 0);
  assert.match(logs.pop(), /not installed .*skipped 2 script\(s\)/);
  assert.equal(main([], { ...io, env: { CI: 'true' }, run: missing }), 1);
  assert.match(errs.pop(), /not installed/);
  assert.equal(main(['--list'], { ...io }), 0);
  assert.equal(logs.pop(), 'a.sh\nb');
});
