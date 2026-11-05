// Full-process offline checks. All peers, credentials, files and QQ events are fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONSOLE_TOKEN = 'fixture-standalone-console-token';
const MODEL_KEY = 'fixture-standalone-model-secret';
const GATEWAY_KEY = 'fixture-standalone-gateway-secret';
const legacyState = { sessions: { 'private:123': 'fixture-old-dsh-session' }, sessionPolicies: {} };

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function wsFrame(value, opcode = 1) {
  const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (payload.length < 126) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}

// A minimal local-only RFC6455 peer avoids adding a websocket test dependency.
function attachGateway(server, calls, sockets) {
  const actionResult = (action) => {
    if (action === 'get_login_info') return { user_id: 999, nickname: 'fixture-bot' };
    if (action === 'get_status') return { online: true, good: true };
    return {};
  };
  server.on('upgrade', (req, socket, head) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    const consume = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        const masked = Boolean(buffer[1] & 0x80);
        let size = buffer[1] & 0x7f;
        let offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        if (size === 127) { socket.destroy(); return; }
        const maskBytes = masked ? 4 : 0;
        if (buffer.length < offset + maskBytes + size) return;
        const mask = buffer.subarray(offset, offset + maskBytes);
        const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + size));
        buffer = buffer.subarray(offset + maskBytes + size);
        if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(wsFrame('', 8)); return; }
        if (opcode === 9) { socket.write(wsFrame(payload.toString(), 10)); continue; }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString('utf8'));
        calls.push({ transport: 'ws', action: message.action, params: message.params });
        socket.write(wsFrame({ status: 'ok', retcode: 0, echo: message.echo, data: actionResult(message.action) }));
      }
    };
    socket.on('data', consume);
    if (head.length) consume(head);
  });
  return actionResult;
}

async function createFixture() {
  const tempBase = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempBase, 'qq-standalone-process-'));
  const calls = { dsh: [], gateway: [], models: [], catalogs: [] };
  const sockets = new Set();
  let modelHold = null;
  let modelEntered = null;
  let child;
  let output = '';
  const servers = [];
  const fixture = { root, calls, get output() { return output; } };
  fixture.close = async () => {
    modelHold?.();
    if (child && child.exitCode == null) {
      child.kill();
      await Promise.race([once(child, 'exit').catch(() => {}), delay(5000, undefined, { ref: false })]);
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(async (server) => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }));
    // Unlink the known dependency junction before removing only this verified fixture.
    const relative = path.relative(tempBase, path.resolve(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.match(path.basename(root), /^qq-standalone-process-/);
    const modulesLink = path.join(root, 'node_modules');
    if (fs.existsSync(modulesLink)) fs.unlinkSync(modulesLink);
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const modules = path.resolve(process.env.QQ_BRIDGE_TEST_MODULES || path.join(ROOT, 'node_modules'));
    assert.ok(fs.existsSync(modules), 'Install dependencies, or set QQ_BRIDGE_TEST_MODULES to an existing node_modules directory');
    fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'prompts'), path.join(root, 'prompts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.symlinkSync(modules, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(path.join(root, 'state'));
    fs.writeFileSync(path.join(root, 'state', 'sessions.json'), JSON.stringify(legacyState));
    fs.writeFileSync(path.join(root, 'state', 'mode.json'), JSON.stringify({ mode: 'chat' }));

    const dsh = http.createServer((req, res) => { calls.dsh.push(req.url); json(res, { error: 'Fixture DSH is unavailable' }, 503); });
    servers.push(dsh);
    const dshPort = await listen(dsh);
    const gateway = http.createServer(async (req, res) => {
      const action = req.url.slice(1);
      calls.gateway.push({ transport: 'http', action, params: await readJson(req) });
      json(res, { status: 'ok', retcode: 0, data: actionResult(action) });
    });
    const actionResult = attachGateway(gateway, calls.gateway, sockets);
    servers.push(gateway);
    const gatewayPort = await listen(gateway);
    const model = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        calls.catalogs.push({ authorization: req.headers.authorization });
        json(res, { data: [{ id: 'fixture' }, { id: 'fixture-updated' }] });
        return;
      }
      const body = await readJson(req);
      calls.models.push({ body, authorization: req.headers.authorization });
      modelEntered?.();
      if (modelHold) await new Promise((resolve) => { modelHold = resolve; });
      const silent = !body.tools?.some((tool) => /^qq_(send_|reply$)/.test(tool.function.name));
      const message = silent ? { role: 'assistant', content: 'Fixture private commentary; never send to QQ.' }
        : { role: 'assistant', content: null, tool_calls: [{ id: `fixture-close-${calls.models.length}`, type: 'function', function: { name: 'qq_mark_read', arguments: JSON.stringify({ throughSeq: 0 }) } }] };
      if (!res.destroyed) json(res, { model: 'fixture', choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    });
    servers.push(model);
    const modelPort = await listen(model);
    const portReservation = http.createServer();
    const consolePort = await listen(portReservation);
    await new Promise((resolve) => portReservation.close(resolve));

    const config = {
      engine: { backend: 'standalone', directLLM: { provider: 'openai-compatible', baseUrl: 'https://model.invalid/v1', model: 'fixture', apiKeyEnv: 'QQ_DIRECT_API_KEY', webSearch: false, maxRetries: 0, requestTimeoutMs: 10000 } },
      dsh: { baseUrl: `http://127.0.0.1:${dshPort}`, authToken: 'fixture-old-dsh-secret', directEngine: false },
      snowluma: { wsUrl: `ws://127.0.0.1:${gatewayPort}`, httpUrl: `http://127.0.0.1:${gatewayPort}`, homeDir: path.join(root, 'fake-snowluma-home'), accessToken: GATEWAY_KEY, followDiscoveredEndpoint: false },
      consolePort, consoleToken: CONSOLE_TOKEN, ownerQQ: 123,
      allow: { private: [123], groups: [456] }, allowAllWhenEmpty: false,
      social: { enabled: false }, slang: { enabled: false },
      socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, wake: { preSleepWaitEnabled: false } }
    };
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
    const preload = path.join(root, 'fixture-preload.mjs');
    fs.writeFileSync(preload, `
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input.url || String(input);
  const url = new URL(raw);
  if (url.origin === 'https://model.invalid') return nativeFetch('http://127.0.0.1:${modelPort}' + url.pathname, init);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Fixture blocked non-local request: ' + url.hostname);
  return nativeFetch(input, init);
};
`);
    const env = { ...process.env, HOME: root, USERPROFILE: root, DSH_HOME: path.join(root, 'fake-dsh-home'), SNOWLUMA_HOME: path.join(root, 'fake-snowluma-home'), QQ_DIRECT_API_KEY: MODEL_KEY };
    for (const name of ['NODE_OPTIONS', 'QQ_BRIDGE_ENGINE', 'DSH_LAUNCH_TOKEN', 'SNOWLUMA_TOKEN', 'SNOWLUMA_HTTP_URL', 'QQ_DIRECT_BASE_URL', 'DEEPSEEK_API_KEY', 'ULTRAROUTER_API_KEY', 'OPENAI_API_KEY']) delete env[name];
    child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'src', 'bridge.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', (error) => { output += error.stack; });
    fixture.api = async (route, body, headers = {}) => {
      const res = await fetch(`http://127.0.0.1:${consolePort}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-console-token': CONSOLE_TOKEN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000)
      });
      return { status: res.status, body: await res.json() };
    };
    fixture.state = (name) => JSON.parse(fs.readFileSync(path.join(root, 'state', name), 'utf8'));
    fixture.notify = (key = 'private:123') => fixture.api('/api/console/notify-ai', { key, message: 'Fixture administrative note; do not forward this note.' });
    fixture.waitIdle = async (modelCount) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const status = await fixture.api('/api/engine');
        if (calls.models.length >= modelCount && status.body.activeTurns === 0) return;
        await delay(30);
      }
      throw new Error(`Fixture direct turn did not finish:\n${output}`);
    };
    fixture.holdNextModel = () => {
      modelHold = () => {};
      return new Promise((resolve) => { modelEntered = () => { modelEntered = null; resolve(); }; });
    };
    fixture.releaseModel = () => { const release = modelHold; modelHold = null; release?.(); };
    const deadline = Date.now() + 15000;
    let lastReadiness = null;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`Fixture bridge exited ${child.exitCode}:\n${output}`);
      try { const status = await fixture.api('/api/status'); lastReadiness = status; if (status.status === 200) return fixture; }
      catch (error) { lastReadiness = String(error?.message || error); }
      await delay(100);
    }
    throw new Error(`Fixture bridge did not expose its console: ${JSON.stringify(lastReadiness)}\n${output}`);
  } catch (error) { await fixture.close(); throw error; }
}

test('standalone bridge runs independently with only local mocked peers', { timeout: 90000 }, async (t) => {
  const h = await createFixture();
  t.after(() => h.close());

  await t.test('startup ignores the old DSH mode and preserves its separate state', async () => {
    const status = await h.api('/api/status');
    assert.equal(status.body.mode, 'reserved2');
    assert.equal('dshReady' in status.body, false);
    assert.equal(status.body.engine.runtimeBackend, 'standalone');
    assert.equal('dshRequired' in status.body.engine, false);
    assert.equal(status.body.engine.ready, true);
    assert.deepEqual(h.state('sessions.json'), legacyState);
    assert.equal(h.calls.dsh.length, 0);
    assert.equal(fs.existsSync(path.join(h.root, 'dsh')), false);
  });

  await t.test('silent direct dispatch creates and completes a local session without DSH', async () => {
    const started = Date.now();
    const notified = await h.notify();
    assert.equal(notified.status, 200, JSON.stringify(notified.body) + '\n' + h.output);
    assert.equal(notified.body.ok, true);
    assert.match(notified.body.sessionId, /^local:/);
    assert.ok(Date.now() - started < 10000, 'Offline DSH must not delay direct dispatch');
    const sessions = h.state('sessions-standalone.json');
    assert.equal(sessions.sessions['private:123'], notified.body.sessionId);
    assert.ok(sessions.sessionPolicies['private:123']);
    assert.equal(h.calls.models.length, 1);
    assert.equal(h.calls.models[0].authorization, `Bearer ${MODEL_KEY}`);
    const request = JSON.stringify(h.calls.models[0].body);
    const social = h.state('social-v2.json');
    const conversation = social.conversations?.['private:123'];
    for (const secret of [MODEL_KEY, GATEWAY_KEY, CONSOLE_TOKEN, 'fixture-old-dsh-secret', conversation?.agentToken].filter(Boolean)) assert.ok(!request.includes(secret), 'Host credentials must not leak to model messages/tools');
    assert.ok(!h.calls.models[0].body.tools.some((tool) => /^qq_(send_|reply$)/.test(tool.function.name)), 'Silent dispatch excludes sending tools');
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('engine UI reads, saves and tests the standalone model without exposing its key', async () => {
    const status = await h.api('/api/engine');
    assert.equal(status.status, 200);
    assert.equal(status.body.backend, 'standalone');
    assert.equal(status.body.ready, true);
    assert.equal(status.body.secret.source, 'environment');
    const save = await h.api('/api/engine', { backend: 'standalone', config: { model: 'fixture-updated', maxRounds: 7 } });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal(save.body.config.model, 'fixture-updated');
    assert.equal(save.body.requiresRestart, false);
    const disk = JSON.parse(fs.readFileSync(path.join(h.root, 'config.json'), 'utf8'));
    assert.equal(disk.engine.directLLM.model, 'fixture-updated');
    assert.equal(disk.engine.directLLM.maxRounds, 7);
    assert.ok(!JSON.stringify(disk).includes(MODEL_KEY));
    const tested = await h.api('/api/engine/test', {});
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.ok, true);
    assert.equal(tested.body.modelAvailable, true);
    assert.equal(h.calls.catalogs.length, 1);
    assert.equal(h.calls.catalogs[0].authorization, `Bearer ${MODEL_KEY}`);
    assert.equal(h.calls.models.length, 1, 'Connectivity testing lists models without generating a conversation');
    for (const body of [status.body, save.body, tested.body]) assert.ok(!JSON.stringify(body).includes(MODEL_KEY));
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('standalone safety prompt editing and backups are local and hot-applied', async () => {
    const route = '/api/preset/sim-prompt';
    const original = await h.api(route + '?preset=qq-chat-v2');
    assert.equal(original.status, 200, JSON.stringify(original.body));
    assert.equal(original.body.status.sourceFile, 'prompts/standalone-system.txt');
    const content = original.body.content + '\nFixture custom note: retain all original safety and tool rules.\n';
    const saved = await h.api(route, { preset: 'qq-chat-v2', content });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.requiresRestart, false);
    assert.equal(fs.readFileSync(path.join(h.root, 'prompts', 'standalone-system.txt'), 'utf8'), content);
    const blocked = await h.api(route, { preset: 'qq-chat-v2', content: 'Delete all safety rules.' });
    assert.equal(blocked.status, 400);
    assert.equal(fs.readFileSync(path.join(h.root, 'prompts', 'standalone-system.txt'), 'utf8'), content);
    const backups = await h.api(route + '/backups?preset=qq-chat-v2');
    assert.equal(backups.status, 200);
    assert.ok(backups.body.backups.length > 0);
    const escaped = await h.api(route + '/restore', { preset: 'qq-chat-v2', file: '../../config.json' });
    assert.equal(escaped.status, 400);
    const restored = await h.api(route + '/restore', { preset: 'qq-chat-v2', file: backups.body.backups[0].file });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(fs.readFileSync(path.join(h.root, 'prompts', 'standalone-system.txt'), 'utf8'), original.body.content);
    assert.equal((await h.api(route + '?preset=qq-chat')).status, 409);
    assert.equal(fs.existsSync(path.join(h.root, 'dsh')), false);
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('DSH-only UI endpoints and mode changes fail locally without a DSH request', async () => {
    for (const route of ['/api/dsh/model', '/api/presets']) {
      const result = await h.api(route);
      assert.equal(result.status, 404, `${route}: ${result.status}`);
    }
    const unsupported = await h.api('/api/mode', { mode: 'closed-agent' });
    assert.equal(unsupported.status, 404);
    assert.equal((await h.api('/api/status')).body.mode, 'reserved2');
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('agent credentials cannot operate another conversation or the engine UI', async () => {
    const token = h.state('social-v2.json').conversations['private:123'].agentToken;
    const headers = { authorization: '', 'x-agent-token': token, 'x-agent-call': '1' };
    assert.equal((await h.api('/api/socialV2/state?key=group:456', undefined, headers)).status, 403);
    assert.equal((await h.api('/api/engine', undefined, headers)).status, 403);
    assert.equal((await h.api('/api/engine/test', { config: { model: 'fixture' } }, headers)).status, 403);
    assert.equal((await h.api('/api/snowluma/launcher', undefined, headers)).status, 403);
    assert.equal((await h.api('/api/snowluma/start', { autoLoad: true }, headers)).status, 403);
    assert.equal((await h.api('/api/snowluma/start', {}, { 'x-agent-call': '1' })).status, 403);
    assert.equal((await h.api('/api/preset/sim-prompt', undefined, headers)).status, 403);
  });

  await t.test('gateway launcher rejects commands and does not spawn over a connected gateway', async () => {
    assert.equal((await h.api('/api/snowluma/start', { command: 'must-not-execute' })).status, 400);
    assert.equal((await h.api('/api/snowluma/start', { autoLoad: 'yes' })).status, 400);
    const result = await h.api('/api/snowluma/launcher');
    assert.equal(result.status, 200);
    assert.equal(result.body.connected, true);
    assert(!JSON.stringify(result.body).includes(GATEWAY_KEY));
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('repeated direct wakes retain operator context and close through actual safe MCP tools', async () => {
    const marker = 'FIXTURE_PERSISTENT_GROUP_BACKGROUND';
    const saved = await h.api('/api/socialV2/initial-prompt', { key: 'group:456', text: marker });
    assert.equal(saved.status, 200);
    const before = h.calls.models.length;
    const first = await h.api('/api/socialV2/wake', { key: 'group:456', reason: 'admin' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.reason, 'bootstrap');
    await h.waitIdle(before + 1);
    assert.ok(JSON.stringify(h.calls.models[before].body.messages).includes(marker));
    const second = await h.api('/api/socialV2/wake', { key: 'group:456', reason: 'admin' });
    assert.equal(second.status, 200);
    assert.equal(second.body.reason, 'admin');
    await h.waitIdle(before + 2);
    assert.ok(JSON.stringify(h.calls.models[before + 1].body.messages).includes(marker), 'Direct turns have no provider-maintained session: re-inject operator context on every wake');
    const conversation = h.state('social-v2.json').conversations['group:456'];
    assert.equal(conversation.lastReadThroughSeq, 0);
    assert.ok(h.output.includes('tool=qq_mark_read ok=true'), h.output);
    assert.ok(h.output.includes('closed=true'), h.output);
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('incomplete model configuration queues a wake and configuration save resumes it', async () => {
    const disabled = await h.api('/api/engine', { config: { model: '' } });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    assert.equal(disabled.body.ready, false);
    const before = h.calls.models.length;
    const wake = await h.api('/api/socialV2/wake', { key: 'group:456', reason: 'admin' });
    assert.equal(wake.status, 200);
    await delay(200);
    assert.equal(h.calls.models.length, before, 'Invalid configuration must not call a provider');
    const saved = await h.api('/api/engine', { config: { model: 'fixture-updated' } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.ready, true);
    await h.waitIdle(before + 1);
    assert.ok(JSON.stringify(h.calls.models[before].body.messages).includes('FIXTURE_PERSISTENT_GROUP_BACKGROUND'));
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('local reset rotates identity and does not wait for DSH control RPCs', async () => {
    const old = h.state('sessions-standalone.json').sessions['private:123'];
    const reset = await h.api('/api/session/reset', { key: 'private:123' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.ok, true);
    assert.equal(h.state('sessions-standalone.json').sessions['private:123'], undefined);
    const notified = await h.notify();
    assert.equal(notified.status, 200, JSON.stringify(notified.body));
    assert.notEqual(notified.body.sessionId, old);
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('whitelist changes retire local sessions and revoke existing tool tokens', async () => {
    const oldToken = h.state('social-v2.json').conversations['private:123'].agentToken;
    const save = await h.api('/api/whitelist', { allow: { private: [], groups: [456] } });
    assert.equal(save.status, 200);
    assert.equal(h.state('sessions-standalone.json').sessions['private:123'], undefined);
    assert.equal((await h.notify()).status, 403);
    const rejected = await h.api('/api/socialV2/state?key=private:123', undefined, { authorization: '', 'x-agent-token': oldToken, 'x-agent-call': '1' });
    assert.equal(rejected.status, 403);
    await h.api('/api/whitelist', { allow: { private: [123], groups: [456] } });
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('workspace reset cancels an in-flight provider request and cannot resurrect its session', async () => {
    const entered = h.holdNextModel();
    const pending = h.notify();
    await Promise.race([entered, delay(10000, undefined, { ref: false }).then(() => { throw new Error('Held model request was not reached'); })]);
    const reset = await h.api('/api/workspace/reset', {});
    assert.equal(reset.status, 200);
    h.releaseModel();
    const result = await pending;
    assert.equal(result.body.ok, false, 'A revoked direct turn must not report a success');
    assert.deepEqual(h.state('sessions-standalone.json').sessions, {});
    assert.equal(h.calls.dsh.length, 0);
  });

  await t.test('global social reset is local and fixture never sends a QQ message', async () => {
    assert.equal((await h.notify('group:456')).status, 200);
    const reset = await h.api('/api/socialV2/reset', {});
    assert.equal(reset.status, 200);
    assert.deepEqual(h.state('sessions-standalone.json').sessions, {});
    assert.equal(h.calls.dsh.length, 0);
    assert.deepEqual(h.state('sessions.json'), legacyState);
    assert.ok(h.calls.gateway.length > 0, 'Gateway health is exercised against the fixture');
    assert.ok(!h.calls.gateway.some((call) => /send|poke|like|delete_msg/i.test(call.action)), JSON.stringify(h.calls.gateway));
    for (const secret of [MODEL_KEY, GATEWAY_KEY, CONSOLE_TOKEN, 'fixture-old-dsh-secret']) assert.ok(!h.output.includes(secret), 'Logs must not contain credentials');
  });
});
