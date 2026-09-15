#!/usr/bin/env node
'use strict';
/**
 * pixel-assets.js — regenerates every pixel-art SVG under docs/assets/.
 *
 * Zero dependencies, deterministic: the same source produces byte-identical
 * files. Every asset is a grid of fixed-size square "pixels" emitted as merged
 * <rect> runs with shape-rendering="crispEdges" — no gradients, no fonts, no
 * anti-aliasing. The pixel fonts below are bitmaps.
 *
 * Usage: node tools/pixel-assets.js
 */

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'assets');

// ---------------------------------------------------------------- palette --
const C = {
  bg: '#0b0f14',
  scan: '#0a0e12', // bg at 92% — banner scanlines only
  border: '#1f2933',
  dim: '#3a4a5a',
  text: '#e6edf3',
  green: '#3fb950',
  amber: '#d29922',
  red: '#f85149',
  blue: '#58a6ff',
  purple: '#bc8cff',
  cyan: '#39d3f2',
};

// Sprite bitmap legend.
const PX = {
  '.': undefined, // leave the cell untouched
  d: C.border,
  k: C.dim,
  w: C.text,
  g: C.green,
  a: C.amber,
  r: C.red,
  b: C.blue,
  p: C.purple,
  c: C.cyan,
};

// ------------------------------------------------------------------ grid ---
class Grid {
  constructor(w, h, cell) {
    this.w = w;
    this.h = h;
    this.cell = cell;
    this.px = new Array(w * h).fill(null);
  }

  set(x, y, color) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = color;
  }

  rect(x, y, w, h, color) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, color);
  }

  /** Stamp a colour-mapped bitmap ('.' = skip). */
  sprite(rows, ox, oy, scale = 1) {
    rows.forEach((row, ry) => {
      [...row].forEach((ch, rx) => {
        const color = PX[ch];
        if (color === undefined) return;
        this.rect(ox + rx * scale, oy + ry * scale, scale, scale, color);
      });
    });
  }

  /** Stamp a single-colour bitmap ('#' = on). */
  mono(rows, ox, oy, color, scale = 1) {
    rows.forEach((row, ry) => {
      [...row].forEach((ch, rx) => {
        if (ch !== '#') return;
        this.rect(ox + rx * scale, oy + ry * scale, scale, scale, color);
      });
    });
  }

  /** Draw a string with a bitmap font; returns the advance width in cells. */
  write(font, str, ox, oy, color, scale = 1) {
    let x = ox;
    for (const ch of str.toUpperCase()) {
      const glyph = font[ch] || font['?'] || font[' '];
      if (color) this.mono(glyph, x, oy, color, scale);
      x += (glyph[0].length + 1) * scale;
    }
    return x - ox - scale;
  }

  /** Panel border with one-pixel notched (rounded) corners. */
  frame(color = C.border) {
    this.rect(0, 0, this.w, 1, color);
    this.rect(0, this.h - 1, this.w, 1, color);
    this.rect(0, 0, 1, this.h, color);
    this.rect(this.w - 1, 0, 1, this.h, color);
    this.set(0, 0, null);
    this.set(this.w - 1, 0, null);
    this.set(0, this.h - 1, null);
    this.set(this.w - 1, this.h - 1, null);
  }

  toSVG(label) {
    const runs = [];
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const c = this.px[y * this.w + x];
        if (c === null) { x++; continue; }
        let e = x;
        while (e + 1 < this.w && this.px[y * this.w + e + 1] === c) e++;
        runs.push({ x, y, w: e - x + 1, h: 1, c });
        x = e + 1;
      }
    }
    // Merge identical runs stacked vertically so solid areas cost one rect.
    const rows = new Map();
    for (const r of runs) {
      if (!rows.has(r.y)) rows.set(r.y, new Map());
      rows.get(r.y).set(`${r.x}:${r.w}:${r.c}`, r);
    }
    const used = new Set();
    const merged = [];
    for (const r of runs) {
      if (used.has(r)) continue;
      const key = `${r.x}:${r.w}:${r.c}`;
      let h = 1;
      for (;;) {
        const below = rows.get(r.y + h);
        const next = below && below.get(key);
        if (!next || used.has(next)) break;
        used.add(next);
        h++;
      }
      r.h = h;
      merged.push(r);
    }
    const groups = new Map();
    for (const r of merged) {
      if (!groups.has(r.c)) groups.set(r.c, []);
      groups.get(r.c).push(r);
    }
    const W = this.w * this.cell;
    const H = this.h * this.cell;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const out = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}">`,
    ];
    for (const [color, list] of groups) {
      const body = list
        .map((r) => `<rect x="${r.x * this.cell}" y="${r.y * this.cell}" width="${r.w * this.cell}" height="${r.h * this.cell}"/>`)
        .join('');
      out.push(`<g fill="${color}">${body}</g>`);
    }
    out.push('</svg>');
    return out.join('\n') + '\n';
  }
}

// ------------------------------------------------- display font: 5x7 caps --
// Fixed width. Used for the banner wordmark only.
const F5 = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#...#', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '#...#', '.###.'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
};

// ---------------------------------------------------- label font: 3x5 caps --
// Proportional: M and W are five wide, N is four, the rest three.
const F3 = {
  ' ': ['..', '..', '..', '..', '..'],
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '##.', '#..', '##.', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  0: ['###', '#.#', '#.#', '#.#', '###'],
  1: ['.#.', '##.', '.#.', '.#.', '###'],
  2: ['##.', '..#', '.#.', '#..', '###'],
  3: ['##.', '..#', '.#.', '..#', '##.'],
  4: ['#.#', '#.#', '###', '..#', '..#'],
  5: ['###', '#..', '##.', '..#', '##.'],
  6: ['.##', '#..', '##.', '#.#', '.#.'],
  7: ['###', '..#', '.#.', '.#.', '.#.'],
  8: ['.#.', '#.#', '.#.', '#.#', '.#.'],
  9: ['.#.', '#.#', '.##', '..#', '##.'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
};

/** Advance width, in cells, of a string in the given font at a scale. */
function measure(font, str, scale = 1) {
  let x = 0;
  for (const ch of str.toUpperCase()) {
    const glyph = font[ch] || font[' '];
    x += (glyph[0].length + 1) * scale;
  }
  return x - scale;
}

// --------------------------------------------------------------- sprites ---
/** Validate a 16x16 bitmap so a miscounted row fails loudly. */
function S(name, rows) {
  if (rows.length !== 16) throw new Error(`sprite ${name}: ${rows.length} rows, expected 16`);
  rows.forEach((row, i) => {
    if (row.length !== 16) throw new Error(`sprite ${name}: row ${i} is ${row.length} wide, expected 16`);
    for (const ch of row) if (!(ch in PX)) throw new Error(`sprite ${name}: row ${i} has unknown pixel "${ch}"`);
  });
  return rows;
}

const SPRITES = {};

SPRITES.brain = S('brain', [
  '....pppkkppp....',
  '..pppppkkppppp..',
  '.ppppppkkpppppp.',
  'pkkkpppkkpppkkkp',
  'ppppkkpkkpkkpppp',
  'pppppppkkppppppp',
  'pkkkpppkkpppkkkp',
  'ppppkkpkkpkkpppp',
  'pppppppkkppppppp',
  '.pkkpppkkpppkkp.',
  '.pppkkpkkpkkppp.',
  '..pppppkkppppp..',
  '...ppppkkpppp...',
  '....pppkkppp....',
  '......pppp......',
  '................',
]);

SPRITES.recall = S('recall', [
  '................',
  '....cccc........',
  '..cc....cc......',
  '.c........c.....',
  '.c........c.....',
  'c..........c....',
  'c..........c....',
  '.c........c.....',
  '.c........c.....',
  '..cc....cc......',
  '....cccc..ww....',
  '...........ww...',
  '............ww..',
  '.............ww.',
  '................',
  '................',
]);

SPRITES.session = S('session', [
  '................',
  '.....w....w.....',
  '..bbbbbbbbbbbb..',
  '..bbbbbbbbbbbb..',
  '..wwwwwwwwwwww..',
  '..w..........w..',
  '..w.kk.kk.kk.w..',
  '..w..........w..',
  '..w.kk.kk.kk.w..',
  '..w..........w..',
  '..w.kk.gg.kk.w..',
  '..w..........w..',
  '..w.kk.kk.kk.w..',
  '..w..........w..',
  '..wwwwwwwwwwww..',
  '................',
]);

SPRITES.staff = S('staff', [
  '................',
  '................',
  '....wwwwwwww....',
  '....wwwwwwww....',
  '....wwwwwwww....',
  '....wwwwwwww....',
  '....wwwwwwww....',
  '....wwwwwwww....',
  '....wwwwwwww....',
  '....aaaaaaaa....',
  '....aaaaaaaa....',
  '.wwwwwwwwwwwwww.',
  '.wwwwwwwwwwwwww.',
  '..kkkkkkkkkkkk..',
  '................',
  '................',
]);

SPRITES.hud = S('hud', [
  '................',
  '................',
  '.wwwwwwwwwwwwww.',
  '.w............w.',
  '.w.gg..gg..aa.w.',
  '.w............w.',
  '.w.kkkkkkkkkk.w.',
  '.w.kkkkkk.....w.',
  '.w.kkkkkkkk...w.',
  '.w.kkkk.......w.',
  '.w............w.',
  '.wwwwwwwwwwwwww.',
  '......wwww......',
  '......wwww......',
  '....wwwwwwww....',
  '................',
]);

SPRITES.cost = S('cost', [
  '................',
  '.....aaaaaa.....',
  '...aaaaaaaaaa...',
  '..aaaaaadaaaaa..',
  '.aaaaaaddddaaaa.',
  '.aaaaadadaaaaaa.',
  'aaaaaadadaaaaaaa',
  'aaaaaaadddaaaaaa',
  'aaaaaaaadadaaaaa',
  'aaaaaaaadadaaaaa',
  '.aaaaaddddaaaaa.',
  '.aaaaaaadaaaaaa.',
  '..aaaaaaaaaaaa..',
  '...aaaaaaaaaa...',
  '.....aaaaaa.....',
  '................',
]);

SPRITES.quickstart = S('quickstart', [
  '................',
  '.........aaaa...',
  '........aaaa....',
  '.......aaaa.....',
  '......aaaa......',
  '.....aaaaaaaa...',
  '....aaaaaaaa....',
  '.......aaaa.....',
  '......aaaa......',
  '.....aaaa.......',
  '....aaaa........',
  '...aaaa.........',
  '..aaaa..........',
  '...aa...........',
  '................',
  '................',
]);

SPRITES.prereq = S('prereq', [
  '................',
  '.wwwwwwwwwwwwww.',
  '.w............w.',
  '.w............w.',
  '.w............w.',
  '.w.........gg.w.',
  '.w........gg..w.',
  '.w.g.....gg...w.',
  '.w.gg...gg....w.',
  '.w..gg.gg.....w.',
  '.w...ggg......w.',
  '.w....g.......w.',
  '.w............w.',
  '.w............w.',
  '.wwwwwwwwwwwwww.',
  '................',
]);

SPRITES.install = S('install', [
  '................',
  '.......ww.......',
  '.......ww.......',
  '.......ww.......',
  '.......ww.......',
  '....wwwwwwww....',
  '.....wwwwww.....',
  '......wwww......',
  '.......ww.......',
  '..kkkkkkkkkkkk..',
  '..bbbbbbbbbbbb..',
  '..bbbbbbkkbbbb..',
  '..bbbbbbkkbbbb..',
  '..bbbbbbkkbbbb..',
  '..bbbbbbkkbbbb..',
  '................',
]);

SPRITES.first = S('first', [
  '.......ww.......',
  '......wwww......',
  '......wwww......',
  '.....wwwwww.....',
  '.....wccccw.....',
  '.....wccccw.....',
  '.....wwwwww.....',
  '.....wwwwww.....',
  '....rwwwwwwr....',
  '...rrwwwwwwrr...',
  '..rr.wwwwww.rr..',
  '.....wwwwww.....',
  '......wwww......',
  '......aaaa......',
  '.......aa.......',
  '................',
]);

SPRITES.commands = S('commands', [
  '................',
  '................',
  '.wwwwwwwwwwwwww.',
  '.w.r.a.g......w.',
  '.wkkkkkkkkkkkkw.',
  '.w............w.',
  '.w.gg.........w.',
  '.w..gg........w.',
  '.w...gg.......w.',
  '.w..gg........w.',
  '.w.gg..gggggg.w.',
  '.w............w.',
  '.wwwwwwwwwwwwww.',
  '................',
  '................',
  '................',
]);

SPRITES.how = S('how', [
  '................',
  '.....cc..cc.....',
  '.....cc..cc.....',
  '...cccccccccc...',
  '...cccccccccc...',
  '.cccccccccccccc.',
  '.ccccc....ccccc.',
  '...ccc....ccc...',
  '...ccc....ccc...',
  '.ccccc....ccccc.',
  '.cccccccccccccc.',
  '...cccccccccc...',
  '...cccccccccc...',
  '.....cc..cc.....',
  '.....cc..cc.....',
  '................',
]);

SPRITES.privacy = S('privacy', [
  '................',
  '.....wwwwww.....',
  '....ww....ww....',
  '....ww....ww....',
  '....ww....ww....',
  '....ww....ww....',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '..aaaaa..aaaaa..',
  '..aaaaa..aaaaa..',
  '..aaaaa..aaaaa..',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '................',
]);

SPRITES.layout = S('layout', [
  '................',
  '................',
  '..aaaa..........',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '.bbbb...........',
  '.bbbbbbbbbbbb...',
  '.bbbbbbbbbbbb...',
  '.bbbbbbbbbbbb...',
  '.bbbbbbbbbbbb...',
  '.bbbbbbbbbbbb...',
  '.bbbbbbbbbbbb...',
  '................',
  '................',
]);

SPRITES.dev = S('dev', [
  '................',
  '..wwwww.........',
  '.wwwwwwwww......',
  '.www..wwwwwwww..',
  '.ww....wwwwwwww.',
  '.......wwwwwwww.',
  '.......wwwwwwww.',
  '.......kkkkkkkk.',
  '........aaaa....',
  '........aaaa....',
  '........aaaa....',
  '........aaaa....',
  '........aaaa....',
  '........aaaa....',
  '.......aaaaaa...',
  '.......aaaaaa...',
]);

SPRITES.uninstall = S('uninstall', [
  '................',
  '......wwwww.....',
  '...rrrrrrrrrrr..',
  '...rrrrrrrrrrr..',
  '....wwwwwwwww...',
  '....w.k.k.k.w...',
  '....w.k.k.k.w...',
  '....w.k.k.k.w...',
  '....w.k.k.k.w...',
  '....w.k.k.k.w...',
  '....w.k.k.k.w...',
  '....w.k.k.k.w...',
  '....w.k.k.k.w...',
  '.....wwwwwww....',
  '................',
  '................',
]);

SPRITES.docs = S('docs', [
  '................',
  '................',
  '..wwwwwbbwwwww..',
  '.wwwwwwbbwwwwww.',
  '.wkkkkwbbwkkkkw.',
  '.wwwwwwbbwwwwww.',
  '.wkkkkwbbwkkkkw.',
  '.wwwwwwbbwwwwww.',
  '.wkkkkwbbwkkkkw.',
  '.wwwwwwbbwwwwww.',
  '.wkkkkwbbwkkkkw.',
  '.wwwwwwbbwwwwww.',
  '..wwwwwbbwwwww..',
  '................',
  '................',
  '................',
]);

SPRITES.license = S('license', [
  '................',
  '................',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '...wwwwwwwwww...',
  '...wkkkkkkkkw...',
  '...wwwwwwwwww...',
  '...wkkkkkkkkw...',
  '...wwwwwwwwww...',
  '...wkkkkkkkkw...',
  '...wwwwwwwwww...',
  '...wkkkkkkkkw...',
  '...wwwwwwwwww...',
  '..aaaaaaaaaaaa..',
  '..aaaaaaaaaaaa..',
  '................',
]);

SPRITES.screens = S('screens', [
  '................',
  '................',
  '................',
  '....wwww........',
  '.wwwwwwwwwwwwww.',
  '.wkkkkkkkkkkkaw.',
  '.wkkkcccccckkkw.',
  '.wkkccddddcckkw.',
  '.wkkcddddddckkw.',
  '.wkkcddddddckkw.',
  '.wkkccddddcckkw.',
  '.wkkkcccccckkkw.',
  '.wkkkkkkkkkkkkw.',
  '.wwwwwwwwwwwwww.',
  '................',
  '................',
]);

// ---------------------------------------------------------------- helpers --
function ledRowWidth(entries, ledSize, gapLed, gapEntry) {
  let w = 0;
  entries.forEach(([label], i) => {
    w += ledSize + gapLed + measure(F3, label);
    if (i < entries.length - 1) w += gapEntry;
  });
  return w;
}

function drawLedRow(g, entries, x0, labelY, ledSize, gapLed, gapEntry, labelColor) {
  const ledY = labelY + Math.floor((5 - ledSize) / 2);
  let x = x0;
  for (const [label, color] of entries) {
    g.rect(x, ledY, ledSize, ledSize, color);
    x += ledSize + gapLed;
    g.write(F3, label, x, labelY, labelColor);
    x += measure(F3, label) + gapEntry;
  }
}

// ----------------------------------------------------------------- assets --
const BANNER_LEDS = [
  ['SCAN', C.green],
  ['WRAP', C.green],
  ['COST', C.amber],
  ['MAP', C.dim],
  ['STAFF', C.green],
];

const PULSE_LEDS = [
  ['SCAN', C.green],
  ['WRAP', C.green],
  ['COST', C.amber],
  ['BACKFILL', C.dim],
  ['STAFF', C.green],
  ['MAP', C.green],
  ['AWRAP', C.amber],
  ['BRAIN', C.green],
];

function buildBanner() {
  const W = 160;
  const H = 33;
  const g = new Grid(W, H, 6);
  for (let y = 0; y < H; y++) g.rect(0, y, W, 1, y % 2 ? C.scan : C.bg);
  g.frame();

  const wordmark = 'AGENTICOS WORKBENCH';
  const tagline = 'A SECOND BRAIN FOR CLAUDE CODE';
  const markW = measure(F5, wordmark);
  const spriteW = 16;
  const gap = 8;
  const left = Math.floor((W - (spriteW + gap + markW)) / 2);
  const markX = left + spriteW + gap;

  g.sprite(SPRITES.brain, left, 4);
  g.write(F5, wordmark, markX, 5, C.text);
  g.rect(markX, 13, markW, 1, C.border);

  const tagW = measure(F3, tagline);
  g.write(F3, tagline, markX + Math.floor((markW - tagW) / 2), 16, C.cyan);

  const rowW = ledRowWidth(BANNER_LEDS, 2, 2, 3);
  drawLedRow(g, BANNER_LEDS, W - 6 - rowW, 25, 2, 2, 3, C.text);

  return g.toSVG('AgenticOS Workbench — a second brain for Claude Code');
}

function buildDivider() {
  const W = 240;
  const H = 3;
  const g = new Grid(W, H, 4);
  g.rect(0, 0, W, H, C.bg);
  for (let x = 0; x < W; x++) {
    if (x % 8 < 4) g.set(x, 0, C.border);
    else g.set(x, 2, C.border);
  }
  g.rect(0, 1, W, 1, C.dim);
  const accents = [C.green, C.cyan, C.blue, C.purple, C.amber];
  let n = 0;
  for (let x = 4; x < W - 2; x += 24) g.rect(x, 0, 2, 3, accents[n++ % accents.length]);
  for (const [x, y] of [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]]) g.set(x, y, null);
  return g.toSVG('Section divider');
}

function buildIcon(sprite, label) {
  const W = 20;
  const H = 20;
  const g = new Grid(W, H, 3);
  g.rect(0, 0, W, H, C.bg);
  g.frame();
  g.sprite(sprite, 2, 2);
  return g.toSVG(label);
}

function buildPulse() {
  const W = 240;
  const H = 12;
  const g = new Grid(W, H, 4);
  g.rect(0, 0, W, H, C.bg);
  g.frame();
  const rowW = ledRowWidth(PULSE_LEDS, 3, 2, 3);
  drawLedRow(g, PULSE_LEDS, Math.floor((W - rowW) / 2), 4, 3, 2, 3, C.text);
  return g.toSVG('Pipeline pulse row');
}

function buildMadeWith() {
  const W = 100;
  const H = 18;
  const g = new Grid(W, H, 2);
  g.rect(0, 0, W, H, C.bg);
  g.frame();
  g.rect(5, 7, 3, 3, C.green);
  g.write(F3, 'MADE WITH CLAUDE CODE', 11, 6, C.text);
  return g.toSVG('Made with Claude Code');
}

const ICONS = [
  ['icon-brain', 'brain', 'Memory'],
  ['icon-recall', 'recall', 'Recall'],
  ['icon-session', 'session', 'Session capture'],
  ['icon-staff', 'staff', 'Chief of staff'],
  ['icon-hud', 'hud', 'Obsidian HUD'],
  ['icon-cost', 'cost', 'Cost'],
  ['icon-quickstart', 'quickstart', 'Quick start'],
  ['icon-prereq', 'prereq', 'Prerequisites'],
  ['icon-install', 'install', 'Installation'],
  ['icon-first', 'first', 'First session'],
  ['icon-commands', 'commands', 'Everyday commands'],
  ['icon-how', 'how', 'How it works'],
  ['icon-privacy', 'privacy', 'Privacy'],
  ['icon-layout', 'layout', 'Repository layout'],
  ['icon-dev', 'dev', 'Development'],
  ['icon-uninstall', 'uninstall', 'Uninstall'],
  ['icon-docs', 'docs', 'Docs'],
  ['icon-license', 'license', 'License'],
  ['icon-screens', 'screens', 'Screenshots'],
];

function buildAll() {
  const files = new Map();
  files.set('banner.svg', buildBanner());
  files.set('divider.svg', buildDivider());
  for (const [name, key, label] of ICONS) {
    files.set(`${name}.svg`, buildIcon(SPRITES[key], `${label} icon`));
  }
  files.set('pulse.svg', buildPulse());
  files.set('made-with.svg', buildMadeWith());
  return files;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = buildAll();
  for (const [name, svg] of files) {
    fs.writeFileSync(path.join(OUT_DIR, name), svg);
    process.stdout.write(`${name} ${Buffer.byteLength(svg)} bytes\n`);
  }
  process.stdout.write(`${files.size} assets written to docs/assets/\n`);
}

if (require.main === module) main();
module.exports = { Grid, F3, F5, PX, C, SPRITES, ICONS, measure, buildAll, buildIcon };

