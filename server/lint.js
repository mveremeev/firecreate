'use strict';

// Optional integration with Mozilla's own extension linter — the same
// addons-linter that AMO review runs. It is the only source of ground truth
// available here: validate() can say the code parses, but only this can say
// whether Firefox will actually accept the manifest and the APIs it calls.
//
// Optional on purpose. make. has no npm dependencies and installs by being
// cloned, so this looks for web-ext on the machine and stays quiet if it isn't
// there. Everything degrades to the built-in checks.
//
// There is still no shell here. The command is a fixed argv passed to
// execFile, the working directory is pinned to the staging folder, and
// --no-config-discovery stops web-ext reading a config file from a parent
// directory and adding flags we didn't choose.

const { execFile } = require('child_process');
const { extractJson } = require('./llm');

const PROBE_MS = 10000;
const LINT_MS = 90000;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_FINDINGS = 20;

// Ordered by preference: an explicit override, then a real install, then npx
// against an already-downloaded copy. --no-install keeps npx from reaching out
// to the network mid-build.
function candidates() {
  const list = [];
  if (process.env.MAKE_WEB_EXT) list.push({ command: process.env.MAKE_WEB_EXT, prefix: [] });
  list.push({ command: 'web-ext', prefix: [] });
  list.push({ command: 'npx', prefix: ['--no-install', 'web-ext'] });
  return list;
}

function run(command, args, { cwd, timeout }) {
  return new Promise(resolve => {
    execFile(command, args, {
      cwd,
      timeout,
      maxBuffer: MAX_BUFFER,
      // No shell: argv goes to the process as-is, so nothing in a filename or
      // a path can be read as a command.
      shell: false,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        // A lint run with findings exits non-zero, so a failed exit is normal
        // here and the caller decides by looking at the output instead.
        failed: Boolean(err),
        timedOut: Boolean(err && err.killed),
        code: err && typeof err.code === 'number' ? err.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

// Probed once per process. `null` means "looked and didn't find it".
let located;

async function locate() {
  if (located !== undefined) return located;
  for (const candidate of candidates()) {
    const args = [...candidate.prefix, '--version'];
    const result = await run(candidate.command, args, { timeout: PROBE_MS });
    if (!result.failed && /\d+\.\d+/.test(result.stdout)) {
      located = { ...candidate, version: result.stdout.trim().split('\n').pop().trim() };
      return located;
    }
  }
  located = null;
  return located;
}

// Exposed so tests can force a known state without a real install.
function setLocated(value) {
  located = value;
}

const trim = (value, max) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function finding(row) {
  const where = row.file
    ? `${row.file}${row.line ? `:${row.line}` : ''}`
    : 'manifest.json';
  return {
    code: trim(row.code, 80),
    where,
    // message is the headline; description says what to do about it, which is
    // the half the model actually needs.
    says: trim(row.message, 200),
    detail: trim(row.description, 300),
  };
}

// Turn addons-linter's JSON into something small enough to hand a model.
function summarise(report) {
  const rows = kind => (Array.isArray(report?.[kind]) ? report[kind] : []).map(finding);
  const errors = rows('errors');
  const warnings = rows('warnings');
  return {
    available: true,
    ok: errors.length === 0,
    counts: {
      errors: errors.length,
      warnings: warnings.length,
      notices: Array.isArray(report?.notices) ? report.notices.length : 0,
    },
    // Errors first and capped: twenty findings is already more than a fix round
    // can act on, and a wall of them crowds out the rest of the context.
    findings: [...errors, ...warnings].slice(0, MAX_FINDINGS),
    truncated: errors.length + warnings.length > MAX_FINDINGS,
  };
}

// Lint one staged extension directory. Never throws — a linter that fails to
// run must not be able to fail a build.
async function lint(dir) {
  const tool = await locate();
  if (!tool) return { available: false, reason: 'web-ext is not installed' };

  const args = [
    ...tool.prefix,
    'lint',
    '--source-dir', dir,
    '--output', 'json',
    '--no-config-discovery',
  ];

  const result = await run(tool.command, args, { cwd: dir, timeout: LINT_MS });
  if (result.timedOut) return { available: false, reason: 'web-ext lint timed out' };

  const report = extractJson(result.stdout);
  if (!report || !report.summary) {
    const why = trim(result.stderr || result.stdout, 200) || `exit ${result.code}`;
    return { available: false, reason: `web-ext lint produced no report (${why})` };
  }

  return summarise(report);
}

// The form the model sees. Plain sentences, because it reads better and the
// codes on their own are not self-explanatory.
function asBriefing(report) {
  if (!report.available || report.ok && !report.findings.length) return '';
  const lines = report.findings.map(f =>
    `- ${f.where} — ${f.says}${f.detail ? ` ${f.detail}` : ''} [${f.code}]`);
  if (report.truncated) lines.push('- …and more, not listed.');
  const head = report.ok
    ? 'Firefox’s own linter accepted this, with warnings worth fixing:'
    : 'Firefox’s own linter rejected this. These are real errors, not style notes:';
  return `${head}\n${lines.join('\n')}`;
}

module.exports = { lint, locate, setLocated, summarise, asBriefing };
