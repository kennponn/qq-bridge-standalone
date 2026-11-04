import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { resolveConversationTiming } from '../src/conversation-timing.js';
import { bindDirectTool } from '../src/direct-tools.js';

const GROUP = 'group:456';
const PRIVATE = 'private:123';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 3500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(message);
    await delay(5);
  }
}

async function fixture(run, { enabled = true, directTurn } = {}) {
  let h;
  h = await bridgeHarness({ config: {
    engine: { backend: 'standalone' }, socialV2: {
      wake: { alwaysAwake: enabled, preSleepWaitEnabled: true, preSleepWaitMs: 300000,
        maxWakePerMinute: 30, maxWakePerHour: 120 },
      proactive: { enabled: true }, sticker: { enabled: false },
    }
  }, files: { 'prompts/standalone-system.txt': 'Fixture. No real network or QQ.' }, globals: {
    getEngineStatus: () => ({ ready: true, secret: { source: 'environment' } }),
    resolveEngineDirectConfig: () => ({ model: 'fixture', provider: 'fixture', apiKey: 'fixture-only',
      baseURL: 'https://model.invalid/v1', webSearch: false, vision: false }),
    createDirectToolSession: async () => ({ tools: [], execute() { throw new Error('Real tools forbidden'); }, async close() {} }),
    runDirectTurn: async options => directTurn ? directTurn({ options, h, request }) : ({ ok: true, sent: 0, closed: true }),
  } });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  function request(route, { key, body, agent = false, token } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/socialV2/' + route + (body === undefined && key ? '?key=' + encodeURIComponent(key) : ''),
        method: body === undefined ? 'GET' : 'POST', headers: {
          'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
          ...(agent ? { 'x-agent-token': token ?? h.getSocialV2State(key).agentToken } : {}),
        } }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(text) }); } catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify({ ...(key ? { key } : {}), ...body }));
    });
  }
  const append = (key, content) => h.appendSocialV2Message(key, 'fixture', content, content, false, false,
    'fixture-' + (h.getSocialV2State(key).lastUnreadSeq + 1), [], '123', []);
  try { await run({ h, request, append }); }
  finally {
    for (const controller of h.directTurnControllers.values()) controller.abort();
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
}

const event = (id, mention = false) => ({ message_type: 'group', group_id: 456, user_id: 123, self_id: 999,
  message_id: id, sender: { nickname: 'fixture' },
  message: [...(mention ? [{ type: 'at', data: { qq: '999' } }] : []), { type: 'text', data: { text: 'fixture-' + id } }] });

test('hot enable releases an existing legacy long wait without hiding unseen arrivals', () => fixture(async ({ h, request, append }) => {
  append(GROUP, 'seen before wait');
  const st = h.getSocialV2State(GROUP);
  h.noteModelMessagesV2(st, [...st.unread]);
  const waiting = request('wait', { key: GROUP, agent: true, body: { timeoutMs: 300000 } });
  await delay(120);
  append(GROUP, 'unseen during legacy wait');
  await delay(120);
  const at = Date.now();
  assert.equal((await request('config', { body: { wake: { alwaysAwake: true } } })).status, 200);
  const result = await waiting;
  assert.equal(result.status, 200);
  assert.equal(result.data.listeningModeChanged, true);
  assert.ok(Date.now() - at < 1000, 'old five-minute wait must return promptly after enable');
  assert.equal(result.data.newMessages.length, 1);
  assert.equal(st.unread.length, 2, 'returning wait must not acknowledge any messages');
  assert.match(result.data.hint, /Do not repeat the old sleep wait/);
}, { enabled: false }));

test('effective state stays active across model diving changes; disabling restores saved policy', () => fixture(async ({ h, request, append }) => {
  const st = h.getSocialV2State(GROUP);
  st.wakeConfig.confirmedBy = 'mark_read';
  st.wakeConfig.triggers.anyMessage = false;
  const original = JSON.stringify(st.wakeConfig);
  const effective = (await request('state', { key: GROUP })).data.wakeConfig;
  assert.equal(effective.mode, 'active');
  assert.equal(effective.alwaysAwake, true);
  assert.equal(effective.batchWindowMs, 1000);
  assert.equal(JSON.stringify(st.wakeConfig), original, 'GET overlay must not persist or replace preferences');
  append(GROUP, 'first');
  h.noteModelMessagesV2(st, [...st.unread]);
  append(GROUP, 'second unseen');
  const closed = await request('wake-config', { key: GROUP, agent: true, body: {
    throughSeq: 1, config: { mode: 'diving', infinite: false, sleepMs: 60000, batchWindowMs: 9000 },
  } });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.wakeConfig.mode, 'active');
  assert.equal(st.wakeConfig.mode, 'diving');
  assert.equal(st.wakeConfig.batchWindowMs, 9000);
  assert.equal(st.unread.length, 1, 'close must preserve unseen arrivals');
  assert.equal(st.sleepTimer, null);
  assert.equal(st.proactiveTimer, null);
  const denied = await request('config', { key: GROUP, agent: true, body: { wake: { alwaysAwake: false } } });
  assert.equal(denied.status, 403, 'model token cannot alter host mode');
  const changed = await request('config', { body: { wake: { alwaysAwake: false } } });
  assert.equal(changed.status, 200);
  const restored = (await request('state', { key: GROUP })).data.wakeConfig;
  assert.equal(restored.mode, 'diving');
  assert.equal(restored.batchWindowMs, 9000);
  assert.ok(st.sleepTimer);
  assert.equal(st.unread.length, 1);
}));

test('safe close bypasses sleep observation but not cursor, token or private behavior', () => fixture(async ({ h, request, append }) => {
  append(GROUP, 'seen');
  const st = h.getSocialV2State(GROUP);
  assert.equal((await request('mark-read', { key: GROUP, agent: true, body: { throughSeq: 1 } })).status, 400);
  h.noteModelMessagesV2(st, [...st.unread]);
  append(GROUP, 'unseen');
  assert.equal((await request('mark-read', { key: GROUP, agent: true, body: { throughSeq: 2 } })).status, 400);
  assert.equal((await request('mark-read', { key: GROUP, agent: true, token: 'invalid', body: { throughSeq: 1 } })).status, 403);
  assert.equal((await request('mark-read', { key: GROUP, agent: true, body: { throughSeq: 1 } })).status, 200);
  assert.equal(st.unread.length, 1);
  assert.equal((await request('state', { key: PRIVATE })).data.wakeConfig.mode, 'diving');
  const prompt = h.buildWakePromptV2(GROUP, 'atMention');
  assert.match(prompt, /GROUP_ALWAYS_AWAKE/);
  assert.doesNotMatch(prompt, /【沉睡前强制等待】/);
  assert.ok(st.wakeConfig.mode === 'diving', 'base policy is unchanged');
}));

test('ordinary and direct group messages batch in one second, never overlap turns or poll idle', () => {
  const starts = [];
  return fixture(async ({ h }) => {
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    st.wakeConfig.triggers.atMention = false;
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() + 60000).toISOString();
    const savedDeadline = st.wakeConfig.sleepUntil;
    const at = Date.now();
    await h.handleIncoming('group', 456, event(1), h.cfg);
    await delay(200);
    await h.handleIncoming('group', 456, event(2, true), h.cfg);
    await until(() => starts.length === 1, 'group did not start within short batching window');
    assert.ok(starts[0] - at >= 900 && starts[0] - at < 2500);
    assert.equal(st.lastWakeReason, 'atMention', 'direct @ retains priority even if AI disabled its trigger');
    await until(() => h.directTurnControllers.size === 0, 'turn cleanup incomplete');
    assert.equal(st.unread.length, 0);
    assert.equal(st.replyCheckTimer, null);
    assert.equal(st.proactiveTimer, null);
    assert.equal(st.sleepTimer, null);
    assert.equal(st.wakeConfig.infinite, false, 'real wake must preserve saved finite policy under the overlay');
    assert.equal(st.wakeConfig.sleepUntil, savedDeadline);
    await h.sendWakePromptV2(GROUP, 'replyCheck');
    await delay(1100);
    assert.equal(starts.length, 1, 'idle state must not start model polling');
    await h.handleIncoming('group', 456, event(3), h.cfg);
    await until(() => starts.length === 2, 'next incoming message was lost after close');
  }, { directTurn: async ({ options, h, request }) => {
    starts.push(Date.now());
    assert.match(options.systemPrompt, /GROUP_ALWAYS_AWAKE_POLICY/);
    options.assertCurrent();
    options.onContextSent();
    const st = h.getSocialV2State(GROUP);
    const deadline = st.wakeConfig.sleepUntil;
    const closed = await request('mark-read', { key: GROUP, agent: true, body: { throughSeq: h.readThroughSeqV2(st) } });
    assert.equal(closed.status, 200);
    assert.equal(st.wakeConfig.sleepUntil, deadline, 'closing must not consume the saved finite policy');
    st.unread = [];
    return { ok: true, sent: 0, closed: true };
  } });
});

test('toggling preserves scheduled incoming work and group wake/send quotas', () => {
  const starts = [];
  return fixture(async ({ h, request, append }) => {
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    st.replyCheckTimer = setTimeout(() => assert.fail('stale reply timer fired'), 10000);
    await h.handleIncoming('group', 456, event(10, true), h.cfg);
    assert.ok(st.pendingWakeTimer);
    const changed = await request('config', { body: { wake: { alwaysAwake: true } } });
    assert.equal(changed.status, 200);
    assert.ok(st.pendingWakeTimer, 'retuning must not drop a pending incoming message');
    assert.equal(st.replyCheckTimer, null, 'toggle must cancel old reply-check timers');
    assert.equal(h.cfg.socialV2.wake.maxWakePerMinute, 30);
    assert.equal(h.cfg.socialV2.wake.maxWakePerHour, 120);
    assert.equal(h.cfg.socialV2.send.maxSendPerMinute, 8);
    assert.equal(h.cfg.socialV2.send.maxSendPerHour, 60);
    await until(() => starts.length === 1, 'pending work did not resume');
    await until(() => h.directTurnControllers.size === 0, 'turn cleanup incomplete');
    st.wakeTimes = Array.from({ length: 30 }, () => Date.now());
    append(GROUP, 'bounded rate fixture');
    await h.sendWakePromptV2(GROUP, 'atMention');
    assert.equal(starts.length, 1);
    assert.ok(st.rateLimitRetryTimer, 'always awake does not bypass wake caps');
    h.socialV2.paused = true;
    await h.handleIncoming('group', 456, event(11, true), h.cfg);
    assert.equal(st.pendingWakeTimer, null, 'paused mode must not schedule new turns');
  }, { enabled: false, directTurn: async ({ options, h }) => {
    starts.push(Date.now());
    options.assertCurrent();
    options.onContextSent();
    h.getSocialV2State(GROUP).unread = [];
    return { ok: true, sent: 0, closed: true };
  } });
});

test('short quiet API and tool guidance share host bounds without weakening schemas', () => fixture(async ({ h, request, append }) => {
  append(GROUP, 'complete question');
  const st = h.getSocialV2State(GROUP);
  st.lastIncomingAt = Date.now() - 6000;
  const waited = await request('wait', { key: GROUP, agent: true,
    body: { purpose: 'reply', quietMs: 999999, timeoutMs: 999999 } });
  assert.equal(waited.status, 200);
  assert.equal(waited.data.quietMs, 3000);
  assert.ok(waited.data.waitedMs < 1000);
  const timing = resolveConversationTiming(h.cfg, GROUP, { standalone: true });
  const definition = { name: 'qq_wait_for_messages', description: 'Legacy five-minute timing.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, token: { type: 'string' },
      quietMs: { type: 'number' }, timeoutMs: { type: 'number' } }, required: ['key', 'token'] } };
  const bound = bindDirectTool(definition, { key: GROUP, agentToken: 'fixture-only', timing });
  assert.match(bound.tool.function.description, /HOST ALWAYS-ON GROUP OVERRIDE/);
  assert.match(bound.tool.function.parameters.properties.quietMs.description, /3000/);
  assert.equal(bound.tool.function.parameters.additionalProperties, false);
  assert.throws(() => bound.arguments({ key: 'group:999' }), /cannot be changed/);
  assert.equal(definition.description, 'Legacy five-minute timing.');
}));
