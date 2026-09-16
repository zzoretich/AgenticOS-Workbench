'use strict';
/**
 * config.js — merged product config. Precedence (low → high):
 *   brain/scripts/config.default.json  ←  <vault>/brain/config.json  ←  <claudeConfigDir>/agenticos.json
 * Read fresh on every call (cheap; keeps long-running callers honest).
 */
const fs = require('fs');
const { PATHS, configFile } = require('./paths.js');
const DEFAULTS = require('../config.default.json');

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function loadConfig() {
  const vaultCfg = readJson(PATHS.CONFIG_JSON) || {};
  const userCfg = readJson(configFile()) || {};
  return deepMerge(deepMerge(DEFAULTS, vaultCfg), userCfg);
}

module.exports = { loadConfig, deepMerge, DEFAULTS };
