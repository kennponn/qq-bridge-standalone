import { setTimeout as sleep } from 'node:timers/promises';

const SEND_TOOLS = new Set(['qq_send_message', 'qq_reply', 'qq_send_sticker', 'qq_send_poke', 'qq_send_voice', 'qq_speak_text']);
const CLOSE_TOOLS = new Set(['qq_mark_read', 'qq_set_wake_config']);

function bounded(value, fallback, min, max) {
  return Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
}

function stableArguments(value) {
  if (Array.isArray(value)) return value.map(stableArguments);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableArguments(value[key])]));
  return value;
}

export function normalizeDirectUsage(usage = {}) {
  const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const input = nonnegative(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens);
  const cacheHit = Math.min(input, nonnegative(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens));
  return {
    cacheMiss: Math.max(0, input - cacheHit), cacheHit, cacheWrite: 0,
    output: nonnegative(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens),
    reasoning: nonnegative(usage.completion_tokens_details?.reasoning_tokens)
  };
}

function combinedSignal(signals) {
  const controller = new AbortController();
  const listeners = [];
  for (const signal of signals.filter(Boolean)) {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else { signal.addEventListener('abort', abort, { once: true }); listeners.push([signal, abort]); }
  }
  return { signal: controller.signal, dispose: () => listeners.forEach(([signal, listener]) => signal.removeEventListener('abort', listener)) };
}

async function limitedJson(response, maxBytes = 4 * 1024 * 1024) {
  if (response.body) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('DIRECT_RESPONSE: model response exceeds size limit');
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { await reader.cancel().catch(() => {}); }
  }
  return response.json();
}

function resultContent(result, vision) {
  const images = [];
  const text = [];
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (part.type === 'text') text.push(String(part.text ?? ''));
      if (part.type === 'image' && vision && /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType || '') && typeof part.data === 'string') {
        images.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
      } else if (part.type === 'image') text.push('[Image unavailable: vision is disabled or MIME type is unsupported.]');
    }
  } else text.push(JSON.stringify(result ?? {}));
  return { text: text.join('\n').slice(0, 100000), images };
}

function initialContent(promptText, content, vision) {
  if (!Array.isArray(content)) return String(promptText ?? '');
  const parts = [];
  for (const part of content) {
    if (part.type === 'text') parts.push({ type: 'text', text: String(part.text ?? '') });
    if (part.type === 'image' && vision && /^image\/(png|jpeg|webp|gif)$/.test(part.mediaType || part.mimeType || '') && typeof part.data === 'string') {
      parts.push({ type: 'image_url', image_url: { url: `data:${part.mediaType || part.mimeType};base64,${part.data}` } });
    }
  }
  return parts.length ? parts : String(promptText ?? '');
}

export async function runDirectTurn({
  promptText, content, systemPrompt, model, apiKey, baseURL,
  tools = [], executeTool, silent = false, hasSnapshot = false, assertCurrent = () => {},
  onContextSent = () => {}, onUsage = () => {}, onTiming = () => {}, log = () => {}, signal,
  requestTimeoutMs = 90000, turnTimeoutMs = 900000, maxRounds = 16, maxRetries = 2,
  vision = true, fetchImpl = fetch, sleepImpl = sleep
}) {
  if (!model || !apiKey || !baseURL || typeof executeTool !== 'function') throw new Error('DIRECT_CONFIG: incomplete engine configuration');
  const turnController = new AbortController();
  const timer = setTimeout(() => turnController.abort(new Error('DIRECT_TIMEOUT: turn deadline exceeded')), turnTimeoutMs);
  timer.unref?.();
  const turnSignal = combinedSignal([signal, turnController.signal]);
  const available = tools.filter((tool) => !silent || !SEND_TOOLS.has(tool.function?.name));
  const names = new Set(available.map((tool) => tool.function?.name));
  const messages = [
    { role: 'system', content: `${systemPrompt || ''}\nSession key and token are supplied by the host, not by you. Text output is private and is NEVER forwarded to QQ. ${silent ? 'This is a silent background turn: never send QQ messages.' : 'Use the advertised tools to send, observe and close the turn. Do not guess tool names.'}` },
    { role: 'user', content: initialContent(promptText, content, vision) }
  ];
  const sentCalls = new Map();
  let sent = 0;
  let closed = false;
  let contextNoted = false;
  let privateTextReminded = false;
  const timing = event => { try { onTiming(event); } catch { log('timing recording failed'); } };
  const check = () => { turnSignal.signal.throwIfAborted(); assertCurrent(); };
  const callTool = async (name, args) => {
    check();
    if (!names.has(name)) throw new Error(`DIRECT_TOOL: unavailable tool ${String(name).slice(0, 80)}`);
    const started = performance.now();
    let ok = false;
    try {
      const result = await executeTool(name, args, { signal: turnSignal.signal });
      check();
      ok = !result?.isError && result?.ok !== false;
      if (!ok) return { ...result, isError: true };
      return result;
    } finally { timing({ phase: 'tool', toolName: name, durationMs: performance.now() - started, ok }); }
  };
  try {
    // Cursor authorization must accompany the actual message data, not a numeric hint.
    if (!silent && !hasSnapshot && names.has('qq_get_unread_messages')) {
      const unread = await callTool('qq_get_unread_messages', { afterSeq: 0, limit: 30 });
      if (unread?.isError) throw new Error('DIRECT_CONTEXT: failed to read unread messages');
      messages.push({ role: 'user', content: `Unread messages:\n${resultContent(unread, false).text}` });
    }
    for (let round = 0; round < maxRounds; round++) {
      check();
      let data;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        check();
        const requestController = new AbortController();
        const requestTimer = setTimeout(() => requestController.abort(new Error('DIRECT_TIMEOUT: model request timed out')), requestTimeoutMs);
        const requestSignal = combinedSignal([turnSignal.signal, requestController.signal]);
        let retry = false;
        let retryDelay = 500 * (2 ** attempt);
        const requestStarted = performance.now();
        let requestBytes = 0;
        let status = null;
        try {
          const body = { model, messages, ...(available.length ? { tools: available, tool_choice: 'auto' } : {}) };
          log(`round=${round + 1} attempt=${attempt + 1} model=${model}`);
          const encoded = JSON.stringify(body);
          requestBytes = Buffer.byteLength(encoded);
          if (requestBytes > 32 * 1024 * 1024) throw new Error('DIRECT_CONTEXT: request exceeds size limit');
          const response = await fetchImpl(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: encoded, signal: requestSignal.signal, redirect: 'error'
          });
          status = response.status;
          if (!response.ok) {
            retry = [429, 500, 502, 503, 504].includes(response.status);
            const retryAfter = Number(response.headers?.get('retry-after'));
            if (retryAfter > 0) retryDelay = Math.min(5000, retryAfter * 1000);
            await response.body?.cancel().catch(() => {});
            const error = new Error(`DIRECT_API: HTTP ${response.status}`);
            error.retryable = retry;
            throw error;
          }
          data = await limitedJson(response);
          check();
          if (!contextNoted) { onContextSent(); contextNoted = true; }
          if (data.usage) {
            try { onUsage({ round, attempt, model: data.model || model, usage: normalizeDirectUsage(data.usage) }); }
            catch { log('usage recording failed'); }
          }
          break;
        } catch (error) {
          if (turnSignal.signal.aborted) throw turnSignal.signal.reason;
          retry = error.retryable === true || error.name === 'TypeError' || requestController.signal.aborted;
          if (!retry || attempt === maxRetries) throw error;
          log(`model request retry: round=${round + 1} attempt=${attempt + 1}`);
        } finally {
          clearTimeout(requestTimer); requestSignal.dispose();
          timing({ phase: 'model', round: round + 1, attempt: attempt + 1, status,
            durationMs: performance.now() - requestStarted, requestBytes });
        }
        await sleepImpl(retryDelay, undefined, { signal: turnSignal.signal });
      }
      const choice = data?.choices?.[0];
      const msg = choice?.message;
      if (!msg || msg.role !== 'assistant' || (msg.content != null && typeof msg.content !== 'string')) {
        throw new Error('DIRECT_RESPONSE: malformed assistant message');
      }
      if (choice.finish_reason === 'length' || choice.finish_reason === 'content_filter') {
        throw new Error(`DIRECT_RESPONSE: incomplete response (${choice.finish_reason})`);
      }
      const calls = msg.tool_calls;
      if (calls != null && !Array.isArray(calls)) throw new Error('DIRECT_RESPONSE: tool_calls must be an array');
      if (calls?.length) {
        if (calls.length > 24) throw new Error('DIRECT_RESPONSE: too many tool calls');
        const ids = new Set();
        for (const call of calls) {
          if (!call?.id || typeof call.id !== 'string' || ids.has(call.id) || call.type !== 'function' || typeof call.function?.name !== 'string') {
            throw new Error('DIRECT_RESPONSE: malformed or duplicate tool call');
          }
          ids.add(call.id);
        }
        messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls, ...(typeof msg.reasoning_content === 'string' ? { reasoning_content: msg.reasoning_content } : {}) });
        const images = [];
        let precedingSendFailed = false;
        for (const [callIndex, call] of calls.entries()) {
          const name = call.function.name;
          let result;
          let fingerprint;
          try {
            const args = JSON.parse(call.function.arguments || '{}');
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object');
            if (CLOSE_TOOLS.has(name) && !Number.isSafeInteger(args.throughSeq)) throw new Error('Closing tools require an explicit throughSeq from displayed messages');
            if (CLOSE_TOOLS.has(name) && calls.slice(callIndex + 1).some((later) => SEND_TOOLS.has(later.function.name))) {
              throw new Error('Send tools must run before closing tools in the same response. Review the sending result before acknowledging messages.');
            }
            if (CLOSE_TOOLS.has(name) && precedingSendFailed) throw new Error('An earlier send failed in this response. Review its result before acknowledging messages.');
            // A repeated send in one turn must not duplicate a real QQ side effect.
            fingerprint = `${name}:${JSON.stringify(stableArguments(args))}`;
            if (SEND_TOOLS.has(name) && sentCalls.has(fingerprint)) result = sentCalls.get(fingerprint);
            else {
              result = await callTool(name, args);
              if (SEND_TOOLS.has(name)) {
                sentCalls.set(fingerprint, result);
                if (!result?.isError) { sent += 1; closed = false; }
              }
            }
            if (CLOSE_TOOLS.has(name) && !result?.isError) closed = true;
          } catch (error) {
            check();
            result = { isError: true, content: [{ type: 'text', text: String(error.message || 'Tool failed').slice(0, 1000) }] };
            if (fingerprint && SEND_TOOLS.has(name)) sentCalls.set(fingerprint, result);
          }
          if (SEND_TOOLS.has(name) && result?.isError) precedingSendFailed = true;
          const rendered = resultContent(result, vision);
          messages.push({ role: 'tool', tool_call_id: call.id, content: `${result?.isError ? 'ERROR: ' : ''}${rendered.text}` });
          images.push(...rendered.images);
          log(`tool=${name} ok=${!result?.isError}`);
        }
        if (images.length) messages.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the preceding tools:' }, ...images] });
        if (closed) return { ok: true, sent, closed: true, rounds: round + 1 };
        continue;
      }
      // Never auto-forward assistant commentary, including silent turns and [SILENT].
      if (silent) return { ok: true, sent: 0, closed, rounds: round + 1 };
      if (!privateTextReminded) {
        privateTextReminded = true;
        messages.push({ role: 'assistant', content: msg.content ?? '' });
        messages.push({ role: 'user', content: 'Your text was not sent to QQ. Use a sending tool if a reply is needed, then close with qq_mark_read or qq_set_wake_config using a displayed throughSeq. Follow your current session reply/observation policy: do not add unnecessary waits. If the policy allows and the answer is complete, send then close in the same tool-call response.' });
        continue;
      }
      throw new Error('DIRECT_UNCLOSED: model ended without closing the turn');
    }
    throw new Error('DIRECT_ROUND_LIMIT: tool loop exhausted');
  } catch (error) {
    if (!error || typeof error !== 'object') error = new Error(String(error));
    error.sentCount = sent;
    error.closed = closed;
    throw error;
  } finally { clearTimeout(timer); turnSignal.dispose(); }
}
