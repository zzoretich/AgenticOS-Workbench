/**
 * json-extract.js — defensive JSON extraction for agent replies.
 *
 * Agent responses sometimes include trailing prose after the JSON ("Here is the
 * brief above. Let me know..."), or wrap output in code fences despite "no fences"
 * instructions. This helper finds the first complete top-level {...} or [...]
 * via balanced-bracket scanning, handling string literals and escapes.
 */

function stripFencesAndPreamble(text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json|javascript)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * Escapes raw control characters that appear INSIDE string literals — small
 * models emit multi-line string values with literal newlines/tabs, which strict
 * JSON.parse rejects ("Bad control character in string literal"). Walks with
 * the same string/escape state machine as scanBalanced; characters outside
 * strings (ordinary formatting whitespace) are left untouched. Idempotent on
 * valid JSON. Only ever inserts escapes, never removes characters, so a reply
 * that was unparseable for other reasons fails exactly as before.
 */
function sanitizeControlChars(text) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { out += ch; escape = false; continue; }
      if (ch === '\\') { out += ch; escape = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? '\\n'
          : code === 0x0d ? '\\r'
          : code === 0x09 ? '\\t'
          : '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

function findFirstJsonObject(raw) {
  const text = stripFencesAndPreamble(raw);
  // Find the first '{' or '[' that isn't inside a string literal.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = scanBalanced(text, i);
    if (end > i) return text.slice(i, end + 1);
  }
  return null;
}

function scanBalanced(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse an agent reply as JSON. Tries direct parse first; if that fails, isolates
 * the first balanced JSON object/array and parses that. Throws on no-JSON-found.
 */
function parseAgentJson(text) {
  if (!text) throw new Error('empty agent reply');

  const stripped = sanitizeControlChars(stripFencesAndPreamble(text));

  // Fast path — clean output, parse direct.
  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through.
  }

  // Slow path — isolate first balanced bracket pair.
  const candidate = findFirstJsonObject(stripped);
  if (!candidate) {
    throw new Error(`no JSON object found in reply (${stripped.length} chars)`);
  }
  return JSON.parse(candidate);
}

module.exports = {
  parseAgentJson,
  findFirstJsonObject,
  stripFencesAndPreamble,
  sanitizeControlChars,
};
