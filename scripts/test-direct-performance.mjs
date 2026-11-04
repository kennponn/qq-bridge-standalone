// Offline performance regressions. All provider responses and QQ tools are fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createDirectPerformanceLedger } from '../src/direct-performance.js';
import { runDirectTurn } from '../src/direct-engine.js';
import { createOutboundScheduler } from '../src/outbound-scheduler.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function clockLedger(options = {}) {
  let monotonic = 0;
  let wall = 100000;
  const ledger = createDirectPerformanceLedger({ ...options, now: () => monotonic, wallNow: () => wall });
  return { ledger, tick(ms) { monotonic += ms; wall += ms; }, set(ms, at = wall) { monotonic = ms; wall = at; } };
}

let callId = 0;
const toolCall = (name, args = {}) => ({ id: `perf-call-${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolMessage = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const tools = ['qq_send_message', 'qq_mark_read', 'qq_set_wake_config', 'qq_wait_for_messages', 'qq_get_unread_messages'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

function engine(replies, execute = async () => ({ ok: true }), options = {}) {
  const requests = [];
  const executed = [];
  const timings = [];
  const delays = [];
  let index = 0;
  return {
    requests, executed, timings, delays,
    run: () => runDirectTurn({
      model: 'offline-performance-fixture', apiKey: 'fixture-credential', baseURL: 'https://provider.invalid/v1',
      promptText: 'FIXTURE_PRIVATE_PAYLOAD', systemPrompt: 'FIXTURE_PERSONA_BODY', tools,
      hasSnapshot: true, maxRetries: 0, ...options,
      onTiming: options.onTiming || (event => timings.push(event)),
      executeTool: async (...args) => { executed.push({ name: args[0], args: args[1] }); return execute(...args); },
      sleepImpl: async (ms) => { delays.push(ms); },
      fetchImpl: async (_url, init) => {
        requests.push({ body: JSON.parse(init.body), bytes: Buffer.byteLength(init.body) });
        const reply = typeof replies === 'function' ? await replies(index++, init) : replies[index++];
        return reply instanceof Response ? reply : json({ choices: [{ message: reply }] });
      }
    })
  };
}

function assertPrivateTiming(events) {
  for (const event of events) {
    const allowed = event.phase === 'model'
      ? ['phase', 'round', 'attempt', 'status', 'durationMs', 'requestBytes']
      : ['phase', 'toolName', 'durationMs', 'ok'];
    assert.ok(['model', 'tool'].includes(event.phase));
    assert.deepEqual(Object.keys(event).sort(), allowed.sort());
    assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    if (event.phase === 'model') {
      assert.ok(Number.isInteger(event.round) && event.round > 0);
      assert.ok(Number.isInteger(event.attempt) && event.attempt > 0);
      assert.ok(Number.isFinite(event.requestBytes) && event.requestBytes > 0);
      assert.ok(event.status === null || Number.isInteger(event.status));
    }
  }
  assert.doesNotMatch(JSON.stringify(events), /FIXTURE_PRIVATE_PAYLOAD|FIXTURE_PERSONA_BODY|fixture-credential|provider\.invalid/);
}

test('ledger records first gateway ACK separately from final tool/turn completion', () => {
  const h = clockLedger();
  const turn = h.ledger.begin('private', { incomingAt: 99500 });
  turn.setup(80);
  turn.timing({ phase: 'model', durationMs: 1250, attempt: 1, requestBytes: 1200 });
  turn.queued(40);
  turn.gateway(100);
  h.tick(1400);
  turn.ack();
  h.tick(2000);
  turn.ack();
  turn.timing({ phase: 'tool', durationMs: 2200 });
  turn.finish('success');
  const row = h.ledger.snapshot().latest;
  assert.equal(row.arrivalWaitMs, 500);
  assert.equal(row.executionToFirstReplyMs, 1400);
  assert.equal(row.firstReplyMs, 1900);
  assert.equal(row.totalMs, 3400);
  assert.equal(row.toolSetupMs, 80);
  assert.equal(row.modelMs, 1250);
  assert.equal(row.toolMs, 2200);
  assert.equal(row.queueMs, 40);
  assert.equal(row.gatewayMs, 100);
  assert.equal(row.completedAt, 103400);
});

test('ledger first ACK is stable when incoming time is unavailable or in the future', () => {
  for (const incomingAt of [undefined, NaN, Infinity, -1, 100001]) {
    const h = clockLedger();
    const turn = h.ledger.begin('private', { incomingAt });
    h.tick(150);
    turn.ack();
    h.tick(900);
    turn.ack();
    turn.finish('success');
    const snapshot = h.ledger.snapshot();
    assert.equal(snapshot.latest.firstReplyMs, null);
    assert.equal(snapshot.latest.executionToFirstReplyMs, 150);
    assert.equal(snapshot.private.count, 0);
  }
});

test('ledger rejects invalid timing values and clamps finite durations and bytes', () => {
  const h = clockLedger();
  const turn = h.ledger.begin('private', { incomingAt: 1 });
  turn.setup(NaN);
  for (const durationMs of [NaN, Infinity, -Infinity, -100, '120']) {
    turn.timing({ phase: 'tool', durationMs });
    turn.queued(durationMs);
    turn.gateway(durationMs);
  }
  turn.timing({ phase: 'unknown', durationMs: 1000, attempt: 10, requestBytes: 9999 });
  turn.timing(null);
  turn.timing({ phase: 'model', durationMs: 1.6, attempt: 1, requestBytes: Infinity });
  turn.timing({ phase: 'model', durationMs: 1e12, attempt: 2, requestBytes: 1e12 });
  turn.timing({ phase: 'model', durationMs: -1, attempt: 3, requestBytes: -1 });
  turn.setup(1e12);
  turn.queued(1e12);
  turn.gateway(1e12);
  h.tick(1e12);
  turn.ack();
  turn.finish('success');
  const row = h.ledger.snapshot().latest;
  for (const field of ['toolSetupMs', 'modelMs', 'queueMs', 'gatewayMs', 'firstReplyMs', 'executionToFirstReplyMs', 'totalMs']) assert.equal(row[field], 86400000);
  assert.equal(row.toolMs, 0);
  assert.equal(row.modelRequests, 3);
  assert.equal(row.modelRetries, 2);
  assert.equal(row.requestBytes, 32 * 1024 * 1024);
  for (const value of Object.values(row)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
});

test('ledger snapshots are detached, anonymous and terminal recording is idempotent', () => {
  const h = clockLedger();
  const turn = h.ledger.begin('private', { incomingAt: 99500, key: 'PRIVATE_IDENTIFIER_FIXTURE', token: 'TOKEN_FIXTURE' });
  turn.timing({ phase: 'model', durationMs: 10, attempt: 1, requestBytes: 123, toolName: 'SECRET_TOOL_FIXTURE', payload: 'PAYLOAD_FIXTURE' });
  h.tick(100);
  turn.ack();
  turn.finish('success');
  turn.finish('failed');
  turn.setup(999);
  turn.queued(999);
  turn.gateway(999);
  turn.timing({ phase: 'model', durationMs: 999, attempt: 99, requestBytes: 999 });
  h.tick(1000);
  turn.ack();
  const first = h.ledger.snapshot();
  assert.equal(first.sampleCount, 1);
  assert.equal(first.latest.totalMs, 100);
  assert.equal(first.latest.executionToFirstReplyMs, 100);
  first.latest.modelMs = 999;
  first.private.latest.firstReplyMs = -1;
  first.private.count = 900;
  const second = h.ledger.snapshot();
  assert.equal(second.latest.modelMs, 10);
  assert.equal(second.private.latest.firstReplyMs, 600);
  assert.equal(second.private.count, 1);
  assert.notStrictEqual(second.latest, second.private.latest);
  assert.doesNotMatch(JSON.stringify(second), /PRIVATE_IDENTIFIER_FIXTURE|TOKEN_FIXTURE|SECRET_TOOL_FIXTURE|PAYLOAD_FIXTURE/);
  assert.deepEqual(Object.keys(second.latest).sort(), ['kind', 'arrivalWaitMs', 'toolSetupMs', 'modelMs', 'toolMs', 'queueMs', 'gatewayMs', 'modelRequests', 'modelRetries', 'requestBytes', 'firstReplyMs', 'executionToFirstReplyMs', 'outcome', 'totalMs', 'completedAt'].sort());
});

test('ledger ring bound evicts old samples and only successful private ACKs affect percentiles', () => {
  const h = clockLedger({ limit: 5 });
  const append = (kind, outcome, delay, ack = true, knownArrival = true) => {
    const turn = h.ledger.begin(kind, knownArrival ? { incomingAt: 100000 } : {});
    h.tick(delay);
    if (ack) turn.ack();
    turn.finish(outcome);
  };
  append('private', 'success', 100);
  append('private', 'success', 100);
  append('group', 'success', 100);
  append('private', 'failed', 100);
  append('private', 'silent', 100);
  append('private', 'success', 100, false);
  let snapshot = h.ledger.snapshot();
  assert.equal(snapshot.sampleCount, 5);
  assert.equal(snapshot.private.count, 1);
  assert.equal(snapshot.private.p50ReplyMs, 200);
  assert.equal(snapshot.private.p95ReplyMs, 200);
  append('private', 'success', 100, true, false);
  snapshot = h.ledger.snapshot();
  assert.equal(snapshot.sampleCount, 5);
  assert.deepEqual(snapshot.private, { count: 0, p50ReplyMs: null, p95ReplyMs: null, latest: null });
});

test('ledger clamps ring capacity and uses nearest-rank successful-private percentiles', () => {
  const h = clockLedger({ limit: 999999 });
  for (let n = 1; n <= 220; n++) {
    const turn = h.ledger.begin('private', { incomingAt: 100000 + n - 1 });
    h.tick(1);
    turn.ack();
    turn.finish('success');
  }
  const snapshot = h.ledger.snapshot();
  assert.equal(snapshot.sampleCount, 200);
  assert.equal(snapshot.private.count, 200);
  assert.equal(snapshot.private.p50ReplyMs, 1);
  assert.equal(snapshot.private.p95ReplyMs, 1);
  const percentiles = clockLedger({ limit: 20 });
  for (const delay of [10, 20, 100, 200]) {
    const turn = percentiles.ledger.begin('private', { incomingAt: 100000 });
    percentiles.tick(delay);
    turn.ack();
    turn.finish('success');
  }
  assert.equal(percentiles.ledger.snapshot().private.p50ReplyMs, 30);
  assert.equal(percentiles.ledger.snapshot().private.p95ReplyMs, 330);
});

test('ledger unknown outcome becomes failed and non-private kind never leaks an identifier', () => {
  const h = clockLedger({ limit: 1 });
  const turn = h.ledger.begin('private:FIXTURE_ID', { incomingAt: 99900 });
  h.tick(50);
  turn.ack();
  turn.finish('RAW_ERROR_FIXTURE');
  const row = h.ledger.snapshot().latest;
  assert.equal(row.kind, 'group');
  assert.equal(row.outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(row), /FIXTURE_ID|RAW_ERROR_FIXTURE/);
});

test('engine executes SEND then displayed-cursor CLOSE in one model response', async () => {
  const h = engine([toolMessage(toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'] }), toolCall('qq_mark_read', { throughSeq: 7 }))]);
  const result = await h.run();
  assert.deepEqual(result, { ok: true, sent: 1, closed: true, rounds: 1 });
  assert.equal(h.requests.length, 1);
  assert.deepEqual(h.executed.map(call => call.name), ['qq_send_message', 'qq_mark_read']);
  assert.equal(h.executed.at(-1).args.throughSeq, 7);
  assertPrivateTiming(h.timings);
  assert.deepEqual(h.timings.map(event => event.phase), ['model', 'tool', 'tool']);
  assert.equal(h.timings[0].status, 200);
  assert.equal(h.timings[0].requestBytes, h.requests[0].bytes);
  assert.ok(h.timings.filter(event => event.phase === 'tool').every(event => event.ok));
});

test('engine failed SEND blocks same-response CLOSE until a later deliberate close', async () => {
  const h = engine([
    toolMessage(toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'] }), toolCall('qq_mark_read', { throughSeq: 7 })),
    toolMessage(toolCall('qq_mark_read', { throughSeq: 7 }))
  ], async name => name === 'qq_send_message' ? { ok: false, error: 'FIXTURE_DELIVERY_FAILURE' } : { ok: true });
  const result = await h.run();
  assert.deepEqual(result, { ok: true, sent: 0, closed: true, rounds: 2 });
  assert.deepEqual(h.executed.map(call => call.name), ['qq_send_message', 'qq_mark_read']);
  const nextMessages = JSON.stringify(h.requests[1].body.messages);
  assert.match(nextMessages, /FIXTURE_DELIVERY_FAILURE/);
  assert.match(nextMessages, /earlier send failed/);
  assertPrivateTiming(h.timings);
  assert.deepEqual(h.timings.filter(event => event.phase === 'tool').map(event => [event.toolName, event.ok]), [['qq_send_message', false], ['qq_mark_read', true]]);
});

test('engine cached ambiguous failed SEND still blocks CLOSE and never repeats the side effect', async () => {
  const h = engine([
    toolMessage(toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'], atUserId: 7 }), toolCall('qq_mark_read', { throughSeq: 7 })),
    toolMessage(toolCall('qq_send_message', { atUserId: 7, messages: ['FIXTURE_REPLY'] }), toolCall('qq_set_wake_config', { throughSeq: 7, config: { mode: 'watching' } })),
    toolMessage(toolCall('qq_mark_read', { throughSeq: 7 }))
  ], async name => { if (name === 'qq_send_message') throw new Error('FIXTURE_AMBIGUOUS_TRANSPORT'); return { ok: true }; });
  const result = await h.run();
  assert.equal(result.rounds, 3);
  assert.equal(result.sent, 0);
  assert.deepEqual(h.executed.map(call => call.name), ['qq_send_message', 'qq_mark_read']);
  assert.match(JSON.stringify(h.requests[1].body.messages), /earlier send failed/);
  assert.equal(h.requests[2].body.messages.filter(message => message.role === 'tool' && /earlier send failed/.test(message.content)).length, 2);
  assertPrivateTiming(h.timings);
  assert.equal(h.timings.filter(event => event.phase === 'tool' && event.toolName === 'qq_send_message').length, 1);
});

test('engine duplicate failed SEND in the same response cannot make CLOSE succeed', async () => {
  const h = engine([
    toolMessage(toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'] }), toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'] }), toolCall('qq_mark_read', { throughSeq: 7 }))
  ], async () => ({ isError: true, content: [{ type: 'text', text: 'FIXTURE_SEND_ERROR' }] }), { maxRounds: 1 });
  await assert.rejects(h.run(), error => error.message.includes('DIRECT_ROUND_LIMIT') && error.sentCount === 0 && error.closed === false);
  assert.deepEqual(h.executed.map(call => call.name), ['qq_send_message']);
  assertPrivateTiming(h.timings);
  assert.equal(h.timings.filter(event => event.phase === 'tool').length, 1);
  assert.equal(h.timings.at(-1).ok, false);
});

for (const sendOk of [true, false]) {
  test(`engine CLOSE before a later ${sendOk ? 'successful' : 'failed'} SEND cannot acknowledge early`, async () => {
    const h = engine([
      toolMessage(toolCall('qq_mark_read', { throughSeq: 7 }), toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'] })),
      toolMessage(toolCall('qq_mark_read', { throughSeq: 7 }))
    ], async name => name === 'qq_send_message' ? { ok: sendOk } : { ok: true });
    const result = await h.run();
    assert.equal(result.rounds, 2);
    assert.equal(result.sent, sendOk ? 1 : 0);
    assert.equal(result.closed, true);
    assert.deepEqual(h.executed.map(call => call.name), ['qq_send_message', 'qq_mark_read']);
    assert.match(JSON.stringify(h.requests[1].body.messages), /Send tools must run before closing tools/);
    assertPrivateTiming(h.timings);
  });
}

test('engine closing-only model response still executes its explicit cursor normally', async () => {
  for (const name of ['qq_mark_read', 'qq_set_wake_config']) {
    const h = engine([toolMessage(toolCall(name, { throughSeq: 7, ...(name === 'qq_set_wake_config' ? { config: { mode: 'watching' } } : {}) }))]);
    const result = await h.run();
    assert.deepEqual(result, { ok: true, sent: 0, closed: true, rounds: 1 });
    assert.equal(h.executed.length, 1);
    assert.equal(h.executed[0].name, name);
    assert.equal(h.executed[0].args.throughSeq, 7);
    assertPrivateTiming(h.timings);
  }
});

test('engine model attempts and retry status/bytes are measured without request payload', async () => {
  const h = engine([
    json({ error: 'FIXTURE_ERROR_RESPONSE_BODY' }, 503),
    toolMessage(toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'] }), toolCall('qq_mark_read', { throughSeq: 7 }))
  ], undefined, { maxRetries: 1 });
  const result = await h.run();
  assert.equal(result.sent, 1);
  assert.equal(result.rounds, 1);
  assert.deepEqual(h.delays, [500]);
  assertPrivateTiming(h.timings);
  const model = h.timings.filter(event => event.phase === 'model');
  assert.deepEqual(model.map(event => [event.round, event.attempt, event.status]), [[1, 1, 503], [1, 2, 200]]);
  assert.deepEqual(model.map(event => event.requestBytes), h.requests.map(request => request.bytes));
  assert.doesNotMatch(JSON.stringify(h.timings), /FIXTURE_ERROR_RESPONSE_BODY/);
  const hLedger = clockLedger();
  const turn = hLedger.ledger.begin('private');
  h.timings.forEach(turn.timing);
  turn.finish('success');
  assert.equal(hLedger.ledger.snapshot().latest.modelRequests, 2);
  assert.equal(hLedger.ledger.snapshot().latest.modelRetries, 1);
});

test('engine network failure timings have null HTTP status and preserve retry logic', async () => {
  const h = engine(index => { if (index === 0) throw new TypeError('FIXTURE_NETWORK_FAILURE'); return toolMessage(toolCall('qq_mark_read', { throughSeq: 7 })); }, undefined, { maxRetries: 1 });
  await h.run();
  assertPrivateTiming(h.timings);
  assert.deepEqual(h.timings.filter(event => event.phase === 'model').map(event => event.status), [null, 200]);
  assert.deepEqual(h.delays, [500]);
  assert.doesNotMatch(JSON.stringify(h.timings), /FIXTURE_NETWORK_FAILURE/);
});

test('engine timing callback exceptions cannot affect success, retries or tool failure recovery', async () => {
  let callbackCount = 0;
  const h = engine([
    json({}, 503),
    toolMessage(toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'] }), toolCall('qq_mark_read', { throughSeq: 7 })),
    toolMessage(toolCall('qq_mark_read', { throughSeq: 7 }))
  ], async name => name === 'qq_send_message' ? { ok: false } : { ok: true }, { maxRetries: 1, onTiming: () => { callbackCount++; throw new Error('FIXTURE_METRICS_SINK_FAILURE'); } });
  const result = await h.run();
  assert.equal(result.closed, true);
  assert.equal(result.rounds, 2);
  assert.equal(result.sent, 0);
  assert.equal(h.requests.length, 3);
  assert.equal(callbackCount, 5);
  assert.deepEqual(h.executed.map(call => call.name), ['qq_send_message', 'qq_mark_read']);
});

test('engine failed model timing callback cannot swallow a genuine nonretryable model failure', async () => {
  const recorded = [];
  const h = engine([json({ error: 'FIXTURE_MODEL_FAILURE' }, 401)], undefined, { onTiming: event => { recorded.push(event); throw new Error('FIXTURE_METRICS_SINK_FAILURE'); } });
  await assert.rejects(h.run(), /DIRECT_API: HTTP 401/);
  assert.equal(h.executed.length, 0);
  assertPrivateTiming(recorded);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, 401);
});

test('engine throwing timing callback never suppresses a successful SEND and CLOSE', async () => {
  let count = 0;
  const h = engine([toolMessage(toolCall('qq_send_message', { messages: ['FIXTURE_REPLY'] }), toolCall('qq_mark_read', { throughSeq: 7 }))], undefined,
    { onTiming: () => { count++; throw new Error('FIXTURE_SINK_ERROR'); } });
  const result = await h.run();
  assert.equal(result.sent, 1);
  assert.equal(result.closed, true);
  assert.equal(result.rounds, 1);
  assert.equal(count, 3);
  assert.deepEqual(h.executed.map(call => call.name), ['qq_send_message', 'qq_mark_read']);
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, message) {
  const end = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > end) assert.fail(message);
    await delay(5);
  }
}

const PRIVATE_KEY = 'private:123';
async function bridgePerformanceFixture(run, { gateway, sleep } = {}) {
  let monotonic = 0;
  let wall = Date.now();
  const ledger = createDirectPerformanceLedger({ now: () => monotonic, wallNow: () => wall });
  const begins = [];
  const ackTimes = [];
  const gatewayCalls = [];
  const advance = ms => { monotonic += ms; wall += ms; };
  const h = await bridgeHarness({
    config: {
      engine: { backend: 'standalone' }, consolePort: 0,
      socialV2: { enabled: true, send: { burstIntervalMinMs: 100, maxGapMs: 10000, maxSendPerMinute: 100 } }
    },
    files: { 'prompts/standalone-system.txt': 'FIXTURE_PRIVATE_SYSTEM_BODY' },
    globals: {
      createDirectPerformanceLedger: () => ({
        snapshot: ledger.snapshot,
        begin(kind, options) {
          begins.push({ kind, ...options });
          const tracker = ledger.begin(kind, options);
          return { ...tracker, ack() { ackTimes.push(monotonic); tracker.ack(); } };
        }
      }),
      createOutboundScheduler: () => createOutboundScheduler({ sleep: sleep || (async ms => advance(ms)) }),
      getEngineStatus: () => ({ ready: true, secret: { source: 'environment' } }),
      resolveEngineDirectConfig: () => ({ model: 'fixture', provider: 'fixture', apiKey: 'fixture-only', baseURL: 'https://provider.invalid/v1', webSearch: false, vision: false }),
      createDirectToolSession: async () => ({ tools: [], execute() {}, async close() {} }),
      runDirectTurn: run,
      fetch: async (url, init = {}) => {
        const action = String(url).split('/').pop();
        const body = JSON.parse(init.body || '{}');
        gatewayCalls.push({ action, body });
        if (gateway) await gateway(action, body);
        advance(50);
        return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: gatewayCalls.length + 1000 } }) };
      }
    }
  });
  h.setMode('reserved2');
  await h.ensureSession(PRIVATE_KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (pathname, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname,
      method: body === undefined ? 'GET' : 'POST', headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers
      } }, res => {
      const parts = [];
      res.on('data', part => parts.push(part));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString('utf8')) }));
    });
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('Fixture local HTTP timeout')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { h, ledger, begins, ackTimes, gatewayCalls, advance, wall: () => wall, request,
    agentHeaders: () => ({ 'x-agent-token': h.getSocialV2State(PRIVATE_KEY).agentToken, 'x-agent-call': '1' }),
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await h.close();
    }
  };
}

test('bridge attributes the first actual agent gateway ACK before a burst finishes, not admin or unknown requests', async () => {
  const burstGate = deferred();
  let waiting = false;
  let f;
  const modelStarted = deferred();
  const modelRelease = deferred();
  let turn;
  f = await bridgePerformanceFixture(async options => {
    options.onContextSent();
    options.onTiming({ phase: 'model', durationMs: 300, round: 1, attempt: 1, status: 200, requestBytes: 600 });
    f.advance(300);
    modelStarted.resolve();
    await modelRelease.promise;
    const response = await f.request('/api/socialV2/send-message', { key: PRIVATE_KEY, messages: ['FIXTURE_FIRST_ACK', 'FIXTURE_SECOND_ACK'], gapMode: 'fixed', gapMs: 1000 }, f.agentHeaders());
    assert.equal(response.status, 200, 'Fixture agent send uses the real HTTP handler');
    options.onTiming({ phase: 'tool', toolName: 'qq_send_message', durationMs: 1100, ok: true });
    return { ok: true, sent: 2, closed: true, rounds: 1 };
  }, { sleep: async ms => { waiting = true; await burstGate.promise; f.advance(ms); } });
  try {
    const st = f.h.getSocialV2State(PRIVATE_KEY);
    f.h.appendSocialV2Message(PRIVATE_KEY, 'fixture', 'FIXTURE_USER_BODY', 'FIXTURE_USER_BODY', false, false, 1);
    const incomingAt = f.wall() - 2000;
    st.unread[0].time = incomingAt;
    st.lastIncomingAt = f.wall();
    turn = f.h.deliverPrompt(PRIVATE_KEY, 'fixture wake', { wakeReason: 'private' });
    await modelStarted.promise;
    const missing = await f.request('/api/socialV2/send-message', { key: PRIVATE_KEY, messages: ['FIXTURE_ADMIN_ATTEMPT'] });
    assert.equal(missing.status, 403);
    const unknown = await f.request('/api/socialV2/send-message', { key: PRIVATE_KEY, messages: ['FIXTURE_UNKNOWN_ATTEMPT'] }, { 'x-agent-token': 'fixture-unknown-token', 'x-agent-call': '1' });
    assert.equal(unknown.status, 403);
    await f.h.sendMessagesV2(PRIVATE_KEY, ['FIXTURE_ADMIN_LOCAL_ACTION'], []);
    assert.equal(f.gatewayCalls.length, 1, 'A fixture operator action still reaches the fake gateway');
    assert.equal(f.ackTimes.length, 0, 'Operator action never becomes a model reply sample');
    modelRelease.resolve();
    await until(() => waiting, 'Burst must wait after its first successful send');
    assert.equal(f.ackTimes.length, 1, 'First ACK is recorded immediately, before the second burst message');
    assert.equal(f.gatewayCalls.length, 2);
    assert.equal(f.ledger.snapshot().sampleCount, 0, 'An active turn does not publish a completed sample');
    burstGate.resolve();
    const result = await turn;
    assert.equal(result.sent, 2);
    const sample = f.ledger.snapshot().latest;
    assert.equal(sample.arrivalWaitMs, 2000);
    assert.equal(sample.executionToFirstReplyMs, 400);
    assert.equal(sample.firstReplyMs, 2400);
    assert.equal(sample.totalMs, 1450);
    assert.equal(sample.outcome, 'success');
    assert.equal(sample.modelRequests, 1);
    assert.equal(sample.requestBytes, 600);
    assert.equal(f.ackTimes.length, 2);
    const admin = await f.request('/api/status');
    assert.equal(admin.status, 200);
    assert.deepEqual(admin.body.performance, f.ledger.snapshot());
    assert.doesNotMatch(JSON.stringify(admin.body.performance), /private:123|FIXTURE_|fixture-console-token|agentToken/);
    for (const headers of [f.agentHeaders(), { 'x-agent-call': '1' }]) {
      const agent = await f.request('/api/status', undefined, headers);
      assert.equal(agent.status, 200);
      assert.equal('performance' in agent.body, false);
      assert.equal('engine' in agent.body, false);
    }
  } finally {
    modelRelease.resolve();
    burstGate.resolve();
    await turn;
    await f.close();
  }
});

test('bridge timing uses the newest actually shown raw message time, never a later inference arrival', async () => {
  let f;
  f = await bridgePerformanceFixture(async options => {
    options.onContextSent();
    const st = f.h.getSocialV2State(PRIVATE_KEY);
    f.h.appendSocialV2Message(PRIVATE_KEY, 'fixture', 'FIXTURE_LATE_ARRIVAL', 'FIXTURE_LATE_ARRIVAL', false, false, 3);
    st.unread.at(-1).time = f.wall() + 1000;
    st.lastIncomingAt = f.wall() + 1000;
    f.advance(250);
    const response = await f.request('/api/socialV2/send-message', { key: PRIVATE_KEY, messages: ['FIXTURE_SNAPSHOT_REPLY'] }, f.agentHeaders());
    assert.equal(response.body.ok, true);
    return { ok: true, sent: 1, closed: true, rounds: 1 };
  });
  try {
    const st = f.h.getSocialV2State(PRIVATE_KEY);
    f.h.appendSocialV2Message(PRIVATE_KEY, 'fixture', 'FIXTURE_OLDER', 'FIXTURE_OLDER', false, false, 1);
    f.h.appendSocialV2Message(PRIVATE_KEY, 'fixture', 'FIXTURE_LATEST_SHOWN', 'FIXTURE_LATEST_SHOWN', false, false, 2);
    const shownAt = f.wall() - 2000;
    st.unread[0].time = f.wall() - 8000;
    st.unread[1].time = shownAt;
    st.lastIncomingAt = f.wall() - 1;
    await f.h.deliverPrompt(PRIVATE_KEY, 'fixture wake', { wakeReason: 'private' });
    assert.equal(f.begins.length, 1);
    assert.equal(f.begins[0].incomingAt, shownAt);
    const sample = f.ledger.snapshot().latest;
    assert.equal(sample.arrivalWaitMs, 2000);
    assert.equal(sample.firstReplyMs, 2300);
    assert.equal(sample.executionToFirstReplyMs, 300);
    assert.ok(st.unread.some(message => message.messageId === '3'), 'Timing never acknowledges new incoming messages');
  } finally { await f.close(); }
});

test('bridge queued send cancelled by pause records no gateway ACK or false successful private sample', async () => {
  const groupGate = deferred();
  let groupRunning = false;
  let f;
  let groupJob;
  let turn;
  f = await bridgePerformanceFixture(async options => {
    options.onContextSent();
    groupJob = f.h.sendMessagesV2('group:456', ['FIXTURE_BLOCK_GLOBAL_ACTION'], []);
    await until(() => groupRunning, 'Fake group gateway action must own the global lane');
    const response = await f.request('/api/socialV2/send-message', { key: PRIVATE_KEY, messages: ['FIXTURE_CANCELLED_REPLY'] }, f.agentHeaders());
    assert.equal(response.body.ok, false);
    options.assertCurrent();
    return { ok: true, sent: 0, closed: true, rounds: 1 };
  }, { gateway: async action => { if (action === 'send_group_msg') { groupRunning = true; await groupGate.promise; } } });
  try {
    await f.h.ensureSession('group:456');
    f.h.appendSocialV2Message(PRIVATE_KEY, 'fixture', 'FIXTURE_USER_BODY', 'FIXTURE_USER_BODY', false, false, 1);
    turn = f.h.deliverPrompt(PRIVATE_KEY, 'fixture wake', { wakeReason: 'private' });
    await until(() => groupRunning && f.h.getSocialV2State(PRIVATE_KEY).sendTimes.length === 1, 'Agent request must be admitted and queued before pause');
    const paused = await f.request('/api/socialV2/activity', { paused: true });
    assert.equal(paused.body.ok, true);
    groupGate.resolve();
    await groupJob;
    const result = await turn;
    assert.equal(result.ok, false);
    assert.equal(f.gatewayCalls.filter(call => call.action === 'send_private_msg').length, 0);
    assert.equal(f.ackTimes.length, 0);
    const snapshot = f.ledger.snapshot();
    assert.equal(snapshot.sampleCount, 1);
    assert.equal(snapshot.latest.outcome, 'cancelled');
    assert.equal(snapshot.latest.firstReplyMs, null);
    assert.equal(snapshot.latest.executionToFirstReplyMs, null);
    assert.equal(snapshot.private.count, 0);
    assert.equal(f.h.getSocialV2State(PRIVATE_KEY).sendTimes.length, 0, 'Rejected queued send rolls back quota');
  } finally {
    groupGate.resolve();
    await groupJob;
    await turn;
    await f.close();
  }
});
