import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { hardenFile, icacls, isHardened } from './state-acl.mjs';

const PROVIDERS = new Set(['deepseek-official', 'openai-ultrarouter', 'openai-compatible']);
const BACKENDS = new Set(['dsh', 'standalone']);
const FIELDS = new Set(['provider', 'model', 'baseUrl', 'apiKeyEnv', 'requestTimeoutMs', 'turnTimeoutMs', 'maxRounds', 'maxRetries', 'vision', 'webSearch']);
const LIMITS = { requestTimeoutMs: [1000, 300000], turnTimeoutMs: [1000, 1500000], maxRounds: [1, 40], maxRetries: [0, 3] };
const DEFAULTS = { requestTimeoutMs: 90000, turnTimeoutMs: 900000, maxRounds: 16, maxRetries: 2, vision: true, webSearch: true };
const PROVIDER_DEFAULTS = {
  'deepseek-official': { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  'openai-ultrarouter': { baseUrl: 'https://ultrarouter.org/v1', apiKeyEnv: 'ULTRAROUTER_API_KEY' },
  'openai-compatible': { baseUrl: '', apiKeyEnv: 'QQ_DIRECT_API_KEY' }
};
const fail = (message) => new Error(`ENGINE_CONFIG: ${message}`);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.prototype.toString.call(value) === '[object Object]';

function ownObject(value, label) {
  if (!object(value)) throw fail(`${label} must be an object`);
  return value;
}

function bounded(value, fallback, min, max) {
  return Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.round(Number(value)))) : fallback;
}

function apiBase(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail('baseUrl must be a URL no longer than 2048 characters');
  const base = value.trim();
  if (!base) return '';
  let url;
  try { url = new URL(base); } catch { throw fail('baseUrl must be a valid HTTPS API base URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[\x00-\x20\x7f\\]/.test(base)) {
    throw fail('baseUrl must use HTTPS without credentials, whitespace, query or fragment');
  }
  if (/\/chat\/completions\/?$/i.test(url.pathname)) throw fail('baseUrl must not include the chat/completions endpoint');
  return url.href.replace(/\/+$/, '');
}

function modelName(value) {
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw fail('model must be a printable string no longer than 200 characters');
  return value.trim();
}

function keyEnvName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value)) throw fail('apiKeyEnv must be an environment variable name');
  return value;
}

function validKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[^\x21-\x7e]/.test(value)) throw fail('API key must be a nonempty printable ASCII token without whitespace');
  if (!value) throw fail('API key is empty');
  return value;
}

function editableEngineSettings(cfg = {}) {
  const engine = object(cfg.engine) ? cfg.engine : {};
  const migrated = !object(engine.directLLM);
  const legacy = object(cfg.dsh) ? cfg.dsh : {};
  const options = migrated ? (object(legacy.directLLM) ? legacy.directLLM : {}) : engine.directLLM;
  const providerValue = options.provider || (migrated ? legacy.provider : '') || 'deepseek-official';
  const provider = PROVIDERS.has(providerValue) ? providerValue : 'openai-compatible';
  const defaults = PROVIDER_DEFAULTS[provider];
  const safe = (resolve, value, fallback) => { try { return resolve(value); } catch { return fallback; } };
  return {
    backend: BACKENDS.has(engine.backend) ? engine.backend : 'dsh',
    directLLM: {
      provider,
      model: safe(modelName, options.model || (migrated ? legacy.model : '') || (provider === 'deepseek-official' ? 'deepseek-chat' : ''), provider === 'deepseek-official' ? 'deepseek-chat' : ''),
      baseUrl: safe(apiBase, options.baseUrl || defaults.baseUrl, defaults.baseUrl),
      apiKeyEnv: safe(keyEnvName, options.apiKeyEnv || defaults.apiKeyEnv, defaults.apiKeyEnv),
      ...Object.fromEntries(Object.entries(LIMITS).map(([key, [min, max]]) => [key, bounded(options[key], DEFAULTS[key], min, max)])),
      vision: options.vision !== false,
      webSearch: options.webSearch !== false
    }
  };
}

export function resolveEngineSettings(cfg = {}) {
  const engine = object(cfg.engine) ? cfg.engine : {};
  const migrated = !object(engine.directLLM);
  const legacy = object(cfg.dsh) ? cfg.dsh : {};
  const options = migrated ? (object(legacy.directLLM) ? legacy.directLLM : {}) : engine.directLLM;
  const providerValue = options.provider || (migrated ? legacy.provider : '') || 'deepseek-official';
  const provider = PROVIDERS.has(providerValue) ? providerValue : (migrated ? 'openai-compatible' : providerValue);
  if (!PROVIDERS.has(provider)) throw fail('provider must be deepseek-official, openai-ultrarouter or openai-compatible');
  const backend = engine.backend ?? 'dsh';
  if (!BACKENDS.has(backend)) throw fail('backend must be dsh or standalone');
  const defaults = PROVIDER_DEFAULTS[provider];
  const directLLM = {
    provider,
    model: modelName(options.model || (migrated ? legacy.model : '') || (provider === 'deepseek-official' ? 'deepseek-chat' : '')),
    baseUrl: apiBase(options.baseUrl || defaults.baseUrl),
    apiKeyEnv: keyEnvName(options.apiKeyEnv || defaults.apiKeyEnv),
    ...Object.fromEntries(Object.entries(LIMITS).map(([key, [min, max]]) => [key, bounded(options[key], DEFAULTS[key], min, max)])),
    vision: options.vision !== false,
    webSearch: options.webSearch !== false
  };
  return { backend, directLLM };
}

export function resolveEngineBackend(cfg, env = process.env) {
  const backend = env.QQ_BRIDGE_ENGINE || (object(cfg?.engine) ? cfg.engine.backend : undefined) || 'dsh';
  if (!BACKENDS.has(backend)) throw fail('QQ_BRIDGE_ENGINE must be dsh or standalone');
  return backend;
}

function credential(settings, env, storedApiKey) {
  const supplied = env.QQ_DIRECT_API_KEY || env[settings.apiKeyEnv];
  if (supplied) return { apiKey: validKey(String(supplied).trim()), source: 'environment' };
  if (typeof storedApiKey === 'string' && storedApiKey) return { apiKey: validKey(storedApiKey), source: 'stored' };
  if (object(storedApiKey) && storedApiKey.apiKey) {
    if (storedApiKey.scope?.baseUrl !== settings.baseUrl || storedApiKey.scope?.provider !== settings.provider) {
      return { apiKey: '', source: 'none', error: 'Stored API key belongs to a different provider or API endpoint; enter a new key for this endpoint.' };
    }
    return { apiKey: validKey(storedApiKey.apiKey), source: 'stored' };
  }
  return { apiKey: '', source: 'none', error: `Configure an API key in the engine UI or environment variable ${settings.apiKeyEnv}.` };
}

export function resolveEngineDirectConfig(cfg, { env = process.env, storedApiKey } = {}) {
  const { directLLM } = resolveEngineSettings(cfg);
  const baseURL = apiBase(env.QQ_DIRECT_BASE_URL || directLLM.baseUrl);
  if (!baseURL) throw fail('configure a HTTPS API baseUrl');
  if (!directLLM.model) throw fail('model is required');
  const key = credential({ ...directLLM, baseUrl: baseURL }, env, storedApiKey);
  if (!key.apiKey) throw fail(key.error);
  const { baseUrl: _baseUrl, apiKeyEnv: _apiKeyEnv, ...options } = directLLM;
  return { ...options, baseURL, apiKey: key.apiKey };
}

export function getEngineStatus({ cfg, runtimeBackend, storedApiKey, env = process.env, dshReady = false, activeTurns } = {}) {
  const result = { ok: true, backend: 'dsh', runtimeBackend: runtimeBackend || 'dsh', requiresRestart: false, ready: false, dshRequired: runtimeBackend !== 'standalone', config: {}, secret: { configured: false, source: 'none' } };
  if (Number.isSafeInteger(activeTurns) && activeTurns >= 0) result.activeTurns = activeTurns;
  try {
    const settings = resolveEngineSettings(cfg);
    Object.assign(result, { backend: settings.backend, config: settings.directLLM });
    result.runtimeBackend = runtimeBackend || resolveEngineBackend(cfg, env);
    if (!BACKENDS.has(result.runtimeBackend)) throw fail('runtime backend must be dsh or standalone');
    result.requiresRestart = result.backend !== result.runtimeBackend;
    result.dshRequired = result.runtimeBackend === 'dsh';
    result.ready = result.runtimeBackend === 'dsh' && dshReady === true;
    try {
      const baseURL = apiBase(env.QQ_DIRECT_BASE_URL || settings.directLLM.baseUrl);
      const key = credential({ ...settings.directLLM, baseUrl: baseURL }, env, storedApiKey);
      result.secret = { configured: Boolean(key.apiKey), source: key.source };
      if (result.runtimeBackend === 'standalone') {
        resolveEngineDirectConfig(cfg, { env, storedApiKey });
        result.ready = true;
      }
      if (!key.apiKey) result.error = key.error;
    } catch (error) {
      result.error = /^ENGINE_CONFIG: /.test(error?.message || '') ? error.message : 'ENGINE_CONFIG: engine is not ready';
    }
  } catch (error) {
    result.ok = false;
    result.error = /^ENGINE_CONFIG: /.test(error?.message || '') ? error.message : 'ENGINE_CONFIG: invalid engine configuration';
    const editable = editableEngineSettings(cfg);
    result.backend = editable.backend;
    result.config = editable.directLLM;
    result.runtimeBackend = BACKENDS.has(runtimeBackend) ? runtimeBackend : editable.backend;
    result.requiresRestart = result.backend !== result.runtimeBackend;
    result.dshRequired = result.runtimeBackend === 'dsh';
    result.ready = result.dshRequired && dshReady === true;
    try {
      const key = credential({ ...editable.directLLM, baseUrl: apiBase(env.QQ_DIRECT_BASE_URL || editable.directLLM.baseUrl) }, env, storedApiKey);
      result.secret = { configured: Boolean(key.apiKey), source: key.source };
    } catch {}
  }
  return result;
}

export function applyEngineSettingsPatch(cfg, patch) {
  ownObject(cfg, 'configuration');
  ownObject(patch, 'patch');
  for (const key of Object.keys(patch)) if (!['backend', 'config', 'apiKey', 'clearApiKey'].includes(key)) throw fail('unknown engine update field');
  if ('backend' in patch && !BACKENDS.has(patch.backend)) throw fail('backend must be dsh or standalone');
  if ('clearApiKey' in patch && typeof patch.clearApiKey !== 'boolean') throw fail('clearApiKey must be boolean');
  if ('apiKey' in patch && typeof patch.apiKey !== 'string') throw fail('apiKey must be a string');
  if (patch.apiKey) validKey(patch.apiKey);
  if (patch.clearApiKey && patch.apiKey) throw fail('enter a key or clear the stored key, not both');
  // A settings editor must be able to repair malformed saved fields; keep all
  // other valid values rather than resolving the broken config before merging.
  const initial = editableEngineSettings(cfg);
  const directLLM = { ...initial.directLLM };
  if ('config' in patch) {
    ownObject(patch.config, 'config');
    for (const key of Object.keys(patch.config)) if (!FIELDS.has(key)) throw fail('unknown model configuration field');
    if ('provider' in patch.config && !PROVIDERS.has(patch.config.provider)) throw fail('unsupported provider');
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      if (key in patch.config && (!Number.isSafeInteger(patch.config[key]) || patch.config[key] < min || patch.config[key] > max)) throw fail(`${key} must be an integer between ${min} and ${max}`);
    }
    for (const key of ['vision', 'webSearch']) if (key in patch.config && typeof patch.config[key] !== 'boolean') throw fail(`${key} must be boolean`);
    if ('model' in patch.config) modelName(patch.config.model);
    if ('baseUrl' in patch.config) apiBase(patch.config.baseUrl);
    if ('apiKeyEnv' in patch.config) keyEnvName(patch.config.apiKeyEnv);
    if (patch.config.provider && patch.config.provider !== directLLM.provider) {
      const nextDefaults = PROVIDER_DEFAULTS[patch.config.provider];
      if (!('baseUrl' in patch.config)) directLLM.baseUrl = nextDefaults.baseUrl;
      if (!('apiKeyEnv' in patch.config)) directLLM.apiKeyEnv = nextDefaults.apiKeyEnv;
    }
    Object.assign(directLLM, patch.config);
  }
  const merged = { ...cfg, engine: { ...(object(cfg.engine) ? cfg.engine : {}), backend: patch.backend ?? initial.backend, directLLM } };
  merged.engine.directLLM = resolveEngineSettings(merged).directLLM;
  return merged;
}

function secretRecord(config, key, env = process.env) {
  const { directLLM } = resolveEngineSettings(config);
  const baseUrl = apiBase(env.QQ_DIRECT_BASE_URL || directLLM.baseUrl);
  if (!baseUrl) throw fail('configure a HTTPS API baseUrl before storing its API key');
  return { version: 1, apiKey: validKey(key), scope: { provider: directLLM.provider, baseUrl } };
}

export function loadStoredEngineKey(secretPath) {
  try {
    const info = fs.lstatSync(secretPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw fail('stored credential file is invalid');
    const data = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
    if (object(data) && data.version === 1 && data.cleared === true && !('apiKey' in data)) return null;
    if (!object(data) || data.version !== 1 || !object(data.scope) || !PROVIDERS.has(data.scope.provider) || !data.scope.baseUrl) throw fail('stored credential format is invalid');
    return { version: 1, apiKey: validKey(data.apiKey), scope: { provider: data.scope.provider, baseUrl: apiBase(data.scope.baseUrl) } };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw fail('cannot read the stored API key; repair or clear the credential file');
  }
}

function privateTemp(file, value) {
  const directory = path.dirname(path.resolve(file));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    // Windows ignores mode bits. Restrict the empty file before writing secrets.
    const hardened = hardenFile(temp);
    if (!hardened.ok) throw fail('cannot protect settings file permissions');
    if (process.platform === 'win32') {
      const removal = icacls([temp, '/remove:g', '*S-1-5-11', '*S-1-5-32-545', '*S-1-1-0', '/Q']);
      if (removal.error || removal.status !== 0) throw fail('cannot protect settings file permissions');
    }
    if (!isHardened(temp)) throw fail('cannot verify private settings file permissions');
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return temp;
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

async function replaceTemp(temp, target) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temp, target); return; }
    catch (error) {
      if (attempt >= 3 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw fail('cannot atomically save engine settings');
      await sleep(25 * (attempt + 1));
    }
  }
}

const saving = new Set();
export async function updateEngineSettings({ configPath, secretPath, cfg, patch, env = process.env, runtimeBackend, dshReady, activeTurns }) {
  const target = path.resolve(configPath);
  if (saving.has(target)) throw fail('another engine settings update is in progress');
  saving.add(target);
  let configTemp;
  let secretTemp;
  let rollbackTemp;
  try {
    let current = cfg;
    try { current = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw fail('cannot read current configuration'); }
    const merged = applyEngineSettingsPatch(current, patch);
    const changeSecret = patch.clearApiKey === true || Boolean(patch.apiKey);
    // Replacement/clear must remain usable even if an old credential file is corrupt.
    const stored = patch.clearApiKey ? null : patch.apiKey ? secretRecord(merged, patch.apiKey, env) : loadStoredEngineKey(secretPath);
    configTemp = privateTemp(target, merged);
    if (changeSecret) {
      secretTemp = privateTemp(secretPath, stored || { version: 1, cleared: true });
      rollbackTemp = privateTemp(target, current);
    }
    await replaceTemp(configTemp, target);
    configTemp = undefined;
    try {
      if (changeSecret) {
        await replaceTemp(secretTemp, secretPath);
        secretTemp = undefined;
      }
    } catch (error) {
      if (rollbackTemp) { await replaceTemp(rollbackTemp, target); rollbackTemp = undefined; }
      throw error;
    }
    return { config: merged, status: getEngineStatus({ cfg: merged, runtimeBackend, storedApiKey: stored, env, dshReady, activeTurns }) };
  } finally {
    for (const temp of [configTemp, secretTemp, rollbackTemp].filter(Boolean)) try { fs.unlinkSync(temp); } catch {}
    saving.delete(target);
  }
}

async function boundedJson(response, signal) {
  if (!response.body?.getReader) throw fail('provider returned an unsupported model list response');
  const reader = response.body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw fail('provider model list exceeds the response limit');
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('provider returned an invalid JSON model list'); }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}

export async function testEngineConnection({ cfg, patch, storedApiKey, env = process.env, fetchImpl = fetch, timeoutMs = 10000 }) {
  const started = performance.now();
  const result = { ok: false, latencyMs: 0, modelAvailable: false, modelsCount: 0 };
  const controller = new AbortController();
  let timer;
  let response;
  try {
    const draft = patch ? applyEngineSettingsPatch(cfg, patch) : cfg;
    let stored = patch?.clearApiKey ? null : storedApiKey;
    if (patch?.apiKey) stored = secretRecord(draft, patch.apiKey, env);
    const config = resolveEngineDirectConfig(draft, { env, storedApiKey: stored });
    const deadline = bounded(timeoutMs, 10000, 100, 30000);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail('connection test timed out')); }, deadline);
    });
    const operation = (async () => {
      try {
        response = await fetchImpl(`${config.baseURL}/models`, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${config.apiKey}` }, redirect: 'error', signal: controller.signal });
        controller.signal.throwIfAborted();
        if (!response.ok) throw fail(`provider returned HTTP ${response.status}`);
        const data = await boundedJson(response, controller.signal);
        controller.signal.throwIfAborted();
        if (!Array.isArray(data?.data) || data.data.length > 10000 || data.data.some((item) => typeof item?.id !== 'string')) throw fail('provider returned a malformed model list');
        result.modelsCount = data.data.length;
        result.modelAvailable = data.data.some((item) => item.id === config.model);
        result.ok = true;
      } finally { await response?.body?.cancel().catch(() => {}); }
    })();
    await Promise.race([operation, timeout]);
  } catch (error) {
    result.error = /^ENGINE_CONFIG: /.test(error?.message || '') ? error.message : 'ENGINE_CONFIG: connection failed; check endpoint, API key and network';
  } finally {
    clearTimeout(timer);
    controller.abort();
    await response?.body?.cancel().catch(() => {});
    result.latencyMs = Math.round(performance.now() - started);
  }
  return result;
}
