'use strict';

// Reads the real tokens out of style.css and checks every text/background
// pair the UI actually uses against WCAG AA. This is a regression guard: the
// palette shipped at 3.34:1 for --ink-3 once, and nothing caught it.
//
//   node test/contrast.js

const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---- colour maths (WCAG 2.x relative luminance) ----

function channel(hex, at) {
  return parseInt(hex.slice(at, at + 2), 16) / 255;
}

function luminance(hex) {
  const raw = hex.replace('#', '');
  const parts = [0, 2, 4].map(i => channel(raw, i));
  const linear = parts.map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// color-mix(in srgb, <fg> N%, transparent) composited over <bg>
function tint(fg, bg, percent) {
  const grab = hex => [0, 2, 4].map(i => parseInt(hex.replace('#', '').slice(i, i + 2), 16));
  const [f, b] = [grab(fg), grab(bg)];
  const a = percent / 100;
  const mixed = f.map((v, i) => Math.round(v * a + b[i] * (1 - a)));
  return `#${mixed.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

// ---- pull the palettes straight out of the stylesheet ----

function tokensFrom(blockStart) {
  const start = CSS.indexOf(blockStart);
  if (start === -1) throw new Error(`token block not found: ${blockStart}`);
  const open = CSS.indexOf('{', start);
  const body = CSS.slice(open + 1, CSS.indexOf('}', open));
  const out = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) out[name] = value;
  return out;
}

const light = tokensFrom(':root {');
const dark = tokensFrom(':root[data-theme="dark"]');

console.log('palette read from style.css');
ok('light palette parsed', Object.keys(light).length >= 10, `${Object.keys(light).length} tokens`);
ok('dark palette parsed', Object.keys(dark).length >= 10, `${Object.keys(dark).length} tokens`);

// ---- the pairs the interface actually renders ----

const AA = 4.5;

// [label, text token, background token]
const PAIRS = [
  ['body text on page', 'ink', 'bg'],
  ['body text on card', 'ink', 'surface'],
  ['secondary text on page', 'ink-2', 'bg'],
  ['hints/timestamps on page', 'ink-3', 'bg'],
  ['hints on card', 'ink-3', 'surface'],
  ['hints on raised surface', 'ink-3', 'elevate'],
  ['error text', 'err', 'bg'],
  ['warning text', 'warn', 'bg'],
  ['success text', 'ok', 'bg'],
];

// [label, text token, tint token, percent, base token] — tinted backgrounds
const TINTED = [
  ['warning on its alert tint', 'warn', 'warn', 12, 'bg'],
  ['warning on the plan banner', 'warn', 'warn', 12, 'surface'],
  ['error on its notice tint', 'err', 'err', 8, 'bg'],
];

for (const [theme, palette] of [['light', light], ['dark', dark]]) {
  console.log(`\n${theme}`);
  for (const [label, fg, bg] of PAIRS) {
    const value = ratio(palette[fg], palette[bg]);
    ok(`${label} — ${value.toFixed(2)}:1`, value >= AA, `needs ${AA}:1`);
  }
  for (const [label, fg, mix, percent, base] of TINTED) {
    const value = ratio(palette[fg], tint(palette[mix], palette[base], percent));
    ok(`${label} — ${value.toFixed(2)}:1`, value >= AA, `needs ${AA}:1`);
  }
  const onAccent = ratio(palette['on-accent'], palette.accent);
  ok(`primary button label — ${onAccent.toFixed(2)}:1`, onAccent >= AA);
}

// The two themes must not silently share a value that only works in one.
console.log('\nsanity');
ok('the themes are actually different', light.bg !== dark.bg && light.ink !== dark.ink);
ok('no token was left at the old failing --ink-3', light['ink-3'] !== '#8b8b84' && dark['ink-3'] !== '#73736d');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
