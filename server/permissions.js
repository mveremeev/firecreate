'use strict';

// What can this extension actually do, and what can a webpage make it do?
//
// Two separate questions. The first is answered by the manifest and is exact.
// The second is answered by grepping the code for the places where web content
// reaches extension privilege, and is deliberately over-eager: these are
// patterns, not proofs. A finding here means "look at this", not "this is a
// vulnerability". Missing something is possible; inventing something is not.

const fs = require('fs');
const path = require('path');
const store = require('./store');

// Plain language, written for someone deciding whether to install this.
// `risk` drives how loudly it is shown; `says` is what they read.
const PERMISSIONS = {
  '<all_urls>':       { risk: 'high',   says: 'Read and change everything on every website you visit.' },
  tabs:               { risk: 'medium', says: 'See the address and title of every tab you have open.' },
  cookies:            { risk: 'high',   says: 'Read and change cookies — including the ones that keep you logged in.' },
  history:            { risk: 'high',   says: 'Read and change your browsing history.' },
  bookmarks:          { risk: 'high',   says: 'Read and change your bookmarks.' },
  downloads:          { risk: 'medium', says: 'Download files and see your download history.' },
  'downloads.open':   { risk: 'high',   says: 'Open downloaded files.' },
  management:         { risk: 'high',   says: 'See, disable and remove your other extensions.' },
  nativeMessaging:    { risk: 'high',   says: 'Talk to programs installed on your computer, outside the browser.' },
  debugger:           { risk: 'high',   says: 'Attach the browser debugger to any page — full control of what it does.' },
  proxy:              { risk: 'high',   says: 'Route your browsing through a proxy of its choosing.' },
  privacy:            { risk: 'high',   says: 'Change your browser privacy settings.' },
  browsingData:       { risk: 'high',   says: 'Erase your browsing data.' },
  webRequest:         { risk: 'medium', says: 'Watch the network requests your browser makes.' },
  webRequestBlocking: { risk: 'high',   says: 'Intercept, change and block network requests before they happen.' },
  clipboardRead:      { risk: 'high',   says: 'Read whatever you have copied to the clipboard.' },
  geolocation:        { risk: 'high',   says: 'Read your physical location.' },
  identity:           { risk: 'medium', says: 'Get access tokens for signing in to services.' },
  sessions:           { risk: 'medium', says: 'See and restore recently closed tabs and windows.' },
  topSites:           { risk: 'medium', says: 'See the sites you visit most.' },
  notifications:      { risk: 'low',    says: 'Show you desktop notifications.' },
  clipboardWrite:     { risk: 'low',    says: 'Put things on your clipboard.' },
  storage:            { risk: 'low',    says: 'Save its own settings.' },
  unlimitedStorage:   { risk: 'low',    says: 'Save an unlimited amount of its own data.' },
  activeTab:          { risk: 'low',    says: 'See the page you are on — but only when you click the button.' },
  contextMenus:       { risk: 'low',    says: 'Add items to the right-click menu.' },
  menus:              { risk: 'low',    says: 'Add items to the right-click menu.' },
  alarms:             { risk: 'low',    says: 'Schedule its own background timers.' },
  idle:               { risk: 'low',    says: 'Tell whether you are away from the computer.' },
};

const EVERYWHERE = /^(\*|https?|file|ftp):\/\/(\*|\*\.\*)?\/?\*?$/;

function describeHost(pattern) {
  if (pattern === '<all_urls>' || EVERYWHERE.test(pattern) || /^\*:\/\/\*\/\*$/.test(pattern)) {
    return { risk: 'high', says: 'Read and change everything on every website you visit.' };
  }
  const host = pattern.match(/^[^:]+:\/\/([^/]+)/);
  if (!host) return null;
  const site = host[1].replace(/^\*\./, '');
  return site === '*'
    ? { risk: 'high', says: 'Read and change everything on every website you visit.' }
    : { risk: 'medium', says: `Read and change pages on ${site}.` };
}

// Anything the manifest asks for, in the order it will matter to a reader.
function readPermissions(manifest) {
  const out = [];
  const seen = new Set();

  const add = (name, info, why) => {
    if (!info || seen.has(name)) return;
    seen.add(name);
    out.push({ name, risk: info.risk, says: info.says, why });
  };

  for (const raw of manifest.permissions || []) {
    const name = String(raw);
    if (PERMISSIONS[name]) add(name, PERMISSIONS[name], 'permissions');
    else if (name.includes('://')) add(name, describeHost(name), 'host permission');
    else add(name, { risk: 'medium', says: `Use the "${name}" browser feature.` }, 'permissions');
  }

  for (const raw of manifest.optional_permissions || []) {
    const name = String(raw);
    const info = PERMISSIONS[name] || (name.includes('://') ? describeHost(name) : null);
    if (info) add(`${name} (optional)`, { ...info, risk: 'low' }, 'asked for later, only if you agree');
  }

  // Content-script matches grant the same reach as a host permission.
  for (const entry of manifest.content_scripts || []) {
    for (const pattern of entry.matches || []) {
      const info = describeHost(String(pattern));
      if (info) {
        add(`content script on ${pattern}`, {
          risk: info.risk,
          says: `${info.says} Its code runs on those pages automatically, whether or not you click anything.`,
        }, 'content_scripts');
      }
    }
  }

  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.risk] - order[b.risk]);
}

// ---- where web content can reach in ----

// Each rule: what to look for, what it means, and what to do instead.
const EXPOSURE_RULES = [
  {
    id: 'postMessage-listener',
    test: source => /addEventListener\s*\(\s*['"`]message['"`]/.test(source)
      && !/\.origin\s*[!=]==?|\.source\s*[!=]==?/.test(source),
    risk: 'high',
    says: 'listens for messages from the webpage without checking where they came from',
    means: 'Any website can send it a message and be treated as trusted.',
    fix: 'Check event.origin and event.source before acting on a message, and ignore anything unexpected.',
  },
  {
    id: 'onMessageExternal',
    test: source => /onMessageExternal|onConnectExternal/.test(source),
    risk: 'high',
    says: 'accepts messages from outside the extension',
    means: 'Websites and other extensions can talk to it directly.',
    fix: 'Remove it unless a specific site genuinely needs to talk to this extension, and verify sender.id / sender.url if it does.',
  },
  {
    id: 'background-fetch-proxy',
    test: source => /onMessage\.addListener/.test(source)
      && /\bfetch\s*\(\s*(request|message|msg|data|params)\b/.test(source),
    risk: 'high',
    says: 'fetches whatever URL it is asked to fetch',
    means: 'A page can use the extension to read other websites using your logged-in session, bypassing the browser\'s protections.',
    fix: 'Only fetch URLs the extension itself constructs, or check the URL against a fixed allowlist first.',
  },
  {
    id: 'eval',
    test: source => /\beval\s*\(|new\s+Function\s*\(/.test(source),
    risk: 'high',
    says: 'runs code built at runtime',
    means: 'If any part of that string comes from a page, the page is running code with the extension\'s privileges.',
    fix: 'Remove it. There is almost always a direct way to do the same thing.',
  },
  {
    id: 'executeScript-variable',
    test: source => /executeScript\s*\(\s*[^)]*\bcode\s*:/.test(source),
    risk: 'high',
    says: 'injects code from a string',
    means: 'If any of that string is page-derived, the page chooses what runs.',
    fix: 'Inject a file instead of a code string.',
  },
  {
    id: 'innerHTML',
    test: source => /\.(innerHTML|outerHTML)\s*=(?!\s*['"`]\s*['"`])|insertAdjacentHTML\s*\(/.test(source),
    risk: 'medium',
    says: 'builds HTML from strings',
    means: 'If page text ends up in there, it becomes code running inside the extension.',
    fix: 'Use textContent, or build elements with createElement.',
  },
];

function scanCode(dir) {
  const findings = [];
  for (const entry of store.listFilesIn(dir)) {
    if (!/\.(js|html)$/.test(entry.path)) continue;
    const abs = store.resolveIn(dir, entry.path);
    if (!abs) continue;
    const source = fs.readFileSync(abs, 'utf8');
    for (const rule of EXPOSURE_RULES) {
      if (rule.test(source)) {
        findings.push({ id: rule.id, file: entry.path, risk: rule.risk, says: rule.says, means: rule.means, fix: rule.fix });
      }
    }
  }
  return findings;
}

function manifestExposure(manifest) {
  const findings = [];

  const external = manifest.externally_connectable;
  if (external) {
    const matches = (external.matches || []).join(', ') || 'unspecified';
    findings.push({
      id: 'externally-connectable',
      file: 'manifest.json',
      risk: 'high',
      says: `lets websites (${matches}) connect to it`,
      means: 'Those pages can send it instructions directly.',
      fix: 'Remove externally_connectable unless a specific site must talk to this extension.',
    });
  }

  const web = manifest.web_accessible_resources;
  const list = Array.isArray(web) ? web : (web || []).flatMap(r => r.resources || []);
  if (list.length) {
    findings.push({
      id: 'web-accessible',
      file: 'manifest.json',
      risk: 'medium',
      says: `exposes ${list.join(', ')} to any website`,
      means: 'A page can load or frame those files and interact with them.',
      fix: 'Expose only what a page truly needs to load — images, not pages that hold logic.',
    });
  }

  return findings;
}

// The whole picture for one built extension.
function analyse(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { permissions: [], exposures: [], worst: 'low' };

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { permissions: [], exposures: [], worst: 'low' };
  }

  const permissions = readPermissions(manifest);
  const exposures = [...manifestExposure(manifest), ...scanCode(dir)];

  const risks = [...permissions, ...exposures].map(item => item.risk);
  const worst = risks.includes('high') ? 'high' : risks.includes('medium') ? 'medium' : 'low';

  return { permissions, exposures, worst };
}

// The same findings, phrased for the model rather than the user.
function asBriefing({ permissions, exposures }) {
  const lines = [];

  const risky = permissions.filter(p => p.risk === 'high');
  if (risky.length) {
    lines.push('These permissions are broad. Drop any the code does not actually use, and narrow the rest:');
    for (const p of risky) lines.push(`- ${p.name} — ${p.says}`);
  }

  if (exposures.length) {
    lines.push('', 'These are places a webpage could reach into the extension:');
    for (const e of exposures) {
      lines.push(`- ${e.file}: ${e.says}. ${e.means} Fix: ${e.fix}`);
    }
  }

  return lines.join('\n');
}

module.exports = { analyse, asBriefing, PERMISSIONS, EXPOSURE_RULES };
