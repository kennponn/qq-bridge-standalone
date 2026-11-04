// Local mocks and isolated MCP processes only; never real QQ or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY = 'private:123';
const TOKEN = 'fixture-direct-token';
const QQ = 'mcp-snowluma-safe.js';
const WEB = 'mcp-web-search-safe.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const schema = (properties) => ({ type: 'object', properties, required: Object.keys(properties) });
const qqDefinitions = [
  ...['qq_send_message', 'qq_get_message_images', 'qq_memory_append', 'qq_wait_for_messages', 'qq_mark_read'].map(name => ({
    name, description: 'fixture-shared-schema', inputSchema: schema({ key: { type: 'string' }, token: { type: 'string' },
      ...(name === 'qq_send_message' ? { messages: { type: 'array', items: { type: 'string' } } } : {}),
      ...(name === 'qq_wait_for_messages' ? { quietMs: { type: 'number' }, timeoutMs: { type: 'number' } } : {}) }),
  })),
  { name: 'qq_reply', description: 'fixture-quote', inputSchema: schema({ groupId: { type: 'string' }, token: { type: 'string' } }) },
  { name: 'qq_send_group_message', inputSchema: schema({ groupId: { type: 'string' }, token: { type: 'string' } }) },
  { name: 'qq_admin', inputSchema: schema({ action: { type: 'string' } }) },
];
const webDefinitions = ['web_search', 'web_fetch', 'web_admin'].map(name => ({ name, inputSchema: schema({ query: { type: 'string' } }) }));

function mockSession({ connection, discovery, clientClose, transportClose } = {}) {
  const clients = [];
  const transports = [];
  const events = [];
  class Transport {
    constructor(options) { this.script = path.basename(options.args[0]); this.options = options; transports.push(this); }
    async close() { events.push(`${this.script}:transportClose`); this.closed = true; await transportClose?.(this.script); }
  }
  class Client {
    constructor() { clients.push(this); }
    async connect(transport) {
      this.transport = transport;
      events.push(`${transport.script}:connect`);
      await connection?.(transport.script);
      events.push(`${transport.script}:connected`);
    }
    async listTools() {
      events.push(`${this.transport.script}:listTools`);
      await discovery?.(this.transport.script);
      return { tools: this.transport.script === QQ ? qqDefinitions : webDefinitions };
    }
    async callTool(request) { this.lastCall = request; return { ok: true }; }
    async close() { events.push(`${this.transport.script}:clientClose`); this.closed = true; await clientClose?.(this.transport.script); }
  }
  const source = fs.readFileSync(path.join(ROOT, 'src', 'direct-tools.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^const ROOT = .*;$/m, "const ROOT = '/fixture';")
    .replace(/^export /gm, '');
  const context = vm.createContext({ path, process: { execPath: '/fixture/node' }, Client,
    StdioClientTransport: Transport, Promise, Map, Set, Object, Number, Error });
  vm.runInContext(source + '\nglobalThis.fixture = { createDirectToolSession, connectDirectToolServers, closeDirectToolClients };', context);
  return { ...context.fixture, clients, transports, events };
}

const options = { key: KEY, agentToken: TOKEN, consolePort: 4321 };

test('QQ and Web initialization both start before either is allowed to finish', async () => {
  const gate = deferred();
  const h = mockSession({ connection: () => gate.promise });
  const starting = h.createDirectToolSession(options);
  await delay(0);
  assert.equal(h.clients.length, 2);
  assert.deepEqual(h.events, [`${QQ}:connect`, `${WEB}:connect`]);
  gate.resolve();
  const session = await starting;
  await session.close();
  assert.ok(h.transports.every(transport => transport.closed));
});

test('an early failure waits for late initialization before tearing down every client', async () => {
  const late = deferred();
  const failure = new Error('fixture initialization failed');
  const h = mockSession({ connection: (script) => script === QQ ? Promise.reject(failure) : late.promise });
  let rejected = false;
  const starting = h.createDirectToolSession(options);
  const result = starting.then(() => assert.fail('Initialization should fail'), error => { rejected = true; assert.equal(error, failure); });
  await delay(0);
  assert.equal(rejected, false);
  assert.ok(!h.events.some(event => /Close$/.test(event)));
  late.resolve();
  await result;
  assert.equal(h.clients.length, 2);
  assert.ok(h.clients.every(client => client.closed));
  assert.ok(h.transports.every(transport => transport.closed));
  assert.ok(h.events.indexOf(`${WEB}:connected`) < h.events.indexOf(`${QQ}:clientClose`));
});

test('partial discovery failure closes the successful sibling and the failing client', async () => {
  const h = mockSession({ discovery: script => { if (script === WEB) throw new Error('fixture discovery failed'); } });
  await assert.rejects(h.createDirectToolSession(options), /fixture discovery failed/);
  assert.equal(h.clients.length, 2);
  assert.ok(h.transports.every(transport => transport.closed));
});

test('synchronous connection failures do not prevent the other server from settling', async () => {
  const late = deferred();
  const h = mockSession();
  const calls = [];
  const starting = h.connectDirectToolServers(script => {
    calls.push(script);
    if (script === QQ) throw new Error('fixture synchronous failure');
    return late.promise;
  });
  const checked = assert.rejects(starting, /fixture synchronous failure/);
  await delay(0);
  assert.deepEqual(calls, [QQ, WEB]);
  late.resolve({});
  await checked;
});

test('client close failure still tears down transports and repeated close is idempotent', async () => {
  const h = mockSession({ clientClose: script => { if (script === QQ) throw new Error('fixture close failed'); } });
  const session = await h.createDirectToolSession(options);
  await Promise.all([session.close(), session.close()]);
  await session.close();
  assert.equal(h.events.filter(event => event.endsWith(':clientClose')).length, 2);
  assert.equal(h.events.filter(event => event.endsWith(':transportClose')).length, 2);
  assert.ok(h.transports.every(transport => transport.closed));
});

test('transport close failure does not prevent sibling teardown', async () => {
  const h = mockSession({ transportClose: script => { if (script === QQ) throw new Error('fixture transport close failed'); } });
  const session = await h.createDirectToolSession(options);
  await session.close();
  assert.equal(h.events.filter(event => event.endsWith(':transportClose')).length, 2);
});

test('web disabled starts only the QQ process; silent and vision filters stay isolated', async () => {
  const h = mockSession();
  const session = await h.createDirectToolSession({ ...options, webSearch: false, silent: true, vision: false });
  try {
    assert.equal(h.clients.length, 1);
    assert.equal(h.transports[0].script, QQ);
    assert.deepEqual(Array.from(session.tools, tool => tool.function.name), ['qq_memory_append', 'qq_wait_for_messages', 'qq_mark_read']);
    await assert.rejects(session.execute('qq_send_message', { messages: ['fixture'] }), /not enabled/);
    await assert.rejects(session.execute('mcp__web-search-safe__web_search', { query: 'fixture' }), /not enabled/);
  } finally { await session.close(); }
});

test('same-key turns build fresh credentials, variant tools and private timing guidance', async () => {
  const h = mockSession();
  const first = await h.createDirectToolSession({ ...options, timing: { fastPrivate: true, quietMs: 1500,
    quietMinMs: 500, quietMaxMs: 3000, defaultWaitMs: 15000, minWaitMs: 100, waitMaxMs: 30000 } });
  const second = await h.createDirectToolSession({ ...options, agentToken: 'fixture-new-token', silent: true, vision: false, webSearch: false });
  try {
    assert.equal(h.clients.length, 3, 'No transport or token-bound registry is reused across turns');
    await first.execute('qq_memory_append', {});
    await second.execute('qq_memory_append', {});
    assert.equal(h.clients[0].lastCall.arguments.key, KEY);
    assert.equal(h.clients[0].lastCall.arguments.token, TOKEN);
    assert.equal(h.clients[2].lastCall.arguments.token, 'fixture-new-token');
    const wait = first.tools.find(tool => tool.function.name === 'qq_wait_for_messages');
    assert.match(wait.function.description, /PRIVATE SESSION OVERRIDE/);
    assert.match(wait.function.parameters.properties.quietMs.description, /1500/);
    for (const session of [first, second]) {
      assert.ok(!JSON.stringify(session.tools).includes(TOKEN));
      assert.ok(session.tools.every(tool => !Object.hasOwn(tool.function.parameters.properties, 'key')
        && !Object.hasOwn(tool.function.parameters.properties, 'token')));
      await assert.rejects(session.execute('qq_memory_append', { key: 'private:456' }), /cannot be changed/);
      await assert.rejects(session.execute('qq_memory_append', { token: 'fixture-foreign-token' }), /cannot be changed/);
    }
    assert.ok(!first.tools.some(tool => ['qq_reply', 'qq_admin', 'qq_send_group_message'].includes(tool.function.name)));
    assert.ok(first.tools.some(tool => tool.function.name === 'mcp__web-search-safe__web_search'));
    assert.ok(!first.tools.some(tool => tool.function.name.includes('web_admin')));
  } finally { await Promise.all([first.close(), second.close()]); }
});

test('group reply remains bound to the current group and does not inherit private timing', async () => {
  const h = mockSession();
  const session = await h.createDirectToolSession({ ...options, key: 'group:456', timing: { fastPrivate: false }, webSearch: false });
  try {
    await session.execute('qq_reply', {});
    assert.equal(h.clients[0].lastCall.arguments.groupId, '456');
    assert.equal(h.clients[0].lastCall.arguments.token, TOKEN);
    await assert.rejects(session.execute('qq_reply', { groupId: '789' }), /cannot be changed/);
    assert.ok(!session.tools.some(tool => /PRIVATE SESSION OVERRIDE/.test(tool.function.description)));
  } finally { await session.close(); }
});

test('invalid credentials and port fail before any client is created', async () => {
  const h = mockSession();
  for (const patch of [{ key: 'private:0' }, { key: 'group:abc' }, { agentToken: '' }, { consolePort: 0 }, { consolePort: 65536 }]) {
    await assert.rejects(h.createDirectToolSession({ ...options, ...patch }), /DIRECT_TOOLS:/);
  }
  assert.equal(h.clients.length, 0);
});

async function isolatedFixture() {
  const base = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'qq-direct-startup-fixture-'));
  const modules = path.resolve(process.env.QQ_BRIDGE_TEST_MODULES || path.join(ROOT, 'node_modules'));
  const fixture = { root, async close() {
    const relative = path.relative(base, path.resolve(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.match(path.basename(root), /^qq-direct-startup-fixture-/);
    const modulesLink = path.join(root, 'node_modules');
    if (fs.existsSync(modulesLink)) fs.unlinkSync(modulesLink);
    fs.rmSync(root, { recursive: true, force: true });
  } };
  try {
    assert.ok(fs.existsSync(modules));
    fs.cpSync(path.join(ROOT, 'src'), path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ consolePort: 4321,
      consoleRequireToken: false, allow: { private: [123], groups: [456] }, socialV2: { tools: {} } }));
    fs.mkdirSync(path.join(root, 'state'));
    fs.writeFileSync(path.join(root, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
    fs.symlinkSync(modules, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fixture.module = await import(pathToFileURL(path.join(root, 'src', 'direct-tools.js')));
    return fixture;
  } catch (error) { await fixture.close(); throw error; }
}

test('actual isolated QQ/Web discovery remains safe after parallel startup', { timeout: 30000 }, async () => {
  const h = await isolatedFixture();
  let session;
  try {
    const started = performance.now();
    session = await h.module.createDirectToolSession(options);
    const ms = Math.round(performance.now() - started);
    const names = session.tools.map(tool => tool.function.name);
    assert.ok(names.includes('qq_send_message'));
    assert.ok(names.includes('qq_memory_append'));
    assert.ok(names.includes('mcp__web-search-safe__web_search'));
    assert.ok(names.includes('mcp__web-search-safe__web_fetch'));
    assert.ok(!names.includes('qq_send_group_message'));
    assert.ok(!JSON.stringify(session.tools).includes(TOKEN));
    console.log(`Fixture actual parallel MCP startup: ${ms}ms; ${names.length} safe tools; no QQ/model calls.`);
  } finally { await session?.close(); await h.close(); }
});

test('actual early failure cleans a sibling that only finishes initialization later', { timeout: 30000 }, async () => {
  const h = await isolatedFixture();
  const log = path.join(h.root, 'fixture-lifecycle.jsonl');
  const logger = `import fs from 'node:fs';
const note = event => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event, pid: process.pid })+'\\n');
note('start'); process.on('exit',()=>note('exit'));
`;
  try {
    fs.writeFileSync(path.join(h.root, 'src', QQ), logger + "setTimeout(()=>process.exit(1),30);\n");
    fs.writeFileSync(path.join(h.root, 'src', WEB), logger + `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
await new Promise(resolve=>setTimeout(resolve,450));
const server=new McpServer({name:'fixture-delayed-peer',version:'0.0.0'});
server.tool('web_search','fixture',{query:z.string()},async()=>({content:[]}));
await server.connect(new StdioServerTransport());
note('ready');
`);
    await assert.rejects(h.module.createDirectToolSession(options), /closed|connection|MCP/i);
    const deadline = Date.now() + 5000;
    let lifecycle;
    while (Date.now() < deadline) {
      lifecycle = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      if (lifecycle.filter(event => event.event === 'exit').length === 2) break;
      await delay(25);
    }
    assert.equal(lifecycle.filter(event => event.event === 'start').length, 2);
    assert.equal(lifecycle.filter(event => event.event === 'ready').length, 1, 'The successful sibling was permitted to finish before teardown');
    assert.equal(lifecycle.filter(event => event.event === 'exit').length, 2, 'Both actual child processes exited after the partial failure');
  } finally { await h.close(); }
});
