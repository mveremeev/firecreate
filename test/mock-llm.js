'use strict';

// A tiny OpenAI-compatible mock for end-to-end testing without a real API key.
// Speaks both unary and SSE, and covers the clarify / build / revise stages.
//
//   node test/mock-llm.js            → listens on :4114
//   BROKEN=1 node test/mock-llm.js   → first build attempt fails validation,
//                                      so the self-check + retry path runs

const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 4114);
const BROKEN = process.env.BROKEN === '1';
// Milliseconds between streamed chunks — raise it to keep a build in flight
// long enough to exercise cancellation.
const CHUNK_MS = Number(process.env.MOCK_CHUNK_MS || 6);

const MODELS = ['mock-small', 'mock-large'];

const CLARIFY = {
  reply: 'Happy to build that. Should it run on every site, or just YouTube?',
  title: 'Shorts Hider',
  spec: ['Hides YouTube Shorts shelves', 'Runs only on youtube.com', 'No settings — always on'],
};

const CONTENT_JS = [
  'if (!window.__shortsHider) {',
  '  window.__shortsHider = true;',
  '  const style = document.createElement("style");',
  '  style.textContent = "ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer { display: none !important; }";',
  '  document.documentElement.appendChild(style);',
  '}',
].join('\n');

function manifest(version, scripts = ['content.js']) {
  return JSON.stringify({
    manifest_version: 2,
    name: 'Shorts Hider',
    version,
    description: 'Hides YouTube Shorts.',
    permissions: ['*://*.youtube.com/*'],
    content_scripts: [{ matches: ['*://*.youtube.com/*'], js: scripts }],
    browser_specific_settings: { gecko: { id: 'shorts-hider@make.local' } },
  }, null, 2);
}

let buildCalls = 0;
let lastRequest = null;

// Scripted tool-calling build, so the agent loop can be exercised end to end.
// NO_TOOLS=1 makes the endpoint reject `tools`, exercising the fallback.
const NO_TOOLS = process.env.NO_TOOLS === '1';

// A fixed sequence, so a run exercises every tool and the check → fix → check
// recovery path deterministically:
//   write manifest → write content → check (fails in BROKEN) → repair
//   → edit_file → check (clean) → finish
function toolScript(messages) {
  const done = [];
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.tool_calls || []) done.push(c.function?.name);
  }
  const has = name => done.includes(name);
  const count = name => done.filter(n => n === name).length;

  const call = (name, args) => ([{
    id: `call_${name}_${done.length}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }]);

  if (!has('list_files')) return call('list_files', {});
  if (!has('write_file')) {
    return call('write_file', {
      path: 'manifest.json',
      content: BROKEN ? manifest('1.0', ['content.js', 'missing.js']) : manifest('1.0'),
    });
  }
  if (count('write_file') === 1) return call('write_file', { path: 'content.js', content: CONTENT_JS });
  if (!has('check')) return call('check', {});

  // BROKEN mode: the first check fails on the missing file — repair it.
  if (BROKEN && count('write_file') === 2) {
    return call('write_file', { path: 'manifest.json', content: manifest('1.0') });
  }
  if (!has('edit_file')) {
    return call('edit_file', {
      path: 'content.js',
      find: 'window.__shortsHider = true;',
      replace: 'window.__shortsHider = true; // checked',
    });
  }
  if (count('check') < 2) return call('check', {});
  return call('finish', { summary: 'Built a Shorts hider.' });
}

function answerFor(messages) {
  const system = messages[0]?.content || '';
  const last = messages[messages.length - 1]?.content || '';

  if (system.includes('clarification stage')) {
    // A follow-up turn grows the spec, so callers can exercise the
    // "the plan moved past what was built" path.
    const turns = messages.filter(m => m.role === 'user').length;
    if (turns > 1) {
      return JSON.stringify({
        ...CLARIFY,
        reply: 'Got it — I added that to the plan.',
        spec: [...CLARIFY.spec, 'Also hides the Shorts tab in the sidebar'],
      });
    }
    return JSON.stringify(CLARIFY);
  }

  if (system.includes('reviewing a generated Firefox extension')) {
    return JSON.stringify({ verdict: 'ok', problems: [] });
  }

  if (system.includes('build stage') || system.includes('revision stage')) {
    buildCalls++;
    const fixing = /problems|not valid JSON/i.test(last);
    // On the first call in BROKEN mode, reference a file we never emit so the
    // server's self-check has something real to catch and repair.
    if (BROKEN && !fixing) {
      return JSON.stringify({
        files: {
          'manifest.json': JSON.stringify({
            manifest_version: 2,
            name: 'Shorts Hider',
            version: '1.0',
            description: 'Hides YouTube Shorts.',
            permissions: ['*://*.youtube.com/*'],
            content_scripts: [{ matches: ['*://*.youtube.com/*'], js: ['content.js', 'missing.js'] }],
          }, null, 2),
          'content.js': CONTENT_JS,
        },
      });
    }
    return JSON.stringify({
      files: {
        'manifest.json': manifest(system.includes('revision stage') ? '1.1' : '1.0'),
        'content.js': CONTENT_JS,
      },
    });
  }

  return '{}';
}

function sendStream(res, content) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const frame = delta => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);

  frame({ reasoning_content: 'Weighing the options… ' });
  let index = 0;
  const timer = setInterval(() => {
    if (index >= content.length) {
      clearInterval(timer);
      res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    frame({ content: content.slice(index, index + 24) });
    index += 24;
  }, CHUNK_MS);

  // Stop pumping if the caller hangs up (that is what a cancelled build does).
  res.on('close', () => clearInterval(timer));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/last-request')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(lastRequest || {}));
  }

  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: MODELS.map(id => ({ id })) }));
  }

  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    return res.end('nope');
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); }
    catch { res.writeHead(400); return res.end('bad json'); }

    // Echo back what routing we were asked for, so tests can assert on it.
    lastRequest = payload;

    if (payload.tools) {
      if (NO_TOOLS) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'This model does not support tool use.' } }));
      }
      const toolCalls = toolScript(payload.messages || []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '', tool_calls: toolCalls }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
      }));
    }

    const content = answerFor(payload.messages || []);
    if (payload.stream) return sendStream(res, content);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock llm on :${PORT}${BROKEN ? ' (BROKEN mode — first build fails self-check)' : ''}`);
});
