// Exercise the actual console controller offline; never synthesize or send QQ messages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const start = html.indexOf('const voiceFemaleIds =');
const end = html.indexOf("document.getElementById('voiceTtsSend').addEventListener", start);
assert.ok(start > 0 && end > start);
const source = html.slice(start, html.indexOf('\n', end));
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length);
assert.match(html, /id="voiceRandomProbability" type="number" min="0" max="100" step="1"/);
assert.match(html, /id="voiceAiEnabled"/);
for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);

function fixture() {
  const nodes = new Map(ids.map(id => [id, {
    value: '', checked: false, disabled: false, hidden: false, textContent: '', className: '', listeners: {},
    options: [{ value: 'zh-CN-XiaoxiaoNeural' }],
    addEventListener(event, callback) { this.listeners[event] = callback; },
    pause() {}, load() {}, removeAttribute() {}, replaceChildren() {},
  }]));
  const result = { ok: true, aiSendEnabled: true, config: { enabled: true, incoming: { enabled: true }, tts: {
    enabled: true, onlineConsent: true, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, randomReplyProbability: 20,
  } }, status: { ttsReady: true } };
  const requests = [];
  const context = vm.createContext({ URL, document: { getElementById(id) { assert.ok(nodes.has(id), id); return nodes.get(id); } },
    async api(path, method, body) { requests.push({ path, method, body }); return structuredClone(result); },
  });
  vm.runInContext(source + '\nthis.controller = { renderVoiceSpeechSettings, saveVoiceSpeechSettings, loadVoiceSpeechSettings, syncVoiceSpeechButtons };', context);
  return { nodes, result, requests, controller: context.controller };
}

test('saved percentage and actual AI permission render separately, with zero for old configs', () => {
  const f = fixture();
  f.controller.renderVoiceSpeechSettings(f.result);
  assert.equal(f.nodes.get('voiceRandomProbability').value, 20);
  assert.equal(f.nodes.get('voiceAiEnabled').checked, true);
  assert.match(f.nodes.get('voiceSettingsStatus').textContent, /20%/);
  delete f.result.config.tts.randomReplyProbability;
  f.result.aiSendEnabled = false;
  f.controller.renderVoiceSpeechSettings(f.result);
  assert.equal(f.nodes.get('voiceRandomProbability').value, 0);
  assert.equal(f.nodes.get('voiceAiEnabled').checked, false);
  assert.match(f.nodes.get('voiceSettingsStatus').textContent, /AI 发语音已关闭/);
});

test('saving valid probabilities carries AI toggle, preserves consent/voice and never sends QQ', async () => {
  for (const value of ['0', '20', '100']) {
    const f = fixture();
    f.controller.renderVoiceSpeechSettings(f.result);
    f.nodes.get('voiceTtsRate').value = '0';
    f.nodes.get('voiceRandomProbability').value = value;
    f.nodes.get('voiceAiEnabled').checked = false;
    await f.controller.saveVoiceSpeechSettings();
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every(request => request.path === '/api/voice/settings'));
    const body = f.requests[0].body;
    assert.equal(body.enabled, false); assert.equal(body.tts.randomReplyProbability, Number(value));
    assert.equal(body.tts.onlineConsent, true); assert.equal(body.tts.enabled, true);
    assert.equal(body.tts.voice, 'zh-CN-XiaoxiaoNeural');
  }
});

test('blank/non-integer/out-of-range probability is rejected before saving', async () => {
  for (const value of ['', ' ', '-1', '101', '20.5', 'abc', 'Infinity']) {
    const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
    f.nodes.get('voiceTtsRate').value = '0'; f.nodes.get('voiceRandomProbability').value = value;
    await f.controller.saveVoiceSpeechSettings();
    assert.equal(f.requests.length, 0, value);
    assert.match(f.nodes.get('voiceSettingsStatus').textContent, /0 到 100 的整数/);
  }
});

test('editing probability is marked unsaved and a late refresh preserves the draft', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceRandomProbability').value = '35';
  f.nodes.get('voiceRandomProbability').listeners.input();
  assert.match(f.nodes.get('voiceSettingsStatus').textContent, /未保存/);
  f.controller.renderVoiceSpeechSettings(f.result, false);
  assert.equal(f.nodes.get('voiceRandomProbability').value, '35');
});

test('operator preview and send remain available while AI permission is off', () => {
  const f = fixture(); f.result.aiSendEnabled = false; f.result.config.enabled = false;
  f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceTtsText').value = 'operator preview';
  f.controller.syncVoiceSpeechButtons();
  assert.equal(f.nodes.get('voiceTtsPreview').disabled, false);
  assert.equal(f.nodes.get('voiceTtsSend').disabled, false);
});
