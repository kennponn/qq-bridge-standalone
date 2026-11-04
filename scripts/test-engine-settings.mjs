// Offline fixtures only: no provider requests, DSH connection or QQ messages.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import { isHardened } from '../src/state-acl.mjs';
import {
  resolveEngineSettings, resolveEngineBackend, resolveEngineDirectConfig,
  getEngineStatus, applyEngineSettingsPatch, loadStoredEngineKey,
  updateEngineSettings, testEngineConnection
} from '../src/engine-settings.js';

const config = () => ({ dsh: { provider: 'openai-ultrarouter', model: 'fixture-model', directEngine: false }, allow: { groups: [42] }, socialV2: { enabled: true }, unrelated: { fixture: true } });
const standalone = () => applyEngineSettingsPatch(config(), { backend: 'standalone' });
const scoped = (cfg = standalone(), apiKey = 'fixture-secret-only') => {
  const { directLLM } = resolveEngineSettings(cfg);
  return { version: 1, apiKey, scope: { provider: directLLM.provider, baseUrl: directLLM.baseUrl } };
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('legacy configuration remains DSH and migrates without activating direct mode', () => {
  const cfg = config();
  cfg.dsh.directEngine = true;
  const resolved = resolveEngineSettings(cfg);
  assert.equal(resolved.backend, 'dsh');
  assert.equal(resolved.directLLM.provider, 'openai-ultrarouter');
  assert.equal(resolved.directLLM.baseUrl, 'https://ultrarouter.org/v1');
  assert.equal(resolved.directLLM.model, 'fixture-model');
  assert.equal(resolveEngineBackend(cfg, {}), 'dsh');
  assert.equal(resolveEngineBackend(cfg, { QQ_BRIDGE_ENGINE: 'standalone' }), 'standalone');
  assert.throws(() => resolveEngineBackend(cfg, { QQ_BRIDGE_ENGINE: 'direct' }), /QQ_BRIDGE_ENGINE/);
  cfg.dsh.directLLM = { baseUrl: 'not-a-valid-url' };
  assert.equal(resolveEngineBackend(cfg, {}), 'dsh');
  assert.equal(resolveEngineBackend({ engine: { backend: 'dsh', directLLM: { provider: 'invalid' } } }, {}), 'dsh');
  assert.throws(() => resolveEngineBackend({ engine: { backend: 'invalid' } }, {}), /QQ_BRIDGE_ENGINE/);
});

test('UI save materializes independent model config and preserves other fields', () => {
  const original = config();
  const next = applyEngineSettingsPatch(original, { backend: 'standalone', config: { model: 'my-fixture' } });
  assert.equal(original.engine, undefined);
  assert.deepEqual(next.allow, original.allow);
  assert.deepEqual(next.socialV2, original.socialV2);
  assert.deepEqual(next.dsh, original.dsh);
  next.dsh.provider = 'deepseek-official';
  next.dsh.model = 'unrelated-new-dsh-model';
  next.dsh.directLLM = { baseUrl: 'https://legacy.invalid/v1' };
  const settings = resolveEngineSettings(next);
  assert.equal(settings.directLLM.provider, 'openai-ultrarouter');
  assert.equal(settings.directLLM.model, 'my-fixture');
  assert.equal(settings.directLLM.baseUrl, 'https://ultrarouter.org/v1');
  const emptyExplicit = { ...original, engine: { directLLM: {} } };
  assert.equal(resolveEngineSettings(emptyExplicit).directLLM.provider, 'deepseek-official');
});

test('provider-only patch resets endpoint and environment defaults safely', () => {
  const changed = applyEngineSettingsPatch(standalone(), { config: { provider: 'deepseek-official' } });
  const fields = changed.engine.directLLM;
  assert.equal(fields.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(fields.apiKeyEnv, 'DEEPSEEK_API_KEY');
  const custom = applyEngineSettingsPatch(changed, { config: { provider: 'openai-compatible', baseUrl: 'https://localhost:4443/api/v1/' } });
  assert.equal(custom.engine.directLLM.baseUrl, 'https://localhost:4443/api/v1');
  assert.equal(custom.engine.directLLM.apiKeyEnv, 'QQ_DIRECT_API_KEY');
});

test('updates reject unexpected fields, type confusion and prototype pollution', () => {
  const cfg = standalone();
  for (const patch of [
    { directLLM: {} }, { dsh: { authToken: 'x' } }, { backend: 'direct' }, { config: null },
    { config: [] }, { config: { apiKey: 'not-a-model-field' } }, { config: { maxRounds: '8' } },
    { config: { maxRounds: 0 } }, { config: { maxRetries: 4 } }, { config: { requestTimeoutMs: 999 } },
    { config: { turnTimeoutMs: 1500001 } }, { config: { vision: 'true' } },
    { config: { provider: 'unknown' } }, { clearApiKey: 'true' }, { apiKey: null },
    { apiKey: 'key with spaces' }, { apiKey: 'newline\nkey' }, { apiKey: 'x', clearApiKey: true },
    JSON.parse('{"__proto__":{"polluted":true}}'), JSON.parse('{"config":{"__proto__":{"polluted":true}}}')
  ]) assert.throws(() => applyEngineSettingsPatch(cfg, patch), /ENGINE_CONFIG/);
  assert.equal({}.polluted, undefined);
  assert.equal(applyEngineSettingsPatch(cfg, { apiKey: '' }).engine.backend, 'standalone');
});

test('API base URL rejects secret-bearing, insecure and complete endpoint URLs', () => {
  for (const baseUrl of ['http://fixture.invalid/v1', 'https://user:password@fixture.invalid/v1', 'https://fixture.invalid/v1?key=secret', 'https://fixture.invalid/v1#key', 'https://fixture.invalid/v1/chat/completions', 'https://fixture.invalid/v1/CHAT/COMPLETIONS/', 'https://fixture.invalid\\v1', 'https://fixture.invalid/white space', 'not-a-url']) {
    assert.throws(() => applyEngineSettingsPatch(standalone(), { config: { baseUrl } }), /ENGINE_CONFIG/);
  }
  for (const apiKeyEnv of ['', 'WITH-DASH', '1WRONG', 'X'.repeat(81)]) assert.throws(() => applyEngineSettingsPatch(standalone(), { config: { apiKeyEnv } }), /apiKeyEnv/);
});

test('global and configured environment keys outrank scoped stored credentials', () => {
  const cfg = standalone();
  assert.equal(resolveEngineDirectConfig(cfg, { env: { QQ_DIRECT_API_KEY: 'global-fixture', ULTRAROUTER_API_KEY: 'provider-fixture' }, storedApiKey: scoped(cfg) }).apiKey, 'global-fixture');
  assert.equal(resolveEngineDirectConfig(cfg, { env: { ULTRAROUTER_API_KEY: 'provider-fixture' }, storedApiKey: scoped(cfg) }).apiKey, 'provider-fixture');
  assert.equal(resolveEngineDirectConfig(cfg, { env: {}, storedApiKey: scoped(cfg) }).apiKey, 'fixture-secret-only');
  assert.throws(() => resolveEngineDirectConfig(cfg, { env: { DEEPSEEK_API_KEY: 'wrong-provider' } }), /Configure an API key/);
  assert.throws(() => resolveEngineDirectConfig(cfg, { env: { QQ_DIRECT_API_KEY: 'bad\nkey' }, storedApiKey: scoped(cfg) }), /ASCII/);
});

test('stored credentials never silently cross provider or endpoint boundaries', () => {
  const cfg = standalone();
  const old = scoped(cfg);
  for (const patch of [{ config: { baseUrl: 'https://changed.invalid/v1' } }, { config: { provider: 'deepseek-official' } }]) {
    const changed = applyEngineSettingsPatch(cfg, patch);
    assert.throws(() => resolveEngineDirectConfig(changed, { env: {}, storedApiKey: old }), /different provider/);
    const status = getEngineStatus({ cfg: changed, runtimeBackend: 'standalone', storedApiKey: old, env: {} });
    assert.equal(status.ready, false);
    assert.deepEqual(status.secret, { configured: false, source: 'none' });
    assert.ok(!JSON.stringify(status).includes(old.apiKey));
    assert.equal(resolveEngineDirectConfig(changed, { env: { QQ_DIRECT_API_KEY: 'intentional-global' }, storedApiKey: old }).apiKey, 'intentional-global');
  }
  assert.throws(() => resolveEngineDirectConfig(cfg, { env: { QQ_DIRECT_BASE_URL: 'https://override.invalid/v1' }, storedApiKey: old }), /different provider/);
});

test('status distinguishes configured backend, running backend, key and DSH readiness', () => {
  const cfg = standalone();
  const status = getEngineStatus({ cfg, runtimeBackend: 'dsh', dshReady: true, storedApiKey: scoped(cfg), env: {}, activeTurns: 2 });
  assert.equal(status.backend, 'standalone');
  assert.equal(status.runtimeBackend, 'dsh');
  assert.equal(status.requiresRestart, true);
  assert.equal(status.dshRequired, true);
  assert.equal(status.ready, true);
  assert.equal(status.activeTurns, 2);
  assert.equal(status.secret.configured, true);
  assert.equal(status.config.model, 'fixture-model');
  assert.ok(!JSON.stringify(status).includes('fixture-secret-only'));
  const direct = getEngineStatus({ cfg, runtimeBackend: 'standalone', dshReady: false, storedApiKey: scoped(cfg), env: {} });
  assert.equal(direct.ready, true);
  assert.equal(direct.dshRequired, false);
  assert.equal(direct.requiresRestart, false);
  const missing = getEngineStatus({ cfg, runtimeBackend: 'standalone', env: {} });
  assert.equal(missing.ready, false);
  assert.equal(missing.ok, true);
  assert.equal(getEngineStatus({ cfg, runtimeBackend: 'dsh', dshReady: true, env: { QQ_DIRECT_API_KEY: 'invalid\nkey' } }).ready, true);
  assert.equal(getEngineStatus({ cfg: { engine: { backend: 'invalid' } }, env: {} }).ok, false);
});

test('settings and strict updates accept cross-realm plain fixture objects', () => {
  const cfg = vm.runInNewContext('({ dsh: { provider: "openai-ultrarouter", model: "cross-realm-model" } })');
  const patch = vm.runInNewContext('({ backend: "standalone", config: { maxRounds: 8 } })');
  assert.equal(resolveEngineSettings(cfg).directLLM.model, 'cross-realm-model');
  assert.equal(applyEngineSettingsPatch(cfg, patch).engine.directLLM.maxRounds, 8);
});

test('UI repairs malformed saved fields while preserving valid unsubmitted fields', () => {
  const cfg = standalone();
  cfg.engine.directLLM = { ...cfg.engine.directLLM, baseUrl: 'http://insecure.invalid/v1', model: 'keep-this-model', apiKeyEnv: 'KEEP_THIS_ENV', maxRounds: 7, maxRetries: 1, vision: false, webSearch: false };
  const partial = applyEngineSettingsPatch(cfg, { config: { baseUrl: 'https://repaired.invalid/v1' } });
  assert.equal(partial.engine.directLLM.baseUrl, 'https://repaired.invalid/v1');
  for (const field of ['provider', 'model', 'apiKeyEnv', 'maxRounds', 'maxRetries', 'vision', 'webSearch']) assert.equal(partial.engine.directLLM[field], cfg.engine.directLLM[field]);
  assert.deepEqual(partial.unrelated, cfg.unrelated);
  const fullDraft = applyEngineSettingsPatch(cfg, { backend: 'standalone', config: { provider: 'openai-compatible', model: 'repaired-model', baseUrl: 'https://full-draft.invalid/v1', apiKeyEnv: 'MY_MODEL_KEY', requestTimeoutMs: 60000, turnTimeoutMs: 600000, maxRounds: 10, maxRetries: 2, vision: true, webSearch: true } });
  assert.equal(resolveEngineDirectConfig(fullDraft, { env: { MY_MODEL_KEY: 'new-fixture-key' } }).baseURL, 'https://full-draft.invalid/v1');
  for (const [field, invalid, replacement] of [['provider', 'unknown-provider', 'deepseek-official'], ['model', { wrong: true }, 'repaired-model'], ['apiKeyEnv', 'BAD-ENV-NAME', 'REPAIRED_ENV']]) {
    const broken = standalone();
    broken.engine.directLLM[field] = invalid;
    assert.doesNotThrow(() => applyEngineSettingsPatch(broken, { config: { [field]: replacement } }));
  }
  assert.throws(() => applyEngineSettingsPatch(cfg, { config: { unknown: 'not-accepted' } }), /unknown/);
  assert.throws(() => applyEngineSettingsPatch(cfg, JSON.parse('{"config":{"__proto__":{}}}')), /unknown/);
});

test('malformed saved model config produces safe editable status without secret leakage', () => {
  const cfg = standalone();
  cfg.engine.directLLM = { ...cfg.engine.directLLM, baseUrl: 'https://fixture-key-only@unsafe.invalid/v1', model: 'preserved-model', apiKeyEnv: 'BAD-ENV' };
  const status = getEngineStatus({ cfg, runtimeBackend: 'standalone', env: { QQ_DIRECT_API_KEY: 'fixture-key-only' } });
  assert.equal(status.ok, false);
  assert.equal(status.ready, false);
  assert.equal(status.backend, 'standalone');
  assert.equal(status.config.model, 'preserved-model');
  assert.equal(status.config.baseUrl, 'https://ultrarouter.org/v1');
  assert.equal(status.config.apiKeyEnv, 'ULTRAROUTER_API_KEY');
  assert.equal(status.secret.source, 'environment');
  assert.ok(!JSON.stringify(status).includes('fixture-key-only'));
  const dsh = getEngineStatus({ cfg, runtimeBackend: 'dsh', dshReady: true, env: {} });
  assert.equal(dsh.ready, true);
  assert.equal(dsh.requiresRestart, true);
});

test('connection test sends only GET models, rejects redirects and does not persist draft', async () => {
  const cfg = standalone();
  const before = JSON.stringify(cfg);
  let requests = 0;
  const result = await testEngineConnection({ cfg, storedApiKey: scoped(cfg), env: {}, patch: { config: { model: 'draft-model', baseUrl: 'https://draft.invalid/v1' }, apiKey: 'draft-key-only' }, fetchImpl: async (url, options) => {
    requests++;
    assert.equal(url, 'https://draft.invalid/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, 'Bearer draft-key-only');
    assert.equal(options.body, undefined);
    return json({ data: [{ id: 'draft-model' }, { id: 'other-model' }] });
  } });
  assert.equal(requests, 1);
  assert.equal(result.ok, true);
  assert.equal(result.modelsCount, 2);
  assert.equal(result.modelAvailable, true);
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(JSON.stringify(cfg), before);
  assert.ok(!JSON.stringify(result).includes('draft-key-only'));
});

test('draft clearing respects environment override and performs no request without a key', async () => {
  let count = 0;
  const fetchImpl = async () => { count++; return json({ data: [] }); };
  const cfg = standalone();
  const without = await testEngineConnection({ cfg, storedApiKey: scoped(cfg), env: {}, patch: { clearApiKey: true }, fetchImpl });
  assert.equal(without.ok, false);
  assert.equal(count, 0);
  const withEnv = await testEngineConnection({ cfg, storedApiKey: scoped(cfg), env: { QQ_DIRECT_API_KEY: 'environment-key' }, patch: { clearApiKey: true }, fetchImpl });
  assert.equal(withEnv.ok, true);
  assert.equal(count, 1);
});

test('connection test handles missing model, HTTP errors and untrusted error messages', async () => {
  const base = { cfg: standalone(), storedApiKey: scoped(), env: {} };
  const absent = await testEngineConnection({ ...base, fetchImpl: async () => json({ data: [{ id: 'not-configured-model' }] }) });
  assert.equal(absent.ok, true);
  assert.equal(absent.modelAvailable, false);
  const unauthorized = await testEngineConnection({ ...base, fetchImpl: async () => json({ echoedKey: 'fixture-secret-only' }, 401) });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.error, /HTTP 401/);
  assert.ok(!JSON.stringify(unauthorized).includes('fixture-secret-only'));
  const failed = await testEngineConnection({ ...base, fetchImpl: async () => { throw new Error('fixture-secret-only'); } });
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes('fixture-secret-only'));
});

test('connection test bounds and validates provider response', async () => {
  const base = { cfg: standalone(), storedApiKey: scoped(), env: {} };
  for (const response of [new Response('not JSON'), json({ data: {} }), json({ data: [null] }), json({ data: [{ id: 42 }] }), json({ data: Array(10001).fill({ id: 'fixture' }) }), new Response('x'.repeat(1024 * 1024 + 1))]) {
    const result = await testEngineConnection({ ...base, fetchImpl: async () => response });
    assert.equal(result.ok, false);
    assert.match(result.error, /JSON|malformed|limit/);
  }
});

test('connection deadline remains effective when mocked fetch ignores abort', async () => {
  const result = await testEngineConnection({ cfg: standalone(), storedApiKey: scoped(), env: {}, timeoutMs: 100, fetchImpl: async () => { await sleep(150); return json({ data: [{ id: 'fixture-model' }] }); } });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  await sleep(80);
  assert.equal(result.ok, false);
  assert.equal(result.modelsCount, 0);
});

test('connection deadline cancels an unbounded response stream', async () => {
  let canceled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { canceled = true; } });
  const result = await testEngineConnection({ cfg: standalone(), storedApiKey: scoped(), env: {}, timeoutMs: 100, fetchImpl: async () => new Response(stream) });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
  assert.equal(canceled, true);
});

test('private atomic save preserves latest unrelated config and never writes key into config', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-engine-settings-'));
  const configPath = path.join(directory, 'config.json');
  const secretPath = path.join(directory, 'state', 'direct-engine-secret.json');
  try {
    const initial = config();
    fs.writeFileSync(configPath, JSON.stringify({ ...initial, externalChange: { retained: true } }));
    const saved = await updateEngineSettings({ configPath, secretPath, cfg: initial, patch: { backend: 'standalone', apiKey: 'saved-fixture-key' }, env: {}, runtimeBackend: 'dsh' });
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(disk.externalChange, { retained: true });
    assert.deepEqual(disk.dsh, initial.dsh);
    assert.ok(!fs.readFileSync(configPath, 'utf8').includes('saved-fixture-key'));
    assert.ok(!JSON.stringify(saved.status).includes('saved-fixture-key'));
    assert.equal(saved.status.requiresRestart, true);
    assert.equal(saved.status.secret.source, 'stored');
    assert.equal(loadStoredEngineKey(secretPath).apiKey, 'saved-fixture-key');
    assert.equal(isHardened(secretPath), true);
    assert.equal(isHardened(configPath), true);
    assert.equal(fs.readdirSync(directory).some((entry) => entry.endsWith('.tmp')), false);
    assert.equal(fs.readdirSync(path.dirname(secretPath)).some((entry) => entry.endsWith('.tmp')), false);
    const cleared = await updateEngineSettings({ configPath, secretPath, cfg: saved.config, patch: { clearApiKey: true }, env: {}, runtimeBackend: 'standalone' });
    assert.equal(loadStoredEngineKey(secretPath), null);
    assert.equal(cleared.status.secret.configured, false);
    assert.equal(cleared.status.ok, true);
    assert.equal(cleared.status.ready, false);
    assert.ok(!fs.readFileSync(secretPath, 'utf8').includes('saved-fixture-key'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('invalid updates do not modify either persisted file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-engine-settings-'));
  const configPath = path.join(directory, 'config.json');
  const secretPath = path.join(directory, 'direct-engine-secret.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(standalone()));
    fs.writeFileSync(secretPath, JSON.stringify(scoped()));
    const before = [fs.readFileSync(configPath, 'utf8'), fs.readFileSync(secretPath, 'utf8')];
    await assert.rejects(updateEngineSettings({ configPath, secretPath, cfg: standalone(), patch: { config: { maxRounds: 1000 }, apiKey: 'new-fixture-key' }, env: {} }), /maxRounds/);
    assert.deepEqual([fs.readFileSync(configPath, 'utf8'), fs.readFileSync(secretPath, 'utf8')], before);
    fs.writeFileSync(secretPath, '{malformed-json-containing-fixture-secret-only');
    assert.throws(() => loadStoredEngineKey(secretPath), (error) => !error.message.includes('fixture-secret-only'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('clear and replacement can repair corrupt credential state without disclosing it', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-engine-settings-'));
  const configPath = path.join(directory, 'config.json');
  const secretPath = path.join(directory, 'direct-engine-secret.json');
  try {
    fs.writeFileSync(configPath, JSON.stringify(standalone()));
    fs.writeFileSync(secretPath, 'corrupt-state-with-old-fixture-key');
    await updateEngineSettings({ configPath, secretPath, cfg: standalone(), patch: { clearApiKey: true }, env: {} });
    assert.equal(loadStoredEngineKey(secretPath), null);
    fs.writeFileSync(secretPath, 'corrupt-state-with-old-fixture-key');
    const replaced = await updateEngineSettings({ configPath, secretPath, cfg: standalone(), patch: { apiKey: 'replacement-fixture-key' }, env: {}, runtimeBackend: 'standalone' });
    assert.equal(loadStoredEngineKey(secretPath).apiKey, 'replacement-fixture-key');
    assert.equal(replaced.status.ready, true);
    assert.ok(!JSON.stringify(replaced.status).includes('replacement-fixture-key'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
