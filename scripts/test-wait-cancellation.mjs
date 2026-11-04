// Fixture files and local mock HTTP only; never use real QQ or model credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const KEY = 'private:123';
const TOKEN = 'fixture-conversation-token';
const CONSOLE_TOKEN = 'fixture-console-token';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, message, ms = 1500) {
  const timeout = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, undefined, { signal: timeout.signal }).then(() => assert.fail(message))]);
  } finally { timeout.abort(); }
}

function loadTools({ port = 12345, fetchImpl, httpImpl = http } = {}) {
  const tools = new Map();
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace('const __dirname = path.dirname(fileURLToPath(import.meta.url));', "const __dirname = '/fixture/src';")
    .replace('await server.connect(new StdioServerTransport());', 'server.connect(new StdioServerTransport());');
  class McpServer {
    tool(name, description, schema, callback) { tools.set(name, { schema, callback }); }
    connect() {}
  }
  const fixtureFs = {
    readFileSync(file) {
      const name = path.basename(String(file));
      if (name === 'config.json') return JSON.stringify({ consolePort: port, consoleToken: CONSOLE_TOKEN });
      if (name === 'mode.json') return JSON.stringify({ mode: 'reserved2' });
      assert.fail(`Unexpected fixture file read: ${name}`);
    },
  };
  const context = vm.createContext({
    McpServer, StdioServerTransport: class {}, z, URL, URLSearchParams, Buffer, Error,
    AbortSignal, AbortController, setTimeout, clearTimeout, path, http: httpImpl,
    fs: fixtureFs, process: { env: { QQ_BRIDGE_DIRECT_PORT: String(port) } },
    fetch: fetchImpl ?? (() => assert.fail('The long-poll tool must not call fetch/undici')),
    SENSITIVE_RE: { test: () => false }, serializeModelData: JSON.stringify,
  });
  vm.runInContext(`${source}\nglobalThis.helpers = { agentApi, agentApiLongPoll };`, context);
  return {
    ...context.helpers,
    call(args, extra) {
      const tool = tools.get('qq_wait_for_messages');
      return tool.callback(z.object(tool.schema).parse(args), extra);
    },
  };
}

async function mockServer(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

test('SDK tool cancellation closes a pending long poll before any response headers', async () => {
  const entered = deferred();
  const disconnected = deferred();
  let call;
  const server = await mockServer(async (request, response) => {
    response.on('close', () => disconnected.resolve());
    let body = '';
    for await (const chunk of request) body += chunk;
    call = { headers: request.headers, url: request.url, body: JSON.parse(body) };
    entered.resolve();
  });
  try {
    const tools = loadTools({ port: server.port });
    const abort = new AbortController();
    const pending = tools.call({ key: KEY, token: TOKEN, timeoutMs: 300000 }, { signal: abort.signal });
    await bounded(entered.promise, 'Long-poll request never reached the mock bridge');
    assert.equal(call.url, '/api/socialV2/wait');
    assert.equal(call.headers['x-agent-token'], TOKEN);
    assert.equal(call.headers['x-console-token'], CONSOLE_TOKEN);
    assert.equal(call.headers['x-agent-call'], '1');
    assert.equal(call.body.key, KEY);
    assert.equal(call.body.timeoutMs, 300000);
    const reason = new Error('fixture tool cancelled');
    abort.abort(reason);
    const result = await bounded(pending, 'Tool cancellation waited for its five-minute budget');
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /fixture tool cancelled/);
    await bounded(disconnected.promise, 'Cancelled HTTP socket remained open');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  } finally { await server.close(); }
});

test('cancellation after headers also tears down an incomplete response body', async () => {
  const entered = deferred();
  const disconnected = deferred();
  const server = await mockServer((request, response) => {
    request.resume();
    response.on('close', () => disconnected.resolve());
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":true,');
    entered.resolve();
  });
  try {
    const abort = new AbortController();
    const reason = new Error('fixture response cancelled');
    const tools = loadTools({ port: server.port });
    const pending = tools.agentApiLongPoll('/api/socialV2/wait', {
      method: 'POST', body: '{}', headers: { 'x-agent-token': TOKEN }, timeoutMs: 300000, signal: abort.signal,
    });
    const outcome = pending.catch((error) => error);
    await bounded(entered.promise, 'Partial response was not started');
    await delay(20);
    abort.abort(reason);
    assert.equal(await bounded(outcome, 'Partial response ignored cancellation'), reason);
    await bounded(disconnected.promise, 'Partial response socket did not close');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  } finally { await server.close(); }
});

test('an already cancelled tool never opens an HTTP request', async () => {
  let requests = 0;
  const tools = loadTools({ httpImpl: { request() { requests++; assert.fail('Cancelled request was sent'); } } });
  const abort = new AbortController();
  abort.abort(new Error('fixture already cancelled'));
  const result = await tools.call({ key: KEY, token: TOKEN }, { signal: abort.signal });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already cancelled/);
  assert.equal(requests, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('successful long polls remove their abort listener and preserve their JSON result', async () => {
  const server = await mockServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, key: KEY, readThroughSeq: 7, newMessages: [] }));
  });
  try {
    const tools = loadTools({ port: server.port });
    const abort = new AbortController();
    const result = await tools.call({ key: KEY, token: TOKEN, purpose: 'reply' }, { signal: abort.signal });
    assert.ok(!result.isError);
    assert.equal(JSON.parse(result.content[0].text).readThroughSeq, 7);
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    abort.abort(new Error('fixture cancellation after successful completion'));
    assert.ok(!result.isError);
  } finally { await server.close(); }
});

test('long poll timeout is still independently enforced when the SDK signal does not abort', async () => {
  const disconnected = deferred();
  const server = await mockServer((request, response) => {
    request.resume();
    response.on('close', () => disconnected.resolve());
  });
  try {
    const abort = new AbortController();
    const tools = loadTools({ port: server.port });
    await assert.rejects(tools.agentApiLongPoll('/api/socialV2/wait', {
      method: 'POST', body: '{}', timeoutMs: 1000, signal: abort.signal,
    }), /1s/);
    assert.equal(abort.signal.aborted, false, 'Request deadline must not cancel the caller signal');
    await bounded(disconnected.promise, 'Timed-out socket remained open');
    assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  } finally { await server.close(); }
});

test('long-poll authentication/business rejection remains visible as a tool error', async () => {
  const server = await mockServer((request, response) => {
    assert.equal(request.headers['x-agent-call'], '1');
    request.resume();
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: { code: 'FIXTURE_STALE_TOKEN', message: 'fixture denial' } }));
  });
  try {
    const tools = loadTools({ port: server.port });
    const result = await tools.call({ key: KEY, token: TOKEN });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /FIXTURE_STALE_TOKEN/);
  } finally { await server.close(); }
});

test('ordinary bridge requests combine caller cancellation with their own timeout', async () => {
  const abort = new AbortController();
  let observed;
  const tools = loadTools({ fetchImpl: async (_url, init) => {
    observed = init.signal;
    assert.equal(init.headers['x-agent-call'], '1');
    assert.equal(init.headers['x-agent-token'], TOKEN);
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const reason = new Error('fixture ordinary request cancelled');
  const pending = tools.agentApi('/api/socialV2/state', { signal: abort.signal,
    headers: { 'x-agent-token': TOKEN }, timeoutMs: 10000 });
  const outcome = pending.catch((error) => error);
  assert.notEqual(observed, abort.signal, 'Caller cancellation must not replace the independent request deadline');
  abort.abort(reason);
  assert.equal(await bounded(outcome, 'Ordinary request ignored caller cancellation'), reason);

  const neverAborted = new AbortController();
  const deadline = tools.agentApi('/api/socialV2/state', { signal: neverAborted.signal,
    headers: { 'x-agent-token': TOKEN }, timeoutMs: 20 });
  const keeper = setTimeout(() => {}, 100);
  try { await assert.rejects(deadline, (error) => error.name === 'TimeoutError'); }
  finally { clearTimeout(keeper); }
  assert.equal(neverAborted.signal.aborted, false);
});

test('ordinary bridge response parsing cannot swallow a cancellation as a null success', async () => {
  const abort = new AbortController();
  const tools = loadTools({ fetchImpl: async (_url, init) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })),
  }) });
  const pending = tools.agentApi('/api/socialV2/state', { signal: abort.signal, timeoutMs: 10000 });
  const outcome = pending.catch((error) => error);
  await delay(5);
  const reason = new Error('fixture JSON body cancelled');
  abort.abort(reason);
  assert.equal(await bounded(outcome, 'JSON body cancellation was swallowed'), reason);
});
