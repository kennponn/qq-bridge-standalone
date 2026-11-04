// Synthetic bridge fixtures only: no real QQ, provider, credentials, or persona files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as roleCard from '../src/role-card.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'private:123';
const ROLE_A = 'FIXTURE_PERSONA_A';
const ROLE_B = 'FIXTURE_PERSONA_B';
const ROLE_C = 'FIXTURE_PERSONA_C';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, message, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}

async function fixture() {
  const turns = [];
  const sessions = [];
  let holdNext = false;
  let holdCleanupNext = false;
  const h = await bridgeHarness({
    config: {
      engine: { backend: 'standalone' },
      consolePort: 0,
      socialV2: { enabled: true, wake: { batchWindowMs: 1000 },
        send: { gapMinMs: 0, gapMaxMs: 0 } },
    },
    files: {
      'state/current-role.json': { role: 'role-a', mode: 'active' },
      'roles/role-a.md': ROLE_A,
      'roles/role-b.md': ROLE_B,
      'roles/role-c.md': ROLE_C,
      'prompts/standalone-system.txt': 'LEGACY_PERSONA_BASE: use the old identity.',
    },
    globals: {
      ...roleCard,
      getEngineStatus: () => ({ ready: true, secret: { source: 'environment' } }),
      resolveEngineDirectConfig: () => ({ model: 'fixture', provider: 'fixture',
        apiKey: 'fixture-only', baseURL: 'https://model.invalid/v1',
        webSearch: false, vision: false }),
      createDirectToolSession: async ({ key, agentToken }) => {
        const gate = deferred();
        const held = holdCleanupNext;
        holdCleanupNext = false;
        const session = { key, agentToken, gate, held, closeStarted: false, closed: false };
        sessions.push(session);
        return { tools: [], execute() {}, async close() {
          session.closeStarted = true;
          if (held) await gate.promise;
          session.closed = true;
        } };
      },
      runDirectTurn: async (options) => {
        const held = holdNext;
        holdNext = false;
        const gate = deferred();
        const turn = { options, gate, held, finished: false };
        turns.push(turn);
        options.assertCurrent();
        options.onContextSent();
        try {
          if (held) {
            const stop = () => gate.resolve();
            options.signal.addEventListener('abort', stop, { once: true });
            try { await gate.promise; }
            finally { options.signal.removeEventListener('abort', stop); }
          }
          options.signal.throwIfAborted();
          options.assertCurrent();
          return { ok: true, sent: 0, closed: false };
        } finally { turn.finished = true; }
      },
    },
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (pathname, body, token) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: pathname, method: 'POST', headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        ...(token ? { 'x-agent-token': token, 'x-agent-call': '1' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (part) => chunks.push(part));
      res.on('end', () => resolve({ status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.setTimeout(2500, () => req.destroy(new Error('Fixture API timeout')));
    req.end(JSON.stringify(body));
  });
  return {
    h, turns, sessions, request,
    async startHeld({ holdCleanup = false } = {}) {
      holdNext = true;
      holdCleanupNext = holdCleanup;
      const count = turns.length;
      const job = h.deliverPrompt(KEY, '', { wakeReason: 'bootstrap' });
      await until(() => turns.length > count, 'Held fixture direct turn did not start');
      return { turn: turns[count], job };
    },
    async dispatch() {
      const count = turns.length;
      await h.deliverPrompt(KEY, '', { wakeReason: 'admin' });
      assert.ok(turns.length > count, 'Current persona direct turn starts');
      return turns.at(-1);
    },
    async close() {
      for (const turn of turns) turn.gate.resolve();
      for (const session of sessions) session.gate.resolve();
      await until(() => h.directTurnControllers.size === 0, 'Fixture turns must finish');
      await until(() => sessions.every((session) => session.closed), 'Fixture MCP cleanup must finish');
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await h.close();
    },
  };
}

function activePersona(turn) {
  const system = String(turn.options.systemPrompt);
  const at = system.lastIndexOf('ACTIVE_PERSONA');
  assert.ok(at >= 0, 'Host persona policy is part of the system instruction');
  assert.ok(system.includes('LEGACY_PERSONA_BASE'), 'User-authored base prompt stays intact');
  assert.ok(at > system.indexOf('LEGACY_PERSONA_BASE'), 'Current persona follows the legacy base');
  return system.slice(at);
}

function preservedState(h) {
  const st = h.getSocialV2State(KEY);
  return JSON.stringify({ unread: st.unread, recent: st.recentMessages,
    topics: st.activeTopics, thoughts: st.pendingThoughts,
    impressions: st.memberImpressions, readThroughSeq: st.lastReadThroughSeq });
}

function assertStopped(turn) {
  assert.equal(turn.options.signal.aborted, true, 'Persona changes abort active inference/tool waits');
  assert.throws(turn.options.assertCurrent, /STALE|persona|role/i,
    'Captured old-persona context cannot continue');
}

test('switching persona aborts old work, revokes its token, and preserves messages and memory', async () => {
  const f = await fixture();
  try {
    const st = f.h.getSocialV2State(KEY);
    f.h.appendSocialV2Message(KEY, 'fixture-user', 'fixture-message', 'fixture-message',
      false, true, 'fixture-id', [], 123);
    st.activeTopics = [{ text: 'fixture-topic', lastMentionAt: Date.now() }];
    st.pendingThoughts = [{ text: 'fixture-thought' }];
    st.memberImpressions = { 'fixture-user': { traits: ['fixture-trait'], interactionCount: 1 } };
    const before = preservedState(f.h);
    const token = st.agentToken;
    const { turn, job } = await f.startHeld();
    assert.match(activePersona(turn), new RegExp(ROLE_A));
    const response = await f.request('/api/role', { role: 'role-b' });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assertStopped(turn);
    await job;
    assert.equal(f.h.getSocialV2State(KEY), st, 'Conversation object is not reset');
    assert.equal(preservedState(f.h), before, 'Persona switch does not erase receipts/history/memory');
    assert.notEqual(st.agentToken, token, 'Old tool credentials are revoked');
    const oldSend = await f.request('/api/socialV2/send-message', { key: KEY,
      messages: ['fixture-stale-reply'] }, token);
    assert.equal(oldSend.status, 403, 'Old persona cannot send via the local tool API');
    assert.equal(f.h.calls.sent.length, 0);
    assert.equal(f.h.calls.http.filter((entry) => entry.url.includes('/send_')).length, 0);
    const next = await f.dispatch();
    assert.match(activePersona(next), new RegExp(ROLE_B));
    assert.doesNotMatch(activePersona(next), new RegExp(ROLE_A));
    const selected = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state/current-role.json')));
    assert.equal(selected.role, 'role-b', 'User-selected role is retained');
  } finally { await f.close(); }
});

test('persona switch automatically replays unread work with the new persona, not the stale prompt', async () => {
  const f = await fixture();
  try {
    f.h.appendSocialV2Message(KEY, 'fixture-user', 'UNREAD_FIXTURE_RECEIPT',
      'UNREAD_FIXTURE_RECEIPT', false, true, 'fixture-id', [], 123);
    const { turn, job } = await f.startHeld();
    const response = await f.request('/api/role', { role: 'role-b' });
    assert.equal(response.body.ok, true);
    assertStopped(turn);
    await job;
    await until(() => f.turns.length >= 2, 'New persona must resume unread work without another QQ message', 4500);
    assert.match(activePersona(f.turns[1]), new RegExp(ROLE_B));
    assert.match(JSON.stringify(f.turns[1].options.content), /UNREAD_FIXTURE_RECEIPT/);
    assert.equal(f.h.getSocialV2State(KEY).unread.length, 1, 'Visibility does not mark the unread message read');
  } finally { await f.close(); }
});

for (const [label, pathname, body, expectedRole] of [
  ['editing the current card', '/api/roles/update', { name: 'role-a', content: ROLE_B }, ROLE_B],
  ['renaming the current card', '/api/roles/rename', { from: 'role-a', to: 'role-renamed' }, ROLE_A],
  ['deleting the current card', '/api/roles/delete', { name: 'role-a' }, null],
  ['clearing the active persona', '/api/role', { role: null }, null],
  ['changing the role injection limit', '/api/roles/limit', { maxInjectChars: 1000 }, ROLE_A],
  ['changing persona speaking mode', '/api/role-mode', { mode: 'silent' }, ROLE_A],
]) {
  test(`${label} invalidates an active direct turn without resetting conversation state`, async () => {
    const f = await fixture();
    try {
      const st = f.h.getSocialV2State(KEY);
      st.memberImpressions = { fixture: { traits: ['keep-me'] } };
      const before = preservedState(f.h);
      const token = st.agentToken;
      const { turn, job } = await f.startHeld();
      const response = await f.request(pathname, body);
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assertStopped(turn);
      await job;
      assert.equal(preservedState(f.h), before);
      assert.notEqual(st.agentToken, token);
      const next = await f.dispatch();
      if (expectedRole) assert.match(activePersona(next), new RegExp(expectedRole));
      else {
        assert.doesNotMatch(activePersona(next), new RegExp(ROLE_A));
        assert.doesNotMatch(activePersona(next), new RegExp(ROLE_B));
      }
    } finally { await f.close(); }
  });
}

test('editing or renaming an unrelated persona does not abort or revoke current work', async () => {
  const f = await fixture();
  try {
    const st = f.h.getSocialV2State(KEY);
    const token = st.agentToken;
    const { turn, job } = await f.startHeld();
    assert.equal((await f.request('/api/roles/update', { name: 'role-b', content: ROLE_C })).body.ok, true);
    assert.equal((await f.request('/api/roles/rename', { from: 'role-b', to: 'role-other' })).body.ok, true);
    assert.equal((await f.request('/api/roles/delete', { name: 'role-other' })).body.ok, true);
    assert.equal(turn.options.signal.aborted, false);
    assert.doesNotThrow(turn.options.assertCurrent);
    assert.equal(st.agentToken, token);
    turn.gate.resolve();
    await job;
  } finally { await f.close(); }
});

test('same-size direct card edits with preserved timestamps invalidate captured persona content', async () => {
  const f = await fixture();
  try {
    assert.equal(ROLE_A.length, ROLE_B.length);
    const { turn, job } = await f.startHeld();
    const file = path.join(f.h.temp, 'roles/role-a.md');
    const before = fs.statSync(file);
    fs.writeFileSync(file, ROLE_B);
    fs.utimesSync(file, before.atime, before.mtime);
    assert.throws(turn.options.assertCurrent, /STALE|persona|role/i,
      'Card content fingerprint must defeat same-size/mtime cache collisions');
    turn.gate.resolve();
    await job;
    assert.match(activePersona(await f.dispatch()), new RegExp(ROLE_B));
  } finally { await f.close(); }
});

test('reselecting the exact unchanged role does not unnecessarily interrupt a turn', async () => {
  const f = await fixture();
  try {
    const { turn, job } = await f.startHeld();
    const token = f.h.getSocialV2State(KEY).agentToken;
    assert.equal((await f.request('/api/role', { role: 'role-a' })).body.ok, true);
    assert.equal(turn.options.signal.aborted, false);
    assert.doesNotThrow(turn.options.assertCurrent);
    assert.equal(f.h.getSocialV2State(KEY).agentToken, token);
    turn.gate.resolve();
    await job;
  } finally { await f.close(); }
});

test('persona authority does not change the QQ account routing nickname or history', async () => {
  const f = await fixture();
  try {
    f.h.setSelfIdentity('LEGACY_QQ_DISPLAY_NICKNAME', '999');
    f.h.recordSentMessagesV2(KEY, ['LEGACY_SENT_MESSAGE']);
    const before = preservedState(f.h);
    assert.equal((await f.request('/api/role', { role: 'role-b' })).body.ok, true);
    const current = await f.dispatch();
    assert.match(activePersona(current), new RegExp(ROLE_B));
    assert.equal(preservedState(f.h), before);
    assert.match(f.h.selfIdentityTextV2(), /LEGACY_QQ_DISPLAY_NICKNAME/);
    assert.match(f.h.selfIdentityTextV2(), /999/);
  } finally { await f.close(); }
});

test('an admitted old-persona HTTP send cannot pass a delayed reply lookup after a role switch', async () => {
  const f = await fixture();
  const lookup = deferred();
  let lookupStarted = false;
  let send;
  try {
    const st = f.h.getSocialV2State(KEY);
    const token = st.agentToken;
    f.h.bot.getMessage = async () => {
      lookupStarted = true;
      await lookup.promise;
      return { message_id: 9001, user_id: 123,
        sender: { user_id: 123, nickname: 'fixture-user' },
        message: [{ type: 'text', data: { text: 'fixture-quoted-message' } }] };
    };
    send = f.request('/api/socialV2/send-message', { key: KEY,
      messages: ['fixture-obsolete-reply'], replyToMessageId: '9001' }, token);
    await until(() => lookupStarted, 'Old-persona request must be admitted before the delayed lookup');
    assert.equal(st.sendTimes.length, 1, 'Admitted send reserves quota before lookup');
    assert.equal((await f.request('/api/role', { role: 'role-b' })).body.ok, true);
    lookup.resolve();
    const result = await send;
    assert.equal(result.body.ok, false);
    assert.ok(result.status === 403 || result.status === 500, 'Stale send is rejected after async lookup');
    assert.equal(f.h.calls.http.filter((entry) => entry.url.includes('/send_')).length, 0,
      'No old-persona payload reaches the synthetic gateway');
    assert.equal(st.sendTimes.length, 0, 'Cancelled send rolls back its quota');
    assert.equal(st.lastAiReplyAt, 0, 'Cancellation is not recorded as an actual reply');
  } finally {
    lookup.resolve();
    await send;
    await f.close();
  }
});

test('a valid current-persona token successfully sends through the synthetic HTTP gateway', async () => {
  const f = await fixture();
  try {
    const st = f.h.getSocialV2State(KEY);
    const token = st.agentToken;
    const result = await f.request('/api/socialV2/send-message', { key: KEY,
      messages: ['fixture-current-valid-reply'] }, token);
    assert.equal(result.status, 200, result.body.error || 'Current token sends normally');
    assert.equal(result.body.ok, true);
    assert.equal(result.body.sent, 1);
    const sent = f.h.calls.http.filter((entry) => entry.url.endsWith('/send_private_msg'));
    assert.equal(sent.length, 1, 'Exactly one send reaches the fake gateway');
    assert.equal(sent[0].body.user_id, 123);
    assert.equal(sent[0].body.message.find((segment) => segment.type === 'text').data.text,
      'fixture-current-valid-reply');
    assert.ok(st.lastAiReplyAt > 0, 'Successful send updates actual-reply state');
    assert.equal(st.sendTimes.length, 1, 'Only the actual successful send uses quota');
    assert.equal(st.agentToken, token, 'Successful send does not rotate current credentials');
  } finally { await f.close(); }
});

for (const kind of ['pause', 'revoke-token']) {
  test(`an admitted current-persona send is rejected after ${kind} during a reply lookup`, async () => {
    const f = await fixture();
    const lookup = deferred();
    let lookupStarted = false;
    let send;
    try {
      const st = f.h.getSocialV2State(KEY);
      const token = st.agentToken;
      f.h.bot.getMessage = async () => {
        lookupStarted = true;
        await lookup.promise;
        return { message_id: 9001, user_id: 123,
          sender: { user_id: 123, nickname: 'fixture-user' },
          message: [{ type: 'text', data: { text: 'fixture-quoted-message' } }] };
      };
      send = f.request('/api/socialV2/send-message', { key: KEY,
        messages: ['fixture-cancelled-current-reply'], replyToMessageId: '9001' }, token);
      await until(() => lookupStarted, 'Current-token send must be admitted before revocation');
      assert.equal(st.sendTimes.length, 1);
      if (kind === 'pause') {
        const response = await f.request('/api/socialV2/activity', { paused: true });
        assert.equal(response.body.ok, true);
        assert.equal(st.agentToken, token, 'Pause test does not rely on a token mismatch');
      } else {
        // Change only credentials, not persona stamp: exercise the final token guard directly.
        st.agentToken = 'fixture-replacement-token';
      }
      const roleState = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state/current-role.json')));
      assert.equal(roleState.role, 'role-a', 'Persona remains unchanged during this guard test');
      lookup.resolve();
      const result = await send;
      assert.equal(result.body.ok, false);
      assert.ok(result.status === 403 || result.status === 500);
      assert.equal(f.h.calls.http.filter((entry) => entry.url.includes('/send_')).length, 0);
      assert.equal(st.sendTimes.length, 0, 'Cancelled reservation is rolled back');
      assert.equal(st.lastAiReplyAt, 0);
      const followup = await f.request('/api/socialV2/send-message', { key: KEY,
        messages: ['fixture-still-disallowed-reply'] }, token);
      assert.equal(followup.body.ok, false, 'New requests remain rejected while paused or revoked');
      assert.ok(followup.status === 403 || followup.status === 500);
      assert.equal(f.h.calls.http.filter((entry) => entry.url.includes('/send_')).length, 0);
    } finally {
      lookup.resolve();
      await send;
      await f.close();
    }
  });
}

function ownerEvent(text, messageId = 'fixture-owner-command') {
  return { user_id: 123, self_id: 999, message_id: messageId,
    sender: { user_id: 123, nickname: 'fixture-owner' },
    message: [{ type: 'text', data: { text } }] };
}

test('persona switching retains the running serializer until slow MCP cleanup releases it', async () => {
  const f = await fixture();
  try {
    const st = f.h.getSocialV2State(KEY);
    f.h.appendSocialV2Message(KEY, 'fixture-user', 'ORIGINAL_UNREAD_FIXTURE',
      'ORIGINAL_UNREAD_FIXTURE', false, true, 'fixture-first-message', [], 123);
    const oldToken = st.agentToken;
    const { turn, job } = await f.startHeld({ holdCleanup: true });
    const owner = f.h.promptQueues.get(KEY);
    assert.equal(owner.running, true);
    const response = await f.request('/api/role', { role: 'role-b' });
    assert.equal(response.body.ok, true);
    assertStopped(turn);
    const newToken = st.agentToken;
    assert.notEqual(newToken, oldToken);
    await until(() => f.sessions[0].closeStarted, 'Old MCP cleanup starts after abort');
    assert.equal(f.h.promptQueues.get(KEY), owner, 'Switch preserves the exact running serializer object');
    assert.equal(owner.running, true);
    await f.h.handleIncoming('private', 123,
      ownerEvent('NEW_UNREAD_DURING_CLEANUP', 'fixture-second-message'), f.h.cfg);
    await delay(1200);
    assert.equal(f.turns.length, 1, 'A new wake cannot overlap cleanup even after its normal batch window');
    assert.equal(f.sessions.length, 1, 'No new MCP token/controller is bound before cleanup releases ownership');
    assert.equal(f.h.promptQueues.get(KEY), owner);
    assert.equal(owner.running, true);
    assert.equal(st.agentToken, newToken, 'Deferred wakes do not overwrite the new persona token');
    assert.equal(st.unread.length, 2, 'Both old and new receipts survive cleanup');
    f.sessions[0].gate.resolve();
    await job;
    await until(() => f.turns.length >= 2, 'New persona must start after the old serializer is released', 4500);
    assert.match(activePersona(f.turns[1]), new RegExp(ROLE_B));
    assert.match(JSON.stringify(f.turns[1].options.content), /NEW_UNREAD_DURING_CLEANUP/);
    assert.equal(f.sessions[1].agentToken, newToken, 'New MCP session binds only the new token');
    assert.equal(f.sessions[0].agentToken, oldToken);
    assert.equal(f.turns[1].options.signal.aborted, false, 'Late old cleanup cannot abort the new turn');
    assert.equal(st.agentToken, newToken);
  } finally { await f.close(); }
});

for (const [command, initialMode, expectedRole, expectedMode] of [
  ['/role off', 'active', null, 'active'],
  ['/role role-b', 'active', 'role-b', 'active'],
  ['/silent', 'active', 'role-a', 'silent'],
  ['/active', 'silent', 'role-a', 'active'],
]) {
  test(`QQ owner ${command} immediately invalidates old persona work without erasing history`, async () => {
    const f = await fixture();
    try {
      if (initialMode === 'silent') {
        assert.equal((await f.request('/api/role-mode', { mode: 'silent' })).body.ok, true);
      }
      const st = f.h.getSocialV2State(KEY);
      f.h.recordSentMessagesV2(KEY, ['PRESERVED_FIXTURE_HISTORY']);
      st.memberImpressions = { fixture: { traits: ['keep-owner-command-memory'] } };
      const before = preservedState(f.h);
      const oldToken = st.agentToken;
      const { turn, job } = await f.startHeld();
      await f.h.handleIncoming('private', 123, ownerEvent(command), f.h.cfg);
      assertStopped(turn);
      await job;
      assert.notEqual(st.agentToken, oldToken, 'QQ commands revoke old tool credentials');
      assert.equal(preservedState(f.h), before, 'QQ commands preserve conversation history and memory');
      const selected = JSON.parse(fs.readFileSync(path.join(f.h.temp, 'state/current-role.json')));
      assert.equal(selected.role, expectedRole);
      assert.equal(selected.mode, expectedMode);
      assert.equal(f.h.calls.sent.length, 1, 'Only the synthetic owner-command confirmation is sent');
    } finally { await f.close(); }
  });
}

test('QQ owner reselecting the same persona does not abort a current turn', async () => {
  const f = await fixture();
  try {
    const st = f.h.getSocialV2State(KEY);
    const oldToken = st.agentToken;
    const { turn, job } = await f.startHeld();
    await f.h.handleIncoming('private', 123, ownerEvent('/role role-a'), f.h.cfg);
    assert.equal(turn.options.signal.aborted, false);
    assert.doesNotThrow(turn.options.assertCurrent);
    assert.equal(st.agentToken, oldToken);
    turn.gate.resolve();
    await job;
  } finally { await f.close(); }
});
