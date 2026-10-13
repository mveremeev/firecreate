'use strict';

// Minimal client for any OpenAI-compatible /chat/completions endpoint.

function endpoint(config, suffix) {
  const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  return `${base}${suffix}`;
}

function authHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
  if (config.provider === 'openrouter') {
    // OpenRouter attributes requests by these; harmless everywhere else.
    headers['HTTP-Referer'] = 'http://localhost/make';
    headers['X-Title'] = 'make.';
  }
  return headers;
}

const asList = value => String(value || '')
  .split(',')
  .map(part => part.trim())
  .filter(Boolean);

// One place that decides what actually goes on the wire, so sampling and
// routing can't drift between the chat, build and review call sites.
function requestBody(config, messages, extra = {}) {
  const body = {
    model: config.model || 'gpt-4o-mini',
    messages,
    temperature: config.temperature ?? 0.2,
    ...extra,
  };

  // Left unset, a provider's default cap can truncate a long file map — and a
  // truncated JSON answer is worse than a refused one, because it can still
  // parse into a partial result.
  if (config.maxTokens > 0) body.max_tokens = config.maxTokens;

  if (config.provider === 'openrouter') {
    // 'off' is a different shape from an effort level: it asks the provider to
    // stop reasoning entirely rather than to reason a little.
    if (config.reasoningEffort === 'off') body.reasoning = { enabled: false };
    else if (config.reasoningEffort) body.reasoning = { effort: config.reasoningEffort };

    const routing = {};
    if (config.sort) routing.sort = config.sort;
    const quantizations = asList(config.quantizations);
    if (quantizations.length) routing.quantizations = quantizations;
    // Without this, a routing filter that matches nothing hard-fails the call.
    if (Object.keys(routing).length) body.provider = { ...routing, allow_fallbacks: true };
  }

  return body;
}

// A dead endpoint makes fetch throw a bare TypeError ("fetch failed"), which
// is meaningless to the person reading it. Say what to do instead.
async function reach(send) {
  try {
    return await send();
  } catch (err) {
    if (err instanceof TypeError) {
      throw new Error(
        'Can\u2019t reach the model provider \u2014 check the base URL in Settings and that it\u2019s running.');
    }
    throw err;   // AbortError and friends pass through untouched
  }
}

function requestFailed(status, body) {
  const text = String(body || '').slice(0, 300).trim();
  if (status === 401 || status === 403) return new Error('The API key was rejected. Check it in Settings.');
  // A routing filter that matches no provider fails here, and the raw message
  // doesn't say so — this is the most likely cause when the model exists.
  if (/no (allowed |eligible )?provider|no endpoints found/i.test(text)) {
    return new Error('No provider matched your routing filters — loosen the quantization or sort settings.');
  }
  if (/reasoning|effort/i.test(text) && /invalid|unsupported|not supported|must be one of/i.test(text)) {
    return new Error(`This model doesn't accept that reasoning level. Try a lower one in Settings. (${text})`);
  }
  if (status === 404) return new Error(`Endpoint or model not found (404). ${text}`);
  if (status === 429) return new Error('Rate limited by the provider — wait a moment and try again.');
  return new Error(`The model provider returned ${status}. ${text}`);
}

// Non-streaming request. Also the tool-loop workhorse: when `tools` is passed
// the reply may be tool calls instead of prose, so content can legitimately be
// empty and the caller inspects `toolCalls`.
async function chat(config, messages, { signal, tools, toolChoice } = {}) {
  const started = Date.now();
  const extra = {};
  if (tools) {
    extra.tools = tools;
    extra.tool_choice = toolChoice || 'auto';
  }

  const res = await reach(() => fetch(endpoint(config, '/chat/completions'), {
    method: 'POST',
    headers: authHeaders(config),
    signal,
    body: JSON.stringify(requestBody(config, messages, extra)),
  }));

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const error = requestFailed(res.status, body);
    // Let the caller decide whether to retry without tools.
    error.rejectedTools = Boolean(tools) && /tool|function.?call/i.test(body);
    throw error;
  }

  const data = await res.json();
  const message = data?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const content = typeof message.content === 'string' ? message.content : '';

  if (!content && !toolCalls.length) {
    const reason = data?.choices?.[0]?.finish_reason;
    // Reasoning tokens count against the completion budget, so a high effort
    // setting can consume the whole allowance and leave nothing to say.
    if (reason === 'length') {
      throw new Error('The reply hit the token limit before it said anything — raise the reply limit in Settings, or lower the reasoning effort.');
    }
    throw new Error(`The model returned an empty response${reason ? ` (finished: ${reason})` : ''}.`);
  }

  return {
    content,
    toolCalls,
    message,
    finishReason: data?.choices?.[0]?.finish_reason || null,
    ms: Date.now() - started,
    usage: data.usage || null,
  };
}

// Streaming variant: requests SSE and forwards deltas as they arrive.
// Falls back to a unary response when the endpoint doesn't stream.
async function chatStream(config, messages, { onThinking, onContent, signal } = {}) {
  const started = Date.now();
  const res = await reach(() => fetch(endpoint(config, '/chat/completions'), {
    method: 'POST',
    headers: authHeaders(config),
    signal,
    body: JSON.stringify(requestBody(config, messages, { stream: true })),
  }));

  if (!res.ok) throw requestFailed(res.status, await res.text().catch(() => ''));

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    if (content && onContent) onContent(content);
    return { content, ms: Date.now() - started, usage: data.usage || null };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let usage = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const event = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }

          if (chunk.usage) usage = chunk.usage;
          const delta = chunk?.choices?.[0]?.delta || {};
          const thinking = delta.reasoning_content || delta.reasoning;
          if (thinking && onThinking) onThinking(thinking);
          if (delta.content) {
            content += delta.content;
            if (onContent) onContent(delta.content);
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  if (!content.trim()) throw new Error('The model returned an empty response.');
  return { content, ms: Date.now() - started, usage };
}

// Ask the provider what models it serves. Not every server implements this.
async function listModels(config, { signal } = {}) {
  const res = await reach(() => fetch(endpoint(config, '/models'), { headers: authHeaders(config), signal }));
  if (!res.ok) throw requestFailed(res.status, await res.text().catch(() => ''));
  const data = await res.json();
  const rows = Array.isArray(data) ? data : (data.data || data.models || []);
  return rows
    .map(m => (typeof m === 'string' ? m : m.id || m.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

// Pull the first complete top-level JSON object out of a model response,
// tracking string state so braces inside strings don't end the scan early.
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }

  // Unbalanced (truncated output) — fall back to the last closing brace.
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// Incrementally pulls the value of a string key out of a streaming JSON object,
// decoding escapes as it goes, so the UI can stream just the human text.
function makeReplyExtractor(onDelta, key = 'reply') {
  const opener = new RegExp(`"${key}"\\s*:\\s*"`);
  let buf = '';
  let pos = 0;
  let started = false;
  let finished = false;
  let escaped = false;
  let text = '';

  return {
    push(chunk) {
      if (finished) return;
      buf += chunk;
      if (!started) {
        const match = buf.match(opener);
        if (!match) return;
        started = true;
        pos = match.index + match[0].length;
      }

      let out = '';
      while (pos < buf.length && !finished) {
        const ch = buf[pos];
        if (escaped) {
          if (ch === 'n') { out += '\n'; pos++; }
          else if (ch === 't') { out += '\t'; pos++; }
          else if (ch === 'r') { pos++; }
          else if (ch === 'u') {
            if (pos + 4 < buf.length) {
              out += String.fromCharCode(parseInt(buf.substr(pos + 1, 4), 16));
              pos += 5;
            } else {
              // Incomplete \uXXXX — rewind onto the backslash and wait for more.
              pos--;
              escaped = false;
              break;
            }
          } else { out += ch; pos++; }
          escaped = false;
        } else if (ch === '\\') { escaped = true; pos++; }
        else if (ch === '"') { finished = true; }
        else { out += ch; pos++; }
      }

      if (out) { text += out; onDelta(out); }
    },
    get finished() { return finished; },
    get text() { return text; },
  };
}

module.exports = { chat, chatStream, listModels, extractJson, makeReplyExtractor };
