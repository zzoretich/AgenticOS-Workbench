'use strict';
// eslint for the repo's JavaScript (spec 2026-09-23-ci-safety-net-design D2): `npm run lint`, and CI's lint job.
// The HUD's TypeScript is checked by tsc instead (`npm run typecheck`).
const js = require('@eslint/js');
const globals = require('globals');

const rules = {
  ...js.configs.recommended.rules,
  // Hooks and best-effort writes swallow errors on purpose: a hook must never fail a session.
  'no-empty': ['error', { allowEmptyCatch: true }],
  // Callback and catch parameters document the shape; a leading underscore marks a deliberate unused binding.
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  // The sanitizers strip NUL and ANSI escapes on purpose, and table-output tests match column padding literally.
  'no-control-regex': 'off',
  'no-regex-spaces': 'off',
};
const languageOptions = (sourceType) => ({ ecmaVersion: 2023, sourceType, globals: { ...globals.node } });

module.exports = [
  // Generated or bundled output, the HUD's TypeScript sources (tsc), and the gitignored private *.local.* files.
  { ignores: ['**/node_modules/**', 'codex-plugin/**', 'obsidian-plugin/main.js', 'obsidian-plugin/src/**', '**/*.local.*'] },
  { files: ['**/*.js', '**/*.cjs'], languageOptions: languageOptions('commonjs'), rules },
  { files: ['**/*.mjs'], languageOptions: languageOptions('module'), rules },
];
