'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const builder = require('./builder');
const llm = require('./llm');
const permissions = require('./permissions');

const PORT = Number(process.env.PORT || 4321);
// Loopback by default: the config file holds an API key, and the server has no
// auth of its own. Set HOST=0.0.0.0 to expose it deliberately.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_BODY = 1e6;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && body !== null && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const fail = err => { if (!settled) { settled = true; reject(err); } };

    req.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_BODY) {
        // Previously this destroyed the socket without settling, so the
        // request handler hung forever.
        fail(new Error('Request body is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('The request body was not valid JSON.')); }
    });
    req.on('aborted', () => fail(new Error('The request was aborted.')));
    req.on('error', fail);
  });
}

// The shape the client sees. Never includes the API key or raw log history.
function publicProject(p) {
  const hasBuild = fs.existsSync(store.xpiPath(p.id));
  return {
    id: p.id,
    title: p.title || null,
    kind: p.kind,
    status: p.status,
    spec: p.spec,
    percent: p.percent,
    prompt: p.prompt,
    builds: p.builds,
    error: p.error,
    hasBuild,
    builtSpec: p.builtSpec,
    builtAt: p.builtAt,
    // True when the plan has moved on since the download was produced.
    stale: hasBuild && Array.isArray(p.builtSpec)
      && JSON.stringify(p.spec) !== JSON.stringify(p.builtSpec),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function fileName(project) {
  const slug = String(project.title || 'extension')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'extension'}.xpi`;
}

// ---- routes ----

// Returns true when it handled the request.
async function handleConfig(req, res, url) {
  // Everything except the key itself.
  const visibleConfig = c => ({
    provider: c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    contextTokens: c.contextTokens,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    reasoningEffort: c.reasoningEffort,
    sort: c.sort,
    quantizations: c.quantizations,
    toolMode: c.toolMode,
    hasKey: Boolean(c.apiKey),
  });

  if (url.pathname === '/api/config' && req.method === 'GET') {
    send(res, 200, visibleConfig(store.getConfig()));
    return true;
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    send(res, 200, visibleConfig(store.saveConfig(await readBody(req))));
    return true;
  }

  // POST /api/config/test — verify credentials without saving them.
  if (url.pathname === '/api/config/test' && req.method === 'POST') {
    const body = await readBody(req);
    const saved = store.getConfig();
    // Test what the form currently shows, including routing — a filter that
    // matches no provider should fail here, not on the first real build.
    const config = {
      ...saved,
      ...body,
      apiKey: body.apiKey === undefined ? saved.apiKey : body.apiKey,
      baseUrl: body.baseUrl || saved.baseUrl,
      model: body.model || saved.model,
    };
    if (!config.model) {
      send(res, 200, { ok: false, error: 'Add a model name first.' });
      return true;
    }

    try {
      const started = Date.now();
      const { usage } = await llm.chat(config, [{ role: 'user', content: 'Reply with the single word: ok' }]);
      send(res, 200, {
        ok: true,
        detail: `${config.model} answered in ${Date.now() - started}ms${usage ? ` · ${usage.total_tokens || '?'} tokens` : ''}.`,
      });
    } catch (err) {
      send(res, 200, { ok: false, error: err.message });
    }
    return true;
  }

  // GET /api/config/models — best effort; many local servers don't implement it.
  if (url.pathname === '/api/config/models' && req.method === 'GET') {
    try {
      send(res, 200, { models: await llm.listModels(store.getConfig()) });
    } catch (err) {
      send(res, 200, { models: [], error: err.message });
    }
    return true;
  }

  return false;
}

async function handleProject(req, res, url, project, action) {
  const id = project.id;

  if (!action && req.method === 'GET') {
    return send(res, 200, { ...publicProject(project), history: project.history });
  }

  // PATCH /api/projects/:id — rename
  if (!action && req.method === 'PATCH') {
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 80);
    if (!title) return send(res, 400, { error: 'A name is required.' });
    const updated = store.mutate(id, p => {
      store.log(p, 'technical', `renamed to "${title}"`);
      p.title = title;
    });
    return send(res, 200, publicProject(updated));
  }

  if (!action && req.method === 'DELETE') {
    builder.stopBuild(id);
    store.deleteProject(id);
    return send(res, 200, { ok: true });
  }

  // POST /api/projects/:id/chat — SSE: thinking | reply | done | error
  if (action === 'chat' && req.method === 'POST') {
    const config = store.getConfig();
    if (!config.model) {
      return send(res, 400, { error: 'No model configured — open Settings and add your API details first.' });
    }
    if (builder.isBuilding(id)) {
      return send(res, 409, { error: 'This project is building right now. Wait for it to finish.' });
    }

    const body = await readBody(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const emit = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    try {
      const result = await builder.clarify(config, id, String(body.message || ''), {
        signal: controller.signal,
        onThinking: delta => emit({ type: 'thinking', delta }),
        onReply: delta => emit({ type: 'reply', delta }),
      });
      emit({ type: 'done', ...result });
    } catch (err) {
      if (err.name !== 'AbortError') emit({ type: 'error', error: err.message });
    } finally {
      clearInterval(heartbeat);
    }
    return res.end();
  }

  if (action === 'build' && req.method === 'POST') {
    if (!store.getConfig().model) {
      return send(res, 400, { error: 'No model configured — open Settings and add your API details first.' });
    }
    if (builder.isBuilding(id)) return send(res, 409, { error: 'This project is already building.' });
    if (!project.spec.length && !project.prompt) return send(res, 400, { error: 'There is nothing to build yet.' });
    builder.startBuild(store.getConfig(), id);
    return send(res, 202, { ok: true });
  }

  if (action === 'stop' && req.method === 'POST') {
    const stopped = builder.stopBuild(id);
    return send(res, 200, { ok: true, stopped });
  }

  // GET /api/projects/:id/logs?level=activity|technical&since=<iso>
  if (action === 'logs' && req.method === 'GET') {
    const level = url.searchParams.get('level') === 'technical' ? 'technical' : 'activity';
    const since = url.searchParams.get('since');
    let lines = project.logs.filter(l => l.level === level);
    if (since) lines = lines.filter(l => l.t > since);
    return send(res, 200, lines);
  }

  // GET /api/projects/:id/files — manifest of generated files
  if (action === 'files' && req.method === 'GET') {
    return send(res, 200, store.listFiles(id));
  }

  // GET /api/projects/:id/permissions — what it can do, and what a page could
  // make it do. Computed from the built files, never from the model.
  if (action === 'permissions' && req.method === 'GET') {
    return send(res, 200, permissions.analyse(store.buildDir(id)));
  }

  // GET /api/projects/:id/file?path=content.js — one file's text
  if (action === 'file' && req.method === 'GET') {
    const rel = url.searchParams.get('path') || '';
    const file = store.readFile(id, rel);
    if (!file) return send(res, 404, { error: 'No such file in this build.' });
    return send(res, 200, { path: rel, ...file });
  }

  if (action === 'download' && req.method === 'GET') {
    const xpi = store.xpiPath(id);
    if (!fs.existsSync(xpi)) return send(res, 404, { error: 'Nothing has been built yet.' });
    return send(res, 200, fs.readFileSync(xpi), {
      'Content-Type': 'application/x-xpinstall',
      'Content-Disposition': `attachment; filename="${fileName(project)}"`,
    });
  }

  return send(res, 405, { error: `Cannot ${req.method} that.` });
}

async function handleApi(req, res, url) {
  if (await handleConfig(req, res, url)) return;

  if (url.pathname === '/api/projects' && req.method === 'GET') {
    return send(res, 200, store.listProjects().map(publicProject));
  }

  if (url.pathname === '/api/projects' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) return send(res, 400, { error: 'Describe what you want to make first.' });
    return send(res, 201, publicProject(store.createProject(text.slice(0, 4000))));
  }

  const parts = url.pathname.split('/').filter(Boolean); // ['api','projects',id,action]
  if (parts[1] === 'projects' && parts[2]) {
    // Restore reaches past the soft-delete filter on purpose — getProject
    // below reports a just-deleted project as gone.
    if (parts[3] === 'restore' && req.method === 'POST') {
      const restored = store.restoreProject(parts[2]);
      if (!restored) return send(res, 404, { error: 'Nothing to restore — the undo window has passed.' });
      return send(res, 200, publicProject(restored));
    }
    const project = store.getProject(parts[2]);
    if (!project) return send(res, 404, { error: 'That project no longer exists.' });
    return handleProject(req, res, url, project, parts[3]);
  }

  send(res, 404, { error: 'Not found.' });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { return send(res, 400, 'Bad request'); }
  if (rel === '/') rel = '/index.html';

  const file = path.resolve(PUBLIC, `.${rel}`);
  // `startsWith(PUBLIC)` alone would also match a sibling like "public-old".
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');

  send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return send(res, 400, { error: 'Bad request URL.' }); }

  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) send(res, 500, { error: err.message });
    else res.end();
  }
});

builder.recoverInterrupted();
store.sweepDeleted();

server.listen(PORT, HOST, () => {
  console.log(`make. → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
