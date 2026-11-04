// Exercise the real console handler with synthetic files and loopback HTTP only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const CONSOLE_TOKEN = 'fixture-console-token';
const PAGE = '<!doctype html><title>Fixture local console</title>';

async function fixture(t, config = {}, remoteAddress = null) {
  const h = await bridgeHarness({ config, files: {
    'public/console.html': PAGE, 'state/console-token': CONSOLE_TOKEN,
  } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (remoteAddress !== null) {
    server.prependListener('connection', socket => {
      Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress });
    });
  }
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await h.close();
  });
  const request = (path = '/api/status', { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method,
      headers: { ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
  return { h, port, request, origin: `http://127.0.0.1:${port}` };
}

test('only explicit boolean false disables console-token authentication', async t => {
  for (const [label, value] of [['absent', undefined], ['true', true], ['string false', 'false'], ['zero', 0], ['null', null]]) {
    await t.test(label, async t => {
      const config = value === undefined ? {} : { consoleRequireToken: value };
      const { h, request } = await fixture(t, config);
      assert.equal(h.cfg.consoleRequireToken, true);
      assert.equal((await request('/')).status, 401);
      assert.equal((await request()).status, 401);
      const status = await request('/api/status', { headers: { 'x-console-token': CONSOLE_TOKEN } });
      assert.equal(status.status, 200);
      assert.equal(status.json.consoleAccess.requireToken, true);
    });
  }
});

test('opt-out serves UI and admin status without a token but retains credentials', async t => {
  const { h, request } = await fixture(t, { consoleRequireToken: false });
  const page = await request('/');
  assert.equal(page.status, 200);
  assert.equal(page.text, PAGE);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  const status = await request();
  assert.equal(status.status, 200);
  assert.deepEqual(status.json.consoleAccess, { requireToken: false, localOnly: true });
  assert.equal(h.cfg.consoleToken, CONSOLE_TOKEN);
  assert.equal(fs.readFileSync(`${h.temp}/state/console-token`, 'utf8').trim(), CONSOLE_TOKEN);
  assert.equal((await request('/api/status', { headers: { 'x-console-token': 'stale-browser-token' } })).status, 200);
  assert.equal((await request('/?token=stale-browser-token')).status, 200);
});

test('same-origin local JSON writes work without an auth prompt', async t => {
  const { request, origin } = await fixture(t, { consoleRequireToken: false });
  const write = await request('/api/role-mode', { method: 'POST', body: { mode: 'silent' },
    headers: { origin, 'sec-fetch-site': 'same-origin' } });
  assert.equal(write.status, 200);
  assert.equal(write.json.roleMode, 'silent');
  assert.equal((await request()).json.roleMode, 'silent');
  const nonJson = await request('/api/role-mode', { method: 'POST', body: { mode: 'active' },
    headers: { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' } });
  assert.equal(nonJson.status, 415);
  assert.equal((await request()).json.roleMode, 'silent');
});

test('any agent header presence still requires the console transport credential', async t => {
  const { request } = await fixture(t, { consoleRequireToken: false });
  for (const marker of [
    { 'x-agent-call': '1' }, { 'x-agent-call': '0' }, { 'x-agent-call': '' },
    { 'x-agent-token': '' }, { 'x-agent-token': 'invalid-fixture-agent-token' },
  ]) {
    assert.equal((await request('/api/status', { headers: marker })).status, 401, JSON.stringify(marker));
    assert.equal((await request('/api/status', { headers: { ...marker, 'x-console-token': 'wrong-fixture-token' } })).status, 401);
  }
});

test('valid MCP credentials remain session-scoped and cannot access admin state', async t => {
  const { h, request } = await fixture(t, { consoleRequireToken: false });
  const token = h.getSocialV2State('private:123').agentToken;
  h.getSocialV2State('group:456');
  const headers = { 'x-console-token': CONSOLE_TOKEN, 'x-agent-token': token, 'x-agent-call': '1' };
  const own = await request('/api/socialV2/state?key=private:123', { headers });
  assert.equal(own.status, 200);
  assert.equal(own.json.key, 'private:123');
  assert.equal((await request('/api/socialV2/state?key=group:456', { headers })).status, 403);
  for (const path of ['/api/socialV2/states', '/api/socialV2/config', '/api/engine', '/api/roles', '/api/snowluma/launcher']) {
    assert.equal((await request(path, { headers })).status, 403, path);
  }
  const status = await request('/api/status', { headers });
  assert.equal(status.status, 200);
  for (const field of ['consoleAccess', 'ownerQQ', 'allowGroups', 'allowPrivate', 'activity', 'snowluma']) {
    assert.equal(field in status.json, false, field);
  }
  for (const marker of ['', '0', '1']) {
    assert.equal((await request('/api/socialV2/state?key=private:123', {
      headers: { 'x-console-token': CONSOLE_TOKEN, 'x-agent-call': marker },
    })).status, 403);
  }
  assert.equal((await request('/api/status', { headers: { 'x-console-token': CONSOLE_TOKEN, 'x-agent-token': '' } })).status, 403);
});

test('exact Host, Origin, and browser fetch-site checks reject cross-site access', async t => {
  const { request, port, origin } = await fixture(t, { consoleRequireToken: false });
  for (const host of [`evil.invalid:${port}`, '127.0.0.1:1', `127.0.0.1.:${port}`, `127.1:${port}`]) {
    assert.equal((await request('/api/status', { headers: { host } })).status, 403, host);
  }
  for (const invalidOrigin of ['http://evil.invalid', 'null', `https://127.0.0.1:${port}`, 'http://127.0.0.1:1', `http://localhost:${port}`]) {
    assert.equal((await request('/api/status', { headers: { origin: invalidOrigin } })).status, 403, invalidOrigin);
  }
  assert.equal((await request('/api/status', { headers: { origin, 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await request('/api/status', { headers: { 'sec-fetch-site': 'none' } })).status, 200);
  for (const site of ['cross-site', 'same-site', 'unknown']) {
    assert.equal((await request('/api/status', { headers: { 'sec-fetch-site': site } })).status, 403, site);
  }
  assert.equal((await request('/api/role-mode', { method: 'POST', body: { mode: 'silent' },
    headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request()).json.roleMode, 'active');
});

test('external top-level UI navigation exception does not extend to APIs, frames or writes', async t => {
  const { request } = await fixture(t, { consoleRequireToken: false });
  const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  assert.equal((await request('/', { headers })).status, 200);
  assert.equal((await request('/api/status', { headers })).status, 403);
  assert.equal((await request('/', { headers: { ...headers, 'sec-fetch-dest': 'iframe' } })).status, 403);
  assert.equal((await request('/', { headers: { ...headers, 'sec-fetch-mode': 'no-cors' } })).status, 403);
  assert.equal((await request('/', { headers: { ...headers, origin: 'http://evil.invalid' } })).status, 403);
  assert.equal((await request('/api/role-mode', { method: 'POST', body: { mode: 'silent' }, headers })).status, 403);
});

test('local exemption checks the actual socket peer, not forwarding headers', async t => {
  const { request } = await fixture(t, { consoleRequireToken: false }, '192.0.2.1');
  assert.equal((await request()).status, 403);
  assert.equal((await request('/api/status', { headers: { 'x-forwarded-for': '127.0.0.1', forwarded: 'for=127.0.0.1' } })).status, 403);
  assert.equal((await request('/api/status', { headers: { 'x-console-token': CONSOLE_TOKEN } })).status, 403);
});

test('recognized loopback socket forms receive the local exemption', async t => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    await t.test(peer, async t => {
      const { request } = await fixture(t, { consoleRequireToken: false }, peer);
      assert.equal((await request()).status, 200);
    });
  }
});

test('UI refresh exposes local mode and disables only console-token controls', async () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(script[1]);
  const nodes = new Map(ids.map(id => [id, { textContent: '', disabled: false, value: '' }]));
  const removedStorage = [];
  let status = { mode: 'reserved2', consoleAccess: { requireToken: false } };
  const context = vm.createContext({
    api: async () => status,
    localStorage: { removeItem(key) { removedStorage.push(key); } },
    document: { querySelectorAll: () => [], getElementById: id => {
      assert.ok(nodes.has(id), `Missing DOM ID: ${id}`);
      return nodes.get(id);
    } },
    updateOverview() {}, setConnectionError(error) { throw error; },
  });
  const source = html.slice(html.indexOf('async function refresh()'), html.indexOf('async function refreshPresets()'));
  vm.runInContext(`${source}\nglobalThis.uiRefresh = refresh;`, context);
  for (const requireToken of [false, true, undefined]) {
    const before = removedStorage.length;
    status = { mode: 'reserved2', consoleAccess: requireToken === undefined ? undefined : { requireToken } };
    await context.uiRefresh();
    for (const id of ['consoleTokenInput', 'consoleTokenSave', 'consoleTokenRandom']) {
      assert.equal(nodes.get(id).disabled, requireToken === false, id);
    }
    assert.deepEqual(removedStorage.slice(before), requireToken === false ? ['consoleToken'] : []);
    assert.match(nodes.get('consoleAccessMode').textContent, requireToken === false ? /\u53d6\u6d88/ : /\u542f\u7528/);
  }
});
