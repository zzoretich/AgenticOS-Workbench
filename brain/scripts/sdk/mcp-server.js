#!/usr/bin/env node
/**
 * agenticos MCP server — stdio server exposing an AgenticOS vault as tools.
 *
 * Registration: declared by the agenticos Claude Code plugin (plugin/.mcp.json);
 * for manual use: `claude mcp add agenticos --scope user -- node <vault>/brain/scripts/sdk/mcp-server.js`
 *
 * Tools provided:
 *   - memory_search   — fuzzy search across brain/memory/** + brain/patterns/**
 *   - memory_read     — read a specific memory or pattern file
 *   - memory_list     — list all memories grouped by type
 *   - pattern_list    — list all patterns with their front-matter tags
 *   - session_list    — recent daily-note dates
 *   - session_recall  — read a daily note by date (YYYY-MM-DD)
 *   - feedback_rules  — return every active feedback rule
 *   - snapshot_read   — return the latest scanner snapshot JSON
 *   - brief_read      — read the current morning brief, if any
 *   - recall          — hybrid (BM25 + vector when available), recency-boosted recall
 *   - wrap_session    — the ONLY write tool: apply an in-session extraction (memories, SESSION.md, drafts)
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const brain = require('./lib/brain.js');
const recall = require('./lib/recall.js');
const { withReport } = require('../lib/pipeline-report.js');

const server = new McpServer(
  { name: 'agenticos', version: require('../package.json').version },
  { capabilities: { tools: {} } }
);

function textResult(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}
function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

server.registerTool(
  'memory_search',
  {
    title: 'Search brain memory',
    description: 'Fuzzy search across brain/memory/** and brain/patterns/** for a keyword. Returns matching files with snippets.',
    inputSchema: { query: z.string().describe('Keyword or phrase to search for') },
  },
  async ({ query }) => {
    const hits = brain.grepMemories(query);
    if (!hits.length) return textResult(`No matches for "${query}".`);
    return jsonResult({ query, count: hits.length, hits });
  }
);

server.registerTool(
  'memory_read',
  {
    title: 'Read a memory or pattern file',
    description: 'Read the full content of a memory/pattern file by path, e.g. "brain/memory/feedback/gsd-boundary.md". Only paths under the vault are allowed.',
    inputSchema: { path: z.string().describe('Relative vault path under brain/') },
  },
  async ({ path: relPath }) => {
    const content = brain.readMemory(relPath);
    if (content == null) return textResult(`Not found or outside vault: ${relPath}`);
    return textResult(content);
  }
);

server.registerTool(
  'memory_list',
  {
    title: 'List all memories grouped by type',
    description: 'Returns every memory under brain/memory/** with type, name, path, and frontmatter.',
    inputSchema: {},
  },
  async () => {
    const mems = brain.listMemories();
    const grouped = mems.reduce((acc, m) => {
      (acc[m.type] = acc[m.type] || []).push({ name: m.name, path: m.path, frontmatter: m.frontmatter });
      return acc;
    }, {});
    return jsonResult({ total: mems.length, byType: grouped });
  }
);

server.registerTool(
  'pattern_list',
  {
    title: 'List decision patterns',
    description: 'Returns every pattern under brain/patterns/** with name, path, and frontmatter.',
    inputSchema: {},
  },
  async () => {
    const patterns = brain.listPatterns();
    return jsonResult({ total: patterns.length, patterns });
  }
);

server.registerTool(
  'session_list',
  {
    title: 'List recent session logs',
    description: 'Return the N most-recent session log dates (YYYY-MM-DD). Default 20.',
    inputSchema: { limit: z.number().int().positive().optional().describe('Max sessions to return') },
  },
  async ({ limit }) => {
    const sessions = brain.listSessions(limit || 20);
    return jsonResult({ count: sessions.length, sessions: sessions.map(s => ({ date: s.date, path: s.path })) });
  }
);

server.registerTool(
  'session_recall',
  {
    title: 'Read a specific session log',
    description: 'Read a session log by date (YYYY-MM-DD).',
    inputSchema: { date: z.string().describe('YYYY-MM-DD') },
  },
  async ({ date }) => {
    const content = brain.readSession(date);
    if (!content) return textResult(`No session found for ${date}`);
    return textResult(content);
  }
);

server.registerTool(
  'feedback_rules',
  {
    title: 'List all feedback rules',
    description: 'Return every active feedback/correction rule with its full content.',
    inputSchema: {},
  },
  async () => {
    const rules = brain.listFeedback().map(f => {
      const content = brain.readMemory(f.path) || '';
      return { name: f.name, path: f.path, content };
    });
    return jsonResult({ count: rules.length, rules });
  }
);

server.registerTool(
  'snapshot_read',
  {
    title: 'Read latest vault snapshot',
    description: 'Return the latest scanner snapshot (system pulse, capabilities, health, etc). Summarized object — omit `full` to keep it small.',
    inputSchema: { full: z.boolean().optional().describe('Include full snapshot JSON (large)') },
  },
  async ({ full }) => {
    const snap = brain.loadSnapshot();
    if (!snap) return textResult('No snapshot available. Run `node brain/scripts/scan-vault.js`.');
    if (full) return jsonResult(snap);
    const slim = {
      scannedAt: snap.scannedAt,
      elapsedMs: snap.elapsedMs,
      config: snap.config?.settings,
      capabilities: {
        agents: snap.capabilities?.agents?.count,
        commands: snap.capabilities?.commands?.count,
        skills: snap.capabilities?.skills?.count,
        hooks: { total: snap.capabilities?.hooks?.count, wired: snap.capabilities?.hooks?.wired },
      },
      brain: snap.brain?.counts,
      plans: snap.plans?.summary,
      health: snap.health?.counts,
    };
    return jsonResult(slim);
  }
);

server.registerTool(
  'recall',
  {
    title: 'Ranked recall over the whole vault',
    description: 'Hybrid (BM25 + vector RRF when the embed index exists), recency-boosted search across brain/memory, brain/patterns, daily notes, and persona/journal. Use for "when did I…" / "what did we decide…" questions before any Bash grep. Returns ranked hits with path, snippet, score, and an age flag (e.g. "stale: 74d").',
    inputSchema: {
      query: z.string().describe('What to recall — 2-5 keywords work best'),
      limit: z.number().int().positive().max(10).optional().describe('Max hits (default 5)'),
    },
  },
  async ({ query, limit }) => {
    let index = recall.loadIndex(brain.PATHS.VAULT);
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (!index || (Date.now() - Date.parse(index.builtAt)) > DAY_MS) {
      index = recall.buildRecallIndex({ vault: brain.PATHS.VAULT });
      recall.saveIndex(index);
    }
    const { hybrid, hits } = await recall.queryRecallHybrid(index, query, { limit: limit || 5 });
    if (!hits.length) return textResult(`No recall hits for "${query}".`);
    return jsonResult({ query, hybrid, count: hits.length, hits });
  }
);

server.registerTool(
  'brief_read',
  {
    title: 'Read the current morning brief',
    description: 'Return the current morning brief (brain/_index/brief.md, or the file named by AOS_BRIEF_PATH) with its age in hours.',
    inputSchema: {},
  },
  async () => {
    const b = brain.readBrief();
    if (!b) return textResult('No morning brief found (checked brain/_index/brief.md and AOS_BRIEF_PATH).');
    return textResult(`# Brief (${b.path}, ${b.ageHours}h old)\n\n${b.content}`);
  }
);

const CANDIDATE = z.object({
  type: z.enum(['user', 'feedback', 'projects', 'reference']),
  title: z.string(), description: z.string(), body: z.string(),
});
const CORRECTION = z.object({ quote: z.string(), rule: z.string(), why: z.string() });

server.registerTool(
  'wrap_session',
  {
    title: 'Write session knowledge into the vault',
    description: 'The only write tool. Applies an extraction exactly as auto-wrap would: candidates pass the noise gate and ' +
      'become memories (+ MEMORY.md lines + promote trail), facts/decisions/feedback fill SESSION.md "Key Context This Session", ' +
      'threads fill "Open Threads", corrections become draft feedback rules under brain/memory/feedback/_drafts/. ' +
      'Prefer zero candidates over weak ones; bodies for feedback carry **Why:** and **How to apply:**.',
    inputSchema: {
      sessionId: z.string().optional().describe('Claude Code session id, if known'),
      facts: z.array(z.string()).describe('What happened (≤8)'),
      decisions: z.array(z.string()).describe('Choices made and why (≤5)'),
      feedback: z.array(z.string()).describe('Corrections or preferences the user expressed (≤5)'),
      threads: z.array(z.string()).describe('Open follow-ups (≤5)'),
      candidates: z.array(CANDIDATE).describe('Durable memories worth keeping (≤3)'),
      corrections: z.array(CORRECTION).optional().describe('Moments the user corrected the assistant: quote, the rule to draft, why'),
    },
  },
  async (input) => {
    const { applyExtraction } = require('../auto-wrap.js');
    const extraction = { facts: input.facts, decisions: input.decisions, feedback: input.feedback, threads: input.threads, candidates: input.candidates };
    const out = await withReport('auto-wrap', async (report) => {
      report.provider = 'in-session';
      return applyExtraction({ extraction, sessionId: input.sessionId || 'in-session', corrections: input.corrections || [], report });
    });
    return jsonResult({ written: out.written, skipped: out.skipped, reasons: out.reasons, drafts: out.drafts });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`[brain-mcp] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
