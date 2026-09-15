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
  // ── Plan 5: persona machinery (scripts only — never IDENTITY/STATE/PLAYBOOK/journal/proposals) ──
  { from: 'proton/scripts/scan-arsenal.js', to: 'brain/scripts/persona/scan-arsenal.js' },
  { from: 'proton/scripts/build-playbook.js', to: 'brain/scripts/persona/build-playbook.js' },
  { from: 'skills/proton-flag-closer/scripts', to: 'plugin/skills/persona-flag-closer/scripts' },
  // ── Plan 5: cost analyzer (no data/, no SKILL.md — the plugin's cost skill is authored in Plan 3) ──
  { from: 'skills/token-goblin/scripts/analyze_transcript.py', to: 'extras/cost/analyze_transcript.py' },
  { from: 'skills/token-goblin/scripts/test_analyze_transcript.py', to: 'extras/cost/test_analyze_transcript.py' },
  { from: 'skills/token-goblin/scripts/pricing.json', to: 'extras/cost/pricing.json' },
  { from: 'skills/token-goblin/assets/report-template.html', to: 'extras/cost/report-template.html' },
];

const EXCLUDE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)main\.js$/,
  /\.map$/,
  /(^|\/)data\.json$/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)package-lock\.json$/,
  /^README\.md$/,
  // ── Plan 5 (execution amendment 2026-09-15, A1): vault-drift files the repo deliberately lacks. Tested against
  //    the path relative to each allowlisted root (brain/scripts → sdk/…, test/…; obsidian-plugin → src/…).
  /^sdk\/(install|local-code|reason|wrap-headless)\.js$/,                                        // install.js retired by contract §2; the other three moved to extras/ollama
  /^sdk\/test\/test-(embed-vault|embed|models|ollama-body|reason|recall-hybrid|recall)\.js$/,    // superseded by brain/scripts/test/live/
  /^test\/wrap-headless\.test\.js$/,                                                             // moved to extras/ollama with its subject; would move the brain lane 307 → 308
  /^src\/data\/session\.ts$/,                                                                    // deleted in Plan 4; nothing under obsidian-plugin/src references it
  /^sitrep-state\.js$/,                                                                          // moved under persona/ in Plan 5 (execution amendment 2026-09-15, A22)
];

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

  // ── Plan 5: persona machinery ──
  { file: 'brain/scripts/persona/scan-arsenal.js',
    from: ' * Proton arsenal scanner — inventories skills, agents, and commands as JSON.',
    to:   ' * Arsenal scanner — inventories the skills, agents, and commands under a Claude config dir as JSON.' },
  { file: ['brain/scripts/persona/scan-arsenal.js', 'brain/scripts/persona/build-playbook.js'],
    from: /const DEFAULT_ROOT = '\/Users\/[^']+\/\.claude';/,           // the owner's absolute config dir (line 10 / line 11)
    to:   "const DEFAULT_ROOT = process.env.CLAUDE_CONFIG_DIR || require('path').join(require('os').homedir(), '.claude');" },
  { file: 'brain/scripts/persona/build-playbook.js',
    from: ' * Proton playbook bootstrap — generates the initial PLAYBOOK.md from the',
    to:   ' * Playbook bootstrap — generates the initial PLAYBOOK.md from the' },
  { file: 'brain/scripts/persona/build-playbook.js',
    from: " * Proton's to curate; regenerating would destroy annotations.",
    to:   " * the persona's to curate; regenerating would destroy annotations." },
  { file: 'brain/scripts/persona/build-playbook.js', from: 'type: proton-playbook', to: 'type: persona-playbook' },
  { file: 'brain/scripts/persona/build-playbook.js', from: '# PROTON PLAYBOOK — the front door', to: '# {{AGENT_NAME}} PLAYBOOK — the front door' },
  { file: 'brain/scripts/persona/build-playbook.js', from: /proton\/PLAYBOOK\.md/g, to: 'persona/PLAYBOOK.md' },

  // ── Plan 5: flag-closer scripts ──
  { file: 'plugin/skills/persona-flag-closer/scripts/collect.js',
    from: '// proton-flag-closer collector: pending proposals + STATE.md flags + new silent failures.',
    to:   '// persona-flag-closer collector: pending proposals + STATE.md flags + new silent failures.' },
  { file: 'plugin/skills/persona-flag-closer/scripts/collect.js', from: "'proton/proposals'", to: "'persona/proposals'" },
  { file: 'plugin/skills/persona-flag-closer/scripts/collect.js', from: "'proton/STATE.md'", to: "'persona/STATE.md'" },
  { file: 'plugin/skills/persona-flag-closer/scripts/collect.js', from: '/^proton-.*-error\\.log$/', to: '/^duty-.*-error\\.log$/' },
  { file: ['plugin/skills/persona-flag-closer/scripts/collect.js', 'plugin/skills/persona-flag-closer/scripts/recheck.js'],
    from: "'skills/proton-flag-closer/state'", to: "'persona/flag-closer'" },
  { file: 'plugin/skills/persona-flag-closer/scripts/collect.js', from: 'Proton flag-closer: ', to: 'Persona flag-closer: ' },
  { file: 'plugin/skills/persona-flag-closer/scripts/collect.js', from: 'say "review proton flags"', to: 'say "review persona flags"' },
  { file: 'plugin/skills/persona-flag-closer/scripts/recheck.js',
    from: '// Deterministic re-verification for proton-flag-closer.', to: '// Deterministic re-verification for persona-flag-closer.' },
  { file: 'plugin/skills/persona-flag-closer/scripts/recheck.js',
    from: "'skills/proton-flag-closer/config/autoapply.json'", to: "'persona/autoapply.json'" },
  { file: 'plugin/skills/persona-flag-closer/scripts/render-digest.js', from: /Proton Flag Review/g, to: 'Persona Flag Review' },

  // ── Plan 5: cost analyzer report template (brand fonts and copyright; pattern-based so this file
  //    and the plan never spell the brand — the brand font is "<Brand> Sans" / "<Brand> Sans Mono" on
  //    lines 12–13, the copyright line is line 89 with four leading spaces) ──
  { file: 'extras/cost/report-template.html', from: '<title>The Token Goblin — Token Hoard Report</title>', to: '<title>AgenticOS Cost Report</title>' },
  { file: 'extras/cost/report-template.html',
    from: /^([ \t]*--font-sans:)'[A-Za-z]+ Sans',/m,
    to:   '$1' },                                                       // → --font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
  { file: 'extras/cost/report-template.html',
    from: /^([ \t]*--font-mono:)'[A-Za-z]+ Sans Mono',/m,
    to:   '$1' },                                                       // → --font-mono:'Consolas','Monaco','Courier New',monospace;
  { file: 'extras/cost/report-template.html',
    from: /^([ \t]*)<p>© 2026 [A-Za-z]+, Inc\. All rights reserved\.<\/p>/m,
    to:   '$1<p>AgenticOS Workbench cost report. MIT licensed.</p>' },
];

module.exports = { ALLOWLIST, EXCLUDE, SCRUBS };
