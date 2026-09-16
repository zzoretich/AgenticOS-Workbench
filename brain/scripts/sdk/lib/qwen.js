'use strict';
/**
 * qwen.js — higher-level local-LLM helpers on top of lib/ollama.js.
 * summarize (map-reduce chunking), extract (structured JSON), classify.
 * All helpers accept an injectable chatFn for offline testing.
 */
const { chat } = require('./ollama.js');
const { parseAgentJson } = require('./json-extract.js');
const { role, thinkFor } = require('./models.js');

class QwenEmptyError extends Error {
  constructor(msg) { super(msg || 'qwen returned empty response'); this.name = 'QwenEmptyError'; }
}

const DEFAULT_MAX_CHARS = 12000;

function splitOversized(block, maxChars) {
  const out = [];
  let buf = '';
  for (const line of String(block).split(/\n/)) {
    if (line.length > maxChars) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
      continue;
    }
    if (buf && (buf + '\n' + line).length > maxChars) { out.push(buf); buf = line; }
    else { buf = buf ? buf + '\n' + line : line; }
  }
  if (buf) out.push(buf);
  return out;
}

function chunkText(text, maxChars = DEFAULT_MAX_CHARS) {
  const s = String(text || '');
  if (!s.trim()) return [];
  if (s.length <= maxChars) return [s];
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf) { chunks.push(buf); buf = ''; } };
  for (const para of s.split(/\n\n+/)) {
    if (para.length > maxChars) { flush(); chunks.push(...splitOversized(para, maxChars)); continue; }
    if (buf && (buf + '\n\n' + para).length > maxChars) { flush(); buf = para; }
    else { buf = buf ? buf + '\n\n' + para : para; }
  }
  flush();
  return chunks;
}

async function callWithRetry(chatFn, args) {
  let reply = await chatFn(args);
  if (!reply || !String(reply).trim()) reply = await chatFn(args); // qwen3.5:4b sometimes returns empty
  if (!reply || !String(reply).trim()) throw new QwenEmptyError();
  return String(reply).trim();
}

function summarizeSystem({ style, maxWords, focus }) {
  const styleHint = {
    bullets: 'Output terse markdown bullets.',
    prose: 'Output a tight prose paragraph.',
    outline: 'Output a nested outline.',
  }[style] || 'Output terse markdown bullets.';
  return [
    'You compress text. Preserve facts, names, numbers, decisions, and action items.',
    styleHint,
    focus ? `Focus on: ${focus}` : '',
    `Keep it under ${maxWords} words. No preamble, no meta-commentary, no emoji.`,
  ].filter(Boolean).join(' ');
}

async function summarizeOnce(text, o) {
  const system = summarizeSystem(o);
  return callWithRetry(o.chatFn, { system, prompt: text, numPredict: 1024, timeoutMs: o.timeoutMs });
}

async function summarize(text, opts = {}) {
  const o = {
    style: opts.style || 'bullets',
    maxWords: opts.maxWords || 150,
    focus: opts.focus || null,
    chatFn: opts.chatFn || chat,
    maxChars: opts.maxChars || DEFAULT_MAX_CHARS,
    timeoutMs: opts.timeoutMs,
  };
  const s = String(text || '');
  if (!s.trim()) return '';
  let current = s;
  while (current.length > o.maxChars) {
    const summaries = [];
    for (const c of chunkText(current, o.maxChars)) summaries.push(await summarizeOnce(c, o));
    const joined = summaries.join('\n\n');
    if (joined.length >= current.length) break; // no-progress guard
    current = joined;
  }
  return summarizeOnce(current, o);
}

async function extract(text, opts = {}) {
  const chatFn = opts.chatFn || chat;
  const system = [
    'You extract structured data. Return ONLY valid JSON. No prose, no code fences.',
    opts.instructions || '',
    opts.schema ? 'Desired shape:\n' + JSON.stringify(opts.schema, null, 2) : '',
  ].filter(Boolean).join('\n');
  // format:'json' makes Ollama grammar-constrain decoding — prose/think-block
  // replies become impossible; truncation (numPredict) stays the residual risk.
  const reply = await callWithRetry(chatFn, {
    system,
    prompt: String(text || ''),
    numPredict: opts.numPredict || 1024,
    timeoutMs: opts.timeoutMs,
    format: 'json',
  });
  try {
    return parseAgentJson(reply);
  } catch (e) {
    // The ledger only records the error message — carry evidence of what the
    // model actually said so parse failures are diagnosable after the fact.
    e.message += ` — reply started: ${JSON.stringify(String(reply).slice(0, 160))}`;
    throw e;
  }
}

async function classify(text, opts = {}) {
  const labels = opts.labels || [];
  const multi = !!opts.multi;
  const chatFn = opts.chatFn || chat;
  const system = [
    `Classify the text. Allowed labels: ${labels.join(', ')}.`,
    multi ? 'Return every label that applies, comma-separated.' : 'Return exactly one label.',
    'Return only the label(s). No prose.',
  ].join(' ');
  const reply = await callWithRetry(chatFn, { system, prompt: String(text || ''), numPredict: 64, timeoutMs: opts.timeoutMs });
  const lc = reply.toLowerCase();
  const found = labels.filter((l) => {
    const esc = l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\W)${esc}(\\W|$)`).test(lc);
  });
  return multi ? found : (found[0] || null);
}

/**
 * reason(prompt, opts) — deep Q&A / coding via the reasoner role.
 * Falls back to the workhorse when the reasoner call fails (Ollama down,
 * model missing, mid-generation crash) so interactive commands degrade
 * instead of dying. Set opts.noFallback to propagate the error instead.
 */
async function reason(prompt, opts = {}) {
  const chatFn = opts.chatFn || chat;
  const r = role('reasoner');
  const args = {
    system: opts.system,
    prompt: String(prompt || ''),
    model: r.tag,
    think: thinkFor('reasoner', opts.effort),
    keepAlive: r.keepAlive,
    numPredict: opts.numPredict || 2048,
    numCtx: opts.numCtx || r.numCtxCap || undefined,
    timeoutMs: opts.timeoutMs || 300000,
    ...(opts.format ? { format: opts.format } : {}),
  };
  try {
    return await callWithRetry(chatFn, args);
  } catch (err) {
    if (opts.noFallback) throw err;
    process.stderr.write(`[reason] reasoner (${r.tag}) unavailable — falling back to workhorse: ${err.message}\n`);
    const w = role('workhorse');
    return callWithRetry(chatFn, { ...args, model: w.tag, think: false, keepAlive: w.keepAlive, numCtx: undefined });
  }
}

module.exports = { summarize, extract, classify, chunkText, reason, QwenEmptyError };
