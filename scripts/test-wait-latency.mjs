// Real wait handler, temporary fixture state and loopback-only HTTP peers.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { resolveConversationTiming } from '../src/conversation-timing.js';

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(run, { key = 'private:123', config = {}, globals = {} } = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    wait: { minMs: 100, maxMs: 600000, defaultMs: 600, defaultQuietMs: 100, minQuietAfterNewMs: 0 },
    wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
    privateChat: { fastReply: true, quietMs: 100, minQuietMs: 0, maxQuietMs: 1000 },
    proactive: { enabled: false }, sticker: { enabled: false }, ...config,
  } }, globals: { resolveConversationTiming, ...globals } });
  h.setMode('reserved2');
  const st = h.getSocialV2State(key);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (body, { cancelAfterMs } = {}) => new Promise((resolve, reject) => {
    let cancelTimer;
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: '/api/socialV2/wait', method: 'POST', headers: {
        'x-console-token': 'fixture-console-token', 'x-agent-token': st.agentToken,
        'content-type': 'application/json',
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        clearTimeout(cancelTimer);
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', error => { clearTimeout(cancelTimer); reject(error); });
    req.setTimeout(5000, () => req.destroy(new Error('Fixture request timed out')));
    req.end(JSON.stringify({ key, ...body }));
    if (cancelAfterMs !== undefined) cancelTimer = setTimeout(() => req.destroy(new Error('Fixture cancelled')), cancelAfterMs);
  });
  const append = text => h.appendSocialV2Message(key, 'fixture-person', text, text,
    false, false, `fixture-${st.lastUnreadSeq + 1}`, [], '789', []);
  const seeAll = () => h.noteModelMessagesV2(st, [...st.unread]);
  try { await run({ h, st, key, request, append, seeAll }); }
  finally { await new Promise(resolve => server.close(resolve)); await h.close(); }
}

test('private unseen message before messages wait returns without a third message', () => fixture(async ({ st, request, append, seeAll }) => {
  append('known first message');
  seeAll();
  append('message received during model thinking');
  st.lastIncomingAt = Date.now() - 3000;
  const result = await request({ purpose: 'messages', timeoutMs: 1200, quietMs: 100, minNewMessages: 20 });
  assert.equal(result.status, 200);
  assert.ok(result.data.waitedMs < 400, 'already-quiet unseen backlog must not wait out the future-message budget');
  assert.equal(result.data.arrived, true);
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
  assert.equal(result.data.readThroughSeq, 2);
  assert.equal(st.unread.length, 2, 'displaying is not acknowledging');
  assert.equal(result.data.countsAsObservation, false);
  assert.equal(st.preSleepWaitObservedAt, 0);
}));

test('entry backlog waits only remaining actual quiet and grants no group sleep observation', () => fixture(async ({ st, request, append, seeAll }) => {
  append('known message');
  seeAll();
  append('unseen complete message');
  st.lastIncomingAt = Date.now() - 100;
  const result = await request({ purpose: 'messages', timeoutMs: 300000, quietMs: 300 });
  assert.equal(result.status, 200);
  assert.ok(result.data.waitedMs >= 100 && result.data.waitedMs < 650);
  assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
  assert.equal(result.data.quiet, true);
  assert.equal(result.data.countsAsObservation, false);
  assert.equal(result.data.preSleepWaitSatisfied, false);
  assert.equal(result.data.preSleepWaitObserved, false);
  assert.equal(result.data.canSleepNow, false);
  assert.equal(st.preSleepWaitObservedAt, 0);
  assert.equal(st.preSleepWaitSatisfiedAt, 0);
}, { key: 'group:456' }));

test('already-seen unacknowledged unread does not make ordinary waits busy-loop', () => fixture(async ({ st, request, append, seeAll }) => {
  append('known but not acknowledged');
  seeAll();
  st.lastIncomingAt = Date.now() - 3000;
  for (let round = 0; round < 2; round++) {
    const result = await request({ purpose: 'messages', timeoutMs: 250, quietMs: 0 });
    assert.ok(result.data.waitedMs >= 250);
    assert.equal(result.data.arrived, false);
    assert.equal(result.data.timeout, true);
    assert.deepEqual(result.data.newMessages, []);
  }
  assert.equal(st.unread.length, 1);
}));

test('future arrival uses its actual quiet timestamp rather than poll detection time', () => fixture(async ({ st, request, append, seeAll }) => {
  append('known message');
  seeAll();
  const timer = setTimeout(() => {
    append('future message');
    st.lastIncomingAt = Date.now() - 200;
  }, 30);
  try {
    const result = await request({ purpose: 'messages', timeoutMs: 800, quietMs: 200 });
    assert.equal(result.data.arrived, true);
    assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
    assert.ok(result.data.waitedMs < 250, 'polling must not restart an already-complete quiet window');
  } finally { clearTimeout(timer); }
}));

test('ordinary wait returns an arrival in its final timeout sleep', async () => {
  let clock = 1800000000000;
  let inject;
  const timers = new Set();
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const clockTimeout = (fn, ms) => {
    const step = inject && ms <= 300;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (step) {
        clock += ms;
        const arrival = inject;
        inject = undefined;
        arrival();
      }
      fn();
    }, step ? 1 : ms);
    timers.add(timer);
    return timer;
  };
  try {
    await fixture(async ({ request, append, seeAll }) => {
      append('known message');
      seeAll();
      inject = () => append('arrived in the final sleep');
      const result = await request({ purpose: 'messages', timeoutMs: 100, quietMs: 0 });
      assert.equal(result.data.waitedMs, 100);
      assert.equal(result.data.arrived, true);
      assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
      assert.equal(result.data.readThroughSeq, 2);
      assert.equal(result.data.preSleepWaitSatisfied, false);
    }, { key: 'group:456', globals: { Date: FixtureDate, setTimeout: clockTimeout } });
  } finally { for (const timer of timers) clearTimeout(timer); }
});

test('response disconnect stops wait without changing observation or model-seen state', () => fixture(async ({ h, st, request, append, seeAll }) => {
  append('known message');
  seeAll();
  st.preSleepWaitObservedAt = 33;
  st.preSleepWaitAccumMs = 77;
  const before = {
    seen: Array.from(st.modelSeenSeqs), through: h.readThroughSeqV2(st),
    observed: st.preSleepWaitObservedAt, satisfied: st.preSleepWaitSatisfiedAt,
    accumulated: st.preSleepWaitAccumMs, unread: st.unread.length,
  };
  await assert.rejects(request({ purpose: 'messages', timeoutMs: 600, quietMs: 100 }, { cancelAfterMs: 60 }), /Fixture cancelled/);
  await pause(800);
  assert.deepEqual({
    seen: Array.from(st.modelSeenSeqs), through: h.readThroughSeqV2(st),
    observed: st.preSleepWaitObservedAt, satisfied: st.preSleepWaitSatisfiedAt,
    accumulated: st.preSleepWaitAccumMs, unread: st.unread.length,
  }, before, 'a disconnected wait must not finish its observation in the background');
}, { key: 'group:456', config: { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 200 } } }));

test('cancelling either quiet-wait path cannot authorize its unseen backlog', () => fixture(async ({ h, st, request, append, seeAll }) => {
  append('known first message');
  seeAll();
  for (const purpose of ['reply', 'messages']) {
    append(`unseen ${purpose} message`);
    const seen = Array.from(st.modelSeenSeqs);
    const through = h.readThroughSeqV2(st);
    await assert.rejects(request({ purpose, timeoutMs: 1000, quietMs: 400 }, { cancelAfterMs: 60 }), /Fixture cancelled/);
    await pause(450);
    assert.deepEqual(Array.from(st.modelSeenSeqs), seen);
    assert.equal(h.readThroughSeqV2(st), through);
    assert.equal(st.preSleepWaitObservedAt, 0);
    assert.equal(st.preSleepWaitSatisfiedAt, 0);
  }
}));

test('neither disabled history buffer can expose or authorize ordinary backlog', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.tools.getUnread = false;
  h.cfg.socialV2.tools.getRecent = false;
  append('hidden pending message');
  const result = await request({ purpose: 'messages', timeoutMs: 200, quietMs: 0 });
  assert.equal(result.data.arrived, false);
  assert.deepEqual(result.data.newMessages, []);
  assert.equal(result.data.readThroughSeq, 0);
  assert.equal(st.modelSeenSeqs.size, 0);
  assert.equal(st.preSleepWaitObservedAt, 0);
}));

test('a seen noncontiguous recent receipt is not unseen backlog or cursor permission', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.tools.getUnread = false;
  append('older message inaccessible to recent');
  append('newer message already seen');
  st.recentMessages = st.recentMessages.filter(m => m.seq === 2);
  h.noteModelMessagesV2(st, st.recentMessages);
  assert.equal(h.readThroughSeqV2(st), 0, 'unseen first message must keep the cursor blocked');
  const result = await request({ purpose: 'messages', timeoutMs: 200, quietMs: 0 });
  assert.ok(result.data.waitedMs >= 200);
  assert.equal(result.data.arrived, false);
  assert.deepEqual(result.data.newMessages, []);
  assert.equal(result.data.readThroughSeq, 0);
}));

test('a capped seen recent backlog cannot hide the newest unseen message behind an inaccessible cursor gap', () => fixture(async ({ h, st, request, append }) => {
  h.cfg.socialV2.tools.getUnread = false;
  h.cfg.socialV2.context.unreadLimit = 20;
  append('inaccessible first message');
  for (let seq = 2; seq <= 15; seq++) append(`seen message ${seq}`);
  st.recentMessages = st.recentMessages.filter(m => m.seq > 1);
  h.noteModelMessagesV2(st, st.recentMessages);
  append('newest unseen message');
  // Keep a cap smaller than the already-seen recent backlog, without evicting
  // the inaccessible seq1 needed to prove cursor authorization remains blocked.
  h.cfg.socialV2.context.unreadLimit = 1;
  st.lastIncomingAt = Date.now() - 3000;
  const first = await request({ purpose: 'messages', timeoutMs: 300, quietMs: 0 });
  assert.deepEqual(first.data.newMessages.map(m => m.seq), [16]);
  assert.equal(first.data.partial, undefined);
  assert.equal(first.data.readThroughSeq, 0);
  const second = await request({ purpose: 'messages', timeoutMs: 200, quietMs: 0 });
  assert.ok(second.data.waitedMs >= 200);
  assert.equal(second.data.arrived, false);
  assert.deepEqual(second.data.newMessages, []);
  assert.equal(second.data.readThroughSeq, 0);
}));

test('genuine completed group observation reports its unlocked gate in the same response', () => fixture(async ({ st, request, append, seeAll }) => {
  append('known message');
  seeAll();
  const result = await request({ purpose: 'messages', timeoutMs: 300, quietMs: 0 });
  assert.equal(result.data.countsAsObservation, true);
  assert.equal(result.data.preSleepWaitSatisfied, true);
  assert.equal(result.data.canSleepNow, true);
  assert.ok(st.preSleepWaitSatisfiedAt > 0);
}, { key: 'group:456', config: { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 200 } } }));

test('an undisclosed final arrival cannot falsely satisfy group sleep observation', () => fixture(async ({ h, st, request, append, seeAll }) => {
  append('known message');
  seeAll();
  h.cfg.socialV2.tools.getUnread = false;
  h.cfg.socialV2.tools.getRecent = false;
  const timer = setTimeout(() => append('hidden near-deadline arrival'), 350);
  try {
    const result = await request({ purpose: 'messages', timeoutMs: 400, quietMs: 0 });
    assert.equal(result.data.arrived, false);
    assert.deepEqual(result.data.newMessages, []);
    assert.equal(result.data.preSleepWaitSatisfied, false);
    assert.equal(result.data.preSleepWaitObserved, false);
    assert.equal(result.data.canSleepNow, false);
    assert.equal(st.preSleepWaitSatisfiedAt, 0);
  } finally { clearTimeout(timer); }
}, { key: 'group:456', config: { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 200 } } }));

test('new message during a genuine group observation still grants observed-not-satisfied', () => fixture(async ({ st, request, append, seeAll }) => {
  append('known message');
  seeAll();
  const timer = setTimeout(() => append('new message during observation'), 30);
  try {
    const result = await request({ purpose: 'messages', timeoutMs: 600, quietMs: 100 });
    assert.equal(result.data.arrived, true);
    assert.deepEqual(result.data.newMessages.map(m => m.seq), [2]);
    assert.equal(result.data.countsAsObservation, true);
    assert.equal(result.data.preSleepWaitSatisfied, false);
    assert.equal(result.data.preSleepWaitObserved, true);
    assert.equal(result.data.canSleepNow, true);
    assert.ok(st.preSleepWaitObservedAt > 0);
  } finally { clearTimeout(timer); }
}, { key: 'group:456', config: { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 500 } } }));
