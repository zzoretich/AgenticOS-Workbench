#!/usr/bin/env node
/**
 * Arsenal scanner — inventories the skills, agents, and commands under a Claude config dir as JSON.
 * Used to bootstrap PLAYBOOK.md (build-playbook.js) and to detect playbook
 * drift during the weekly reflection duty.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = process.env.CLAUDE_CONFIG_DIR || require('path').join(require('os').homedir(), '.claude');
const EXCLUDE_FILES = new Set(['INDEX.md', 'README.md']);
const DESC_MAX = 200;

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    // YAML block scalars put the value on the following indented lines.
    if (/^[>|][-+]?$/.test(val)) {
      const buf = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && !/^[ \t]/.test(lines[j])) break;
        buf.push(lines[j].trim());
      }
      val = buf.filter(Boolean).join(' ');
    }
    fm[key] = unquote(val);
  }
  return fm;
}

function unquote(s) {
  const t = (s || '').trim();
  return /^(".*"|'.*')$/s.test(t) ? t.slice(1, -1).trim() : t;
}

function firstHeading(text) {
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const m = body.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  // No frontmatter description and no H1 (many commands) -> first prose line.
  for (const line of body.split('\n')) {
    if (line.trim()) return line.trim();
  }
  return '';
}

function clip(s) {
  return (s || '').slice(0, DESC_MAX);
}

function scanArsenal(root = DEFAULT_ROOT) {
  const out = [];

  const skillsDir = path.join(root, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const dir of fs.readdirSync(skillsDir)) {
      const skillMd = path.join(skillsDir, dir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const text = fs.readFileSync(skillMd, 'utf8');
      const fm = parseFrontmatter(text);
      out.push({
        type: 'skill',
        name: fm.name || dir,
        description: clip(fm.description || firstHeading(text)),
        path: skillMd,
      });
    }
  }

  for (const [type, sub] of [['agent', 'agents'], ['command', 'commands']]) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || EXCLUDE_FILES.has(f)) continue;
      const full = path.join(dir, f);
      if (!fs.statSync(full).isFile()) continue;
      const text = fs.readFileSync(full, 'utf8');
      const fm = parseFrontmatter(text);
      const base = f.replace(/\.md$/, '');
      out.push({
        type,
        name: fm.name || base,
        description: clip(fm.description || firstHeading(text)),
        path: full,
      });
    }
  }

  out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return out;
}

if (require.main === module) {
  const rootIdx = process.argv.indexOf('--root');
  const root = rootIdx !== -1 ? process.argv[rootIdx + 1] : DEFAULT_ROOT;
  process.stdout.write(JSON.stringify(scanArsenal(root), null, 2) + '\n');
}

module.exports = { scanArsenal };
