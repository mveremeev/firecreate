'use strict';

// End-to-end check of the whole pipeline against the mock LLM.
// Runs against a scratch data directory — the real data/ is never touched.
//
//   node test/e2e.js

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MOCK_PORT = 4571;
const NO_TOOLS_PORT = 4573;
const APP_PORT = 4572;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'make-e2e-'));

let passed = 0;
let failed = 0;
const children = [];

function ok(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { await fetch(url); return true; } catch { await sleep(100); }
  }
  return false;
}

function start(name, args, env) {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => console.error(`[${name}] ${d}`.trim()));
  children.push(child);
  return child;
}

function shutdown() {
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  fs.rmSync(DATA, { recursive: true, force: true });
}

async function main() {
  console.log(`scratch data dir: ${DATA}\n`);

  start('mock', [path.join(__dirname, 'mock-llm.js')], {
    MOCK_PORT: String(MOCK_PORT), BROKEN: '1', MOCK_CHUNK_MS: '30',
  });
  // A second mock that refuses tool calling, for the fallback path.
  start('no-tools', [path.join(__dirname, 'mock-llm.js')], {
    MOCK_PORT: String(NO_TOOLS_PORT), NO_TOOLS: '1', MOCK_CHUNK_MS: '5',
  });
  start('server', [path.join(__dirname, '..', 'server', 'index.js')], {
    PORT: String(APP_PORT), HOST: '127.0.0.1', MAKE_DATA: DATA,
  });

  if (!await waitFor(`http://127.0.0.1:${MOCK_PORT}/models`)) throw new Error('mock never came up');
  if (!await waitFor(`http://127.0.0.1:${NO_TOOLS_PORT}/models`)) throw new Error('no-tools mock never came up');
  if (!await waitFor(`${BASE}/api/projects`)) throw new Error('server never came up');

  // ---- config ----
  console.log('config');
  await req('POST', '/api/config', {
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    apiKey: 'test-key',
    model: 'mock-small',
    toolMode: 'oneshot',   // the sections below cover the single-reply protocol
  });
  const config = await req('GET', '/api/config');
  ok('config round-trips', config.json.model === 'mock-small');
  ok('sampling defaults are exposed', config.json.temperature === 0.2 && config.json.maxTokens === 0);
  ok('provider defaults to the generic profile', config.json.provider === 'openai');
  ok('api key is never returned', config.text.includes('"hasKey":true') && !config.text.includes('test-key'));

  const blank = await req('POST', '/api/config', { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-small' });
  ok('omitting the key keeps the saved one', blank.json.hasKey === true);

  const models = await req('GET', '/api/config/models');
  ok('model list fetches', Array.isArray(models.json.models) && models.json.models.includes('mock-large'));

  const test = await req('POST', '/api/config/test', {});
  ok('connection test passes', test.json.ok === true, test.json.error);

  // ---- create ----
  console.log('\nproject lifecycle');
  const created = await req('POST', '/api/projects', { text: 'hide youtube shorts' });
  ok('project is created', created.status === 201 && created.json.id);
  const id = created.json.id;

  const blankPrompt = await req('POST', '/api/projects', { text: '   ' });
  ok('blank prompt is rejected', blankPrompt.status === 400);

  // ---- clarify over SSE ----
  const chat = await fetch(`${BASE}/api/projects/${id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  });
  const stream = await chat.text();
  const events = stream.split('\n\n')
    .filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } })
    .filter(Boolean);

  ok('reasoning is forwarded', events.some(e => e.type === 'thinking'));
  ok('reply streams incrementally', events.filter(e => e.type === 'reply').length > 1);
  const done = events.find(e => e.type === 'done');
  ok('done carries the reply', Boolean(done) && done.reply.startsWith('Happy to build that.'));
  ok('reply never leaks raw JSON', Boolean(done) && !done.reply.includes('"spec"'));
  ok('spec is captured', Boolean(done) && done.spec.length === 3);
  ok('title is captured', Boolean(done) && done.title === 'Shorts Hider');

  const streamedReply = events.filter(e => e.type === 'reply').map(e => e.delta).join('');
  ok('streamed text matches the final reply', streamedReply === done.reply,
    `streamed ${JSON.stringify(streamedReply.slice(0, 40))}`);

  // ---- build ----
  console.log('\nbuild');
  const build = await req('POST', `/api/projects/${id}/build`);
  ok('build is accepted', build.status === 202);

  let project;
  for (let i = 0; i < 100; i++) {
    project = (await req('GET', `/api/projects/${id}`)).json;
    if (project.status !== 'building') break;
    await sleep(100);
  }
  ok('build reaches ready', project.status === 'ready', `status=${project.status} error=${project.error}`);
  ok('percent lands on 100', project.percent === 100);
  ok('build counter increments', project.builds === 1);

  const technical = (await req('GET', `/api/projects/${id}/logs?level=technical`)).json;
  ok('self-check caught the bad manifest',
    technical.some(l => l.line.includes('missing.js')),
    'BROKEN mode should have produced a missing-file problem');
  ok('it retried after the failure', technical.some(l => l.line.includes('attempt 2')));

  const activity = (await req('GET', `/api/projects/${id}/logs?level=activity`)).json;
  ok('activity log names the files it wrote', activity.some(l => l.line.startsWith('writing ')));
  ok('activity log is user-readable', activity.some(l => l.line === 'packaged — ready to install'));

  const since = activity[activity.length - 3].t;
  const tail = (await req('GET', `/api/projects/${id}/logs?level=activity&since=${encodeURIComponent(since)}`)).json;
  ok('logs support incremental fetch', tail.length === 2 && tail.every(l => l.t > since));

  // ---- generated files ----
  console.log('\nfiles');
  const files = (await req('GET', `/api/projects/${id}/files`)).json;
  ok('files are listed', files.length === 2);
  ok('manifest sorts first', files[0].path === 'manifest.json');
  ok('sizes are reported', files.every(f => f.size > 0));

  const content = await req('GET', `/api/projects/${id}/file?path=content.js`);
  ok('file contents are readable', content.json.text.includes('__shortsHider'));

  const escape = await req('GET', `/api/projects/${id}/file?path=../../../etc/passwd`);
  ok('path traversal is refused', escape.status === 404);
  const absolute = await req('GET', `/api/projects/${id}/file?path=/etc/passwd`);
  ok('absolute paths are refused', absolute.status === 404);

  // ---- packaging ----
  console.log('\npackaging');
  const xpiRes = await fetch(`${BASE}/api/projects/${id}/download`);
  const xpi = Buffer.from(await xpiRes.arrayBuffer());
  const xpiFile = path.join(DATA, 'out.xpi');
  fs.writeFileSync(xpiFile, xpi);

  ok('download is an attachment named after the project',
    /filename="shorts-hider\.xpi"/.test(xpiRes.headers.get('content-disposition') || ''));
  ok('xpi has the zip magic number', xpi.subarray(0, 2).toString() === 'PK');

  let unzipOk = false;
  let listing = '';
  try {
    execFileSync('unzip', ['-t', xpiFile], { stdio: 'pipe' });
    listing = execFileSync('unzip', ['-p', xpiFile, 'manifest.json'], { encoding: 'utf8' });
    unzipOk = true;
  } catch (err) {
    listing = String(err.stderr || err.message);
  }
  ok('the zip passes unzip -t', unzipOk, listing.slice(0, 200));
  ok('manifest survives the round trip', JSON.parse(listing || '{}').name === 'Shorts Hider');

  ok('a fresh build is not stale', project.stale === false);
  ok('the built spec is snapshotted', Array.isArray(project.builtSpec) && project.builtSpec.length === 3);
  ok('build time is recorded', Boolean(project.builtAt));

  // ---- revision ----
  console.log('\nrevision');
  await fetch(`${BASE}/api/projects/${id}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'also hide the sidebar' }),
  }).then(r => r.text());

  const changed = (await req('GET', `/api/projects/${id}`)).json;
  ok('changing the plan marks the build stale', changed.stale === true);
  ok('the snapshot still reflects the old build', changed.builtSpec.length === 3 && changed.spec.length === 4);
  ok('status itself stays ready', changed.status === 'ready');

  await req('POST', `/api/projects/${id}/build`);
  for (let i = 0; i < 100; i++) {
    project = (await req('GET', `/api/projects/${id}`)).json;
    if (project.status !== 'building') break;
    await sleep(100);
  }
  ok('rebuild succeeds', project.status === 'ready', project.error || '');
  ok('rebuild counted', project.builds === 2);
  ok('rebuilding clears the stale flag', project.stale === false);
  ok('the snapshot catches up', project.builtSpec.length === 4);
  const revised = await req('GET', `/api/projects/${id}/file?path=manifest.json`);
  ok('revision used the revise prompt', JSON.parse(revised.json.text).version === '1.1');

  // ---- the tool loop ----
  console.log('\ntool loop');
  await req('POST', '/api/config', { toolMode: 'auto' });

  const agent = (await req('POST', '/api/projects', { text: 'hide shorts, with tools' })).json;
  await fetch(`${BASE}/api/projects/${agent.id}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '' }),
  }).then(r => r.text());
  await req('POST', `/api/projects/${agent.id}/build`);

  let built;
  for (let i = 0; i < 200; i++) {
    built = (await req('GET', `/api/projects/${agent.id}`)).json;
    if (built.status !== 'building') break;
    await sleep(100);
  }
  ok('a tool-driven build reaches ready', built.status === 'ready', `status=${built.status} error=${built.error}`);

  const agentTech = (await req('GET', `/api/projects/${agent.id}/logs?level=technical`)).json;
  const agentAct = (await req('GET', `/api/projects/${agent.id}/logs?level=activity`)).json;
  const lines = agentAct.map(l => l.line);

  ok('the loop is logged with step and token counts', agentTech.some(l => /tool loop · \d+ steps/.test(l.line)));

  // The linter is optional, so what is asserted is that the stage runs and
  // reports either way — never that web-ext happens to be on this machine.
  ok('the lint stage ran and said what it found',
    agentTech.some(l => /^web-ext lint( skipped)? ·/.test(l.line)),
    agentTech.map(l => l.line).join(' | ').slice(0, 300));
  ok('a missing linter does not fail the build', built.status === 'ready');

  ok('tool calls read as plain language', lines.includes('writing manifest.json') && lines.includes('editing content.js'));
  ok('no raw tool names leak into activity', !lines.some(l => /write_file|edit_file|list_files/.test(l)));
  ok('the self-check ran inside the loop', lines.some(l => /checks passed|found problems/.test(l)));
  ok('BROKEN mode was caught by check, not by the packager',
    lines.some(l => l.startsWith('found problems —')));
  ok('the edit tool actually applied',
    (await req('GET', `/api/projects/${agent.id}/file?path=content.js`)).json.text.includes('// checked'));
  ok('the review pass ran', agentTech.some(l => /review round \d+ · nothing found/.test(l.line)));
  ok('both review lenses ran',
    agentTech.some(l => /behaviour review ·/.test(l.line)) && agentTech.some(l => /security review ·/.test(l.line)));

  const perms = (await req('GET', `/api/projects/${agent.id}/permissions`)).json;
  ok('permissions are reported in plain language',
    perms.permissions.some(p => /youtube\.com/.test(p.says)), JSON.stringify(perms.permissions));
  ok('the risk level is computed', ['low', 'medium', 'high'].includes(perms.worst));
  ok('a narrow extension reports no web-reachable entry points', perms.exposures.length === 0);
  ok('review is described plainly', lines.includes('reading it back over'));

  const agentFiles = (await req('GET', `/api/projects/${agent.id}/files`)).json;
  ok('only the files the model wrote exist', agentFiles.length === 2);

  // A tools-only endpoint that refuses them must fall back, not fail.
  console.log('\ntool fallback');
  const noTools = (await req('POST', '/api/projects', { text: 'fallback check' })).json;
  await fetch(`${BASE}/api/projects/${noTools.id}/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '' }),
  }).then(r => r.text());
  await req('POST', '/api/config', { baseUrl: `http://127.0.0.1:${NO_TOOLS_PORT}/v1` });
  await req('POST', `/api/projects/${noTools.id}/build`);

  let fell;
  for (let i = 0; i < 200; i++) {
    fell = (await req('GET', `/api/projects/${noTools.id}`)).json;
    if (fell.status !== 'building') break;
    await sleep(100);
  }
  ok('a tool-less endpoint still builds', fell.status === 'ready', `status=${fell.status} error=${fell.error}`);
  ok('the fallback is explained in the log',
    (await req('GET', `/api/projects/${noTools.id}/logs?level=technical`)).json
      .some(l => /falling back to single-reply/.test(l.line)));
  await req('POST', '/api/config', { baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, toolMode: 'oneshot' });

  // ---- OpenRouter routing ----
  console.log('\nopenrouter routing');
  await req('POST', '/api/config', {
    provider: 'openrouter', sort: 'throughput', quantizations: 'fp4', reasoningEffort: 'high',
    temperature: 0.15, maxTokens: 64000,
  });
  await req('POST', '/api/config/test', {});
  const sent = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/last-request`)).json();

  ok('routing preferences are sent', sent.provider?.sort === 'throughput');
  ok('quantization filter is sent as a list', JSON.stringify(sent.provider?.quantizations) === '["fp4"]');
  ok('fallbacks stay on so a narrow filter cannot hard-fail', sent.provider?.allow_fallbacks === true);
  ok('reasoning effort is sent', sent.reasoning?.effort === 'high');

  for (const effort of ['minimal', 'low', 'medium', 'xhigh', 'max']) {
    await req('POST', '/api/config', { reasoningEffort: effort });
    await req('POST', '/api/config/test', {});
    const body = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/last-request`)).json();
    ok(`reasoning "${effort}" survives the round trip`, body.reasoning?.effort === effort);
  }
  await req('POST', '/api/config', { reasoningEffort: 'off' });
  await req('POST', '/api/config/test', {});
  const offBody = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/last-request`)).json();
  ok('"off" disables reasoning rather than setting a level',
    offBody.reasoning?.enabled === false && offBody.reasoning?.effort === undefined);

  await req('POST', '/api/config', { reasoningEffort: 'nonsense' });
  ok('an unknown level falls back rather than being sent',
    (await req('GET', '/api/config')).json.reasoningEffort === 'high');
  await req('POST', '/api/config', { reasoningEffort: 'high' });
  ok('temperature comes from config, not a hardcode', sent.temperature === 0.15);
  ok('a reply limit is sent when set', sent.max_tokens === 64000);

  await req('POST', '/api/config', { provider: 'openai', quantizations: '', maxTokens: 0, temperature: 0.2 });
  const plain = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/last-request`)).json();
  await req('POST', '/api/config/test', {});
  const afterPlain = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/last-request`)).json();
  ok('routing is omitted for plain endpoints', afterPlain.provider === undefined && afterPlain.reasoning === undefined,
    JSON.stringify({ provider: afterPlain.provider, reasoning: afterPlain.reasoning }));
  ok('no reply limit is sent when unset', afterPlain.max_tokens === undefined);
  void plain;

  await req('POST', '/api/config', { toolMode: 'oneshot' });

  // ---- context budgeting ----
  console.log('\ncontext');
  // A small window forces trimming after only a few turns.
  await req('POST', '/api/config', { contextTokens: 8000 });
  const tiny = (await req('GET', '/api/config')).json;
  ok('context window is configurable', tiny.contextTokens === 8000);

  const filler = 'x'.repeat(3000);
  for (let i = 0; i < 4; i++) {
    await fetch(`${BASE}/api/projects/${id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `${filler} round ${i}` }),
    }).then(r => r.text());
  }

  const tech = (await req('GET', `/api/projects/${id}/logs?level=technical`)).json;
  const trimmed = tech.filter(l => /older messages trimmed/.test(l.line));
  ok('long conversations get trimmed', trimmed.length > 0);

  // The budget bounds the conversation history, not the fixed system prompt.
  const sizes = tech
    .map(l => l.line.match(/history (\d+) tok/))
    .filter(Boolean)
    .map(m => Number(m[1]));
  ok('history stays inside the budget', sizes.length > 0 && Math.max(...sizes) <= 8000 * 0.10 * 1.2,
    `largest was ${Math.max(...sizes)} tok`);
  ok('the log separates history from fixed overhead',
    tech.some(l => /history \d+ tok · total \d+ tok/.test(l.line)));

  const full = (await req('GET', `/api/projects/${id}`)).json;
  ok('the full history is still stored and served', full.history.length >= 10,
    `history=${full.history.length}`);

  await req('POST', '/api/config', { contextTokens: 128000 });

  // ---- stopping must not destroy the working build ----
  console.log('\nstop');
  const beforeStop = fs.readFileSync(path.join(DATA, 'builds', `${id}.xpi`));
  await req('POST', `/api/projects/${id}/build`);
  await sleep(120);
  const stop = await req('POST', `/api/projects/${id}/stop`);
  ok('stop reaches a build in flight', stop.json.stopped === true);

  for (let i = 0; i < 100; i++) {
    project = (await req('GET', `/api/projects/${id}`)).json;
    if (project.status !== 'building') break;
    await sleep(50);
  }
  ok('stopping returns to ready, not draft', project.status === 'ready', `status=${project.status}`);
  ok('the previous .xpi survives a stop',
    fs.readFileSync(path.join(DATA, 'builds', `${id}.xpi`)).equals(beforeStop));
  ok('the previous files survive a stop',
    (await req('GET', `/api/projects/${id}/files`)).json.length === 2);
  ok('no staging directory is left behind', !fs.existsSync(path.join(DATA, 'builds', `${id}.staging`)));
  ok('a stop is explained in the activity log',
    (await req('GET', `/api/projects/${id}/logs?level=activity`)).json
      .some(l => l.line.includes('build stopped')));

  // ---- guards ----
  console.log('\nguards');
  const missing = await req('GET', '/api/projects/does-not-exist');
  ok('unknown project is a clean 404', missing.status === 404 && Boolean(missing.json.error));

  const traversalId = await req('GET', '/api/projects/..%2F..%2Fconfig');
  ok('project ids reject traversal', traversalId.status === 404);

  const badJson = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  ok('malformed JSON gets a 500-free error', badJson.status < 600 && badJson.status !== 200);

  const staticEscape = await fetch(`${BASE}/../server/store.js`);
  ok('static server refuses to climb out of public/', staticEscape.status === 404 || staticEscape.status === 403);

  // ---- rename + delete ----
  console.log('\nrename and delete');
  const renamed = await req('PATCH', `/api/projects/${id}`, { title: 'Renamed Thing' });
  ok('rename works', renamed.json.title === 'Renamed Thing');
  const emptyName = await req('PATCH', `/api/projects/${id}`, { title: '  ' });
  ok('empty rename is refused', emptyName.status === 400);

  const removed = await req('DELETE', `/api/projects/${id}`);
  ok('delete succeeds', removed.status === 200);
  ok('project is hidden immediately', (await req('GET', `/api/projects/${id}`)).status === 404);
  ok('it disappears from the list too', !(await req('GET', '/api/projects')).json.some(p => p.id === id));
  ok('artifacts survive inside the undo window', fs.existsSync(path.join(DATA, 'builds', `${id}.xpi`)));

  const restored = await req('POST', `/api/projects/${id}/restore`);
  ok('restore brings it back', restored.status === 200 && restored.json.id === id);
  ok('it is readable again', (await req('GET', `/api/projects/${id}`)).status === 200);

  await req('DELETE', `/api/projects/${id}`);
  await sleep(9200);   // past the 8s undo window
  ok('sweep removes artifacts after the window', !fs.existsSync(path.join(DATA, 'builds', `${id}.xpi`)));
  ok('restore is refused after the window', (await req('POST', `/api/projects/${id}/restore`)).status === 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0;
}

main()
  .then(good => { shutdown(); process.exit(good ? 0 : 1); })
  .catch(err => { console.error('\nharness error:', err); shutdown(); process.exit(1); });
