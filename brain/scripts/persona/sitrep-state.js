#!/usr/bin/env node
'use strict';
/**
 * sitrep-state.js — deterministic work-state collector + change detector for the
 * persona-sitrep duty (duty #3). Zero LLM tokens; pure Node + git.
 *
 * Modes:
 *   node persona/sitrep-state.js diff    → print {first_run, changed, changes, state}; read-only
 *   node persona/sitrep-state.js update  → persist current alert-state to brain/_index/.sitrep-state.json
 *
 * The push decision compares ONLY alert-relevant state (stalled planning phases, open
 * persona flags, pending proposals, pending feedback-rule drafts) — never dirty counts
 * or commit SHAs — so routine commits never fire a push. Stall detection is mtime-only on .planning/STATE.md
 * (format-agnostic: GSD STATE.md layouts vary; idle time is the honest signal).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { VAULT, PATHS } = require('../lib/paths.js');

const REPOS_FILE = path.join(VAULT, 'persona', 'repos.json');
const STORE_FILE = path.join(PATHS.INDEX, '.sitrep-state.json');
const PERSONA_STATE = path.join(VAULT, 'persona', 'STATE.md');
const PROPOSALS_DIR = path.join(VAULT, 'persona', 'proposals');
const DRAFTS_DIR = path.join(VAULT, 'brain', 'memory', 'feedback', '_drafts');

function git(repoPath, args) {
  try {
    return execFileSync('git', ['-C', repoPath, ...args],
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

/** persona/repos.json is optional: { stall_threshold_days?: number, repos?: [{ name, path }] }.
 *  A corrupt or unreadable file warns once on stderr and is treated as empty. */
function loadRepos() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[sitrep-state] persona/repos.json unreadable: ${e.message} — watching no repos`);
    cfg = {};
  }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) cfg = {};
  return { threshold: cfg.stall_threshold_days || 4, repos: Array.isArray(cfg.repos) ? cfg.repos : [] };
}

/** brain/_index/.sitrep-state.json is written by `update`. A store that is corrupt — truncated mid-write by a
 *  PERSONA_TIMEOUT kill, say — warns once on stderr and reads as a first run, so the sitrep duty degrades to
 *  "no change to report" instead of crashing at step 1. The twin of loadRepos() above (ruling A48). */
function loadStore() {
  if (!fs.existsSync(STORE_FILE)) return { first_run: true, prev: {} };
  try {
    const prev = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (typeof prev !== 'object' || prev === null || Array.isArray(prev)) throw new Error('not a JSON object');
    return { first_run: false, prev };
  } catch (e) {
    console.error(`[sitrep-state] ${STORE_FILE} unreadable: ${e.message} — treating this as a first run`);
    return { first_run: true, prev: {} };
  }
}

function collectRepos(repos) {
  return repos.map(({ name, path: p }) => {
    if (!fs.existsSync(path.join(p, '.git'))) return { name, path: p, missing: true };
    const branch = git(p, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
    const porcelain = git(p, ['status', '--porcelain']);
    const dirty = porcelain === null ? -1 : (porcelain ? porcelain.split('\n').length : 0);
    const last_commit = git(p, ['log', '-1', '--format=%cI %s']) || '';
    return { name, path: p, branch, dirty, last_commit };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function detectPlanning(repos, thresholdDays, now = Date.now()) {
  const planning = []; const stalled = [];
  for (const { name, path: p } of repos) {
    const stateFile = path.join(p, '.planning', 'STATE.md');
    if (!fs.existsSync(stateFile)) continue;
    try {
      const idleDays = (now - fs.statSync(stateFile).mtimeMs) / 86400000;
      const phase = (fs.readFileSync(stateFile, 'utf8').split('\n')
        .find(l => /phase/i.test(l)) || '').trim().slice(0, 120);
      planning.push({ repo: name, state_file: stateFile,
        idle_days: Math.round(idleDays * 10) / 10, phase });
      if (idleDays > thresholdDays) stalled.push(`${name}: ${phase || 'unknown phase'}`);
    } catch {
      /* unreadable STATE.md — skip this repo's planning lane */
      continue;
    }
  }
  planning.sort((a, b) => a.repo.localeCompare(b.repo));
  stalled.sort();
  return { planning, stalled };
}

function parseFlags(stateMdText) {
  const sec = stateMdText.split(/^## Flags\s*$/m)[1];
  if (!sec) return [];
  return sec.split(/^## /m)[0].split('\n')
    .filter(l => l.startsWith('- [ ] '))
    .map(l => l.slice(6).trim())
    .sort();
}

function listProposals(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').sort();
}

function collect(now = Date.now()) {
  const { threshold, repos } = loadRepos();
  const { planning, stalled } = detectPlanning(repos, threshold, now);
  const flagsText = fs.existsSync(PERSONA_STATE) ? fs.readFileSync(PERSONA_STATE, 'utf8') : '';
  return {
    generated: new Date(now).toISOString(),
    threshold_days: threshold,
    repos: collectRepos(repos),
    planning,
    alert: { stalled, flags: parseFlags(flagsText), proposals: listProposals(PROPOSALS_DIR),
      drafts: listProposals(DRAFTS_DIR) },
  };
}

function diffAlert(prev, cur) {
  const changes = {}; let changed = false;
  for (const key of ['stalled', 'flags', 'proposals', 'drafts']) {
    const before = new Set(prev[key] || []); const after = new Set(cur[key] || []);
    const added = [...after].filter(x => !before.has(x)).sort();
    const removed = [...before].filter(x => !after.has(x)).sort();
    if (added.length) { changes[`${key}_added`] = added; changed = true; }
    if (removed.length) { changes[`${key}_removed`] = removed; changed = true; }
  }
  return { changed, changes };
}

function main() {
  const mode = process.argv[2];
  const state = collect();
  if (mode === 'update') {
    fs.writeFileSync(STORE_FILE, JSON.stringify(state.alert, null, 2) + '\n');
    console.log(JSON.stringify({ updated: true, store: STORE_FILE }));
    return;
  }
  if (mode !== 'diff') { console.error('usage: persona/sitrep-state.js diff|update'); process.exit(1); }
  const { first_run, prev } = loadStore();
  const { changed, changes } = diffAlert(prev, state.alert);
  console.log(JSON.stringify(
    { first_run, changed: first_run ? false : changed, changes, state }, null, 2));
}

if (require.main === module) main();
module.exports = { parseFlags, listProposals, detectPlanning, diffAlert, collectRepos, collect, loadStore };
