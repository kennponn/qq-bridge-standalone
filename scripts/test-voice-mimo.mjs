// Offline fixtures only: never use a real credential, network, or QQ account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { loadMimoApiKey, prepareMimoKeyUpdate, mimoSecretStatus, runMimoSpeech, MIMO_TTS_ENDPOINT, MIMO_TTS_MODEL } from '../src/voice-mimo.js';
import { createSpeechService, resolveVoiceSettings, mergeVoiceSettings, speechVoices } from '../src/voice-speech.js';
import { isHardened } from '../src/state-acl.mjs';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function call(port, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Fixture timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function listen(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const KEY = 'fixture-mimo-private-key', MP3 = Buffer.from('ID3-OFFLINE-FIXTURE');
const config = () => ({ enabled: true, tts: { enabled: true, onlineConsent: true, provider: 'mimo', voice: '冰糖', style: '温柔自然', rate: 0, randomReplyProbability: 50 } });
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const response = () => jsonResponse({ choices: [{ message: { audio: { data: MP3.toString('base64') } } }] });
async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mimo-test-'));
  fs.mkdirSync(path.join(root, 'state'));
  try { await run(root); }
  finally { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); }
}
function saveKey(root, patch = { mimoApiKey: KEY }) {
  const update = prepareMimoKeyUpdate(root, patch);
  try { update.commit(); } finally { update.cleanup(); }
}

test('MiMo settings preserve old Edge defaults, validate provider voices and reset consent on provider changes', () => {
  assert.equal(resolveVoiceSettings().tts.provider, 'edge');
  assert.equal(resolveVoiceSettings().tts.style, '');
  const next = mergeVoiceSettings({}, { tts: { provider: 'mimo' } });
  assert.equal(next.tts.voice, '冰糖'); assert.equal(next.tts.onlineConsent, false);
  assert.equal(mergeVoiceSettings(config(), { tts: { provider: 'edge' } }).tts.onlineConsent, false);
  assert.equal(mergeVoiceSettings({}, { tts: { provider: 'mimo', onlineConsent: true } }).tts.onlineConsent, true);
  for (const patch of [{ provider: 'untrusted' }, { provider: 'mimo', voice: 'zh-CN-XiaoxiaoNeural' }, { provider: 'edge', voice: '冰糖' }, { style: 'x'.repeat(201) }, { style: '\n' }]) assert.throws(() => mergeVoiceSettings({}, { tts: patch }));
  assert.equal(speechVoices('mimo').length, 8);
  assert.equal(resolveVoiceSettings(config()).tts.randomReplyProbability, 50);
});

test('MiMo credentials are private, scoped to the official endpoint, replaceable and clearable', () => fixture(async root => {
  assert.equal(loadMimoApiKey(root, {}), ''); saveKey(root);
  const file = path.join(root, 'state/mimo-tts-secret.json');
  assert.equal(isHardened(file), true); assert.equal(loadMimoApiKey(root, {}), KEY);
  assert.equal(JSON.stringify(mimoSecretStatus(root, {})).includes(KEY), false);
  saveKey(root, { mimoApiKey: 'fixture-replacement' }); assert.equal(loadMimoApiKey(root, {}), 'fixture-replacement');
  assert.throws(() => prepareMimoKeyUpdate(root, { mimoApiKey: KEY, clearMimoApiKey: true }));
  assert.throws(() => prepareMimoKeyUpdate(root, { mimoApiKey: 'contains space' }));
  saveKey(root, { clearMimoApiKey: true }); assert.equal(loadMimoApiKey(root, {}), '');
  fs.writeFileSync(file, JSON.stringify({ version: 1, endpoint: 'https://untrusted.invalid', apiKey: KEY }));
  assert.throws(() => loadMimoApiKey(root, {}), /凭据不可读取/);
  saveKey(root); assert.equal(loadMimoApiKey(root, {}), KEY);
  assert.equal(loadMimoApiKey(root, { MIMO_API_KEY: 'fixture-env' }), 'fixture-env');
  assert.deepEqual(fs.readdirSync(path.join(root, 'state')), ['mimo-tts-secret.json']);
}));

test('MiMo worker sends only text/style to the fixed official endpoint and writes returned MP3', () => fixture(async root => {
  saveKey(root); const output = path.join(root, 'preview.mp3'); let calls = 0;
  const options = { root, output, text: '测试朗读', voice: '冰糖', rate: 10, style: '温柔自然' };
  await runMimoSpeech({ root, check: true }, { env: {}, fetchImpl: () => assert.fail('Health must not upload text.') });
  await runMimoSpeech(options, { env: {}, fetchImpl: async (url, request) => {
    calls++; assert.equal(url, MIMO_TTS_ENDPOINT); assert.equal(request.redirect, 'error');
    assert.equal(request.headers['api-key'], KEY);
    const body = JSON.parse(request.body);
    assert.equal(body.model, MIMO_TTS_MODEL); assert.equal(body.stream, false);
    assert.deepEqual(body.audio, { format: 'mp3', voice: '冰糖' });
    assert.deepEqual(body.messages.at(-1), { role: 'assistant', content: '测试朗读' });
    assert.match(body.messages[0].content, /温柔自然/); assert.match(body.messages[0].content, /10%/);
    assert.equal(request.body.includes(KEY), false); return response();
  } });
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(output), MP3);
  await assert.rejects(runMimoSpeech(options, { env: {}, fetchImpl: () => assert.fail('Never overwrite output.') }), /参数无效/);
}));

test('provider errors and malformed/oversized responses never reveal text or credentials', () => fixture(async root => {
  saveKey(root); const options = { root, output: path.join(root, 'bad.mp3'), text: 'private spoken fixture', voice: '冰糖', rate: 0 };
  for (const fetchImpl of [
    async () => new Response(KEY + options.text, { status: 401 }),
    async () => new Response(KEY + options.text, { status: 403 }),
    async () => new Response(KEY + options.text, { status: 429 }),
    async () => { throw new Error(KEY + options.text); },
    async () => jsonResponse({ choices: [] }),
    async () => jsonResponse({ choices: [{ message: { audio: { data: 'not!base64' } } }] }),
    async () => new Response('x'.repeat(6 * 1024 * 1024 + 1))
  ]) {
    await assert.rejects(runMimoSpeech(options, { env: {}, fetchImpl }), error => !error.message.includes(KEY) && !error.message.includes(options.text));
    assert.equal(fs.existsSync(options.output), false);
  }
}));

test('timeouts, pre-abort and mid-response cancellation prevent audio output', () => fixture(async root => {
  saveKey(root); const options = { root, output: path.join(root, 'cancel.mp3'), text: 'fixture', voice: '冰糖', rate: 0 };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runMimoSpeech({ ...options, signal: controller.signal }, { env: {}, fetchImpl: () => assert.fail('Pre-abort must not upload.') }), error => error.statusCode === 409);
  await assert.rejects(runMimoSpeech({ ...options, timeoutMs: 5 }, { env: {}, fetchImpl: (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true })) }), error => error.statusCode === 504);
  const midway = new AbortController();
  await assert.rejects(runMimoSpeech({ ...options, signal: midway.signal }, { env: {}, fetchImpl: async () => { midway.abort(); return response(); } }), error => error.statusCode === 409);
  assert.equal(fs.existsSync(options.output), false);
}));

test('speech service uses MiMo without Python and retains MP3/duration checks, consent and provider guards', () => fixture(async root => {
  const cfg = config(); let probes = 0, generated = 0;
  const service = createSpeechService({ root, getConfig: () => cfg, auditText: value => assert.notEqual(value, KEY),
    run: () => assert.fail('MiMo must not spawn Python'),
    runMimo: async options => { if (!options.check) { generated++; fs.writeFileSync(options.output, MP3); } return { ok: true }; },
    probe: async () => { probes++; return { ok: true, codec: 'mp3', duration: 2 }; } });
  assert.equal((await service.health()).ttsReady, true);
  const entry = await service.synthesize('fixture'); assert.equal(entry.provider, 'mimo'); assert.equal(generated, 1); assert.equal(probes, 1);
  cfg.tts.provider = 'edge'; assert.throws(() => service.get(entry.id), /服务已变化/); service.invalidate();
  cfg.tts.provider = 'mimo'; cfg.tts.onlineConsent = false;
  await assert.rejects(service.synthesize('fixture'), /授权/);
}));

test('provider change during synthesis discards output instead of sending stale audio', () => fixture(async root => {
  const cfg = config();
  const service = createSpeechService({ root, getConfig: () => cfg, auditText() {},
    runMimo: async options => { if (!options.check) { fs.writeFileSync(options.output, MP3); cfg.tts.provider = 'edge'; } return { ok: true }; },
    probe: () => assert.fail('Provider change must discard output before probing') });
  await assert.rejects(service.synthesize('fixture'), error => error.statusCode === 409);
  assert.deepEqual(fs.readdirSync(path.join(root, 'state/voice-previews')), []);
}));

test('narrow console API stores MiMo key separately, never returns it or changes the chat engine', async () => {
  const h = await bridgeHarness({ config: { socialV2: { voice: config() }, engine: { backend: 'standalone', directLLM: { provider: 'openai-compatible', model: 'fixture-chat', baseUrl: 'https://model.invalid/v1' } } } });
  try {
    await listen(h, async port => {
      const result = await call(port, '/api/voice/settings', { method: 'POST', body: { mimoApiKey: KEY, tts: { provider: 'mimo', voice: '冰糖', enabled: true, onlineConsent: true, style: '温柔自然' } } });
      assert.equal(result.status, 200); assert.equal(result.json.mimoSecret.configured, true);
      assert.equal(JSON.stringify(result.json).includes(KEY), false);
      const stored = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
      assert.equal(JSON.stringify(stored).includes(KEY), false); assert.equal(stored.engine.directLLM.model, 'fixture-chat');
      assert.equal(loadMimoApiKey(h.temp, {}), KEY);
      const read = await call(port, '/api/voice/settings'); assert.equal(JSON.stringify(read.json).includes(KEY), false);
      assert.equal(h.calls.http.length, 0);
      const cleared = await call(port, '/api/voice/settings', { method: 'POST', body: { clearMimoApiKey: true } });
      assert.equal(cleared.json.mimoSecret.configured, false);
    });
  } finally { await h.close(); }
});
