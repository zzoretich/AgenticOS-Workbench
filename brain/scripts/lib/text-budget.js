'use strict';
/** text-budget.js — the vault's canonical token heuristic (chars/4). */
function estimateTokens(s) { return Math.ceil(String(s ?? '').length / 4); }

function fitToBudget(sections, budget) {
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const s of ordered) {
    const t = estimateTokens(s.text);
    if (used + t <= budget) { kept.push(s); used += t; }
    else dropped.push(s.name);
  }
  kept.sort((a, b) => sections.indexOf(a) - sections.indexOf(b)); // original order in output
  return { text: kept.map((s) => s.text).join('\n'), dropped };
}

module.exports = { estimateTokens, fitToBudget };
