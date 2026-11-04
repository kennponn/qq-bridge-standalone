// Synthetic peers only; the real bridge functions never contact QQ or a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createOutboundScheduler } from '../src/outbound-scheduler.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, message = 'Fixture did not advance') {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(2);
  }
}

async function fixture({ pause, fail, config = {} } = {}) {
  const events = [];
  const waits = [];
  const cleanups = [];
  let active = 0;
  let maxActive = 0;
  const transport = async (kind, segments) => {
    const label = Array.isArray(segments)
      ? segments.find((segment) => ['text', 'record', 'image'].includes(segment.type))?.type
      : 'sdk';
    active++;
    maxActive = Math.max(maxActive, active);
    const event = { kind, label, segments, at: Date.now() };
    events.push(event);
    try {
      await delay(2);
      if (fail?.(event, events)) throw new Error('fixture gateway rejected');
      return { message_id: 9001 };
    } finally { active--; }
  };
  const h = await bridgeHarness({
    config: { engine: { backend: 'standalone' }, sendDelayMs: 5,
      socialV2: { send: { burstIntervalMinMs: 100, burstIntervalMaxMs: 100,
        maxGapMs: 10000, maxSendPerMinute: 8, maxSendPerHour: 60 },
        voice: { enabled: true, autoReadback: false }, replyCheck: { enabled: false } }, ...config },
    files: { 'roles/alpha.md': 'FIXTURE_ALPHA', 'roles/beta.md': 'FIXTURE_BETA',
      'state/current-role.json': { role: 'alpha', mode: 'active' } },
    globals: {
      createOutboundScheduler: () => createOutboundScheduler({ sleep: async (ms) => {
        const wait = { ms, gate: deferred() };
        waits.push(wait);
        if (pause?.(wait)) await wait.gate.promise;
        else await delay(Math.min(ms, 2));
      } }),
      captureDirectSendMetrics: () => ({ ack() {}, queued() {}, gateway() {} }),
      inspectAudio: async () => ({ ok: true, size: 512, duration: 1, codec: 'fixture', warnings: [] }),
      cleanupTemp: (file, converted) => cleanups.push({ file, converted }),
      safeFetchBuffer: async () => ({ buffer: Buffer.from('89504e470d0a1a0a00000000', 'hex') }),
      fetch: async (url, init = {}) => {
        const body = JSON.parse(init.body ?? '{}');
        if (!/\/send_(group|private)_msg$/.test(String(url))) {
          return { ok: true, status: 200,
            json: async () => ({ status: 'ok', retcode: 0, data: [] }) };
        }
        const data = await transport(body.user_id ? 'private' : 'group', body.message);
        return { ok: true, status: 200,
          json: async () => ({ status: 'ok', retcode: 0, data }) };
      },
    },
  });
  h.setMode('reserved2');
  h.bot.sendPrivateMessage = (id, text) => transport('private', text);
  h.bot.sendGroupMessage = (id, text) => transport('group', text);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (pathname, body, token = h.getSocialV2State(body.key || 'group:456').agentToken) =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: pathname, method: 'POST', headers: {
          'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
          'x-agent-token': token, 'x-agent-call': '1',
        } }, (res) => {
        const chunks = [];
        res.on('data', (part) => chunks.push(part));
        res.on('end', () => resolve({ status: res.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.setTimeout(2500, () => req.destroy(new Error('Fixture request timed out')));
      req.end(JSON.stringify(body));
    });
  return { h, events, waits, cleanups, request, maxActive: () => maxActive,
    async close() {
      for (const wait of waits) wait.gate.resolve();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    } };
}

test('ready private action enters a group gap; entire same-key jobs stay ordered', async () => {
  const gate = deferred();
  const events = [];
  const scheduler = createOutboundScheduler({ sleep: () => gate.promise });
  const a = scheduler.enqueue('group', async ({ send, wait }) => {
    await send(() => events.push('A'));
    await wait(100);
    await send(() => events.push('B'));
  });
  const c = scheduler.enqueue('group', ({ send }) => send(() => events.push('C')));
  await until(() => events.length === 1);
  await scheduler.enqueue('private', ({ send }) => send(() => events.push('P')));
  assert.deepEqual(events, ['A', 'P']);
  gate.resolve();
  await Promise.all([a, c]);
  assert.deepEqual(events, ['A', 'P', 'B', 'C']);
});

test('failed action retains global cooldown, does not poison either lane, and timing is observational', async () => {
  const gate = deferred();
  const events = [];
  const timings = [];
  const scheduler = createOutboundScheduler({ sleep: () => gate.promise });
  const a = scheduler.enqueue('a', ({ send }) => send(() => { events.push('A'); throw new Error('fixture'); },
    { cooldownMs: 300, onTiming: (value) => { timings.push(value); throw new Error('observational'); } }));
  const caught = assert.rejects(a, /fixture/);
  const b = scheduler.enqueue('b', ({ send }) => send(() => events.push('B')));
  await until(() => events.length === 1);
  await delay(5);
  assert.deepEqual(events, ['A']);
  gate.resolve();
  await Promise.all([caught, b]);
  await scheduler.enqueue('a', ({ send }) => send(() => events.push('C')));
  assert.deepEqual(events, ['A', 'B', 'C']);
  assert.equal(timings.length, 1);
  assert.ok(timings[0].queueMs >= 0 && timings[0].gatewayMs >= 0);
});

test('all five bridge paths preserve same-key invocation order, quote-first-only, and one active gateway', async () => {
  const f = await fixture();
  try {
    const jobs = [
      f.h.sendToQQ('group:456', 'fixture-A'),
      f.h.sendVoiceV2('group:456', path.join(f.h.temp, 'fixture.mp3'), { guard: true }),
      f.h.sendStickerV2('group:456', 'fixture-sticker'),
      f.h.sendBurstToQQ('group:456', ['fixture-D1', 'fixture-D2'], 1, 1),
      f.h.sendMessagesV2('group:456', ['fixture-E1', 'fixture-E2'], [1], '501', '111'),
    ];
    await Promise.all(jobs);
    assert.deepEqual(f.events.map((entry) => entry.label), ['sdk', 'record', 'image', 'sdk', 'sdk', 'text', 'text']);
    assert.equal(f.maxActive(), 1);
    assert.equal(f.events[5].segments.filter((segment) => segment.type === 'reply').length, 1);
    assert.equal(f.events[5].segments.filter((segment) => segment.type === 'at').length, 1);
    assert.equal(f.events[6].segments.some((segment) => ['reply', 'at'].includes(segment.type)), false);
    assert.equal(f.h.lastSendSucceeded('group:456'), true);
  } finally { await f.close(); }
});

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy' : 'V2'} group burst gaps let private through without reordering same-key follow-ups`, async () => {
    const f = await fixture({ pause: (wait) => wait.ms === 300 });
    try {
      const group = legacy
        ? f.h.sendBurstToQQ('group:456', ['fixture-A', 'fixture-B'], 300, 300)
        : f.h.sendMessagesV2('group:456', ['fixture-A', 'fixture-B'], [300]);
      const follow = f.h.sendMessagesV2('group:456', ['fixture-C'], []);
      await until(() => f.waits.some((wait) => wait.ms === 300));
      await f.h.sendMessagesV2('private:123', ['fixture-P'], []);
      assert.deepEqual(f.events.map((event) => event.kind), ['group', 'private']);
      f.waits.find((wait) => wait.ms === 300).gate.resolve();
      await Promise.all([group, follow]);
      assert.deepEqual(f.events.map((event) => event.kind), ['group', 'private', 'group', 'group']);
      assert.equal(f.maxActive(), 1);
    } finally { await f.close(); }
  });
}

test('sticker pause is local; same-key text cannot overtake it', async () => {
  const f = await fixture({ pause: (wait) => wait.ms >= 800 });
  try {
    const sticker = f.h.sendStickerV2('group:456', 'fixture-sticker');
    const text = f.h.sendMessagesV2('group:456', ['fixture-text'], []);
    await until(() => f.waits.length > 0);
    await f.h.sendMessagesV2('private:123', ['fixture-private'], []);
    assert.deepEqual(f.events.map((event) => event.kind), ['private']);
    f.waits[0].gate.resolve();
    await Promise.all([sticker, text]);
    assert.deepEqual(f.events.map((event) => event.label), ['text', 'image', 'text']);
  } finally { await f.close(); }
});

for (const rejectFirst of [false, true]) {
  test(`legacy global cooldown survives ${rejectFirst ? 'failed' : 'successful'} SDK send`, async () => {
    const f = await fixture({ pause: (wait) => wait.ms === 300,
      fail: (_, entries) => rejectFirst && entries.length === 1, config: { sendDelayMs: 300 } });
    try {
      const legacy = f.h.sendToQQ('group:456', 'fixture-A');
      await until(() => f.waits.length === 1);
      const privateJob = f.h.sendMessagesV2('private:123', ['fixture-P'], []);
      await delay(5);
      assert.equal(f.events.length, 1);
      f.waits[0].gate.resolve();
      await Promise.all([legacy, privateJob]);
      assert.equal(f.h.lastSendSucceeded('group:456'), !rejectFirst);
      assert.deepEqual(f.events.map((event) => event.kind), ['group', 'private']);
    } finally { await f.close(); }
  });
}

test('V2 partial gateway failure keeps err.sent, rolls back failed quota only, and never retries', async () => {
  const f = await fixture({ fail: (_, entries) => entries.length === 2 });
  try {
    const response = await f.request('/api/socialV2/send-message', { key: 'group:456',
      messages: ['fixture-A', 'fixture-B', 'fixture-C'], gapMode: 'fixed', gaps: [100, 100] });
    assert.equal(response.status, 500);
    assert.equal(f.events.length, 3);
    const st = f.h.getSocialV2State('group:456');
    assert.equal(st.sendTimes.length, 2);
    assert.equal(st.recentMessages.filter((message) => message.isSelf).length, 2);
    assert.deepEqual(Array.from(await f.h.sendMessagesV2('group:456', ['fixture-D'], [])), ['fixture-D']);
    assert.equal(f.events.length, 4);
    assert.equal(f.maxActive(), 1);
  } finally { await f.close(); }
});

test('V2 direct partial failure exposes exactly the acknowledged messages in err.sent', async () => {
  const f = await fixture({ fail: (_, entries) => entries.length === 2 });
  try {
    await assert.rejects(f.h.sendMessagesV2('group:456', ['fixture-A', 'fixture-B', 'fixture-C'], []), (error) => {
      assert.deepEqual(Array.from(error.sent), ['fixture-A', 'fixture-C']);
      return true;
    });
    assert.equal(f.events.length, 3);
    assert.equal(f.maxActive(), 1);
  } finally { await f.close(); }
});

test('concurrent same-key requests cannot bypass reserved quota while another conversation remains independent', async () => {
  const f = await fixture({ pause: (wait) => wait.ms === 300 });
  try {
    f.h.cfg.socialV2.send.maxSendPerMinute = 2;
    const first = f.request('/api/socialV2/send-message', { key: 'group:456',
      messages: ['fixture-A', 'fixture-B'], gapMode: 'fixed', gaps: [300] });
    await until(() => f.waits.some((wait) => wait.ms === 300));
    const blocked = await f.request('/api/socialV2/send-message', {
      key: 'group:456', messages: ['fixture-C'] });
    assert.equal(blocked.status, 429);
    assert.equal(f.h.getSocialV2State('group:456').sendTimes.length, 2);
    const privateResponse = await f.request('/api/socialV2/send-message', {
      key: 'private:123', messages: ['fixture-P'] });
    assert.equal(privateResponse.status, 200);
    assert.deepEqual(f.events.map((event) => event.kind), ['group', 'private']);
    f.waits.find((wait) => wait.ms === 300).gate.resolve();
    assert.equal((await first).status, 200);
    assert.equal(f.events.length, 3);
    assert.equal(f.maxActive(), 1);
  } finally { await f.close(); }
});

test('all five queued paths recheck allowlist, with legacy failure accounting unchanged', async () => {
  const f = await fixture({ pause: (wait) => wait.ms === 300 });
  try {
    const first = f.h.sendMessagesV2('group:456', ['fixture-A', 'fixture-B'], [300]);
    const firstResult = Promise.allSettled([first]);
    await until(() => f.waits.some((wait) => wait.ms === 300));
    const results = Promise.allSettled([
      f.h.sendToQQ('group:456', 'fixture-C'),
      f.h.sendVoiceV2('group:456', path.join(f.h.temp, 'fixture.mp3'), { guard: true }),
      f.h.sendStickerV2('group:456', 'fixture-sticker'),
      f.h.sendBurstToQQ('group:456', ['fixture-D'], 1, 1),
      f.h.sendMessagesV2('group:456', ['fixture-E'], []),
    ]);
    f.h.cfg.allow.groups = [];
    f.waits.find((wait) => wait.ms === 300).gate.resolve();
    assert.equal((await firstResult)[0].status, 'rejected');
    assert.deepEqual((await results).map((result) => result.status),
      ['fulfilled', 'rejected', 'rejected', 'fulfilled', 'rejected']);
    assert.equal(f.events.length, 1);
    assert.equal(f.h.lastSendSucceeded('group:456'), false);
  } finally { await f.close(); }
});

test('voice gateway failure frees the lane and cleans temporary audio exactly once', async () => {
  const f = await fixture({ fail: (_, entries) => entries.length === 1 });
  try {
    await assert.rejects(f.h.sendVoiceV2('group:456', path.join(f.h.temp, 'fixture.mp3'),
      { guard: true, audio: { volume: 2 } }), /fixture gateway rejected/);
    assert.equal(f.cleanups.length, 1);
    assert.equal(f.cleanups[0].converted, true);
    await f.h.sendMessagesV2('private:123', ['fixture-P'], []);
    assert.deepEqual(f.events.map((event) => event.label), ['record', 'text']);
    assert.equal(f.maxActive(), 1);
  } finally { await f.close(); }
});

for (const change of ['persona', 'token', 'pause', 'allowlist']) {
  test(`${change} change during group gap prevents stale send and rolls back unsent quota`, async () => {
    const f = await fixture({ pause: (wait) => wait.ms === 300 });
    try {
      const key = 'group:456';
      const job = f.request('/api/socialV2/send-message', { key,
        messages: ['fixture-A', 'fixture-B'], gapMode: 'fixed', gaps: [300] });
      await until(() => f.waits.some((wait) => wait.ms === 300));
      if (change === 'persona') fs.writeFileSync(path.join(f.h.temp, 'state/current-role.json'),
        JSON.stringify({ role: 'beta', mode: 'active' }));
      if (change === 'token') f.h.getSocialV2State(key).agentToken = 'fixture-revoked';
      if (change === 'pause') f.h.socialV2.paused = true;
      if (change === 'allowlist') f.h.cfg.allow.groups = [];
      f.waits.find((wait) => wait.ms === 300).gate.resolve();
      const response = await job;
      assert.equal(response.status, 500);
      assert.equal(f.events.length, 1);
      assert.equal(f.h.getSocialV2State(key).sendTimes.length, 1);
      assert.equal(f.h.getSocialV2State(key).recentMessages.filter((message) => message.isSelf).length, 1);
      assert.equal(f.maxActive(), 1);
    } finally { await f.close(); }
  });
}
