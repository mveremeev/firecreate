'use strict';

// The tools the build stage is allowed to call.
//
// Deliberately narrow: every path is resolved inside one staging directory and
// nothing here can execute a command. The model writes files and asks for them
// to be checked — that is the whole vocabulary. There is no shell tool, and
// adding one would put the plaintext API key in data/config.json one `curl`
// away from a model that is improvising code from half-remembered patterns.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const { analyse } = require('./permissions');

const MAX_FILES = 60;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_READ_BYTES = 128 * 1024;

// JSON Schema definitions handed to the model.
const DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List the files that currently exist in the extension, with their sizes.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one file from the extension.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Path relative to the extension root, e.g. "content.js".' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a file or replace its entire contents. Use edit_file for small changes to an existing file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the extension root.' },
          content: { type: 'string', description: 'The complete file contents.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact snippet in an existing file. Prefer this over rewriting a whole file. The snippet must appear exactly once.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          find: { type: 'string', description: 'Exact text to replace, including indentation.' },
          replace: { type: 'string', description: 'Replacement text.' },
        },
        required: ['path', 'find', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Remove a file from the extension.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check',
      description: 'Run the build self-checks: manifest validity, that every referenced file exists, and that every .js and .json file parses. Call this before finishing.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Declare the extension complete. Only call this after check() reports no problems.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'One sentence on what was built or changed.' } },
        required: ['summary'],
      },
    },
  },
];

// Every filesystem tool goes through this. A rejected path returns an error to
// the model rather than throwing, so it can correct itself and carry on.
function resolve(dir, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return { error: 'A path is required.' };
  const asked = rel.trim();

  // Refuse an absolute path rather than quietly reinterpreting it as relative.
  // Silently turning "/etc/passwd" into "<staging>/etc/passwd" stays inside the
  // sandbox but hides the fact that the model asked for something it can't have.
  if (path.isAbsolute(asked) || /^[a-zA-Z]:[\\/]/.test(asked)) {
    return { error: `Paths must be relative to the extension root — "${asked}" is absolute.` };
  }

  const clean = path.normalize(asked);
  const abs = path.resolve(dir, clean);
  if (abs !== dir && !abs.startsWith(dir + path.sep)) {
    return { error: `"${asked}" is outside the extension folder.` };
  }
  return { abs, rel: clean };
}

// `validate` lives in builder.js; it is injected to avoid a require cycle.
function makeTools(dir, { validate, onCall } = {}) {
  const announce = (name, detail) => { if (onCall) onCall(name, detail); };

  const handlers = {
    list_files() {
      const files = store.listFilesIn(dir);
      announce('list_files', `${files.length} files`);
      if (!files.length) return { files: [], note: 'Nothing has been written yet.' };
      return { files };
    },

    read_file({ path: rel }) {
      const target = resolve(dir, rel);
      if (target.error) return target;
      if (!fs.existsSync(target.abs) || !fs.statSync(target.abs).isFile()) {
        return { error: `There is no file at "${target.rel}".` };
      }
      announce('read_file', target.rel);
      const text = fs.readFileSync(target.abs, 'utf8');
      return text.length > MAX_READ_BYTES
        ? { path: target.rel, content: text.slice(0, MAX_READ_BYTES), truncated: true }
        : { path: target.rel, content: text };
    },

    write_file({ path: rel, content }) {
      const target = resolve(dir, rel);
      if (target.error) return target;
      if (typeof content !== 'string') return { error: 'content must be a string.' };
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
        return { error: `That file is over ${MAX_FILE_BYTES / 1024}KB. Split it up.` };
      }
      const existing = store.listFilesIn(dir);
      if (existing.length >= MAX_FILES && !existing.some(f => f.path === target.rel)) {
        return { error: `An extension may have at most ${MAX_FILES} files.` };
      }

      fs.mkdirSync(path.dirname(target.abs), { recursive: true });
      fs.writeFileSync(target.abs, content);
      announce('write_file', target.rel);
      return { ok: true, path: target.rel, bytes: Buffer.byteLength(content) };
    },

    edit_file({ path: rel, find, replace }) {
      const target = resolve(dir, rel);
      if (target.error) return target;
      if (!fs.existsSync(target.abs)) return { error: `There is no file at "${target.rel}".` };
      if (typeof find !== 'string' || !find) return { error: 'find must be a non-empty string.' };
      if (typeof replace !== 'string') return { error: 'replace must be a string.' };

      const before = fs.readFileSync(target.abs, 'utf8');
      const first = before.indexOf(find);
      if (first === -1) return { error: 'That snippet is not in the file. Read it again and match it exactly.' };
      if (before.indexOf(find, first + find.length) !== -1) {
        return { error: 'That snippet appears more than once. Include enough surrounding text to make it unique.' };
      }

      fs.writeFileSync(target.abs, before.slice(0, first) + replace + before.slice(first + find.length));
      announce('edit_file', target.rel);
      return { ok: true, path: target.rel };
    },

    delete_file({ path: rel }) {
      const target = resolve(dir, rel);
      if (target.error) return target;
      if (!fs.existsSync(target.abs)) return { error: `There is no file at "${target.rel}".` };
      fs.rmSync(target.abs, { force: true });
      announce('delete_file', target.rel);
      return { ok: true };
    },

    check() {
      const problems = validate ? validate(dir) : [];
      const { permissions, exposures } = analyse(dir);
      announce('check', problems.length ? `${problems.length} problems` : 'clean');

      // Surfaced on every check, passing or not: over-broad permissions and
      // web-reachable entry points are the two things the model most needs
      // pushed back at it, and it should see them while it can still act.
      const security = {
        broadPermissions: permissions.filter(p => p.risk === 'high').map(p => `${p.name} — ${p.says}`),
        webReachable: exposures.map(e => `${e.file}: ${e.says}. ${e.means} Fix: ${e.fix}`),
      };
      if (security.broadPermissions.length || security.webReachable.length) {
        security.instruction = 'Remove any permission the code does not use, narrow the rest, '
          + 'and close every entry point a page can reach unless the plan genuinely requires it.';
      }

      if (problems.length) return { ok: false, problems, security };
      return {
        ok: true,
        security,
        note: 'No problems found. These checks cover syntax and references only — they cannot tell whether the extension behaves correctly.',
      };
    },

    finish({ summary }) {
      announce('finish', '');
      return { ok: true, summary: String(summary || '') };
    },
  };

  return {
    definitions: DEFINITIONS,
    names: Object.keys(handlers),
    // Returns a JSON-serialisable result for any call, never throws.
    run(name, rawArguments) {
      const handler = handlers[name];
      if (!handler) return { error: `There is no tool called "${name}".` };

      let args = {};
      if (typeof rawArguments === 'string' && rawArguments.trim()) {
        try {
          args = JSON.parse(rawArguments);
        } catch {
          return { error: 'Your arguments were not valid JSON. Send them again.' };
        }
      } else if (rawArguments && typeof rawArguments === 'object') {
        args = rawArguments;
      }

      try {
        return handler(args);
      } catch (err) {
        return { error: err.message };
      }
    },
  };
}

module.exports = { makeTools, DEFINITIONS };
