// Standalone private-flow integration with fixture-only model and QQ peers.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { resolveConversationTiming } from '../src/conversation-timing.js';

const PRIVATE = 'private:123';
const GROUP = 'group:456';
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(message);
    await delay(5);
  }
}

async function fixture(run, { config = {}, directTurn } = {}) {
  let h;
  const hPromise = bridgeHarness({ config: {
    engine: { backend: 'standalone' },
    socialV2: {
      wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000, maxWakePerMinute: 1, maxWakePerHour: 1 },
      proactive: { enabled: false }, sticker: { enabled: false }, ...config,
    },
  }, files: { 'prompts/standalone-system.txt': 'Fixture persona. Never send commentary as QQ text.' },
  globals: {
    getEngineStatus: () => ({ ready: true, secret: { source: 'environment' } }),
    resolveEngineDirectConfig: () => ({ model: 'fixture', provider: 'fixture', apiKey: 'fixture-only',
      baseURL: 'https://model.invalid/v1', webSearch: false, vision: false }),
    createDirectToolSession: async () => ({ tools: [], execute() { throw new Error('No real tool calls allowed'); }, async close() {} }),
    runDirectTurn: async options => directTurn
      ? directTurn({ options, h, request }) : ({ ok: true, sent: 0, closed: true }),
  } });
  h = await hPromise;
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  function request(route, key, body, token = h.getSocialV2State(key).agentToken) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `/api/socialV2/${route}`, method: 'POST', headers: {
          'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': token,
        },
      }, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Fixture API timeout')));
      req.end(JSON.stringify({ key, ...body }));
    });
  }
  const append = (key, text) => h.appendSocialV2Message(key, 'fixture-person', text, text,
    false, false, `fixture-${h.getSocialV2State(key).lastUnreadSeq + 1}`, [], '123', []);
  try { await run({ h, request, append }); }
  finally {
    for (const controller of h.directTurnControllers.values()) controller.abort();
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
}

test('fast private close bypasses group observation but never unseen cursor, token or tool guards', () => fixture(async ({ h, request, append }) => {
  append(PRIVATE, 'first complete private message');
  const privateState = h.getSocialV2State(PRIVATE);
  assert.equal((await request('mark-read', PRIVATE, { throughSeq: 1 })).status, 400);
  h.noteModelMessagesV2(privateState, [...privateState.unread]);
  append(PRIVATE, 'second private message not yet shown');
  assert.equal((await request('mark-read', PRIVATE, { throughSeq: 2 })).status, 400);
  assert.equal(privateState.unread.length, 2);

  append(GROUP, 'fresh group message');
  const groupState = h.getSocialV2State(GROUP);
  h.noteModelMessagesV2(groupState, [...groupState.unread]);
  assert.equal((await request('mark-read', GROUP, { throughSeq: 1 })).status, 400, 'group sleep gate keeps its existing status contract');
  assert.equal(groupState.unread.length, 1);
  assert.equal((await request('mark-read', PRIVATE, { throughSeq: 1 }, groupState.agentToken)).status, 403);
  h.cfg.socialV2.tools.markRead = false;
  assert.equal((await request('mark-read', PRIVATE, { throughSeq: 1 })).status, 403);
  h.cfg.socialV2.tools.markRead = true;

  const closed = await request('mark-read', PRIVATE, { throughSeq: 1 });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.markedCount, 1);
  assert.deepEqual(Array.from(privateState.unread, m => m.seq), [2]);
  assert.equal(privateState.preSleepWaitSatisfiedAt, 0, 'private exemption is not an observation receipt');
  h.noteModelMessagesV2(privateState, [...privateState.unread]);
  const combined = await request('wake-config', PRIVATE, {
    throughSeq: 2, config: { mode: 'diving', infinite: true, triggers: { atMention: true } },
  });
  assert.equal(combined.status, 200);
  assert.equal(privateState.unread.length, 0);
  assert.equal((await request('wake-config', GROUP, {
    throughSeq: 1, config: { mode: 'diving', infinite: true, triggers: { atMention: true } },
  })).status, 400, 'group combined close still requires observation');
}));

test('private fast-reply opt-out preserves the legacy observation gate', () => fixture(async ({ h, request, append }) => {
  append(PRIVATE, 'fresh private message');
  const st = h.getSocialV2State(PRIVATE);
  h.noteModelMessagesV2(st, [...st.unread]);
  assert.equal(resolveConversationTiming(h.cfg, PRIVATE, { standalone: true }).fastPrivate, false);
  assert.equal((await request('mark-read', PRIVATE, { throughSeq: 1 })).status, 400);
  assert.equal(st.unread.length, 1);
}, { config: { privateChat: { fastReply: false } } }));

test('same-key private replies stay serial and the next incoming message starts without the global one-per-minute delay', async () => {
  const starts = [];
  let active = 0;
  let peakActive = 0;
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  try {
    await fixture(async ({ h }) => {
      const event = id => ({ self_id: 999, user_id: 123, message_id: `fixture-message-${id}`,
        message: [{ type: 'text', data: { text: `complete private message ${id}` } }],
        sender: { user_id: 123, nickname: 'fixture-person' },
      });
      const firstAt = Date.now();
      await h.handleIncoming('private', 123, event(1), h.cfg);
      await until(() => starts.length === 1, 'first private turn did not start after its short batch window');
      assert.ok(starts[0] - firstAt < 2000);
      await h.handleIncoming('private', 123, event(2), h.cfg);
      assert.equal(starts.length, 1, 'second message must not overlap the first direct turn');
      assert.ok(h.getSocialV2State(PRIVATE).pendingWakeReasons.length > 0);
      release();
      await until(() => starts.length === 2, 'second private turn was incorrectly held by the global one-per-minute limit');
      await until(() => h.directTurnControllers.size === 0 && h.promptQueues.size === 0, 'private turns did not close');
      assert.ok(starts[1] - starts[0] < 2500);
      assert.equal(peakActive, 1);
      assert.equal(h.getSocialV2State(PRIVATE).unread.length, 0);
      assert.equal(h.getSocialV2State(PRIVATE).replyCheckTimer, null, 'fast private close must not arrange an unsolicited long-wait turn');

      const privateTiming = resolveConversationTiming(h.cfg, PRIVATE, { standalone: true });
      assert.equal(privateTiming.maxWakePerMinute, 30);
      const st = h.getSocialV2State(PRIVATE);
      st.wakeTimes = Array.from({ length: privateTiming.maxWakePerMinute }, () => Date.now());
      h.appendSocialV2Message(PRIVATE, 'fixture-person', 'rate-limited fixture', 'rate-limited fixture', false, false, 'fixture-rate-limit', [], '123');
      await h.sendWakePromptV2(PRIVATE, 'private');
      assert.equal(starts.length, 2, 'private convenience must still have a bounded model-wake rate');
      assert.ok(st.rateLimitRetryTimer);

      const groupState = h.getSocialV2State(GROUP);
      groupState.wakeTimes = [Date.now()];
      h.appendSocialV2Message(GROUP, 'fixture-person', 'group fixture', 'group fixture', false, false, 'fixture-group-rate', [], '789');
      await h.sendWakePromptV2(GROUP, 'question');
      assert.equal(starts.length, 2, 'group still obeys the original one-per-minute global configuration');
      assert.ok(groupState.rateLimitRetryTimer);
    }, { directTurn: async ({ options, h, request }) => {
      active++;
      peakActive = Math.max(peakActive, active);
      starts.push(Date.now());
      try {
        assert.match(options.systemPrompt, /PRIVATE_REPLY_POLICY/);
        options.assertCurrent();
        options.onContextSent();
        const throughSeq = h.readThroughSeqV2(h.getSocialV2State(PRIVATE));
        if (starts.length === 1) await hold;
        const result = await request('mark-read', PRIVATE, { throughSeq });
        assert.equal(result.status, 200);
        return { ok: true, sent: 0, closed: true };
      } finally { active--; }
    } });
  } finally { release(); }
});
