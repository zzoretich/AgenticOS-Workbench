'use strict';
/**
 * export-scrubs.js — data for export-from-vault.js.
 *   ALLOWLIST: [{from: <vault-relative>, to: <repo-relative>}] — the ONLY things copied.
 *   EXCLUDE:   regexes tested against the path relative to each allowlisted root.
 *   SCRUBS:    rewrites applied to the copied text; `from` is a literal string or a RegExp,
 *              `file` is the repo-relative destination path (string or array). Every scrub
 *              must match at least once per export or the tool reports it as unmatched
 *              (exit 3) — drift is visible. Owner identifiers (home path, transcript slug,
 *              first name) are always RegExp patterns so this file never contains them.
 * Structural rewrites (constants that become config, derived slugs, resolver changes)
 * are NOT scrubs; they are code changes made in the repo (Plan 1 Tasks 5–9).
 */

// Owner-identifier patterns (shared by several entries).
const HOME_RE = /\/Users\/[^\/\s'"]+\/\.claude/;                 // /Users/<owner>/.claude (one occurrence per file)
const SLUG_RE = /(?<!-)-Users-[a-z-]+--claude/g;                 // -Users-<owner>--claude, the Claude Code transcript slug
const WIN_SLUG_RE = /(?<=C--Users-|C:\\Users\\)[a-z]+(?=--claude|\\\.claude)/g; // <owner> inside the Windows examples
const FIRST_NAME = '[A-Z][a-z]+';                                // one capitalized word
const ALLOWLIST = [
  { from: 'brain/scripts', to: 'brain/scripts' },
  { from: '.obsidian/plugins/agentic-os', to: 'obsidian-plugin' },
];

const EXCLUDE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)main\.js$/,
  /\.map$/,
  /(^|\/)data\.json$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)package-lock\.json$/,
  /^README\.md$/,
];

const LIVE_TESTS = ['embed-vault', 'embed', 'models', 'ollama-body', 'reason', 'recall-hybrid', 'recall']
  .map(n => `brain/scripts/sdk/test/test-${n}.js`);

const SCRUBS = [
  // ── brain/scripts: comments and fixtures ──
  { file: 'brain/scripts/lib/feedback-drafts.js', from: new RegExp(`awaiting ${FIRST_NAME}'s batch approval`), to: "awaiting the owner's batch approval" },
  { file: 'brain/scripts/test/memory-writer.test.js', from: new RegExp(`${FIRST_NAME} prefers terse answers\\.`), to: 'The owner prefers terse answers.' },
  { file: 'brain/scripts/test/noise-gate.test.js', from: new RegExp(`${FIRST_NAME} prefers terse answers\\.`), to: 'The owner prefers terse answers.' },
  { file: 'brain/scripts/collectors/projects.js', from: WIN_SLUG_RE, to: 'alice' },
  { file: 'brain/scripts/collectors/projects.js', from: SLUG_RE, to: '-home-alice--claude' },
  { file: 'brain/scripts/collectors/projects.js', from: HOME_RE, to: '/home/alice/.claude' },
  { file: 'brain/scripts/map-workspace.js', from: /"JARVIS DemoHub"/g, to: '"Example Workspace"' },
  { file: 'brain/scripts/map-workspace.js', from: /\/usr\/local\/bin\/node /g, to: 'node ' },
  { file: 'brain/scripts/sdk/mcp-server.js',
    from: /^ \*   claude mcp add brain --scope user -- node \/Users\/[^\/\s]+\/\.claude\/brain\/scripts\/sdk\/mcp-server\.js$/m,
    to:   ' *   declared by the agenticos Claude Code plugin (plugin/.mcp.json); see docs/install.md' },
  { file: 'brain/scripts/lib/paths.js', from: '"/Users/<someone>/.claude"', to: '"<home>/.claude"' },
  { file: 'brain/scripts/test/auto-cost.test.js', from: SLUG_RE, to: '-home-alice--claude' },
  { file: 'brain/scripts/test/auto-wrap.test.js', from: 'Relocated the brief output to OneDrive', to: 'Relocated the brief output to cloud storage' },
  { file: 'brain/scripts/test/auto-wrap.test.js', from: /Gmail/g, to: 'a personal mailbox' },
  { file: 'brain/scripts/test/sitrep-state.test.js', from: '# Proton State', to: '# Persona State' },
  { file: LIVE_TESTS, from: /\/\/ Run: node \/Users\/[^\/\s]+\/\.claude\/brain\/scripts\/sdk\/test\//, to: '// Run: node brain/scripts/test/live/' },
  { file: 'brain/scripts/sdk/test/test-recall.js', from: /proton\/journal/g, to: 'persona/journal' },
  { file: 'brain/scripts/sdk/test/test-recall.js', from: 'type: proton-journal', to: 'type: persona-journal' },

  // ── obsidian plugin: labels, comments, fixtures, manifest ──
  { file: 'obsidian-plugin/manifest.json', from: new RegExp(`"author": "${FIRST_NAME}"`), to: '"author": "AgenticOS Workbench contributors"' },
  { file: 'obsidian-plugin/manifest.json', from: 'Workbench for the .claude Agentic OS — live monitor of sessions, agents, memory, and health.', to: 'Workbench for your AgenticOS vault: live monitor of sessions, agents, memory, and health.' },
  { file: 'obsidian-plugin/package.json', from: 'Agentic OS — workbench for the claude-brain vault', to: 'Agentic OS: Obsidian workbench for an AgenticOS vault' },
  { file: 'obsidian-plugin/src/data/briefing.ts', from: 'port of WATZON adaptive briefing from dashboards/dashboard.js', to: 'adaptive briefing (ported from the earlier Mission Control dashboard)' },
  { file: 'obsidian-plugin/src/data/commandRegistry.ts', from: /\n\s*\{ name: "\/watzon",\s*kind: "clipboard",\s*desc: "Ask Watzon — copies" \},/, to: '' },
  { file: 'obsidian-plugin/src/data/fixQueue.test.ts', from: /JARVIS DemoHub/g, to: 'Example Workspace' },
  { file: 'obsidian-plugin/src/data/snapshot.ts', from: '"workspaces/Ai Agent Projects/JARVIS"', to: '"workspaces/Example Workspace"' },
  { file: 'obsidian-plugin/src/views/PulseTab.ts', from: /WATZON/g, to: 'BRIEFING' },
  { file: 'obsidian-plugin/src/views/PulseTab.ts', from: /aos-pulse-watzon/g, to: 'aos-pulse-briefing' },
  { file: 'obsidian-plugin/styles.css', from: /aos-pulse-watzon/g, to: 'aos-pulse-briefing' },
  { file: 'obsidian-plugin/styles.css', from: /WATZON/g, to: 'BRIEFING' },
  { file: 'obsidian-plugin/styles.css', from: 'Jarvis-style terminal aesthetic', to: 'Terminal aesthetic' },
  { file: 'obsidian-plugin/src/ui/AnchorModal.ts', from: 't.setPlaceholder("162.94")', to: 't.setPlaceholder("0.00")' },
  { file: 'obsidian-plugin/src/ui/TerminalPanel.ts', from: 'text: "[ TERMINAL // .claude ]"', to: 'text: "[ TERMINAL ]"' },
];

module.exports = { ALLOWLIST, EXCLUDE, SCRUBS };
