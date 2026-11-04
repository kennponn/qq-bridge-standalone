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
async function fixture({ config = {}, roleMode = 'active', hook, fetchImpl } = {}) {
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
            const entry = { id, file, text: safe, chars: Array.from(safe).length, expiresAt: Date.now() + 600000, duration: 2, used: false, busy: false };
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
          invalidate() { calls.invalidations++; entries.clear(); }
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
function recordRequests(h) { return h.calls.http.filter(request => /send_(private|group)_msg$/.test(request.url)); }

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
    for (const body of [{ tts: { enabled: 'true', onlineConsent: true } }, { incoming: { enabled: false }, tts: { onlineConsent: 1 } }, { tts: { voice: 'arbitrary' } }, { tts: { rate: 51 } }, { tts: { rate: 0.1 } }, { tts: { provider: 'other' } }, { unknown: true }, { incoming: null }, { tts: [] }]) {
      const result = await call(port, '/api/voice/settings', { method: 'POST', body });
      assert.equal(result.status, 400, JSON.stringify(body)); assert.ok(before.equals(fs.readFileSync(file))); assert.deepEqual(clone(f.h.cfg.socialV2.voice), cfgBefore);
    }
    assert.equal(f.calls.invalidations, 0); assert.equal(f.calls.synth.length, 0);
  }); } finally { await f.close(); }
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
    for (const text of ['fixture-console-token', 'fixture-only', 'C:\\Users\\example\\file.txt']) await assert.rejects(f.h.speakText('group:456', { text }), /凭据|路径/);
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
