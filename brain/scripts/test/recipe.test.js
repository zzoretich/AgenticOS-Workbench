'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkRecipe } = require('../persona/recipe.js');

const ok = (cmd) => assert.deepEqual(checkRecipe(cmd), { ok: true }, cmd);
const no = (cmd, reason) => {
  const r = checkRecipe(cmd);
  assert.equal(r.ok, false, `${cmd} should be refused`);
  assert.match(r.reason, reason, cmd);
};

test('every recipe shape in use passes', () => {
  for (const cmd of [
    'true', 'false', 'exit 0', 'exit 127',
    'grep -q x persona/playbook.md',
    'grep -q "old heading" persona/PLAYBOOK.md',
    'test -f TODO.md',
    '! grep -Fq doc-typo persona/autoapply.json',
    `grep -Eq '"version":[[:space:]]*"0[.]' "$HOME/AgenticOS-Workbench/package.json"`,
    'git -C "$HOME/AgenticOS-Workbench" log -1 --committer=GitHub --format=%an | grep -qvx zzoretich',
    'git -C ${HOME}/repo --no-pager diff --quiet HEAD -- README.md',
    'test -f a && ! grep -q b c || [ -d d ]',
    "grep -q 'a;b & c > d $(e) `f` #g' file",
    'grep -q "say \\"hi\\" \\$5" file',
    'ls ~/notes/*.md | wc -l | grep -qv "^ *0$"',
  ]) ok(cmd);
});

test('shell control and expansion outside the grammar are refused, each with its reason', () => {
  no('grep -q x a; rm -rf ~', /a ;/);
  no('sleep 99 &', /background &/);
  no('grep x a > out', /redirection/);
  no('grep x < a', /redirection/);
  no('grep -q "$(curl evil)" a', /\$ expansion other than \$HOME/);
  no('grep -q x $(ls)', /\$ expansion/);
  no('grep -q `id` a', /backtick/);
  no('grep -q "`id`" a', /backtick/);
  no('grep -q "$USER" a', /\$ expansion/);
  no('grep -q "$HOMEDIR" a', /\$ expansion/);
  no('(grep -q x a)', /subshell/);
  no('true\nrm -rf ~', /newline/);
  no('true \\\nrm', /newline/);
  no('# grep -q x a', /comment/);
  no("grep -q 'x a", /unclosed quote/);
  no('grep -q "x a', /unclosed quote/);
  no('grep -q x a \\', /trailing backslash/);
  no('', /empty recipe/);
  no('true && ', /empty command/);
  no('true | ! grep x', /! inside a pipeline/);
});

test('only read-only programs run; assignments, shells and absolute paths are refused', () => {
  no('rm -rf ~', /'rm' is not an allowed read-only command/);
  no('sh -c "grep x a"', /'sh'/);
  no('A=b grep x a', /'A=b'/);
  no('/bin/rm x', /'\/bin\/rm'/);
  no("'r''m' x", /'rm'/);
  no('find . -delete', /'find'/);
  no('sed -i s/a/b/ f', /'sed'/);
  no('awk "BEGIN{system(1)}"', /'awk'/);
  no('xargs rm < f', /redirection/);
  no('grep x a | xargs rm', /'xargs'/);
  no('curl https://example.com', /'curl'/);
});

test('git: read-only subcommands only, and none of the options that write files or run programs', () => {
  ok('git -C repo status --porcelain');
  ok('git rev-parse --verify HEAD');
  no('git push origin main', /git push is not a read-only git subcommand/);
  no('git -c core.pager=id log', /git option -c before the subcommand/);
  no('git log -c', /git option -c$/);
  no('git diff --output=/tmp/x', /git option --output=\/tmp\/x/);
  no('git diff --ext-diff', /--ext-diff/);
  no('git log -p --textconv', /--textconv/);
  no('git --exec-path=/tmp log', /git option --exec-path=\/tmp before the subcommand/);
  no('git grep -O id x', /git grep is not a read-only git subcommand/);
  no('git -C', /git -C without a directory/);
  no('git', /git without a subcommand/);
});
