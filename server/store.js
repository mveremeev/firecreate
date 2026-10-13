'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// MAKE_DATA lets tests run against a scratch directory instead of the real one.
const DATA = process.env.MAKE_DATA ? path.resolve(process.env.MAKE_DATA) : path.join(ROOT, 'data');
const PROJECTS = path.join(DATA, 'projects');
const BUILDS = path.join(DATA, 'builds');
const CONFIG_FILE = path.join(DATA, 'config.json');

const MAX_LOGS = 800;      // per project, oldest dropped
const MAX_FILE_BYTES = 512 * 1024;

for (const dir of [DATA, PROJECTS, BUILDS]) fs.mkdirSync(dir, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write via temp file + rename so a crash mid-write can't leave corrupt JSON.
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

// ---- config ----

const DEFAULT_CONFIG = {
  provider: 'openai',        // 'openai' (any compatible endpoint) | 'openrouter'
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  contextTokens: 128000,

  // Sampling. 0.2, not the 0.4 this shipped with — code generation wants
  // determinism, and the extra variance was buying nothing.
  temperature: 0.2,
  maxTokens: 0,              // 0 = let the provider decide

  // OpenRouter-only routing. Ignored for plain OpenAI-compatible endpoints.
  reasoningEffort: 'high',   // '' | low | medium | high
  sort: 'throughput',        // '' | throughput | latency | price
  quantizations: '',         // comma list, e.g. "fp4" — blank means no filter

  toolMode: 'auto',          // auto | tools | oneshot
};

const PROVIDERS = new Set(['openai', 'openrouter']);
// Providers disagree about which of these they accept — OpenRouter passes the
// value through, so an unsupported one comes back as a 400 rather than being
// silently ignored. Better to offer the range and report the rejection.
const EFFORTS = new Set(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SORTS = new Set(['', 'throughput', 'latency', 'price']);
const TOOL_MODES = new Set(['auto', 'tools', 'oneshot']);

function getConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) };
}

const pick = (allowed, value, fallback) =>
  allowed.has(String(value)) ? String(value) : fallback;

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function saveConfig(patch) {
  const current = getConfig();
  const next = {
    provider: pick(PROVIDERS, patch.provider ?? current.provider, DEFAULT_CONFIG.provider),
    baseUrl: String(patch.baseUrl ?? current.baseUrl).trim() || DEFAULT_CONFIG.baseUrl,
    // Omitting apiKey keeps the saved one; passing '' clears it.
    apiKey: patch.apiKey === undefined ? current.apiKey : String(patch.apiKey).trim(),
    model: String(patch.model ?? current.model).trim(),
    contextTokens: Math.round(clampNumber(
      patch.contextTokens ?? current.contextTokens, 8000, 2000000, DEFAULT_CONFIG.contextTokens)),
    temperature: clampNumber(patch.temperature ?? current.temperature, 0, 2, DEFAULT_CONFIG.temperature),
    maxTokens: Math.round(clampNumber(patch.maxTokens ?? current.maxTokens, 0, 400000, 0)),
    reasoningEffort: pick(EFFORTS, patch.reasoningEffort ?? current.reasoningEffort, DEFAULT_CONFIG.reasoningEffort),
    sort: pick(SORTS, patch.sort ?? current.sort, DEFAULT_CONFIG.sort),
    quantizations: String(patch.quantizations ?? current.quantizations).trim(),
    toolMode: pick(TOOL_MODES, patch.toolMode ?? current.toolMode, DEFAULT_CONFIG.toolMode),
  };
  writeJson(CONFIG_FILE, next);
  return next;
}

// ---- projects ----

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function projectFile(id) {
  return path.join(PROJECTS, `${id}.json`);
}

function normalize(project) {
  if (!project || !project.id) return null;
  return {
    kind: 'Firefox extension',
    title: null,
    status: 'draft',           // draft | building | ready | error
    prompt: '',
    history: [],
    spec: [],
    logs: [],
    percent: 0,
    builds: 0,
    error: null,
    builtSpec: null,   // snapshot of the spec the current .xpi was built from
    builtAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...project,
  };
}

function createProject(text) {
  const now = new Date().toISOString();
  const project = normalize({
    id: newId(),
    prompt: text,
    createdAt: now,
    updatedAt: now,
  });
  saveProject(project);
  return project;
}

// Deleting is reversible for a few seconds — see deleteProject/restoreProject.
const UNDO_WINDOW_MS = 8000;

const expired = project =>
  Date.now() - new Date(project.deletedAt).getTime() > UNDO_WINDOW_MS;

// Reads through the soft-delete filter. Only restore and the sweep want this.
function getProjectRaw(id) {
  if (!validId(id)) return null;
  return normalize(readJson(projectFile(id), null));
}

function getProject(id) {
  const project = getProjectRaw(id);
  if (!project) return null;
  if (project.deletedAt) {
    if (expired(project)) hardDelete(id);
    return null;
  }
  return project;
}

function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  if (project.logs.length > MAX_LOGS) project.logs = project.logs.slice(-MAX_LOGS);
  writeJson(projectFile(project.id), project);
  return project;
}

// Read-modify-write against the file on disk. Every background write goes
// through this so a build in progress can't clobber a concurrent edit.
function mutate(id, fn) {
  const project = getProject(id);
  if (!project) return null;
  fn(project);
  return saveProject(project);
}

function listProjects() {
  return fs.readdirSync(PROJECTS)
    .filter(f => f.endsWith('.json'))
    .map(f => normalize(readJson(path.join(PROJECTS, f), null)))
    .filter(p => p && !p.deletedAt)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function hardDelete(id) {
  if (!validId(id)) return false;
  fs.rmSync(projectFile(id), { force: true });
  fs.rmSync(buildDir(id), { recursive: true, force: true });
  fs.rmSync(stageDir(id), { recursive: true, force: true });
  fs.rmSync(xpiPath(id), { force: true });
  return true;
}

// Flag it, hide it, and sweep it for real once the undo window closes.
function deleteProject(id) {
  const project = getProjectRaw(id);
  if (!project || project.deletedAt) return false;
  mutate(id, p => { p.deletedAt = new Date().toISOString(); });
  setTimeout(() => {
    const current = getProjectRaw(id);
    if (current && current.deletedAt && expired(current)) hardDelete(id);
  }, UNDO_WINDOW_MS + 500).unref();
  return true;
}

function restoreProject(id) {
  // Deliberately via getProjectRaw: mutate() reads through getProject, which
  // filters soft-deleted projects, so a mutate-based restore always no-ops.
  const project = getProjectRaw(id);
  if (!project || !project.deletedAt) return null;
  delete project.deletedAt;
  return saveProject(project);
}

// A soft-deleted project whose sweep timer died with the process would sit
// hidden on disk forever. Clear those at boot.
function sweepDeleted() {
  for (const file of fs.readdirSync(PROJECTS)) {
    if (!file.endsWith('.json')) continue;
    const project = readJson(path.join(PROJECTS, file), null);
    if (project && project.deletedAt && expired(project)) hardDelete(project.id);
  }
}

function log(project, level, line) {
  project.logs.push({ t: new Date().toISOString(), level, line: String(line) });
  if (project.logs.length > MAX_LOGS) project.logs = project.logs.slice(-MAX_LOGS);
}

// ---- build artifacts ----

function buildDir(id) {
  return path.join(BUILDS, id);
}

// Builds are assembled here and only promoted over buildDir once they pass
// their self-checks, so a failed or cancelled rebuild can't destroy a good one.
function stageDir(id) {
  return path.join(BUILDS, `${id}.staging`);
}

function xpiPath(id) {
  return path.join(BUILDS, `${id}.xpi`);
}

function walk(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(abs, rel));
    else if (entry.isFile()) out.push({ path: rel, size: fs.statSync(abs).size });
  }
  return out;
}

function listFilesIn(dir) {
  return walk(dir).sort((a, b) => {
    // manifest first, then shallowest, then alphabetical.
    if (a.path === 'manifest.json') return -1;
    if (b.path === 'manifest.json') return 1;
    const depth = a.path.split('/').length - b.path.split('/').length;
    return depth || a.path.localeCompare(b.path);
  });
}

function listFiles(id) {
  return validId(id) ? listFilesIn(buildDir(id)) : [];
}

// Resolve a path inside `root`, refusing anything that escapes it.
function resolveIn(root, rel) {
  if (typeof rel !== 'string' || !rel) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function resolveBuildPath(id, rel) {
  return validId(id) ? resolveIn(buildDir(id), rel) : null;
}

function readFile(id, rel) {
  const abs = resolveBuildPath(id, rel);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const size = fs.statSync(abs).size;
  if (size > MAX_FILE_BYTES) {
    return { text: `— file is ${(size / 1024).toFixed(0)} KB, too large to display —`, size, truncated: true };
  }
  return { text: fs.readFileSync(abs, 'utf8'), size, truncated: false };
}

// Read every file in a directory back as a { path: contents } map.
function readAllFilesIn(dir) {
  const files = {};
  for (const entry of listFilesIn(dir)) {
    const abs = resolveIn(dir, entry.path);
    if (abs) files[entry.path] = fs.readFileSync(abs, 'utf8');
  }
  return files;
}

// For revisions and reviews. Defaults to the live build, but a caller mid-build
// wants the staging copy.
function readAllFiles(id, dir) {
  return readAllFilesIn(dir || buildDir(id));
}

module.exports = {
  DATA, PROJECTS, BUILDS,
  getConfig, saveConfig,
  createProject, getProject, getProjectRaw, saveProject, mutate, listProjects,
  deleteProject, restoreProject, sweepDeleted, validId,
  log, buildDir, stageDir, xpiPath,
  listFiles, listFilesIn, readFile, readAllFiles, readAllFilesIn, resolveBuildPath, resolveIn,
};
