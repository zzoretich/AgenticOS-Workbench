'use strict';
/**
 * embed.js — embedding client for the embedder role via Ollama /api/embed.
 * Returns unit-normalized vectors so cosine similarity is a plain dot product.
 * dimensions defaults to 256 (qwen3-embedding supports Matryoshka truncation);
 * if the serving model ignores the field, whatever dimension comes back is
 * normalized and stored as-is — recall.js only compares like against like.
 */
const http = require('http');
const { role } = require('./models.js');

const HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const PORT = Number(process.env.OLLAMA_PORT || 11434);
const BATCH = 16;
const DEFAULT_DIMS = 256;

function normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const len = Math.sqrt(s) || 1;
  return v.map((x) => x / len);
}

function postEmbed(payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: HOST, port: PORT, path: '/api/embed', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`ollama embed HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (!Array.isArray(parsed.embeddings)) return reject(new Error('ollama embed: no embeddings in reply'));
          resolve(parsed.embeddings);
        } catch (e) { reject(new Error('ollama embed parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('ollama embed timeout')); });
    req.write(body);
    req.end();
  });
}

/** embed(texts, opts) -> Promise<number[][]> (unit-normalized, one per input) */
async function embed(texts, opts = {}) {
  const arr = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || ''));
  if (!arr.length) return [];
  const r = role('embedder');
  const postFn = opts.postFn || postEmbed;
  const out = [];
  for (let i = 0; i < arr.length; i += BATCH) {
    const embeddings = await postFn({
      model: r.tag,
      input: arr.slice(i, i + BATCH),
      keep_alive: r.keepAlive,
      truncate: true,
      dimensions: opts.dimensions || DEFAULT_DIMS,
    }, opts.timeoutMs || 120000);
    out.push(...embeddings.map(normalize));
  }
  return out;
}

module.exports = { embed, normalize };
