#!/usr/bin/env node
/** Offline UI contract tests. No bridge process, model request, or QQ message is started. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const html = await readFile(fileURLToPath(new URL('../public/console.html', import.meta.url)), 'utf8');
const source = html.slice(html.indexOf('// Engine settings deliberately'), html.indexOf('\nasync function saveMode'));
assert(source.length > 1000, 'Engine UI controller exists');
assert(!/localStorage|sessionStorage|console\.log/.test(source), 'Engine controller never stores or logs credentials');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'DOM IDs are unique');
assert.match(html, /id="engineApiKey" type="password" autocomplete="new-password"/);
assert.match(html, /id="engineClearApiKey" type="checkbox"/);

const nodes = new Map(ids.map(id => [id, {
  id, value: '', checked: false, disabled: false, hidden: false, textContent: '', className: '',
  style: {}, listeners: {}, dataset: {},
  addEventListener(event, callback) { this.listeners[event] = callback; },
  reportValidity() { return true; },
}]));
const modes = ['chat', 'closed-agent', 'reserved', 'reserved2'].map(mode => ({ dataset: { mode }, disabled: false }));
let response;
const requests = [];
const context = vm.createContext({
  URL, Object, String, Number,
  document: {
    getElementById(id) { assert(nodes.has(id), `Missing element ${id}`); return nodes.get(id); },
    querySelectorAll(selector) { assert.equal(selector, '#modeRow button'); return modes; },
  },
  async api(path, method, body) {
    requests.push({ path, method, body });
    return structuredClone(response);
  },
  refresh() {}, confirm() { return true; },
});
vm.runInContext(source + '\nthis.controller = { populateEngineForm, renderEngineState, engineDraftPayload, safeEngineError, refreshEngineSettings };', context);
const controller = context.controller;
const node = id => nodes.get(id);
const clone = value => JSON.parse(JSON.stringify(value));
const settings = {
  ok: true, backend: 'standalone', runtimeBackend: 'standalone', requiresRestart: false,
  ready: true, dshRequired: false,
  config: {
    provider: 'deepseek-official', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY', requestTimeoutMs: 90000, turnTimeoutMs: 900000,
    maxRounds: 16, maxRetries: 0, vision: false, webSearch: true,
  },
  secret: { configured: true, source: 'file' },
};
let passed = 0;
async function test(name, callback) { await callback(); passed += 1; console.log(`PASS ${name}`); }

await test('Secret is not preloaded even if a malformed response contains it', () => {
  controller.populateEngineForm({ ...settings, apiKey: 'must-not-render', secret: { ...settings.secret, apiKey: 'must-not-render' } });
  assert.equal(node('engineApiKey').value, '');
  assert(![...nodes.values()].some(el => el.textContent.includes('must-not-render')));
});
await test('Full configuration payload preserves units, false booleans, and zero retries', () => {
  assert.deepEqual(clone(controller.engineDraftPayload()), { backend: 'standalone', config: settings.config });
  assert.equal(node('engineRequestTimeoutSec').value, 90);
  assert.equal(node('engineTurnTimeoutSec').value, 900);
});
await test('Blank key means keep: no API key or clear flag is sent', () => {
  node('engineApiKey').value = '   ';
  const payload = controller.engineDraftPayload();
  assert(!Object.hasOwn(payload, 'apiKey'));
  assert(!Object.hasOwn(payload, 'clearApiKey'));
});
await test('New key is sent only as an explicit draft override', () => {
  node('engineApiKey').value = 'synthetic-test-key';
  assert.equal(controller.engineDraftPayload().apiKey, 'synthetic-test-key');
});
await test('Explicit key deletion clears the input and never combines replace and clear', () => {
  node('engineClearApiKey').checked = true;
  node('engineClearApiKey').listeners.change.call(node('engineClearApiKey'));
  const payload = controller.engineDraftPayload();
  assert.equal(node('engineApiKey').value, '');
  assert.equal(payload.clearApiKey, true);
  assert(!Object.hasOwn(payload, 'apiKey'));
  assert.equal(node('engineApiKey').disabled, true);
  controller.populateEngineForm(settings);
});
await test('Provider change resets only its non-secret connection defaults', () => {
  node('engineProvider').value = 'openai-ultrarouter';
  node('engineProvider').listeners.change.call(node('engineProvider'));
  assert.equal(node('engineBaseUrl').value, 'https://ultrarouter.org/v1');
  assert.equal(node('engineApiKeyEnv').value, 'ULTRAROUTER_API_KEY');
  assert.equal(node('engineModel').value, 'deepseek-chat');
  controller.populateEngineForm(settings);
});
await test('Unsafe or full completion endpoints are rejected before submission', () => {
  for (const url of ['http://example.test/v1', 'https://user:pass@example.test/v1', 'https://example.test/v1?token=x', 'https://example.test/v1#secret', 'https://example.test/v1/chat/completions']) {
    node('engineBaseUrl').value = url;
    assert.throws(() => controller.engineDraftPayload(), /HTTPS/);
  }
  controller.populateEngineForm(settings);
});
await test('Polling never overwrites an editable model or credential draft', () => {
  node('engineModel').value = 'draft-model';
  node('engineApiKey').value = 'synthetic-test-key';
  controller.renderEngineState(settings);
  assert.equal(node('engineModel').value, 'draft-model');
  assert.equal(node('engineApiKey').value, 'synthetic-test-key');
});
await test('Saved-vs-running status never claims backend switched before restart', () => {
  controller.renderEngineState({ ...settings, backend: 'dsh', requiresRestart: true });
  assert.match(node('engineRuntimeText').textContent, /独立运行/);
  assert.equal(node('engineRestartNotice').hidden, false);
  assert.match(node('engineRestartNotice').textContent, /已保存：DSH 桥接/);
  assert.match(node('engineRestartNotice').textContent, /当前进程仍为独立运行/);
});
await test('Standalone disables unsupported DSH mode and preset controls', () => {
  assert(modes.every(button => button.disabled === (button.dataset.mode !== 'reserved2')));
  assert.equal(node('closedPreset').disabled, true);
  assert.equal(node('section-dsh').style.display, 'none');
  assert.equal(node('dshEffortSave').disabled, true);
  assert.equal(node('engineModeNote').hidden, false);
  assert.equal(node('simPromptPreset').disabled, true);
  assert.equal(node('v2AgentPreset').disabled, true);
  assert.match(node('simPromptSave').textContent, /独立提示词/);
  assert.equal(node('slangExtract').disabled, true);
  assert.equal(node('slangResearch').disabled, true);
  assert.equal(node('slangLearnerPreset').disabled, true);
  assert.equal(node('slangAdd').disabled, false);
});
await test('DSH runtime retains all original mode/model controls', () => {
  controller.renderEngineState({ ...settings, backend: 'dsh', runtimeBackend: 'dsh', dshRequired: true });
  assert(modes.every(button => button.disabled === false));
  assert.equal(node('closedPreset').disabled, false);
  assert.equal(node('section-dsh').style.display, '');
  assert.equal(node('dshEffortSave').disabled, false);
  assert.equal(node('slangResearch').disabled, false);
  assert.equal(node('simPromptPreset').disabled, false);
  assert.match(node('simPromptSave').textContent, /DSH/);
});
await test('Changing to DSH submits only backend, not disabled standalone drafts', () => {
  node('engineBackendStandalone').checked = false;
  node('engineBackendDsh').checked = true;
  assert.deepEqual(clone(controller.engineDraftPayload()), { backend: 'dsh' });
});
await test('Connection test submits editable draft once without a configuration save', async () => {
  controller.populateEngineForm(settings);
  node('engineModel').value = 'draft-model';
  node('engineApiKey').value = 'synthetic-test-key';
  response = { ok: true, latencyMs: 12.8, modelsCount: 8, modelAvailable: true };
  const before = requests.length;
  await node('engineTest').listeners.click();
  assert.equal(requests.length, before + 1);
  const request = requests.at(-1);
  assert.equal(request.path, '/api/engine/test');
  assert.equal(request.body.config.model, 'draft-model');
  assert.equal(request.body.apiKey, 'synthetic-test-key');
  assert.match(node('engineTestMsg').textContent, /未发送模型对话/);
  assert(!node('engineTestMsg').textContent.includes('synthetic-test-key'));
});
await test('Model-list success with missing model remains a visible warning', async () => {
  response = { ok: true, latencyMs: 3, modelsCount: 8, modelAvailable: false };
  await node('engineTest').listeners.click();
  assert.match(node('engineTestMsg').textContent, /模型不在列表中/);
  assert.match(node('engineTestMsg').className, /err/);
});
await test('Error feedback cannot expose the typed key', async () => {
  response = { ok: false, error: 'Unauthorized synthetic-test-key' };
  await node('engineTest').listeners.click();
  assert(!node('engineTestMsg').textContent.includes('synthetic-test-key'));
  assert.match(node('engineTestMsg').textContent, /密钥已隐藏/);
  assert.match(node('engineTestMsg').textContent, /当前配置未被更改/);
});
await test('Successful save clears key input and shows pending restart truthfully', async () => {
  response = { ...settings, runtimeBackend: 'dsh', requiresRestart: true, dshRequired: true };
  await node('engineForm').listeners.submit({ preventDefault() {} });
  assert.equal(requests.at(-1).path, '/api/engine');
  assert.equal(node('engineApiKey').value, '');
  assert.match(node('engineFormMsg').textContent, /当前引擎尚未切换/);
  assert.match(node('engineRuntimeText').textContent, /DSH 桥接/);
  assert.equal(node('engineSave').disabled, false);
});
await test('Malformed saved configuration still opens an editable repair form', async () => {
  vm.runInContext('engineFormInitialized = false; engineFormDirty = false;', context);
  response = {
    ...settings, ok: false, ready: false,
    config: { ...settings.config, baseUrl: 'https://api.deepseek.com/v1', model: 'preserved-model' },
    error: 'ENGINE_CONFIG: baseUrl must be an HTTPS API base URL',
    secret: { configured: true, source: 'stored' },
  };
  const result = await controller.refreshEngineSettings();
  assert.equal(result.ok, false);
  assert.equal(node('engineAllFields').disabled, false);
  assert.equal(node('engineSave').disabled, false);
  assert.equal(node('engineModel').value, 'preserved-model');
  assert.equal(node('engineApiKey').value, '');
  assert.match(node('engineSecretStatus').textContent, /本地私密文件/);
  assert.match(node('engineFormMsg').textContent, /可修复的设置/);
  assert.match(node('engineFormMsg').className, /err/);
});
await test('Reload retains configuration repair errors instead of claiming success', async () => {
  await node('engineReload').listeners.click();
  assert.match(node('engineFormMsg').textContent, /配置有误/);
  assert.equal(node('engineSave').disabled, false);
});
await test('User can edit and save repaired connection settings without losing valid fields', async () => {
  node('engineBaseUrl').value = 'https://model.example.test/v1';
  node('engineForm').listeners.input();
  response = { ...settings, config: { ...settings.config, baseUrl: 'https://model.example.test/v1', model: 'preserved-model' } };
  await node('engineForm').listeners.submit({ preventDefault() {} });
  const request = requests.at(-1);
  assert.equal(request.path, '/api/engine');
  assert.equal(request.body.config.baseUrl, 'https://model.example.test/v1');
  assert.equal(request.body.config.model, 'preserved-model');
  assert.equal(request.body.config.maxRetries, 0);
  assert.match(node('engineFormMsg').textContent, /设置已保存/);
  assert.equal(node('engineApiKey').value, '');
});

console.log(`\n${passed} engine console tests passed.`);
