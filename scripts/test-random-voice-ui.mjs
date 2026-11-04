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
const configSource = html.slice(html.indexOf('let alwaysAwakeActionBusy ='), html.indexOf('async function viewV2State()'));
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
    pause() {}, load() {}, removeAttribute() {}, replaceChildren() { this.options = []; }, appendChild(option) { this.options.push(option); },
  }]));
  for (const node of nodes.values()) {
    let value = node.value;
    Object.defineProperty(node, 'value', { get: () => value, set: next => { value = String(next); } });
  }
  const toolCheckbox = { checked: false, dataset: { v2Tool: 'sendVoice' } };
  const result = { ok: true, aiSendEnabled: true, config: { enabled: true, incoming: { enabled: true }, tts: {
    enabled: true, onlineConsent: true, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, randomReplyProbability: 20,
  } }, status: { ttsReady: true } };
  const requests = [];
  let hook;
  const context = vm.createContext({ URL, document: {
    getElementById(id) { assert.ok(nodes.has(id), id); return nodes.get(id); },
    createElement() { return { value: '', textContent: '' }; },
    querySelector() { return toolCheckbox; },
    querySelectorAll() { return [toolCheckbox]; },
  },
    async api(path, method, body) {
      const request = { path, method, body }; requests.push(request);
      if (hook) { const answer = await hook(request); if (answer !== undefined) return answer; }
      if (path === '/api/socialV2/config') return { ok: true, config: { tools: { sendVoice: toolCheckbox.checked } } };
      if (method === 'POST') {
        result.config.enabled = body.enabled;
        result.aiSendEnabled = body.enabled;
        Object.assign(result.config.tts, body.tts);
        Object.assign(result.config.incoming, body.incoming);
        if (body.mimoApiKey) result.mimoSecret = { configured: true };
        if (body.clearMimoApiKey) result.mimoSecret = { configured: false };
      }
      return structuredClone(result);
    },
  });
  vm.runInContext(source + '\n' + configSource + '\nthis.controller = { renderVoiceSpeechSettings, saveVoiceSpeechSettings, loadVoiceSpeechSettings, syncVoiceSpeechButtons, saveV2Config, hasVoiceSpeechDraft };', context);
  return { nodes, result, requests, toolCheckbox, controller: context.controller, hook(value) { hook = value; } };
}

test('saved percentage and actual AI permission render separately, with zero for old configs', () => {
  const f = fixture();
  f.controller.renderVoiceSpeechSettings(f.result);
  assert.equal(f.nodes.get('voiceRandomProbability').value, '20');
  assert.equal(f.nodes.get('voiceAiEnabled').checked, true);
  assert.match(f.nodes.get('voiceSettingsStatus').textContent, /20%/);
  delete f.result.config.tts.randomReplyProbability;
  f.result.aiSendEnabled = false;
  f.controller.renderVoiceSpeechSettings(f.result);
  assert.equal(f.nodes.get('voiceRandomProbability').value, '0');
  assert.equal(f.nodes.get('voiceAiEnabled').checked, false);
  assert.match(f.nodes.get('voiceSettingsStatus').textContent, /AI 发语音已关闭/);
});

test('switching voice provider resets consent, rebuilds voices and keeps the draft until saved', () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceTtsProvider').value = 'mimo';
  f.nodes.get('voiceTtsProvider').listeners.input();
  assert.equal(f.nodes.get('voiceOnlineConsent').checked, false);
  assert.equal(f.nodes.get('voiceTtsVoice').value, '冰糖');
  assert.equal(f.nodes.get('voiceMimoSettings').hidden, false);
  assert.match(f.nodes.get('voiceConsentLabel').textContent, /小米 MiMo/);
  assert.equal(f.controller.hasVoiceSpeechDraft(), true);
  assert.equal(f.nodes.get('voiceTtsPreview').disabled, true);
});

test('MiMo credentials are saved only through the narrow API, cleared from the form and never restored', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceTtsProvider').value = 'mimo'; f.nodes.get('voiceTtsProvider').listeners.input();
  f.nodes.get('voiceOnlineConsent').checked = true;
  f.nodes.get('voiceMimoApiKey').value = 'fixture-mimo-ui-key'; f.nodes.get('voiceMimoApiKey').listeners.input();
  f.nodes.get('voiceMimoStyle').value = '  温柔自然  ';
  const saved = await f.controller.saveVoiceSpeechSettings();
  assert.equal(saved, true);
  assert.equal(f.requests[0].path, '/api/voice/settings');
  assert.equal(f.requests[0].body.mimoApiKey, 'fixture-mimo-ui-key');
  assert.equal(f.requests[0].body.tts.provider, 'mimo'); assert.equal(f.requests[0].body.tts.style, '温柔自然');
  assert.equal(f.nodes.get('voiceMimoApiKey').value, '');
  assert.equal(JSON.stringify(f.result).includes('fixture-mimo-ui-key'), false);
  await f.controller.loadVoiceSpeechSettings(); assert.equal(f.nodes.get('voiceMimoApiKey').value, '');
});

test('general parameter save does not leak MiMo Key into the full configuration endpoint', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceMimoApiKey').value = 'fixture-mimo-ui-key'; f.nodes.get('voiceMimoApiKey').listeners.input();
  await f.controller.saveV2Config();
  const general = f.requests.find(request => request.path === '/api/socialV2/config');
  const voice = f.requests.find(request => request.path === '/api/voice/settings' && request.method === 'POST');
  assert.ok(general); assert.ok(voice);
  assert.equal(JSON.stringify(general.body).includes('fixture-mimo-ui-key'), false);
  assert.equal(voice.body.mimoApiKey, 'fixture-mimo-ui-key');
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
  await f.controller.loadVoiceSpeechSettings();
  assert.equal(f.nodes.get('voiceRandomProbability').value, '35');
  assert.match(f.nodes.get('voiceSettingsStatus').textContent, /未保存/);
});

test('top/bottom general save includes dirty voice settings through the narrow consent API', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceRandomProbability').value = '35';
  f.nodes.get('voiceRandomProbability').listeners.input();
  await f.controller.saveV2Config();
  const writes = f.requests.filter(request => request.method === 'POST');
  assert.deepEqual(writes.map(request => request.path), ['/api/socialV2/config', '/api/voice/settings']);
  assert.equal(writes[1].body.tts.randomReplyProbability, 35);
  assert.equal(writes[0].body.voice, undefined, 'Full configuration must not carry online consent.');
  assert.equal(f.result.config.tts.randomReplyProbability, 35);
  assert.equal(f.controller.hasVoiceSpeechDraft(), false);
  assert.match(f.nodes.get('v2ConfigMsg').textContent, /二代及语音参数已保存/);
  assert.match(f.nodes.get('v2ConfigMsg').textContent, /35%/);
});

test('general save validates voice input before any configuration write', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceRandomProbability').value = '101';
  f.nodes.get('voiceRandomProbability').listeners.input();
  await f.controller.saveV2Config();
  assert.equal(f.requests.length, 0);
  assert.match(f.nodes.get('v2ConfigMsg').textContent, /未保存/);
});

test('partial failure is not shown as success and preserves the unsaved voice draft', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceRandomProbability').value = '35'; f.nodes.get('voiceRandomProbability').listeners.input();
  f.hook(request => request.path === '/api/voice/settings' && request.method === 'POST' ? { ok: false, error: 'fixture rejected' } : undefined);
  await f.controller.saveV2Config();
  assert.match(f.nodes.get('v2ConfigMsg').textContent, /二代参数已保存，但语音设置未确认/);
  assert.equal(f.nodes.get('v2ConfigMsg').className, 'meta err');
  assert.equal(f.nodes.get('voiceRandomProbability').value, '35'); assert.equal(f.controller.hasVoiceSpeechDraft(), true);
});

test('save verifies reread values and never claims success for a stale or mismatched response', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceRandomProbability').value = '35'; f.nodes.get('voiceRandomProbability').listeners.input();
  f.hook(request => request.path === '/api/voice/settings' && request.method !== 'POST' ? { ...structuredClone(f.result), config: { ...f.result.config, tts: { ...f.result.config.tts, randomReplyProbability: 0 } } } : undefined);
  assert.equal(await f.controller.saveVoiceSpeechSettings(), false);
  assert.match(f.nodes.get('voiceSettingsStatus').textContent, /读取值与提交值不一致/);
  assert.equal(f.controller.hasVoiceSpeechDraft(), true);
});

test('narrow save synchronizes the general voice tool checkbox to prevent a later stale overwrite', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceAiEnabled').checked = true;
  f.nodes.get('voiceRandomProbability').value = '20';
  assert.equal(await f.controller.saveVoiceSpeechSettings(), true);
  assert.equal(f.toolCheckbox.checked, true);
  f.requests.length = 0;
  await f.controller.saveV2Config();
  const writes = f.requests.filter(request => request.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].body.tools.sendVoice, true);
});

test('a new voice edit during global save remains dirty instead of being overwritten by the saved snapshot', async () => {
  const f = fixture(); f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceRandomProbability').value = '35'; f.nodes.get('voiceRandomProbability').listeners.input();
  f.hook(request => {
    if (request.path === '/api/socialV2/config' && request.method === 'POST') {
      f.nodes.get('voiceRandomProbability').value = '40'; f.nodes.get('voiceRandomProbability').listeners.input();
    }
  });
  await f.controller.saveV2Config();
  assert.equal(f.result.config.tts.randomReplyProbability, 35);
  assert.equal(f.nodes.get('voiceRandomProbability').value, '40'); assert.equal(f.controller.hasVoiceSpeechDraft(), true);
});

test('operator preview and send remain available while AI permission is off', () => {
  const f = fixture(); f.result.aiSendEnabled = false; f.result.config.enabled = false;
  f.controller.renderVoiceSpeechSettings(f.result);
  f.nodes.get('voiceTtsText').value = 'operator preview';
  f.controller.syncVoiceSpeechButtons();
  assert.equal(f.nodes.get('voiceTtsPreview').disabled, false);
  assert.equal(f.nodes.get('voiceTtsSend').disabled, false);
});
