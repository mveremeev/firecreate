'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const llm = require('./llm');
const store = require('./store');
const { zipDir } = require('./zip');
const { makeTools } = require('./tools');
const { lint, asBriefing: lintBriefing } = require('./lint');
const permissions = require('./permissions');

const MAX_ATTEMPTS = 3;
const MAX_FILES = 60;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOOL_STEPS = 40;      // hard stop on a runaway loop
const MAX_REVIEW_ROUNDS = 2;

// ---- prompts ----

const CLARIFY_SYSTEM = [
  'You are the clarification stage of "make.", which builds Firefox extensions for people who do not write code.',
  'IMPORTANT: you run headless — there is no human on your side of the conversation. NEVER use any tools (including AskUserQuestion or similar interactive tools); there is nobody to answer them and the turn will hang forever. Do ALL asking and answering inside your reply text.',
  '',
  'Your job is to turn a vague wish into a plan precise enough to build from.',
  'Ask at most two questions per reply, and only when the answer changes what gets built. Otherwise pick a sensible default, say what you assumed in one clause, and move on — an exhausted person would rather correct one guess than answer five questions.',
  'Never ask about implementation. Whether it needs a content script is your problem, not theirs.',
  'Keep replies to a few short sentences. No jargon, no sign-up or account talk.',
  '',
  'After EVERY user message respond with a single JSON object and nothing else:',
  '{"reply": "<your message to the user>", "title": "<short name for the extension>", "spec": ["<one behaviour per bullet>", ...]}',
  '',
  'The spec is the contract the build stage works from — it is the only thing that stage sees. Rewrite it in full every time.',
  'Each bullet describes ONE observable behaviour, concrete enough that someone could check it: what the user does, and what happens.',
  '  Good: "Clicking the toolbar button copies the page title and URL as a markdown link."',
  '  Bad: "Nice sharing options." — nobody can check that.',
  'Split compound wishes into separate bullets rather than listing five features in one.',
  'Say where it runs (which sites, or everywhere) and what happens by default before anything is configured.',
  '',
  'Once it is clear enough to build, say so plainly and stop asking questions.',
  'If the extension is already built and the user asks for a change, rewrite the spec to describe the extension as it will be AFTER the change, and tell them they can rebuild.',
  '',
  'How building actually works, so you can answer accurately if asked — do not guess at this:',
  'You never see the code. The build stage does. On a rebuild it is given the existing extension and edits it in place; it does not start from nothing, so working parts stay working.',
  'It also receives the most recent messages of this conversation, so a bug the user just described reaches it directly.',
  'When someone reports something is broken, say plainly in the spec what the correct behaviour is — that is what gets fixed.',
].join('\n');

// Not style notes. Each of these is a way a generated extension passes the
// self-checks, installs cleanly, and then quietly does nothing — the failure
// mode the checks cannot see. Stated as the correct pattern rather than a
// prohibition, because "don't do X" leaves the model to invent Y.
const FIREFOX_RULES = [
  'Firefox specifics that decide whether this works at all:',
  '',
  'CLIPBOARD — navigator.clipboard.write() needs a focused document and a user gesture, so it FAILS from a background script. Do it in the popup or a content script, inside the click handler itself:',
  '    copyBtn.addEventListener("click", async () => {',
  '      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);',
  '    });',
  '',
  'DOWNLOADS — browser.downloads.download() will not accept a data: URL. Go through a blob:',
  '    const url = URL.createObjectURL(blob);',
  '    await browser.downloads.download({ url, filename });',
  '    setTimeout(() => URL.revokeObjectURL(url), 60000);',
  '',
  'MESSAGING — in runtime.onMessage either return a Promise, or return true and call sendResponse later. Never both, and never return true without eventually calling sendResponse — the sender hangs forever.',
  '',
  'CAPTURE — browser.tabs.captureVisibleTab gives you the visible viewport only, scaled by devicePixelRatio. Full-page capture means scrolling, capturing repeatedly and stitching, and position:fixed elements will repeat in every slice.',
  '',
  'STORAGE — storage.local is for settings, not images. Pass blobs or object URLs between contexts instead of base64 round-trips.',
  '',
  'CONTENT SCRIPTS — see the page DOM but not the page\'s JavaScript. They cannot read page variables. They also run again on every navigation, so guard against double injection.',
].join('\n');

// Shared by every stage that writes code.
const CRAFT = [
  'Choosing where code goes:',
  '- Triggered by clicking the toolbar button → popup.html + popup.js, using "activeTab" and browser.tabs.executeScript when you need the page.',
  '- Must change pages automatically → content script, with the narrowest "matches" that satisfy the plan.',
  '- Needs to outlive the popup, listen for browser events, or hold state across tabs → background script.',
  '- User-configurable → options_ui, with defaults that already work before anyone opens it.',
  '',
  'Quality bar — a non-technical person installs this and tries to use it:',
  '- Every control you draw must do something. No dead buttons, no handlers that log and return.',
  '- No stubs, no TODO comments, no functions returning placeholder data. If it is in the plan, implement it.',
  '- When something can fail, say so in the interface. Never catch an error and drop it.',
  '- Plain scripts only: no import/export, no bundlers, no libraries, no network requests.',
  '- Keep it as small as the plan allows. Extra features are not a bonus.',
].join('\n');

// The trust boundary. An extension holds privileges no webpage has, so every
// place web content can reach extension code is a place a hostile page could
// borrow them. A bug here is worse than a malicious extension: it works, it
// looks legitimate, and the exploit lives on someone else's website.
const TRUST_RULES = [
  'The trust boundary — treat anything from a webpage as hostile:',
  '- Ask for the fewest permissions the plan needs. If activeTab is enough, do NOT ask for <all_urls>. Never declare a permission the code does not call.',
  '- A content script listening with window.addEventListener("message", …) must check event.source === window and event.origin before acting. Without that, any site on the internet can drive the extension.',
  '- runtime.onMessage must check sender before doing anything privileged.',
  '- NEVER fetch a URL that came from the page. The background script holds every host permission and the user\'s cookies — a handler that fetches whatever it is told lets any page read any site as that user.',
  '- Never eval() or new Function() a page-derived string, and never pass executeScript a code: string.',
  '- Build extension UI with textContent and createElement, not innerHTML. Extension pages run with extension privileges, so HTML injection there is worse than on a webpage.',
  '- web_accessible_resources should list only assets a page must load — images, not pages that contain logic.',
  '- Do not add externally_connectable unless the plan names a specific site that must talk to the extension.',
].join('\n');

const MANIFEST_RULES = [
  'manifest.json must include manifest_version (2), name, version, description, and permissions,',
  'plus "browser_specific_settings": {"gecko": {"id": "<name>@make.local"}}.',
  'Every file it references must exist.',
].join('\n');

// The tool loop's system prompt. Unlike the one-shot path, this one is
// required to use tools.
const AGENT_SYSTEM = [
  'You are the build stage of "make.", which turns a plain-language plan into a working Firefox extension (Manifest V2).',
  'Someone who does not write code will install what you produce and try to use it. It has to work, not merely load.',
  '',
  'How to work:',
  '1. Decide the smallest architecture that satisfies the plan — see "Choosing where code goes".',
  '2. Write manifest.json first, declaring only what you will actually use.',
  '3. Write one file at a time with write_file, finishing each before starting the next.',
  '4. Read a file with read_file before editing it. Use edit_file for targeted changes; rewrite a whole file only when most of it changes.',
  '5. Call check. Fix whatever it reports, then check again.',
  '6. Before finishing, re-read the plan and confirm every bullet has a path from something the user can see to code that does it.',
  '7. Call finish.',
  '',
  'check() only proves the code parses and the manifest\'s references resolve. It cannot tell you whether the extension behaves correctly — that part is on you.',
  'Keep any prose between tool calls to one short sentence.',
  '',
  MANIFEST_RULES,
  '',
  CRAFT,
  '',
  TRUST_RULES,
  '',
  FIREFOX_RULES,
].join('\n');

const REVIEW_SYSTEM = [
  'You are reviewing a generated Firefox extension (Manifest V2) before a non-technical person installs it.',
  'The build self-checks already passed: the code parses and every referenced file exists. That proves nothing about behaviour.',
  'Find the places where this will install cleanly and then not work.',
  '',
  'Work in this order:',
  '1. Take each bullet of the plan and trace it through the code. Is there a path from a control the user can see to code that does that thing? Name any bullet that has no working path.',
  '2. Check the Firefox specifics below — these are how generated extensions usually fail.',
  '3. Look for dead controls, handlers that never fire, and errors that are caught and dropped.',
  '4. Check the manifest declares what the code uses, and nothing it does not.',
  '',
  FIREFOX_RULES,
  '',
  'Respond with a single JSON object and nothing else:',
  '{"verdict": "ok" | "problems", "problems": ["<which file, what is wrong, and what the user would see>", ...]}',
  'Report only defects you can point at in the code, and say what breaks from the user\'s side.',
  'An empty list is a fine answer. Do not report style preferences, naming, or features the plan never asked for.',
].join('\n');

const SECURITY_REVIEW_SYSTEM = [
  'You are auditing a generated Firefox extension (Manifest V2) for one thing only: could a hostile webpage use this extension to do something it could not do on its own?',
  'This is not about whether the extension is malicious. Assume the author meant well. Look for the places where web content reaches extension privilege — those are exploitable whether or not anyone intended it.',
  '',
  TRUST_RULES,
  '',
  'Also judge the permissions: for each one the manifest declares, is it actually used by the code, and is it the narrowest thing that works? An unused or over-broad permission is a finding.',
  '',
  'An automated scan has already flagged some candidates. Confirm or dismiss each one by reading the code, and add anything it missed — it only matches patterns.',
  '',
  'Respond with a single JSON object and nothing else:',
  '{"verdict": "ok" | "problems", "problems": ["<which file, what a page could do, and the fix>", ...]}',
  'Report only what you can point at in the code. Say what a hostile page gains, concretely.',
  'An empty list is a fine answer. Do not speculate about threats the code does not enable.',
].join('\n');

const ONESHOT_PROTOCOL = [
  'IMPORTANT: you run headless — NEVER use any tools. Output everything as text: a single JSON object and nothing else.',
  'Respond with a map of file path to file contents:',
  '{"files": {"manifest.json": "...", "background.js": "...", ...}}',
].join('\n');

const BUILD_SYSTEM = [
  'You are the build stage of "make.", which turns a plain-language plan into a working Firefox extension (Manifest V2).',
  'Someone who does not write code will install what you produce and try to use it. It has to work, not merely load.',
  ONESHOT_PROTOCOL,
  '',
  MANIFEST_RULES,
  '',
  CRAFT,
  '',
  TRUST_RULES,
  '',
  FIREFOX_RULES,
].join('\n');

const REVISE_SYSTEM = [
  'You are the revision stage of "make.", which changes an existing Firefox extension (Manifest V2).',
  'You are given the current extension and an updated plan. Apply only what changed.',
  ONESHOT_PROTOCOL,
  'Return the COMPLETE file map for the new version — every file, including the ones you did not touch.',
  'Preserve everything that still applies. Do not rewrite files the change does not affect, and do not drop features the plan still lists. Bump the manifest version.',
  '',
  MANIFEST_RULES,
  '',
  CRAFT,
  '',
  TRUST_RULES,
  '',
  FIREFOX_RULES,
].join('\n');

// ---- context budgeting ----
//
// Sending the whole transcript every turn gets expensive and, past a point,
// makes answers worse — the useful signal drowns. Spend a slice of the
// model's window instead: keep the opening (the original ask and the first
// plan, which anchor what is being built) and as much of the recent tail as
// fits, and drop the middle.

const CONTEXT_SHARE = 0.10;   // of the model's window
const HEAD_SHARE = 0.20;      // of that budget, taken from the start
const CHARS_PER_TOKEN = 4;    // rough, and deliberately conservative

function contextBudget(config, share = CONTEXT_SHARE) {
  const tokens = Number(config.contextTokens) || 128000;
  return Math.max(4000, Math.round(tokens * share * CHARS_PER_TOKEN));
}

const sizeOf = messages => messages.reduce((total, m) => total + (m.content || '').length, 0);

function trimHistory(history, chars) {
  if (sizeOf(history) <= chars) return { messages: history, dropped: 0 };

  const headChars = chars * HEAD_SHARE;
  const head = [];
  let used = 0;
  for (const message of history) {
    if (used + message.content.length > headChars) break;
    head.push(message);
    used += message.content.length;
  }

  const tail = [];
  used = 0;
  for (let i = history.length - 1; i >= head.length; i--) {
    if (used + history[i].content.length > chars - headChars) break;
    tail.unshift(history[i]);
    used += history[i].content.length;
  }

  // The newest turn is the one being answered — never drop it, however long.
  if (!tail.length && history.length > head.length) tail.push(history[history.length - 1]);

  const dropped = history.length - head.length - tail.length;
  if (dropped <= 0) return { messages: history, dropped: 0 };

  return {
    messages: [
      ...head,
      { role: 'system', content: `[${dropped} message${dropped === 1 ? '' : 's'} from the middle of this conversation were omitted to stay within context. The plan below is authoritative.]` },
      ...tail,
    ],
    dropped,
  };
}

// Just the most recent turns, for stages that want the change request rather
// than the whole conversation.
function recentTurns(history, chars) {
  const tail = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (used + history[i].content.length > chars) break;
    tail.unshift(history[i]);
    used += history[i].content.length;
  }
  return tail;
}

const asTranscript = messages => messages
  .map(m => `${m.role === 'user' ? 'User' : 'You'}: ${m.content}`)
  .join('\n');

// ---- clarify ----

async function clarify(config, projectId, userMessage, events = {}) {
  const project = store.getProject(projectId);
  if (!project) throw new Error('Project not found.');

  const message = String(userMessage || '').trim() || project.prompt;
  store.mutate(projectId, p => {
    store.log(p, 'activity', userMessage ? `you · ${message}` : 'started');
    p.history.push({ role: 'user', content: message });
  });

  const current = store.getProject(projectId);
  const history = current.history;
  const { messages: context, dropped } = trimHistory(history, contextBudget(config));

  // Re-state the plan so it survives even when the turns that produced it were
  // trimmed away — otherwise a long conversation slowly forgets what it agreed.
  const anchor = current.spec.length
    ? [{ role: 'system', content: `The plan agreed so far:\n${current.spec.map(s => `- ${s}`).join('\n')}` }]
    : [];

  const messages = [{ role: 'system', content: CLARIFY_SYSTEM }, ...anchor, ...context];
  // Report the two separately: the budget bounds the conversation, while the
  // system prompt and plan anchor are fixed overhead on every turn. Rolling
  // them into one number makes an over-budget history impossible to spot.
  store.mutate(projectId, p => {
    store.log(p, 'technical', `llm clarify · turn ${history.length}`
      + ` · history ${Math.round(sizeOf(context) / CHARS_PER_TOKEN)} tok`
      + ` · total ${Math.round(sizeOf(messages) / CHARS_PER_TOKEN)} tok`
      + (dropped ? ` · ${dropped} older messages trimmed` : ''));
  });

  const extractor = llm.makeReplyExtractor(d => events.onReply && events.onReply(d));
  const { content, ms, usage } = await llm.chatStream(config, messages, {
    signal: events.signal,
    onThinking: events.onThinking,
    onContent: d => extractor.push(d),
  });

  const parsed = llm.extractJson(content);
  // Prefer the parsed value; fall back to whatever streamed out of "reply";
  // only show the raw content if the model ignored the format entirely.
  const reply = (parsed && typeof parsed.reply === 'string' && parsed.reply)
    || extractor.text
    || content;

  const result = store.mutate(projectId, p => {
    store.log(p, 'technical',
      `llm reply · ${ms}ms${usage ? ` · ${usage.prompt_tokens || '?'} tok in / ${usage.completion_tokens || '?'} tok out` : ''}`);
    if (parsed && Array.isArray(parsed.spec)) p.spec = parsed.spec.map(String).filter(Boolean);
    if (parsed && parsed.title) p.title = String(parsed.title).slice(0, 80);
    p.history.push({ role: 'assistant', content: reply });
    store.log(p, 'activity', `make · ${reply}`);
  });

  return { reply, spec: result.spec, title: result.title, status: result.status };
}

// ---- validation ----

class BuildStopped extends Error {}

// Everything the manifest can point at. Missing targets are the single most
// common way a generated extension fails to load, so check them all.
function referencedPaths(manifest) {
  const refs = [];
  const add = (value, why) => {
    if (typeof value === 'string' && value && !/^(https?:)?\/\//.test(value)) refs.push({ file: value, why });
  };

  for (const script of manifest.background?.scripts || []) add(script, 'background.scripts');
  add(manifest.background?.page, 'background.page');

  for (const entry of manifest.content_scripts || []) {
    for (const js of entry.js || []) add(js, 'content_scripts.js');
    for (const css of entry.css || []) add(css, 'content_scripts.css');
  }

  for (const action of ['browser_action', 'page_action', 'action']) {
    add(manifest[action]?.default_popup, `${action}.default_popup`);
    add(manifest[action]?.default_icon, `${action}.default_icon`);
    for (const icon of Object.values(manifest[action]?.default_icon || {})) add(icon, `${action}.default_icon`);
  }

  for (const icon of Object.values(manifest.icons || {})) add(icon, 'icons');
  add(manifest.options_ui?.page, 'options_ui.page');
  add(manifest.sidebar_action?.default_panel, 'sidebar_action.default_panel');
  add(manifest.devtools_page, 'devtools_page');
  add(manifest.chrome_url_overrides?.newtab, 'chrome_url_overrides.newtab');

  return refs;
}

// Returns a list of human-readable problems. Empty means the build is sound.
function validate(dir) {
  const problems = [];
  const manifestPath = path.join(dir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) return ['There is no manifest.json.'];

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return [`manifest.json is not valid JSON: ${err.message}`];
  }

  for (const key of ['manifest_version', 'name', 'version']) {
    if (!(key in manifest)) problems.push(`manifest.json is missing "${key}".`);
  }
  if (manifest.version !== undefined && !/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) {
    problems.push(`manifest version "${manifest.version}" is not a valid dotted number like "1.0".`);
  }

  for (const ref of referencedPaths(manifest)) {
    const target = store.resolveIn(dir, ref.file.replace(/^\//, ''));
    if (!target || !fs.existsSync(target)) {
      problems.push(`${ref.why} references "${ref.file}", but that file was not generated.`);
    }
  }

  // Parse every generated file so syntax errors surface here, not in Firefox.
  for (const entry of store.listFilesIn(dir)) {
    const abs = path.join(dir, entry.path);
    const source = fs.readFileSync(abs, 'utf8');
    if (entry.path.endsWith('.js')) {
      try {
        new vm.Script(source, { filename: entry.path });
      } catch (err) {
        problems.push(`${entry.path} has a JavaScript syntax error: ${err.message}`);
      }
    } else if (entry.path.endsWith('.json')) {
      try {
        JSON.parse(source);
      } catch (err) {
        problems.push(`${entry.path} is not valid JSON: ${err.message}`);
      }
    }
  }

  return problems;
}

// Put a directory back exactly as it was. Fix rounds are speculative: if one
// fails or breaks the checks, we restore rather than ship something worse than
// what we already had.
function restoreFiles(dir, snapshot) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(snapshot)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
}

// ---- build ----

const running = new Map(); // projectId -> AbortController

function isBuilding(id) {
  return running.has(id);
}

function stopBuild(id) {
  const controller = running.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

function writeFiles(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const written = [];
  const skipped = [];
  for (const [rel, contents] of Object.entries(files)) {
    if (written.length >= MAX_FILES) { skipped.push(rel); continue; }

    const clean = path.normalize(String(rel)).replace(/^[/\\]+/, '');
    const dest = path.resolve(dir, clean);
    if (dest !== dir && !dest.startsWith(dir + path.sep)) { skipped.push(rel); continue; }

    const body = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
    if (Buffer.byteLength(body) > MAX_FILE_BYTES) { skipped.push(rel); continue; }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    written.push(clean);
  }
  return { written, skipped };
}

async function generate(config, projectId, messages, signal, onProgress) {
  const seen = new Set();
  let bytes = 0;

  const { content, ms, usage } = await llm.chatStream(config, messages, {
    signal,
    onContent: delta => {
      bytes += delta.length;
      // Approach the end of the generation band asymptotically so the bar
      // always moves but never claims to be finished early.
      onProgress(10 + 55 * (1 - Math.exp(-bytes / 9000)));
      // Announce each file as its key appears in the streaming JSON.
      for (const match of delta.matchAll(/"([\w./-]+\.[a-z]{2,5})"\s*:/g)) {
        if (!seen.has(match[1])) {
          seen.add(match[1]);
          store.mutate(projectId, p => store.log(p, 'activity', `writing ${match[1]}`));
        }
      }
    },
  });

  store.mutate(projectId, p => store.log(p, 'technical',
    `llm reply · ${ms}ms${usage ? ` · ${usage.prompt_tokens || '?'} tok in / ${usage.completion_tokens || '?'} tok out` : ''}`));

  return content;
}

// Plain-language names for the activity timeline. A non-technical user sees
// "writing content.js", not "write_file".
const TOOL_VERB = {
  list_files: () => 'looking at the files',
  read_file: detail => `reading ${detail}`,
  write_file: detail => `writing ${detail}`,
  edit_file: detail => `editing ${detail}`,
  delete_file: detail => `removing ${detail}`,
  check: detail => (detail === 'clean' ? 'checks passed' : `found problems — ${detail}`),
  finish: () => 'finishing up',
};

// The agentic path: the model drives, calling tools until it declares itself
// done. Returns false when the endpoint cannot do tool calling at all, so the
// caller can fall back to the one-shot JSON protocol.
async function runToolLoop(config, projectId, { stage, opening, signal, floor = 10, ceiling = 65 }) {
  const tools = makeTools(stage, {
    validate,
    onCall: (name, detail) => {
      const phrase = TOOL_VERB[name];
      if (phrase) store.mutate(projectId, p => store.log(p, 'activity', phrase(detail)));
    },
  });

  const messages = [
    { role: 'system', content: AGENT_SYSTEM },
    { role: 'user', content: opening },
  ];

  let steps = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let finished = false;

  while (steps < MAX_TOOL_STEPS && !finished) {
    if (signal.aborted) throw new BuildStopped();
    steps++;

    let answer;
    try {
      answer = await llm.chat(config, messages, { signal, tools: tools.definitions });
    } catch (err) {
      // First step only: an endpoint without tool support tells us here, and
      // the one-shot protocol still works fine for it.
      if (steps === 1 && (err.rejectedTools || /tool|function/i.test(err.message))) {
        store.mutate(projectId, p => store.log(p, 'technical',
          `endpoint refused tool calling (${err.message}) — falling back to single-reply mode`));
        return false;
      }
      throw err;
    }

    if (answer.usage) {
      tokensIn += answer.usage.prompt_tokens || 0;
      tokensOut += answer.usage.completion_tokens || 0;
    }

    if (!answer.toolCalls.length) {
      // It stopped calling tools without finishing. Nudge once, then accept.
      if (steps === 1) {
        store.mutate(projectId, p => store.log(p, 'technical', 'model answered without using tools — falling back to single-reply mode'));
        return false;
      }
      messages.push(answer.message);
      const problems = validate(stage);
      if (!problems.length) break;
      messages.push({
        role: 'user',
        content: `Not done yet — check reports:\n${problems.map(p => `- ${p}`).join('\n')}\nFix these, then call check and finish.`,
      });
      continue;
    }

    messages.push(answer.message);
    for (const call of answer.toolCalls) {
      const name = call.function?.name;
      const result = tools.run(name, call.function?.arguments);
      if (name === 'finish' && result.ok) finished = true;
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 24000),
      });
    }

    // Progress: the loop has no byte count to lean on, so pace it by steps.
    const pct = floor + Math.round((ceiling - floor) * (1 - Math.exp(-steps / 7)));
    store.mutate(projectId, p => { p.percent = Math.max(p.percent, pct); });
  }

  store.mutate(projectId, p => store.log(p, 'technical',
    `tool loop · ${steps} steps · ${tokensIn} tok in / ${tokensOut} tok out${finished ? '' : ' · ended without finish()'}`));

  if (steps >= MAX_TOOL_STEPS && !finished) {
    store.mutate(projectId, p => store.log(p, 'activity', 'took too many steps — stopping here'));
  }
  return true;
}

// A second opinion, aimed squarely at the failure mode the self-checks miss:
// code that installs cleanly and then does nothing.
async function askReviewer(config, projectId, { system, user, label, signal }) {
  const { content, usage } = await llm.chat(config, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { signal });

  store.mutate(projectId, p => store.log(p, 'technical',
    `${label} · ${usage ? `${usage.prompt_tokens || '?'} tok in / ${usage.completion_tokens || '?'} tok out` : 'no usage'}`));

  const parsed = llm.extractJson(content);
  return Array.isArray(parsed?.problems) ? parsed.problems.map(String).filter(Boolean) : [];
}

// Two passes with different lenses. "Does it work" and "can a webpage abuse
// it" are separate questions, and one prompt asked to do both does neither
// well. The security pass is seeded with a deterministic scan of the code, so
// the model starts from real candidates rather than an open-ended hunt.
async function reviewBuild(config, projectId, { stage, brief, signal }) {
  const files = store.readAllFilesIn(stage);
  const listing = Object.entries(files)
    .map(([name, body]) => `--- ${name} ---\n${body}`)
    .join('\n\n');

  if (listing.length > contextBudget(config, 0.5)) {
    store.mutate(projectId, p => store.log(p, 'technical', 'too large to review in one pass — skipping review'));
    return [];
  }

  const found = [];

  found.push(...await askReviewer(config, projectId, {
    system: REVIEW_SYSTEM,
    label: 'behaviour review',
    signal,
    user: `The plan:\n\n${brief}\n\nThe extension:\n\n${listing}`,
  }));

  const scan = permissions.analyse(stage);
  const briefing = permissions.asBriefing(scan);
  store.mutate(projectId, p => {
    const broad = scan.permissions.filter(x => x.risk === 'high');
    if (broad.length) store.log(p, 'technical', `scan · broad permissions: ${broad.map(x => x.name).join(', ')}`);
    for (const item of scan.exposures) store.log(p, 'technical', `scan · ${item.file}: ${item.says}`);
  });

  found.push(...await askReviewer(config, projectId, {
    system: SECURITY_REVIEW_SYSTEM,
    label: 'security review',
    signal,
    user: [
      `The plan:\n\n${brief}`,
      briefing ? `The automated scan flagged:\n\n${briefing}` : 'The automated scan flagged nothing — check anyway.',
      `The extension:\n\n${listing}`,
    ].join('\n\n'),
  }));

  return found;
}

async function runBuild(config, projectId) {
  const controller = new AbortController();
  running.set(projectId, controller);
  const { signal } = controller;
  const checkStopped = () => { if (signal.aborted) throw new BuildStopped(); };

  const start = store.getProject(projectId);
  // Revise whenever code already exists on disk — projects created before the
  // build counter existed still have files worth building on.
  const existing = store.listFiles(projectId).length > 0 ? store.readAllFiles(projectId) : null;
  // …unless the extension has outgrown the window, in which case sending it
  // would crowd out everything else. Build fresh from the spec instead.
  const room = contextBudget(config, 0.5);
  const tooBig = existing && JSON.stringify(existing).length > room;
  const revising = Boolean(existing) && !tooBig;
  const previous = revising ? existing : null;

  if (tooBig) {
    store.mutate(projectId, p => store.log(p, 'technical',
      'existing code is too large to revise in context — rebuilding from the plan'));
  }

  store.mutate(projectId, p => {
    p.status = 'building';
    p.percent = 4;
    p.error = null;
    store.log(p, 'activity', revising ? 'applying your changes' : 'build started');
  });

  const specText = (start.spec.length ? start.spec : [start.prompt]).map(s => `- ${s}`).join('\n');
  const brief = `Title: ${start.title || 'Untitled'}\n\nSpec:\n${specText}`;

  // The spec is a summary; the conversation is where the nuance of a change
  // lives ("smaller", "only on the homepage", "no, the other one"). Give the
  // revision stage both.
  const askedFor = revising
    ? asTranscript(recentTurns(start.history, contextBudget(config, CONTEXT_SHARE / 2)))
    : '';

  const messages = revising
    ? [
      { role: 'system', content: REVISE_SYSTEM },
      {
        role: 'user',
        content: [
          `Here is the current extension:\n\n${JSON.stringify({ files: previous }, null, 2)}`,
          askedFor && `Most recent conversation, where the change was requested:\n\n${askedFor}`,
          `Updated spec:\n\n${brief}`,
          'Return the complete updated file map.',
        ].filter(Boolean).join('\n\n'),
      },
    ]
    : [
      { role: 'system', content: BUILD_SYSTEM },
      { role: 'user', content: `Build this Firefox extension.\n\n${brief}` },
    ];

  store.mutate(projectId, p => store.log(p, 'technical',
    `${revising ? 'revise' : 'build'} context · ${Math.round(sizeOf(messages) / CHARS_PER_TOKEN)} tok`
    + (revising ? ` · ${Object.keys(previous).length} existing files` : '')));

  const live = store.buildDir(projectId);
  const stage = store.stageDir(projectId);
  let succeeded = false;
  let usedTools = false;

  try {
    // The tool loop edits files in place, so it starts from a copy of the
    // current build rather than an empty folder.
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    if (revising) {
      for (const [rel, body] of Object.entries(previous)) {
        const dest = path.join(stage, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
      }
    }

    if (config.toolMode !== 'oneshot') {
      const opening = revising
        ? `Change the existing extension to match this updated plan.\n\n${brief}`
          + (askedFor ? `\n\nWhat the user asked for, in their words:\n\n${askedFor}` : '')
          + '\n\nStart by listing the files, then read the ones you need to change. '
          + 'Leave files the request does not touch alone.'
        : `Build this Firefox extension.\n\n${brief}\n\nStart by writing manifest.json.`;

      const drove = await runToolLoop(config, projectId, { stage, opening, signal });
      if (drove) {
        usedTools = true;
        const problems = validate(stage);
        if (!problems.length) succeeded = true;
        else {
          store.mutate(projectId, p => {
            for (const problem of problems) store.log(p, 'technical', `check failed · ${problem}`);
          });
          if (config.toolMode === 'tools') {
            throw new Error(`The generated extension still had problems: ${problems[0]}`);
          }
        }
      } else if (config.toolMode === 'tools') {
        throw new Error('This endpoint does not support tool calling. Switch build mode to "single reply" in Settings.');
      }
      // Anything else falls through to the one-shot protocol below.
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !succeeded; attempt++) {
      checkStopped();
      store.mutate(projectId, p => {
        p.percent = attempt === 1 ? 10 : 20;
        store.log(p, 'technical', `llm ${revising ? 'revise' : 'build'} · attempt ${attempt}`);
      });

      const content = await generate(config, projectId, messages, signal, pct =>
        store.mutate(projectId, p => { p.percent = Math.max(p.percent, Math.round(pct)); }));
      checkStopped();

      const parsed = llm.extractJson(content);
      if (!parsed?.files || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) {
        store.mutate(projectId, p => store.log(p, 'technical', 'reply was not a usable {"files": {...}} object'));
        messages.push({ role: 'assistant', content: content.slice(0, 4000) });
        messages.push({ role: 'user', content: 'That was not valid JSON in the required shape. Reply again with ONLY the {"files": {...}} object.' });
        continue;
      }

      store.mutate(projectId, p => { p.percent = Math.max(p.percent, 70); store.log(p, 'activity', 'checking the code'); });
      const { written, skipped } = writeFiles(stage, parsed.files);
      store.mutate(projectId, p => {
        store.log(p, 'technical', `fs wrote ${written.length} files${skipped.length ? ` · skipped ${skipped.length} unsafe/oversized` : ''}`);
      });

      checkStopped();
      const problems = validate(stage);
      if (problems.length === 0) {
        succeeded = true;
        break;
      }

      store.mutate(projectId, p => {
        for (const problem of problems) store.log(p, 'technical', `check failed · ${problem}`);
        store.log(p, 'activity', attempt < MAX_ATTEMPTS
          ? `found ${problems.length} problem${problems.length === 1 ? '' : 's'} — fixing`
          : `found ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
      });

      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`The generated extension still had problems after ${MAX_ATTEMPTS} attempts: ${problems[0]}`);
      }

      messages.push({ role: 'assistant', content: content.slice(0, 8000) });
      messages.push({
        role: 'user',
        content: `The extension you produced has these problems:\n${problems.map(p => `- ${p}`).join('\n')}\n\nFix them and reply again with ONLY the complete {"files": {...}} object.`,
      });
    }

    // Ground truth, when the machine has it. Everything above this line is
    // either the model's own opinion of its code or our own parsing of it;
    // web-ext lint is Mozilla's, and it is the same check AMO runs. It knows
    // which APIs exist in Firefox and which manifest keys are real, which is
    // exactly the class of mistake that installs cleanly and then does nothing.
    checkStopped();
    store.mutate(projectId, p => { p.percent = Math.max(p.percent, 66); });
    const report = await lint(stage);

    if (!report.available) {
      // Not an error. It is an optional tool and the build stands without it.
      store.mutate(projectId, p => store.log(p, 'technical', `web-ext lint skipped \u00b7 ${report.reason}`));
    } else {
      store.mutate(projectId, p => {
        store.log(p, 'technical',
          `web-ext lint \u00b7 ${report.counts.errors} errors \u00b7 ${report.counts.warnings} warnings \u00b7 ${report.counts.notices} notices`);
        for (const found of report.findings) store.log(p, 'technical', `lint \u00b7 ${found.where} \u00b7 ${found.says}`);
      });

      if (!report.ok && usedTools) {
        store.mutate(projectId, p => store.log(p, 'activity',
          `Firefox rejected ${report.counts.errors} thing${report.counts.errors === 1 ? '' : 's'} \u2014 fixing`));

        const beforeLintFix = store.readAllFilesIn(stage);
        let fixed = false;
        try {
          await runToolLoop(config, projectId, {
            stage,
            floor: 66,
            ceiling: 70,
            signal,
            opening: [
              lintBriefing(report),
              '',
              'Read the affected files and fix these with edit_file. Change nothing else.',
              'Then call check, and finish.',
            ].join('\n'),
          });
          fixed = validate(stage).length === 0;
        } catch (err) {
          if (err instanceof BuildStopped || err.name === 'AbortError') throw err;
          store.mutate(projectId, p => store.log(p, 'technical', `lint fix round failed \u00b7 ${err.message}`));
        }

        if (!fixed) {
          restoreFiles(stage, beforeLintFix);
          store.mutate(projectId, p => {
            store.log(p, 'technical', 'lint fixes reverted \u2014 they broke the self-checks');
            store.log(p, 'activity', 'couldn\u2019t apply those fixes \u2014 keeping the working version');
          });
        } else {
          const after = await lint(stage);
          store.mutate(projectId, p => store.log(p, 'technical',
            `web-ext lint (after fixes) \u00b7 ${after.available ? `${after.counts.errors} errors` : after.reason}`));
        }
      } else if (!report.ok) {
        // One-shot mode has no tool loop to send the findings back through.
        store.mutate(projectId, p => store.log(p, 'activity',
          'Firefox flagged some problems \u2014 they are listed under the technical details'));
      }
    }

    // The self-checks prove the code parses and its references resolve. They
    // cannot tell whether Firefox will let it run. That is what this is for.
    if (usedTools) {
      for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
        checkStopped();
        store.mutate(projectId, p => {
          p.percent = Math.max(p.percent, 68 + round * 4);
          store.log(p, 'activity', 'reading it back over');
        });

        // Best-effort by nature. The extension already passed its checks; a
        // failed second opinion must never throw that away.
        let problems;
        try {
          problems = await reviewBuild(config, projectId, { stage, brief, signal });
        } catch (err) {
          if (err instanceof BuildStopped || err.name === 'AbortError') throw err;
          store.mutate(projectId, p => {
            store.log(p, 'technical', `review round ${round} failed · ${err.message}`);
            store.log(p, 'activity', 'couldn’t double-check it — packaging what was built');
          });
          break;
        }

        if (!problems.length) {
          store.mutate(projectId, p => store.log(p, 'technical', `review round ${round} · nothing found`));
          break;
        }

        store.mutate(projectId, p => {
          for (const problem of problems) store.log(p, 'technical', `review · ${problem}`);
          store.log(p, 'activity',
            `found ${problems.length} thing${problems.length === 1 ? '' : 's'} that wouldn’t work — fixing`);
        });

        checkStopped();
        // Keep a copy of the working version. Repairs are speculative — if
        // they fail or break the checks, we keep what we had rather than
        // losing a build that was already sound.
        const beforeFix = store.readAllFilesIn(stage);
        let repaired = false;
        try {
          await runToolLoop(config, projectId, {
            stage,
            floor: 72,
            ceiling: 84,
            signal,
            opening: [
              'A review of the extension you just built found these problems:',
              problems.map(p => `- ${p}`).join('\n'),
              '',
              'Read the affected files and fix them with edit_file. Do not rewrite anything unrelated.',
              'Then call check, and finish.',
            ].join('\n'),
          });
          repaired = validate(stage).length === 0;
        } catch (err) {
          if (err instanceof BuildStopped || err.name === 'AbortError') throw err;
          store.mutate(projectId, p => store.log(p, 'technical', `fix round failed · ${err.message}`));
        }

        if (!repaired) {
          restoreFiles(stage, beforeFix);
          store.mutate(projectId, p => {
            store.log(p, 'technical', 'fixes reverted — the pre-review version was sound');
            store.log(p, 'activity', 'couldn’t apply the fixes — keeping the working version');
          });
          break;
        }
      }
    }

    checkStopped();
    store.mutate(projectId, p => { p.percent = 88; store.log(p, 'activity', 'packaging'); });

    // Package from staging, then swap both the folder and the .xpi into place.
    // Until this point the previous working build is still intact.
    const xpi = store.xpiPath(projectId);
    const pending = `${xpi}.pending`;
    fs.rmSync(pending, { force: true });
    const count = zipDir(stage, pending);
    const size = fs.statSync(pending).size;
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));

    fs.rmSync(live, { recursive: true, force: true });
    fs.renameSync(stage, live);
    fs.rmSync(xpi, { force: true });
    fs.renameSync(pending, xpi);

    store.mutate(projectId, p => {
      p.title = p.title || manifest.name;
      p.status = 'ready';
      p.percent = 100;
      p.builds += 1;
      p.error = null;
      // Remember what this .xpi was built from, so later spec changes can be
      // reported as "the download is now behind your plan".
      p.builtSpec = [...p.spec];
      p.builtAt = new Date().toISOString();
      store.log(p, 'technical', `packaged ${count} files · ${(size / 1024).toFixed(1)} KB`);
      store.log(p, 'activity', 'packaged — ready to install');
    });
  } catch (err) {
    const intact = fs.existsSync(store.xpiPath(projectId));

    if (err instanceof BuildStopped || err.name === 'AbortError') {
      store.mutate(projectId, p => {
        p.status = intact ? 'ready' : 'draft';
        p.percent = intact ? 100 : 0;
        store.log(p, 'activity', intact
          ? 'build stopped — the previous version is untouched'
          : 'build stopped — nothing was kept');
      });
      return;
    }

    store.mutate(projectId, p => {
      p.status = 'error';
      p.error = err.message;
      store.log(p, 'activity', `something went wrong — ${err.message}`);
      if (intact) store.log(p, 'activity', 'the previous version is still available to download');
      store.log(p, 'technical', `error · ${err.stack || err.message}`);
    });
  } finally {
    // Staging is scratch space either way — a promoted build has already
    // renamed it away, and anything left behind belongs to a failed attempt.
    fs.rmSync(stage, { recursive: true, force: true });
    fs.rmSync(`${store.xpiPath(projectId)}.pending`, { force: true });
    running.delete(projectId);
  }
}

function startBuild(config, projectId) {
  if (running.has(projectId)) return false;
  runBuild(config, projectId).catch(err => {
    store.mutate(projectId, p => {
      p.status = 'error';
      p.error = err.message;
      store.log(p, 'technical', `error · ${err.stack || err.message}`);
    });
  });
  return true;
}

// A build can't survive a restart, so anything left "building" is stale.
function recoverInterrupted() {
  for (const project of store.listProjects()) {
    fs.rmSync(store.stageDir(project.id), { recursive: true, force: true });
    fs.rmSync(`${store.xpiPath(project.id)}.pending`, { force: true });
    if (project.status !== 'building') continue;

    const intact = fs.existsSync(store.xpiPath(project.id));
    store.mutate(project.id, p => {
      p.status = intact ? 'ready' : 'draft';
      p.percent = intact ? 100 : 0;
      store.log(p, 'activity', 'build was interrupted when the server restarted');
    });
  }
}

module.exports = {
  clarify, startBuild, stopBuild, isBuilding, recoverInterrupted, validate,
  trimHistory, recentTurns, contextBudget,   // exported for tests
  prompts: { CLARIFY_SYSTEM, AGENT_SYSTEM, BUILD_SYSTEM, REVISE_SYSTEM, REVIEW_SYSTEM,
    SECURITY_REVIEW_SYSTEM, FIREFOX_RULES, CRAFT, TRUST_RULES },
};
