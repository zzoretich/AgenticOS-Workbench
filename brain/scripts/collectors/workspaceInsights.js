'use strict';
const { nowIso } = require('./util');

const SYSTEM = 'You are a terse project analyst. Given a workspace summary, reply with EXACTLY two lines and nothing else:\nINSIGHT: <2-3 sentences on momentum, risk, or what is stuck>\nNEXT: <one short next action, or NONE if a next step is already set>';

function buildPrompt(entry) {
  const objectives = (entry.objectives || []).map((o) => `- ${o.text}`).join('\n') || '(none)';
  const subs = (entry.subprojects || []).map((s) => `${s.name}${s.status ? ` (${s.status})` : ''}`).join(', ') || '(none)';
  const age = entry.lastEvent && entry.lastEvent.ageDays != null ? `${entry.lastEvent.ageDays}d ago` : 'unknown';
  const nextSet = entry.next && entry.next.text ? entry.next.text : 'NONE';
  return [
    `Workspace: ${entry.name}`,
    `Status: ${entry.status || 'unknown'}`,
    `Summary: ${entry.summary || '(none)'}`,
    `Last activity: ${age}`,
    `Objectives:\n${objectives}`,
    `Subprojects: ${subs}`,
    `Existing next step: ${nextSet}`,
  ].join('\n');
}

function parseInsightReply(text) {
  const out = { insight: null, next: null };
  if (!text) return out;
  const im = text.match(/INSIGHT:\s*([\s\S]*?)(?:\nNEXT:|$)/i);
  const nm = text.match(/NEXT:\s*(.*)$/im);
  if (im) out.insight = im[1].trim() || null;
  if (nm) {
    const v = nm[1].trim();
    out.next = (!v || /^none$/i.test(v)) ? null : v;
  }
  return out;
}

// generateInsight(entry, { chatFn, model, numPredict }) -> { insight, next }
// chatFn defaults to the real ollama helper; injectable for tests.
async function generateInsight(entry, opts = {}) {
  const model = opts.model || require('../sdk/lib/models.js').role('workhorse').tag;
  let chatFn = opts.chatFn;
  if (!chatFn) {
    const ollama = require('../sdk/lib/ollama');
    chatFn = (o) => ollama.chat(o);
  }
  try {
    const reply = await chatFn({
      system: SYSTEM, prompt: buildPrompt(entry), model,
      numPredict: opts.numPredict || 200, timeoutMs: 60000,
    });
    const parsed = parseInsightReply(reply);
    const insight = {
      text: parsed.insight, status: parsed.insight ? 'ok' : 'unavailable',
      model, generatedAt: nowIso(), inputHash: entry.inputHash,
    };
    let next = entry.next;
    if ((!next || !next.text) && parsed.next) next = { text: parsed.next, source: 'ai' };
    return { insight, next };
  } catch {
    return { insight: { text: null, status: 'unavailable', model, generatedAt: nowIso(), inputHash: entry.inputHash }, next: entry.next };
  }
}

module.exports = { buildPrompt, parseInsightReply, generateInsight, SYSTEM };
