'use strict';

// Unit checks for the pieces with real logic in them: the context window
// budget and the zip writer.
//
//   node test/unit.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.MAKE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'make-unit-'));

const { trimHistory, recentTurns, contextBudget } = require('../server/builder');
const { zipDir, crc32 } = require('../server/zip');
const { extractJson, makeReplyExtractor } = require('../server/llm');

let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const turn = (role, size, tag) => ({ role, content: `${tag}:` + 'x'.repeat(Math.max(0, size - tag.length - 1)) });
const size = messages => messages.reduce((n, m) => n + m.content.length, 0);

// ---- context budget ----
console.log('context budget');

ok('budget is a tenth of the window, in characters',
  contextBudget({ contextTokens: 100000 }) === 100000 * 0.10 * 4);
ok('a missing window falls back to a sane default',
  contextBudget({}) === 128000 * 0.10 * 4);
ok('tiny windows still get a workable floor',
  contextBudget({ contextTokens: 1000 }) === 4000);

const short = [turn('user', 100, 'a'), turn('assistant', 100, 'b')];
ok('short conversations pass through untouched',
  trimHistory(short, 10000).messages === short && trimHistory(short, 10000).dropped === 0);

// 40 turns of 1000 chars against a 10000-char budget.
const long = Array.from({ length: 40 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', 1000, `m${i}`));
const trimmed = trimHistory(long, 10000);
const kept = trimmed.messages.filter(m => m.role !== 'system');

ok('it drops the middle', trimmed.dropped > 0 && kept.length < long.length);
ok('it stays within budget', size(trimmed.messages) <= 10000 * 1.2, `used ${size(trimmed.messages)}`);
ok('the opening survives', kept[0].content.startsWith('m0:'));
ok('the newest turn survives', kept[kept.length - 1].content.startsWith('m39:'));
ok('a marker explains the gap',
  trimmed.messages.some(m => m.role === 'system' && /omitted/.test(m.content)));

const head = kept.filter(m => Number(m.content.match(/^m(\d+)/)[1]) < 20).length;
const tail = kept.length - head;
ok('roughly a fifth comes from the start', head >= 1 && head <= 4, `head=${head}`);
ok('the rest comes from the end', tail > head, `head=${head} tail=${tail}`);

const huge = [turn('user', 50000, 'big')];
ok('a single oversized turn is never dropped',
  trimHistory(huge, 1000).messages.some(m => m.content.startsWith('big:')));

ok('recentTurns takes from the end',
  recentTurns(long, 3500).at(-1).content.startsWith('m39:'));
ok('recentTurns respects its budget', size(recentTurns(long, 3500)) <= 3500);

// ---- json extraction ----
console.log('\njson extraction');

ok('plain object', extractJson('{"a":1}').a === 1);
ok('ignores prose around it', extractJson('Sure!\n{"a":1}\nHope that helps').a === 1);
ok('survives fenced code', extractJson('```json\n{"a":1}\n```').a === 1);
ok('braces inside strings do not end the scan',
  extractJson('{"a":"}{","b":2}').b === 2);
ok('nested objects', extractJson('{"a":{"b":{"c":3}}}').a.b.c === 3);
ok('returns null on junk', extractJson('no json here') === null);

// ---- streaming reply extractor ----
console.log('\nstreaming reply extractor');

function streamThrough(text, chunkSize) {
  let out = '';
  const extractor = makeReplyExtractor(d => { out += d; });
  for (let i = 0; i < text.length; i += chunkSize) extractor.push(text.slice(i, i + chunkSize));
  return out;
}

const payload = JSON.stringify({ reply: 'Hi there.\nLine two — “quoted” ✓', title: 'T', spec: ['a'] });
const expected = 'Hi there.\nLine two — “quoted” ✓';
ok('whole payload at once', streamThrough(payload, payload.length) === expected);
ok('one character at a time', streamThrough(payload, 1) === expected,
  JSON.stringify(streamThrough(payload, 1)));
ok('awkward chunk sizes agree',
  [2, 3, 5, 7, 13].every(n => streamThrough(payload, n) === expected));

const escaped = JSON.stringify({ reply: 'a\\b "c" é — d' });
ok('escapes survive being split',
  [1, 2, 3, 4].every(n => streamThrough(escaped, n) === 'a\\b "c" é — d'),
  JSON.stringify(streamThrough(escaped, 1)));

// ---- prompts ----
//
// The Firefox rules are the difference between an extension that loads and one
// that works. Losing them from a prompt in a refactor would be invisible in
// every other test, so it is checked here.
console.log('\nprompts');

const { prompts } = require('../server/builder');
const tok = text => Math.round(text.length / 4);

const WRITES_CODE = ['AGENT_SYSTEM', 'BUILD_SYSTEM', 'REVISE_SYSTEM'];
for (const name of WRITES_CODE) {
  ok(`${name} carries the Firefox rules`, prompts[name].includes(prompts.FIREFOX_RULES));
  ok(`${name} carries the craft guidance`, prompts[name].includes(prompts.CRAFT));
}
ok('REVIEW_SYSTEM carries the Firefox rules', prompts.REVIEW_SYSTEM.includes(prompts.FIREFOX_RULES));

for (const name of WRITES_CODE) {
  ok(`${name} carries the trust-boundary rules`, prompts[name].includes(prompts.TRUST_RULES));
}
ok('SECURITY_REVIEW_SYSTEM carries the trust-boundary rules',
  prompts.SECURITY_REVIEW_SYSTEM.includes(prompts.TRUST_RULES));
ok('the security lens is told the author probably meant well',
  /assume the author meant well/i.test(prompts.SECURITY_REVIEW_SYSTEM));
ok('the security lens is told the scan only matches patterns',
  /only matches patterns/i.test(prompts.SECURITY_REVIEW_SYSTEM));

const TRUST_MUST_COVER = [
  ['unchecked postMessage', /event\.origin/],
  ['sender validation', /check sender/i],
  ['the fetch-proxy hole', /NEVER fetch a URL that came from the page/],
  ['eval on page data', /eval\(\)/],
  ['innerHTML in extension pages', /innerHTML/],
  ['web_accessible_resources', /web_accessible_resources/],
  ['externally_connectable', /externally_connectable/],
  ['least privilege', /fewest permissions/i],
  ['activeTab over <all_urls>', /activeTab is enough[\s\S]*<all_urls>/i],
];
for (const [label, pattern] of TRUST_MUST_COVER) {
  ok(`the trust rules cover ${label}`, pattern.test(prompts.TRUST_RULES));
}

// Each rule names the specific failure it prevents.
const MUST_MENTION = [
  ['clipboard from a background page', /clipboard[\s\S]*background script/i],
  ['data: URLs in downloads', /downloads\.download[\s\S]*data: URL/i],
  ['the sendResponse contract', /sendResponse/i],
  ['captureVisibleTab being viewport-only', /captureVisibleTab[\s\S]*viewport/i],
];
for (const [label, pattern] of MUST_MENTION) {
  ok(`the rules cover ${label}`, pattern.test(prompts.FIREFOX_RULES));
}

ok('the plan is described as the contract the build stage sees',
  /contract/i.test(prompts.CLARIFY_SYSTEM));
ok('the clarify stage is told to prefer defaults over interrogating',
  /sensible default/i.test(prompts.CLARIFY_SYSTEM));
ok('the clarify stage knows a rebuild edits rather than restarts',
  /edits it in place/.test(prompts.CLARIFY_SYSTEM) && /do not guess at this/i.test(prompts.CLARIFY_SYSTEM));
ok('the clarify stage knows the build sees recent messages',
  /most recent messages/.test(prompts.CLARIFY_SYSTEM));
ok('the agent is told check() does not prove behaviour',
  /cannot tell you whether the extension behaves/i.test(prompts.AGENT_SYSTEM));
ok('the one-shot prompts still forbid tools',
  /NEVER use any tools/.test(prompts.BUILD_SYSTEM) && /NEVER use any tools/.test(prompts.REVISE_SYSTEM));
ok('the agent prompt does NOT forbid tools',
  !/NEVER use any tools/.test(prompts.AGENT_SYSTEM));

// Dense beats long: a system prompt that dwarfs the task crowds out the work.
// The prompts that write code carry three rule blocks and legitimately run
// longer than the ones that only read it — the point is catching runaway
// growth, not enforcing one number everywhere.
const CEILING = { AGENT_SYSTEM: 1500, BUILD_SYSTEM: 1500, REVISE_SYSTEM: 1500 };
for (const name of ['CLARIFY_SYSTEM', 'AGENT_SYSTEM', 'BUILD_SYSTEM', 'REVISE_SYSTEM', 'REVIEW_SYSTEM', 'SECURITY_REVIEW_SYSTEM']) {
  const limit = CEILING[name] || 900;
  ok(`${name} stays under ${limit} tokens (${tok(prompts[name])})`, tok(prompts[name]) < limit);
}

// ---- permissions and exposure analysis ----
//
// This is the only part of the pipeline that tells the truth about what a
// built extension can do, so it must not depend on the model's cooperation.
console.log('\npermission analysis');

const perms = require('../server/permissions');

function extensionWith(manifest, files = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.MAKE_DATA, 'ext-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
const named = (report, needle) => report.permissions.find(p => p.name.includes(needle));
const flagged = (report, id) => report.exposures.find(e => e.id === id);

const broad = perms.analyse(extensionWith({
  permissions: ['<all_urls>', 'cookies', 'tabs', 'activeTab', 'storage', 'somethingNew'],
}));
ok('<all_urls> is high risk and said plainly',
  named(broad, '<all_urls>').risk === 'high' && /every website/.test(named(broad, '<all_urls>').says));
ok('cookies mentions staying logged in', /logged in/.test(named(broad, 'cookies').says));
ok('activeTab is low risk and says why', named(broad, 'activeTab').risk === 'low');
ok('an unknown permission still gets reported', Boolean(named(broad, 'somethingNew')));
ok('high risk sorts to the top', broad.permissions[0].risk === 'high');
ok('the worst risk is surfaced', broad.worst === 'high');

const narrow = perms.analyse(extensionWith({ permissions: ['https://example.com/*', 'storage'] }));
ok('a single-site host permission names the site',
  narrow.permissions[0].risk === 'medium' && /example\.com/.test(narrow.permissions[0].says));
ok('a narrow extension is not called high risk', narrow.worst === 'medium');

const wildcardHost = perms.analyse(extensionWith({ permissions: ['*://*/*'] }));
ok('a wildcard host pattern is treated as every site', wildcardHost.worst === 'high');

const injected = perms.analyse(extensionWith({
  permissions: ['storage'],
  content_scripts: [{ matches: ['<all_urls>'], js: ['c.js'] }],
}, { 'c.js': 'console.log(1);' }));
ok('a content script on every site counts as broad reach',
  injected.worst === 'high' && /automatically/.test(named(injected, 'content script').says));

// The entry points a hostile page could use.
const listener = code => perms.analyse(extensionWith({ permissions: [] }, { 'x.js': code }));

ok('an unchecked postMessage listener is flagged',
  flagged(listener('window.addEventListener("message", e => browser.runtime.sendMessage(e.data));'),
    'postMessage-listener')?.risk === 'high');
ok('a listener that checks the origin is not flagged',
  !flagged(listener('window.addEventListener("message", e => { if (e.origin !== location.origin) return; go(e.data); });'),
    'postMessage-listener'));
ok('a background fetch proxy is flagged',
  flagged(listener('browser.runtime.onMessage.addListener(request => fetch(request.url).then(r => r.text()));'),
    'background-fetch-proxy')?.risk === 'high');
ok('eval is flagged', flagged(listener('const f = eval(payload);'), 'eval')?.risk === 'high');
ok('new Function is flagged', flagged(listener('const f = new Function(payload);'), 'eval'));
ok('innerHTML assignment is flagged', flagged(listener('box.innerHTML = data;'), 'innerHTML'));
ok('clearing innerHTML with an empty string is not flagged',
  !flagged(listener('box.innerHTML = "";'), 'innerHTML'));
ok('onMessageExternal is flagged',
  flagged(listener('browser.runtime.onMessageExternal.addListener(go);'), 'onMessageExternal')?.risk === 'high');

const exposed = perms.analyse(extensionWith({
  permissions: [],
  externally_connectable: { matches: ['*://*/*'] },
  web_accessible_resources: ['viewer.html'],
}));
ok('externally_connectable is flagged high', flagged(exposed, 'externally-connectable')?.risk === 'high');
ok('web_accessible_resources is flagged', flagged(exposed, 'web-accessible')?.risk === 'medium');
ok('every exposure explains what a page gains and how to fix it',
  exposed.exposures.every(e => e.means && e.fix));

const clean = perms.analyse(extensionWith(
  { permissions: ['activeTab', 'storage'] },
  { 'x.js': 'document.title = "hi";' }));
ok('a minimal extension is clean', clean.worst === 'low' && clean.exposures.length === 0);

ok('a missing manifest degrades quietly',
  perms.analyse(path.join(process.env.MAKE_DATA, 'nope')).worst === 'low');
ok('an unparseable manifest degrades quietly',
  perms.analyse(extensionWith('not json')).permissions.length === 0);

const briefing = perms.asBriefing(broad);
ok('the briefing names the broad permissions for the model', /<all_urls>/.test(briefing));
ok('the briefing is empty when there is nothing to say', perms.asBriefing(clean) === '');

// ---- tool sandbox ----
console.log('\ntool sandbox');

const { makeTools } = require('../server/tools');

const sandbox = path.join(process.env.MAKE_DATA, 'sandbox');
fs.mkdirSync(sandbox, { recursive: true });
fs.writeFileSync(path.join(process.env.MAKE_DATA, 'secret.txt'), 'the api key');

const calls = [];
const tools = makeTools(sandbox, { validate: () => [], onCall: (n, d) => calls.push(`${n}:${d}`) });

ok('write_file creates a file',
  tools.run('write_file', { path: 'a.js', content: 'var a = 1;' }).ok === true);
ok('read_file reads it back',
  tools.run('read_file', { path: 'a.js' }).content === 'var a = 1;');
ok('list_files sees it',
  tools.run('list_files', {}).files.some(f => f.path === 'a.js'));

// Containment — the whole point of not shipping a shell tool.
for (const escape of ['../secret.txt', '../../secret.txt', '/etc/passwd', 'sub/../../secret.txt']) {
  const read = tools.run('read_file', { path: escape });
  const wrote = tools.run('write_file', { path: escape, content: 'pwned' });
  ok(`"${escape}" cannot be read or written`,
    Boolean(read.error) && Boolean(wrote.error),
    JSON.stringify({ read, wrote }));
}
ok('the file outside the sandbox is untouched',
  fs.readFileSync(path.join(process.env.MAKE_DATA, 'secret.txt'), 'utf8') === 'the api key');

ok('edit_file replaces an exact snippet',
  tools.run('edit_file', { path: 'a.js', find: 'var a = 1;', replace: 'var a = 2;' }).ok === true
  && fs.readFileSync(path.join(sandbox, 'a.js'), 'utf8') === 'var a = 2;');
ok('a snippet that is not there is reported, not guessed at',
  /not in the file/.test(tools.run('edit_file', { path: 'a.js', find: 'nope', replace: 'x' }).error || ''));

tools.run('write_file', { path: 'dup.js', content: 'x();\nx();' });
ok('an ambiguous snippet is refused rather than half-applied',
  /more than once/.test(tools.run('edit_file', { path: 'dup.js', find: 'x();', replace: 'y();' }).error || ''));
ok('the ambiguous file was left alone',
  fs.readFileSync(path.join(sandbox, 'dup.js'), 'utf8') === 'x();\nx();');

ok('an unknown tool is reported, not thrown',
  /no tool called/.test(tools.run('exec', { cmd: 'rm -rf /' }).error || ''));
ok('there is no shell tool at all',
  !tools.names.some(n => /exec|shell|bash|run|command/.test(n)), tools.names.join(', '));
ok('malformed arguments are reported, not thrown',
  /not valid JSON/.test(tools.run('write_file', '{oops').error || ''));
ok('missing files are reported, not thrown',
  Boolean(tools.run('read_file', { path: 'ghost.js' }).error));
ok('every call is announced for the activity log', calls.some(c => c.startsWith('write_file:a.js')));

ok('check reports clean when the validator finds nothing', tools.run('check', {}).ok === true);
const failing = makeTools(sandbox, { validate: () => ['manifest.json is missing "name".'] });
const checked = failing.run('check', {});
ok('check surfaces problems verbatim',
  checked.ok === false && checked.problems[0].includes('missing "name"'));

// ---- zip writer ----
console.log('\nzip writer');

ok('crc32 matches the known check value', crc32(Buffer.from('123456789')) === 0xcbf43926);

const source = path.join(process.env.MAKE_DATA, 'src');
fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ name: 'x' }));
fs.writeFileSync(path.join(source, 'big.js'), 'console.log(1);\n'.repeat(500));  // compressible
fs.writeFileSync(path.join(source, 'tiny.txt'), 'q');                            // stored
fs.writeFileSync(path.join(source, 'nested', 'deep.js'), 'const a = 1;');

const archive = path.join(process.env.MAKE_DATA, 'out.zip');
const count = zipDir(source, archive);
ok('every file is archived', count === 4);

let listing = '';
let valid = false;
try {
  execFileSync('unzip', ['-t', archive], { stdio: 'pipe' });
  listing = execFileSync('unzip', ['-l', archive], { encoding: 'utf8' });
  valid = true;
} catch (err) {
  listing = String(err.stderr || err.message);
}
ok('the archive passes unzip -t', valid, listing.slice(0, 200));
ok('nested paths use forward slashes', /nested\/deep\.js/.test(listing));
ok('deflate actually shrank the compressible file',
  fs.statSync(archive).size < fs.statSync(path.join(source, 'big.js')).size);

if (valid) {
  const back = execFileSync('unzip', ['-p', archive, 'nested/deep.js'], { encoding: 'utf8' });
  ok('contents round-trip byte for byte', back === 'const a = 1;');
} else {
  ok('contents round-trip byte for byte', false, 'unzip unavailable');
}

// ---- web-ext lint (optional integration) ----
// Async, so everything below runs in a promise chain and the summary moves
// into finish().

function finish() {
  fs.rmSync(process.env.MAKE_DATA, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

const lintModule = require('../server/lint');

// A stand-in for web-ext: answers --version, and prints a canned addons-linter
// report for anything else. Lets the whole path be exercised on a machine that
// has never installed the real thing.
const fakeToolPath = path.join(process.env.MAKE_DATA, 'fake-web-ext.js');
fs.writeFileSync(fakeToolPath, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('9.9.9'); process.exit(0); }
console.log(JSON.stringify(${JSON.stringify({
  count: 3,
  summary: { errors: 1, notices: 1, warnings: 1 },
  errors: [{ code: 'MANIFEST_FIELD_REQUIRED', message: 'name is required', description: 'Add a name.', file: 'manifest.json', line: 2 }],
  warnings: [{ code: 'UNSAFE_VAR_ASSIGNMENT', message: 'Unsafe assignment to innerHTML', description: 'Use textContent.', file: 'popup.js', line: 14 }],
  notices: [{ code: 'X', message: 'y' }],
})}));
process.exit(1);
`);
fs.chmodSync(fakeToolPath, 0o755);

(async () => {
  console.log('\nweb-ext lint');

  // Shaping, with no subprocess involved at all.
  const shaped = lintModule.summarise({
    summary: { errors: 1, notices: 0, warnings: 1 },
    errors: [{ code: 'E1', message: 'broken', description: 'fix it', file: 'manifest.json', line: 3 }],
    warnings: [{ code: 'W1', message: 'iffy', file: 'a.js' }],
    notices: [],
  });
  ok('errors and warnings are both surfaced', shaped.counts.errors === 1 && shaped.counts.warnings === 1);
  ok('a report with errors is not ok', shaped.ok === false);
  ok('findings carry file and line', shaped.findings[0].where === 'manifest.json:3');
  ok('errors are listed before warnings', shaped.findings[0].code === 'E1' && shaped.findings[1].code === 'W1');

  const many = lintModule.summarise({
    summary: {},
    errors: Array.from({ length: 40 }, (_, i) => ({ code: `E${i}`, message: 'x', file: 'a.js' })),
  });
  ok('a wall of findings is capped', many.findings.length === 20 && many.truncated === true);

  const warnOnly = lintModule.summarise({ summary: {}, errors: [], warnings: [{ code: 'W', message: 'm', file: 'a.js' }] });
  ok('warnings alone still pass', warnOnly.ok === true);
  ok('the briefing distinguishes rejection from warnings',
    /rejected/.test(lintModule.asBriefing(shaped)) && /warnings worth fixing/.test(lintModule.asBriefing(warnOnly)));
  ok('an unavailable linter briefs as nothing', lintModule.asBriefing({ available: false }) === '');

  // Missing linter: reported, never thrown, never fatal.
  lintModule.setLocated(null);
  const absent = await lintModule.lint(sandbox);
  ok('a missing linter reports unavailable rather than failing',
    absent.available === false && typeof absent.reason === 'string');

  // End to end against the stand-in, including a non-zero exit — which is what
  // a real lint run with findings does, and must not be read as a crash.
  lintModule.setLocated(undefined);
  process.env.MAKE_WEB_EXT = fakeToolPath;
  const real = await lintModule.lint(sandbox);
  delete process.env.MAKE_WEB_EXT;
  ok('a real run parses the report despite a non-zero exit',
    real.available === true && real.ok === false && real.counts.errors === 1,
    JSON.stringify(real).slice(0, 200));
  ok('the run picked up both findings',
    real.findings.length === 2 && real.findings[0].where === 'manifest.json:2');

  finish();
})().catch(err => {
  console.error(err);
  process.exit(1);
});
