// Real bridge functions and HTTP handlers with temporary state and fake speech/QQ peers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { resolveVoiceSettings, validateSpeechText } from '../src/voice-speech.js';

const ADMIN = { 'x-console-token': 'fixture-console-token' };
const voice = { enabled: true, maxPerMinute: 2, maxPerHour: 10, tts: { enabled: true, onlineConsent: true, voice: 'zh-CN-XiaoxiaoNeural', rate: 0 }, incoming: { enabled: true } };
const clone = value => JSON.parse(JSON.stringify(value));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture({ config = {}, roleMode = 'active', hook, fetchImpl, duration = 2 } = {}) {
  const calls = { synth: [], health: 0, invalidations: 0, get: [], sends: [] };
  const entries = new Map();
  let gate = hook;
  const h = await bridgeHarness({ config: { engine: { backend: 'standalone' }, ...config, socialV2: { enabled: true, tools: { sendVoice: true }, voice: clone(voice), ...config.socialV2 } },
    files: { 'state/current-role.json': { role: null, mode: roleMode } },
    globals: {
      inspectAudio: async file => ({ ok: true, size: fs.statSync(file).size, duration: 2, codec: 'mp3', warnings: [] }),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      createSpeechService({ root, getConfig, auditText }) {
        const get = id => { calls.get.push(id); const entry = entries.get(id); if (!entry) throw Object.assign(new Error('fixture preview absent'), { statusCode: 404 }); return entry; };
        return {
          async health() { calls.health++; const current = resolveVoiceSettings(getConfig()); return { ttsInstalled: true, ttsReady: current.tts.enabled && current.tts.onlineConsent, reason: 'fixture health checks availability only' }; },
          async synthesize(text, options = {}) {
            const current = resolveVoiceSettings(getConfig());
            if (!current.tts.enabled || !current.tts.onlineConsent) throw Object.assign(new Error('fixture consent required'), { statusCode: 403 });
            const safe = validateSpeechText(text, current.tts.maxChars);
            auditText(safe); options.assertAllowed?.();
            calls.synth.push({ text: safe, voice: options.voice, rate: options.rate, signal: options.signal });
            if (gate) await gate(options);
            options.assertAllowed?.();
            if (options.signal?.aborted) throw Object.assign(new Error('fixture cancelled'), { statusCode: 409 });
            if (!resolveVoiceSettings(getConfig()).tts.onlineConsent) throw Object.assign(new Error('fixture consent revoked'), { statusCode: 409 });
            const id = crypto.randomUUID();
            const file = path.join(root, 'state', id + '.mp3'); fs.writeFileSync(file, 'ID3fixture-only-audio');
            const entry = { id, file, text: safe, chars: Array.from(safe).length, expiresAt: Date.now() + 600000, duration, used: false, busy: false };
            entries.set(id, entry); return entry;
          },
          get,
          async use(id, send) {
            const entry = get(id);
            if (entry.used || entry.busy) throw Object.assign(new Error('fixture preview already used'), { statusCode: 409 });
            entry.busy = true;
            try { const result = await send(entry); calls.sends.push(entry.id); entry.used = true; return result; }
            finally { entry.busy = false; }
          },
          invalidate() { calls.invalidations++; entries.clear(); },
          discard(id) { const entry = entries.get(id); if (!entry || entry.busy) return false; fs.unlinkSync(entry.file); entries.delete(id); return true; }
        };
      }
    }
  });
  h.setMode('reserved2');
  return { h, calls, entries, hook(value) { gate = value; }, async close() { await h.close(); } };
}
function call(port, pathname, { method = 'GET', headers = ADMIN, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('fixture request timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function withServer(f, run) {
  const server = f.h.startConsoleServer(); if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try { await run(server.address().port); } finally { await new Promise(resolve => server.close(resolve)); }
}
function agentHeaders(h, key = 'group:456') { return { ...ADMIN, 'x-agent-call': '1', 'x-agent-token': h.getSocialV2State(key).agentToken }; }
function recordRequests(h) { return h.calls.http.filter(request => /send_(private|group)_msg$/.test(request.url) && request.body?.message?.some(segment => segment.type === 'record')); }
function textRequests(h) { return h.calls.http.filter(request => /send_(private|group)_msg$/.test(request.url) && request.body?.message?.some(segment => segment.type === 'text')); }

test('narrow settings preserve model/persona/other config and enable voice/tool without generation', async () => {
  const f = await fixture({ config: { engine: { backend: 'standalone', directLLM: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', apiKeyEnv: 'QQ_DIRECT_API_KEY' } }, extraFixture: { preserve: 1 }, socialV2: { voice: { enabled: false, tts: { enabled: false, onlineConsent: false } }, tools: { sendVoice: false, memory: true } } } });
  try {
    const cfgFile = path.join(f.h.temp, 'config.json'); const before = JSON.parse(fs.readFileSync(cfgFile)); const role = fs.readFileSync(path.join(f.h.temp, 'state/current-role.json'));
    await withServer(f, async port => {
      const result = await call(port, '/api/voice/settings', { method: 'POST', body: { incoming: { enabled: true }, tts: { enabled: true, onlineConsent: true, voice: 'zh-CN-XiaoyiNeural', rate: 10 } } });
      assert.equal(result.status, 200); assert.equal(result.json.config.enabled, true); assert.equal(result.json.status.ttsReady, true);
      const after = JSON.parse(fs.readFileSync(cfgFile));
      assert.deepEqual(after.engine, before.engine); assert.deepEqual(after.extraFixture, before.extraFixture); assert.ok(role.equals(fs.readFileSync(path.join(f.h.temp, 'state/current-role.json'))));
      assert.equal(after.socialV2.tools.sendVoice, true); assert.equal(after.socialV2.tools.memory, true); assert.equal(f.calls.synth.length, 0); assert.equal(recordRequests(f.h).length, 0);
      assert.equal(f.calls.invalidations, 1); assert.equal(f.calls.health, 1);
      assert.ok(result.json.voices.every(item => item.gender === 'female'));
    });
  } finally { await f.close(); }
});

test('stale full v2 config cannot grant/revoke online consent or tts settings', async () => {
  const f = await fixture();
  try { await withServer(f, async port => {
    const before = clone(f.h.cfg.socialV2.voice);
    const result = await call(port, '/api/socialV2/config', { method: 'POST', body: { voice: { enabled: false, tts: { enabled: false, onlineConsent: false } }, context: { contextWindow: 30 } } });
    assert.equal(result.status, 200); assert.deepEqual(clone(f.h.cfg.socialV2.voice), before); assert.equal(f.h.cfg.socialV2.context.contextWindow, 30); assert.equal(f.calls.synth.length, 0);
  }); } finally { await f.close(); }
});

test('malformed mixed settings reject atomically before file or runtime changes', async () => {
  const f = await fixture();
  try { await withServer(f, async port => {
    const file = path.join(f.h.temp, 'config.json'); const before = fs.readFileSync(file); const cfgBefore = clone(f.h.cfg.socialV2.voice);
    for (const body of [{ tts: { enabled: 'true', onlineConsent: true } }, { incoming: { enabled: false }, tts: { onlineConsent: 1 } }, { tts: { voice: 'arbitrary' } }, { tts: { rate: 51 } }, { tts: { rate: 0.1 } }, { tts: { provider: 'other' } }, { unknown: true }, { incoming: null }, { tts: [] }, ...[-1, 101, 0.5, '20', null, true].map(value => ({ enabled: true, tts: { randomReplyProbability: value } }))]) {
      const result = await call(port, '/api/voice/settings', { method: 'POST', body });
      assert.equal(result.status, 400, JSON.stringify(body)); assert.ok(before.equals(fs.readFileSync(file))); assert.deepEqual(clone(f.h.cfg.socialV2.voice), cfgBefore);
    }
    assert.equal(f.calls.invalidations, 0); assert.equal(f.calls.synth.length, 0);
  }); } finally { await f.close(); }
});

test('AI voice permission and probability save independently without disabling operator TTS', async () => {
  const f = await fixture();
  try { await withServer(f, async port => {
    const disabled = await call(port, '/api/voice/settings', { method: 'POST', body: { enabled: false, tts: { enabled: true, onlineConsent: true, randomReplyProbability: 20 } } });
    assert.equal(disabled.status, 200); assert.equal(disabled.json.aiSendEnabled, false);
    assert.equal(disabled.json.config.tts.randomReplyProbability, 20);
    assert.equal(disabled.json.status.ttsReady, true); assert.equal(f.h.cfg.socialV2.tools.sendVoice, false);
    await f.h.speakText('private:123', { text: 'manual speech still allowed' });
    assert.equal(recordRequests(f.h).length, 1);
    const enabled = await call(port, '/api/voice/settings', { method: 'POST', body: { enabled: true, tts: { randomReplyProbability: 100 } } });
    assert.equal(enabled.json.aiSendEnabled, true); assert.equal(f.h.cfg.socialV2.tools.sendVoice, true);
    const persisted = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'config.json')));
    assert.equal(persisted.socialV2.voice.tts.randomReplyProbability, 100);
    const off = await call(port, '/api/voice/settings', { method: 'POST', body: { tts: { randomReplyProbability: 0 } } });
    assert.equal(off.json.config.tts.randomReplyProbability, 0); assert.equal(off.json.aiSendEnabled, true);
  }); } finally { await f.close(); }
});

const randomConfig = probability => ({ socialV2: { tools: { sendVoice: true }, voice: { ...clone(voice), tts: { ...voice.tts, randomReplyProbability: probability } } } });

test('one to three cleaned characters remain text without synthesis or voice quota', async () => {
  for (const messages of ['嗯', '好的', '知道了', ' (轻声) 嗯 ', '嗯  嗯']) {
    const f = await fixture({ config: randomConfig(100) });
    try { await withServer(f, async port => {
      const result = await call(port, '/api/socialV2/send-message', { method: 'POST', headers: agentHeaders(f.h), body: { key: 'group:456', messages } });
      assert.equal(result.status, 200); assert.equal(result.json.delivery, undefined);
      assert.equal(f.calls.synth.length, 0); assert.equal(recordRequests(f.h).length, 0);
      assert.equal(textRequests(f.h).length, 1); assert.equal(f.h.voiceSendTimes.size, 0);
    }); } finally { await f.close(); }
  }
});

test('automatic audio shorter than 1.5 seconds falls back once before dispatch and discards its cache', async () => {
  for (const duration of [0.8, 1.12, 1.44, NaN]) {
    const f = await fixture({ config: randomConfig(100), duration });
    try { await withServer(f, async port => {
      const result = await call(port, '/api/socialV2/send-message', { method: 'POST', headers: agentHeaders(f.h), body: { key: 'group:456', messages: '这是一段完整的测试回复' } });
      assert.equal(result.status, 200); assert.equal(result.json.delivery, undefined);
      assert.equal(f.calls.synth.length, 1); assert.equal(recordRequests(f.h).length, 0);
      assert.equal(textRequests(f.h).length, 1); assert.equal(f.h.voiceSendTimes.size, 0);
      assert.equal(f.entries.size, 0); assert.equal(f.h.getSocialV2State('group:456').recentMessages.length, 1);
    }); } finally { await f.close(); }
  }
});

test('1.5-second automatic audio is eligible and short operator speech stays available', async () => {
  const f = await fixture({ config: randomConfig(100), duration: 1.5 });
  try { await withServer(f, async port => {
    const result = await call(port, '/api/socialV2/send-message', { method: 'POST', headers: agentHeaders(f.h), body: { key: 'group:456', messages: '这是一段测试回复' } });
    assert.equal(result.status, 200); assert.equal(result.json.delivery, 'voice'); assert.equal(recordRequests(f.h).length, 1);
  }); } finally { await f.close(); }
  const manual = await fixture({ duration: 0.8 });
  try { await manual.h.speakText('private:123', { text: '嗯' }); assert.equal(recordRequests(manual.h).length, 1); }
  finally { await manual.close(); }
});

test('100% converts group/private normal text endpoints to one verified voice with one context entry', async () => {
  for (const endpoint of ['/api/socialV2/send-message', '/api/socialV2/send-burst', '/api/send/group', '/api/send/private']) {
    const f = await fixture({ config: randomConfig(100) });
    try { await withServer(f, async port => {
      const key = endpoint.endsWith('/private') ? 'private:123' : 'group:456';
      const token = f.h.getSocialV2State(key).agentToken;
      const body = endpoint.startsWith('/api/socialV2/') ? { key, messages: 'random short reply' }
        : { groupId: '456', userId: '123', token, message: 'random short reply' };
      const result = await call(port, endpoint, { method: 'POST', headers: agentHeaders(f.h, key), body });
      assert.equal(result.status, 200, endpoint); assert.equal(result.json.delivery, 'voice');
      assert.equal(result.json.verified, true); assert.equal(result.json.sent, 1); assert.equal(result.json.failed, 0);
      assert.match(result.json.hint, /不要补发/);
      assert.equal(recordRequests(f.h).length, 1); assert.equal(recordRequests(f.h)[0].body.message[0].type, 'record');
      assert.equal(f.h.calls.sent.length, 0, 'No duplicate text.'); assert.equal(f.calls.synth.length, 1);
      assert.equal(textRequests(f.h).length, 0, 'No duplicate HTTP text.');
      const recent = f.h.getSocialV2State(key).recentMessages;
      assert.equal(recent.length, 1); assert.equal(recent[0].text, 'random short reply'); assert.ok(recent[0].messageId);
      assert.equal(f.h.getSocialV2State(key).sendTimes.length, 1); assert.equal(f.h.voiceSendTimes.get(key).length, 1);
    }); } finally { await f.close(); }
  }
});

test('zero probability/disabled voice/long text/@/links/bursts stay text without generation', async () => {
  for (const kind of ['zero', 'tool', 'voice', 'consent', 'tts', 'long', 'at', 'url', 'burst']) {
    const f = await fixture({ config: randomConfig(kind === 'zero' ? 0 : 100) });
    try { await withServer(f, async port => {
      if (kind === 'tool') f.h.cfg.socialV2.tools.sendVoice = false;
      if (kind === 'voice') f.h.cfg.socialV2.voice.enabled = false;
      if (kind === 'consent') f.h.cfg.socialV2.voice.tts.onlineConsent = false;
      if (kind === 'tts') f.h.cfg.socialV2.voice.tts.enabled = false;
      const messages = kind === 'long' ? 'x'.repeat(301) : kind === 'url' ? 'https://example.test' : kind === 'burst' ? ['first', 'second'] : 'text reply';
      const result = await call(port, '/api/socialV2/send-message', { method: 'POST', headers: agentHeaders(f.h), body: { key: 'group:456', messages, gapMode: 'fixed', gapMs: 100, ...(kind === 'at' ? { atUserId: '111' } : {}) } });
      assert.equal(result.status, 200, kind); assert.equal(result.json.delivery, undefined);
      assert.equal(f.calls.synth.length, 0, kind); assert.equal(recordRequests(f.h).length, 0, kind);
      assert.equal(textRequests(f.h).length, kind === 'burst' ? 2 : 1);
      assert.equal(f.h.getSocialV2State('group:456').recentMessages.length, kind === 'burst' ? 2 : 1);
    }); } finally { await f.close(); }
  }
});

test('synthesis failure before dispatch falls back once to original text, with no private error logs', async () => {
  const f = await fixture({ config: randomConfig(100), hook: async () => { throw new Error('FIXTURE-PRIVATE-TTS-FAILURE'); } });
  try { await withServer(f, async port => {
    const result = await call(port, '/api/socialV2/send-message', { method: 'POST', headers: agentHeaders(f.h), body: { key: 'group:456', messages: 'fallback reply' } });
    assert.equal(result.status, 200); assert.equal(result.json.sent, 1); assert.equal(result.json.delivery, undefined);
    assert.equal(textRequests(f.h).length, 1); assert.equal(textRequests(f.h)[0].body.message[0].data.text, 'fallback reply');
    assert.equal(recordRequests(f.h).length, 0); assert.equal(f.h.voiceSendTimes.size, 0);
    assert.equal(f.h.getSocialV2State('group:456').recentMessages.length, 1);
    assert.ok(!fs.readFileSync(path.join(f.h.temp, 'state/bridge.log'), 'utf8').includes('FIXTURE-PRIVATE-TTS-FAILURE'));
  }); } finally { await f.close(); }
});

test('random speech uses the same stage-direction filter as outgoing text', async () => {
  const f = await fixture({ config: randomConfig(100) });
  try { await withServer(f, async port => {
    const result = await call(port, '/api/socialV2/send-message', { method: 'POST', headers: agentHeaders(f.h), body: { key: 'group:456', messages: '(quietly) hello (private thoughts)' } });
    assert.equal(result.status, 200); assert.equal(result.json.delivery, 'voice');
    assert.equal(f.calls.synth[0].text, 'hello');
    assert.equal(f.h.getSocialV2State('group:456').recentMessages[0].text, 'hello');
  }); } finally { await f.close(); }
});

test('quotes and administrator text sends are never converted', async () => {
  const f = await fixture({ config: randomConfig(100) });
  try {
    const token = f.h.getSocialV2State('group:456').agentToken;
    const sent = await f.h.sendReplyMessagesV2('group:456', ['quoted reply'], [], '9001', null, { token, tool: 'sendMessage' });
    assert.equal(sent.voice, undefined); assert.equal(f.calls.synth.length, 0);
    assert.equal(textRequests(f.h)[0].body.message[0].type, 'reply');
    await f.h.sendReplyMessagesV2('group:456', ['operator reply'], [], null, null, {});
    await f.h.sendReplyMessagesV2('private:123', ['owner reply'], [], null, null, {});
    assert.equal(f.calls.synth.length, 0); assert.equal(recordRequests(f.h).length, 0);
    assert.equal(textRequests(f.h).length, 3);
  } finally { await f.close(); }
});

test('random conversion refuses forbidden text permissions, muted groups and sensitive speech before synthesis', async () => {
  for (const kind of ['token', 'pause', 'v2', 'textTool', 'ban', 'credential']) {
    const f = await fixture({ config: randomConfig(100) });
    try {
      const key = 'group:456'; const token = f.h.getSocialV2State(key).agentToken;
      if (kind === 'pause') f.h.socialV2.paused = true;
      if (kind === 'v2') f.h.cfg.socialV2.enabled = false;
      if (kind === 'textTool') f.h.cfg.socialV2.tools.sendMessage = false;
      if (kind === 'ban') { f.h.setSelfIdentity('fixture bot', '789'); f.h.observeGroupBanV2({ group_id: 456, user_id: 789, duration: 3600, sub_type: 'ban', notice_type: 'group_ban' }); }
      await assert.rejects(f.h.sendReplyMessagesV2(key, [kind === 'credential' ? 'fixture-console-token' : 'forbidden reply'], [], null, null, { token: kind === 'token' ? 'invalid' : token, tool: 'sendMessage' }));
      assert.equal(f.calls.synth.length, 0, kind); assert.equal(recordRequests(f.h).length, 0, kind); assert.equal(textRequests(f.h).length, 0, kind);
    } finally { await f.close(); }
  }
});

test('disconnecting a random text reply aborts synthesis without fallback or a QQ send', async () => {
  const started = deferred(), cancelled = deferred();
  const f = await fixture({ config: randomConfig(100), hook: options => new Promise(resolve => {
    started.resolve(); options.signal.addEventListener('abort', () => { cancelled.resolve(); resolve(); }, { once: true });
  }) });
  try { await withServer(f, async port => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/socialV2/send-message', method: 'POST', headers: { ...agentHeaders(f.h), 'content-type': 'application/json' } });
    req.on('error', () => {}); req.end(JSON.stringify({ key: 'group:456', messages: 'disconnect random reply' }));
    await started.promise; req.destroy();
    await Promise.race([cancelled.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('random reply cancellation not observed')), 1500))]);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(recordRequests(f.h).length, 0); assert.equal(textRequests(f.h).length, 0);
  }); } finally { await f.close(); }
});

test('exhausted voice budget keeps ordinary text available without another synthesis', async () => {
  const f = await fixture({ config: randomConfig(100) });
  try {
    f.h.cfg.socialV2.voice.maxPerMinute = 1;
    await f.h.speakText('group:456', { text: 'first voice' });
    await withServer(f, async port => {
      const result = await call(port, '/api/socialV2/send-message', { method: 'POST', headers: agentHeaders(f.h), body: { key: 'group:456', messages: 'limited voice becomes text' } });
      assert.equal(result.status, 200); assert.equal(result.json.delivery, undefined); assert.equal(f.calls.synth.length, 1);
      assert.equal(recordRequests(f.h).length, 1); assert.equal(textRequests(f.h).length, 1);
    });
  } finally { await f.close(); }
});

test('unverified success and uncertain gateway failure never trigger duplicate text', async () => {
  for (const failed of [false, true]) {
    let attempts = 0;
    const f = await fixture({ config: randomConfig(100), fetchImpl: async url => {
      if (String(url).endsWith('/send_group_msg')) {
        attempts++;
        if (failed) throw new Error('FIXTURE-UNCERTAIN-GATEWAY');
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message: [] } }) };
    } });
    try { await withServer(f, async port => {
      const result = await call(port, '/api/socialV2/send-message', { method: 'POST', headers: agentHeaders(f.h), body: { key: 'group:456', messages: 'possibly delivered voice' } });
      assert.equal(attempts, 1); assert.equal(f.h.calls.sent.length, 0);
      assert.equal(textRequests(f.h).length, 0);
      assert.equal(result.status, failed ? 500 : 200);
      if (failed) { assert.match(result.json.error, /不要自动补发或重试/); assert.equal(f.h.getSocialV2State('group:456').sendTimes.length, 0); }
      else { assert.equal(result.json.delivery, 'voice'); assert.equal(result.json.verified, false); }
      assert.ok(!result.text.includes('FIXTURE-UNCERTAIN-GATEWAY'));
    }); } finally { await f.close(); }
  }
});

test('permissions, probability, persona and reset changes during random synthesis cancel with no text fallback', async () => {
  for (const kind of ['token', 'pause', 'probability', 'persona', 'epoch', 'voice', 'consent', 'textTool', 'provider']) {
    const reached = deferred(), gate = deferred();
    const f = await fixture({ config: randomConfig(100), hook: async () => { reached.resolve(); await gate.promise; } });
    try {
      const token = f.h.getSocialV2State('group:456').agentToken;
      const pending = f.h.sendReplyMessagesV2('group:456', ['pending random reply'], [], null, null, { token, tool: 'sendMessage' });
      await reached.promise;
      if (kind === 'token') f.h.getSocialV2State('group:456').agentToken = 'rotated-token';
      if (kind === 'pause') f.h.socialV2.paused = true;
      if (kind === 'probability') f.h.cfg.socialV2.voice.tts.randomReplyProbability = 0;
      if (kind === 'persona') fs.writeFileSync(path.join(f.h.temp, 'state/current-role.json'), JSON.stringify({ role: null, mode: 'silent' }));
      if (kind === 'epoch') f.h.resetEpoch();
      if (kind === 'voice') f.h.cfg.socialV2.voice.enabled = false;
      if (kind === 'consent') f.h.cfg.socialV2.voice.tts.onlineConsent = false;
      if (kind === 'textTool') f.h.cfg.socialV2.tools.sendMessage = false;
      if (kind === 'provider') f.h.cfg.socialV2.voice.tts.provider = 'mimo';
      gate.resolve(); await assert.rejects(pending);
      assert.equal(recordRequests(f.h).length, 0, kind); assert.equal(f.h.calls.sent.length, 0, kind);
    } finally { gate.resolve(); await f.close(); }
  }
});

test('settings/preview/audio/speak administrative endpoints reject agent calls before generation', async () => {
  const f = await fixture();
  try { await withServer(f, async port => {
    const headers = agentHeaders(f.h);
    for (const [pathname, method, body] of [['/api/voice/settings', 'GET'], ['/api/voice/settings', 'POST', { tts: { enabled: true, onlineConsent: true } }], ['/api/voice/preview', 'POST', { text: 'hello' }], ['/api/voice/preview/' + crypto.randomUUID(), 'GET'], ['/api/voice/speak', 'POST', { target: 'group:456', text: 'hello' }]]) {
      assert.equal((await call(port, pathname, { method, body, headers })).status, 403);
    }
    const unauthorized = await call(port, '/api/voice/preview', { method: 'POST', headers: {}, body: { text: 'hello' } }); assert.equal(unauthorized.status, 401);
    assert.equal(f.calls.synth.length, 0); assert.equal(recordRequests(f.h).length, 0);
  }); } finally { await f.close(); }
});

test('preview never sends QQ, returns only opaque URL and authenticated no-store media', async () => {
  const f = await fixture();
  try { await withServer(f, async port => {
    const preview = await call(port, '/api/voice/preview', { method: 'POST', body: { text: 'preview only', voice: 'zh-CN-XiaoyiNeural', rate: 5 } });
    assert.equal(preview.status, 200); assert.match(preview.json.previewId, /^[0-9a-f-]+$/); assert.equal(preview.json.audioUrl, '/api/voice/preview/' + preview.json.previewId);
    assert.ok(!preview.json.audioUrl.includes('?')); assert.ok(!preview.text.includes(f.h.temp)); assert.equal(recordRequests(f.h).length, 0);
    assert.equal((await call(port, preview.json.audioUrl, { headers: {} })).status, 401);
    const audio = await call(port, preview.json.audioUrl); assert.equal(audio.status, 200); assert.equal(audio.headers['content-type'], 'audio/mpeg'); assert.equal(audio.headers['cache-control'], 'no-store'); assert.match(audio.headers['content-security-policy'], /media-src 'self' blob:/);
  }); } finally { await f.close(); }
});

test('text paths and known credential strings are rejected before fake provider receives text', async () => {
  const f = await fixture();
  try {
    for (const text of ['fixture-console-token', 'C:\\Users\\example\\file.txt']) await assert.rejects(f.h.speakText('group:456', { text }), /凭据|路径/);
    assert.equal(f.calls.synth.length, 0); assert.equal(recordRequests(f.h).length, 0);
  } finally { await f.close(); }
});

test('agent token, pause, silent mode, disabled tool/v2, no allow and group ban reject before generation', async () => {
  for (const kind of ['token', 'paused', 'silent', 'tool', 'v2', 'allow', 'ban']) {
    const f = await fixture({ roleMode: kind === 'silent' ? 'silent' : 'active' });
    try {
      const key = 'group:456'; const token = f.h.getSocialV2State(key).agentToken;
      if (kind === 'paused') f.h.socialV2.paused = true;
      if (kind === 'tool') f.h.cfg.socialV2.tools.sendVoice = false;
      if (kind === 'v2') f.h.cfg.socialV2.enabled = false;
      if (kind === 'allow') f.h.cfg.allow.groups = ['999'];
      if (kind === 'ban') { f.h.setSelfIdentity('fixture bot', '789'); f.h.observeGroupBanV2({ group_id: 456, user_id: 789, duration: 3600, sub_type: 'ban', notice_type: 'group_ban' }); }
      await assert.rejects(f.h.speakText(key, { text: 'hello' }, { agent: true, token: kind === 'token' ? 'invalid' : token }));
      assert.equal(f.calls.synth.length, 0, kind); assert.equal(recordRequests(f.h).length, 0, kind);
    } finally { await f.close(); }
  }
});

test('generated 300-character speech sends a record and retains full sent text with verification', async () => {
  const f = await fixture();
  try {
    const text = '测'.repeat(300);
    const result = await f.h.speakText('group:456', { text });
    assert.equal(result.ok, true); assert.equal(result.verified, true); assert.equal(result.chars, 300);
    const sent = recordRequests(f.h); assert.equal(sent.length, 1); assert.equal(sent[0].body.message[0].type, 'record');
    assert.equal(f.h.getSocialV2State('group:456').recentMessages.at(-1).text, text);
    assert.equal(f.h.voiceSendTimes.get('group:456').length, 1);
  } finally { await f.close(); }
});

test('successful gateway submission with failed record readback is explicitly unverified', async () => {
  const gateway = [];
  const f = await fixture({ fetchImpl: async (url, init) => { gateway.push(url); return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: String(url).endsWith('/get_msg') ? { message: [] } : { message_id: 9001 } }) }; } });
  try { const result = await f.h.speakText('private:123', { text: 'hello' }); assert.equal(result.ok, true); assert.equal(result.verified, false); assert.equal(gateway.filter(url => url.endsWith('/send_private_msg')).length, 1); }
  finally { await f.close(); }
});

test('conflicting same-target speech is serialized and per-minute cap rejects before new synthesis', async () => {
  const gate = deferred(); const reached = deferred();
  const f = await fixture({ config: { socialV2: { voice: { ...clone(voice), maxPerMinute: 1 } } }, hook: async () => { reached.resolve(); await gate.promise; } });
  try {
    const first = f.h.speakText('group:456', { text: 'first' }); await reached.promise;
    await assert.rejects(f.h.speakText('group:456', { text: 'duplicate' }), /重复提交/);
    assert.equal(f.calls.synth.length, 1); gate.resolve(); await first;
    await assert.rejects(f.h.speakText('group:456', { text: 'limited' }), /频率超限/);
    assert.equal(f.calls.synth.length, 1); assert.equal(recordRequests(f.h).length, 1);
  } finally { gate.resolve(); await f.close(); }
});

test('one preview cannot be sent twice even to another allowed target', async () => {
  const f = await fixture();
  try {
    const entry = await f.h.speechService.synthesize('preview reuse');
    await f.h.speakText('group:456', { previewId: entry.id });
    await assert.rejects(f.h.speakText('private:123', { previewId: entry.id }), /already used/);
    assert.equal(recordRequests(f.h).length, 1); assert.equal(f.calls.synth.length, 1);
  } finally { await f.close(); }
});

test('epoch/persona/consent/token/pause changes during async synthesis cancel before QQ send', async () => {
  for (const kind of ['epoch', 'persona', 'consent', 'token', 'pause']) {
    const reached = deferred(), gate = deferred(); const f = await fixture({ hook: async () => { reached.resolve(); await gate.promise; } });
    try {
      const token = f.h.getSocialV2State('group:456').agentToken;
      const task = f.h.speakText('group:456', { text: 'pending' }, { agent: true, token });
      await reached.promise;
      if (kind === 'epoch') f.h.resetEpoch();
      if (kind === 'persona') fs.writeFileSync(path.join(f.h.temp, 'state/current-role.json'), JSON.stringify({ role: null, mode: 'silent' }));
      if (kind === 'consent') f.h.cfg.socialV2.voice.tts.onlineConsent = false;
      if (kind === 'token') f.h.getSocialV2State('group:456').agentToken = 'rotated-fixture-token';
      if (kind === 'pause') f.h.socialV2.paused = true;
      gate.resolve(); await assert.rejects(task); assert.equal(recordRequests(f.h).length, 0, kind); assert.equal(f.h.voiceSendTimes.size, 0);
    } finally { gate.resolve(); await f.close(); }
  }
});

test('client disconnect aborts preview and outbound synthesis without sending', async () => {
  for (const endpoint of ['/api/voice/preview', '/api/voice/speak']) {
    const started = deferred(), cancelled = deferred();
    const f = await fixture({ hook: options => new Promise(resolve => { started.resolve(); options.signal.addEventListener('abort', () => { cancelled.resolve(); resolve(); }, { once: true }); }) });
    try { await withServer(f, async port => {
      const req = http.request({ host: '127.0.0.1', port, path: endpoint, method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' } }); req.on('error', () => {});
      req.end(JSON.stringify(endpoint.endsWith('/preview') ? { text: 'disconnect' } : { target: 'group:456', text: 'disconnect' }));
      await started.promise; req.destroy();
      await Promise.race([cancelled.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('abort not observed')), 1500))]);
      await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(recordRequests(f.h).length, 0);
    }); } finally { await f.close(); }
  }
});

test('worker/provider failures are not written to bridge logs as raw private text', async () => {
  const privateMarker = 'FIXTURE-PRIVATE-PROVIDER-ERROR';
  const f = await fixture({ hook: async () => { throw new Error(privateMarker); } });
  try {
    await assert.rejects(f.h.speakText('group:456', { text: 'private fixture' }));
    const log = path.join(f.h.temp, 'state/bridge.log'); assert.ok(!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes(privateMarker));
    assert.equal(recordRequests(f.h).length, 0);
  } finally { await f.close(); }
});

test('gateway failures with internal paths or known credentials never reach model tool responses or logs', async () => {
  for (const privateValue of ['C:\\Users\\example\\audio\\generated.mp3', 'fixture-console-token']) {
    let sendAttempts = 0;
    const f = await fixture({ fetchImpl: async url => {
      const action = String(url).split('/').pop();
      if (action === 'send_group_msg') {
        sendAttempts++;
        return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 100,
          wording: `fixture gateway could not open ${privateValue}` }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
    } });
    try {
      await withServer(f, async port => {
        const token = f.h.getSocialV2State('group:456').agentToken;
        const result = await call(port, '/api/socialV2/speak-text', { method: 'POST', headers: agentHeaders(f.h),
          body: { key: 'group:456', token, text: 'fixture short speech' } });
        assert.equal(result.status, 502);
        assert.equal(result.json.ok, false);
        assert.ok(!result.text.includes(privateValue));
        assert.match(result.json.error, /隐藏内部路径或凭据/);
      });
      assert.equal(sendAttempts, 1);
      assert.equal(f.h.voiceSendTimes.size, 0, 'Rejected gateway sends must not spend a successful-send quota.');
      const log = path.join(f.h.temp, 'state/bridge.log');
      assert.ok(!fs.existsSync(log) || !fs.readFileSync(log, 'utf8').includes(privateValue));
    } finally { await f.close(); }
  }
});

test('late successful gateway acknowledgement spends quota without resurrecting reset or stale persona context', async () => {
  for (const retire of ['reset', 'persona']) {
    const started = deferred(), gate = deferred();
    let sendAttempts = 0;
    const f = await fixture({ fetchImpl: async url => {
      const action = String(url).split('/').pop();
      if (action === 'send_group_msg') {
        sendAttempts++; started.resolve(); await gate.promise;
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9876 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0,
        data: action === 'get_msg' ? { message: [{ type: 'record', data: { duration: 2 } }] } : {} }) };
    } });
    try {
      const oldState = f.h.getSocialV2State('group:456');
      const token = oldState.agentToken;
      const pending = f.h.speakText('group:456', { text: 'fixture OLD-PERSONA speech' }, { agent: true, token });
      await started.promise;
      if (retire === 'reset') { f.h.resetEpoch(); f.h.socialV2.conversations.delete('group:456'); }
      if (retire === 'persona') fs.writeFileSync(path.join(f.h.temp, 'state/current-role.json'), JSON.stringify({ role: 'fixture-new-persona', mode: 'active' }));
      gate.resolve();
      const result = await pending;
      assert.equal(result.ok, true, 'An acknowledged QQ send must not be reported as a retryable failure.');
      assert.equal(result.messageId, 9876);
      assert.equal(sendAttempts, 1);
      assert.equal(f.h.voiceSendTimes.get('group:456').length, 1, 'Actual acknowledged sends still spend quota.');
      if (retire === 'reset') assert.equal(f.h.socialV2.conversations.has('group:456'), false);
      if (retire === 'persona') assert.ok(!oldState.recentMessages.some(message => String(message.text).includes('OLD-PERSONA')));
    } finally { gate.resolve(); await f.close(); }
  }
});
