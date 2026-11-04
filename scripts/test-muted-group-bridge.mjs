// Offline permission integration: fake QQ/model peers and temporary state only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const OTHER = 'group:789';
const PRIVATE = 'private:123';
const SELF = '999';
const ROLE = 'fixture-muted-persona';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(message);
    await delay(5);
  }
}
function incoming(key, id, content = 'fixture ordinary conversation') {
  const [kind, conv] = key.split(':');
  return { post_type: 'message', message_type: kind, self_id: Number(SELF),
    ...(kind === 'group' ? { group_id: Number(conv) } : {}),
    user_id: kind === 'private' ? Number(conv) : 124,
    sender: { user_id: kind === 'private' ? Number(conv) : 124, nickname: 'fixture sender' },
    message_id: id, message: [{ type: 'text', data: { text: content } }] };
}
function ban(duration, userId = SELF, groupId = 456) {
  return { post_type: 'notice', notice_type: 'group_ban', self_id: Number(SELF),
    group_id: groupId, user_id: Number(userId), operator_id: 123,
    sub_type: duration > 0 ? 'ban' : 'lift_ban', duration };
}

async function fixture(run, { muted = false, whole = false, role = 'member', directTurn } = {}) {
  const members = new Map();
  const accountMembers = new Map();
  const permissionSelfIds = new Set([SELF]);
  const groups = new Map();
  const requests = [];
  const sends = [];
  const providerStarts = [];
  const failures = [];
  const future = Math.floor(Date.now() / 1000) + 3600;
  members.set('456', { group_id: 456, user_id: Number(SELF), role,
    shut_up_timestamp: muted ? future : 0 });
  members.set('789', { group_id: 789, user_id: Number(SELF), role: 'member', shut_up_timestamp: 0 });
  groups.set('456', { group_id: 456, group_all_shut: whole });
  groups.set('789', { group_id: 789, group_all_shut: false });
  let sendResult = null;
  let beforeSend = null;
  let beforePermission = null;
  const envelope = data => ({ ok: true, status: 200,
    json: async () => ({ status: 'ok', retcode: 0, data }) });
  let h;
  h = await bridgeHarness({ config: {
    engine: { backend: 'standalone' }, allow: { groups: ['456', '789'], private: ['123'] },
    socialV2: { wake: { alwaysAwake: true, maxWakePerMinute: 30, maxWakePerHour: 120 },
      proactive: { enabled: false }, sticker: { enabled: false },
      send: { maxSendPerMinute: 8, maxSendPerHour: 60 } },
  }, files: {
    'prompts/standalone-system.txt': 'Fixture only; never access a real gateway or model.',
    'state/current-role.json': { role: ROLE, mode: 'active' },
    [`roles/${ROLE}.md`]: 'Fixture selected identity must remain unchanged.',
  }, globals: {
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.hostname, '127.0.0.1', 'offline fixture forbids external fetch');
      const action = parsed.pathname.split('/').pop();
      const params = init.body ? JSON.parse(init.body) : Object.fromEntries(parsed.searchParams);
      requests.push({ action, group: String(params.group_id ?? ''), user: String(params.user_id ?? '') });
      if (action === 'get_group_member_info') {
        assert.ok(permissionSelfIds.has(String(params.user_id)), 'permission lookup must query a fixture bot account, not another member');
        if (beforePermission) await beforePermission({ action, params });
        return envelope(accountMembers.get(`${params.group_id}:${params.user_id}`)
          ?? members.get(String(params.group_id)) ?? {});
      }
      if (action === 'get_group_info') {
        if (beforePermission) await beforePermission({ action, params });
        return envelope(groups.get(String(params.group_id)) ?? {});
      }
      if (action === 'send_group_msg' || action === 'send_private_msg') {
        sends.push({ action, group: String(params.group_id ?? ''), user: String(params.user_id ?? '') });
        if (beforeSend) await beforeSend({ action, params });
        return sendResult ? { ok: true, status: 200, json: async () => sendResult } : envelope({ message_id: 9001 });
      }
      assert.fail('Unexpected fixture gateway action: ' + action);
    },
    getEngineStatus: () => ({ ready: true, secret: { source: 'environment' } }),
    resolveEngineDirectConfig: () => ({ model: 'fixture', provider: 'fixture', apiKey: 'fixture-only',
      baseURL: 'https://model.invalid/v1', webSearch: false, vision: false }),
    createDirectToolSession: async () => ({ tools: [], execute() { throw new Error('Real tools forbidden'); }, async close() {} }),
    runDirectTurn: async options => {
      const key = [...h.directTurnControllers].find(([, controller]) => controller.signal === options.signal)?.[0];
      providerStarts.push(key);
      try {
        if (directTurn) return await directTurn({ options, h, request, key });
        options.onContextSent();
        const closed = await request('mark-read', key, { throughSeq: h.readThroughSeqV2(h.getSocialV2State(key)) });
        assert.equal(closed.status, 200);
        return { ok: true, sent: 0, closed: true };
      } catch (error) { failures.push(error); throw error; }
    },
  } });
  h.setMode('reserved2');
  h.setSelfIdentity('fixture bot', SELF);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  function request(route, key, body, token = h.getSocialV2State(key).agentToken) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/socialV2/' + route, method: 'POST', headers: {
          'content-type': 'application/json', 'x-console-token': 'fixture-console-token', 'x-agent-token': token,
        } }, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(6000, () => req.destroy(new Error('Fixture API timeout')));
      req.end(JSON.stringify({ key, ...body }));
    });
  }
  const append = (key, id, content = 'fixture request') => h.appendSocialV2Message(key,
    'fixture sender', content, content, false, false, String(id), [], '124', []);
  const receive = (key, id, content) => h.handleIncoming(key.split(':')[0], Number(key.split(':')[1]),
    incoming(key, id, content), h.cfg);
  try {
    await run({ h, request, append, receive, members, accountMembers, permissionSelfIds,
      groups, requests, sends, providerStarts,
      setSendResult(value) { sendResult = value; }, setBeforeSend(value) { beforeSend = value; },
      setBeforePermission(value) { beforePermission = value; } });
    assert.equal(failures.length, 0, failures.map(error => error.stack ?? String(error)).join('\n'));
  } finally {
    for (const controller of h.directTurnControllers.values()) controller.abort();
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
}

test('verified individual mute retains incoming records but prevents waking or calling the provider', () => fixture(async ({ h, receive, providerStarts, requests }) => {
  const cfgBefore = JSON.stringify(h.cfg);
  const roleBefore = fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8');
  const st = h.getSocialV2State(GROUP);
  const wakeBefore = JSON.stringify(st.wakeConfig);
  const permission = await h.checkGroupSendPermissionV2(GROUP, { force: true });
  assert.equal(permission.known, true);
  assert.equal(permission.blocked, true);
  assert.equal(permission.reason, 'individual');
  assert.ok(permission.blockedUntil > Date.now());
  await receive(GROUP, 1);
  await receive(GROUP, 2, 'fixture second muted message');
  assert.equal(st.unread.length, 2);
  assert.equal(st.recentMessages.length, 2);
  assert.equal(st.pendingWakeTimer, null);
  await delay(1150);
  assert.equal(providerStarts.length, 0);
  assert.equal(st.wakeTimes.length, 0, 'muted observation must not consume a model wake quota');
  assert.equal(JSON.stringify(st.wakeConfig), wakeBefore);
  assert.equal(JSON.stringify(h.cfg), cfgBefore);
  assert.equal(fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8'), roleBefore);
  assert.ok(requests.some(entry => entry.action === 'get_group_member_info' && entry.user === SELF));
}, { muted: true }));

test('known-muted text sending is rejected before the gateway and rolls back reserved send quota', () => fixture(async ({ h, request, append, sends }) => {
  await h.checkGroupSendPermissionV2(GROUP, { force: true });
  append(GROUP, 10);
  const st = h.getSocialV2State(GROUP);
  h.noteModelMessagesV2(st, [...st.unread]);
  const unreadBefore = JSON.stringify(st.unread);
  const before = st.sendTimes.length;
  const result = await request('send-message', GROUP, { messages: ['fixture text must never reach QQ'] });
  assert.equal(result.data.ok, false);
  assert.ok(result.status >= 400);
  assert.equal(sends.length, 0);
  assert.equal(st.sendTimes.length, before, 'rejected send must not spend the reserved quota');
  assert.equal(JSON.stringify(st.unread), unreadBefore);
  assert.equal(st.recentMessages.filter(message => message.isSelf).length, 0);
}, { muted: true }));

test('muted group does not block other group or private automatic participation', () => fixture(async ({ h, receive, providerStarts }) => {
  await h.checkGroupSendPermissionV2(GROUP, { force: true });
  await receive(GROUP, 20);
  await receive(OTHER, 21);
  await receive(PRIVATE, 22);
  await until(() => providerStarts.includes(OTHER) && providerStarts.includes(PRIVATE), 'unrelated conversations stopped waking');
  await until(() => h.directTurnControllers.size === 0, 'unrelated fixture turns did not close');
  assert.equal(providerStarts.includes(GROUP), false);
  assert.equal(h.getSocialV2State(GROUP).unread.length, 1);
  assert.equal(h.getSocialV2State(OTHER).unread.length, 0);
  assert.equal(h.getSocialV2State(PRIVATE).unread.length, 0);
}, { muted: true }));

test('lifting an individual mute restores future messages without rewriting earlier history or persona', () => fixture(async ({ h, receive, members, providerStarts }) => {
  await h.checkGroupSendPermissionV2(GROUP, { force: true });
  await receive(GROUP, 30);
  const st = h.getSocialV2State(GROUP);
  const suppressedSeq = st.lastUnreadSeq;
  const oldHistory = JSON.stringify(st.recentMessages);
  const roleBefore = fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8');
  members.get('456').shut_up_timestamp = 0;
  h.observeGroupBanV2(ban(0));
  const permission = await h.checkGroupSendPermissionV2(GROUP, { force: true });
  assert.equal(permission.blocked, false);
  assert.equal(JSON.stringify(st.recentMessages), oldHistory);
  assert.equal(h.buildWakeSnapshotV2(GROUP).sendSuppressedThroughSeq, suppressedSeq);
  assert.equal(providerStarts.length, 0, 'lifting a mute must not immediately replay stale chatter');
  await receive(GROUP, 31, 'fixture fresh message after unmute');
  const snapshot = h.buildWakeSnapshotV2(GROUP);
  assert.equal(snapshot.sendSuppressedThroughSeq, suppressedSeq);
  assert.ok(snapshot.messages.some(message => message.seq > suppressedSeq), 'new messages must not be marked as muted backlog');
  await until(() => providerStarts.includes(GROUP), 'future message after unmute did not restore automatic participation');
  await until(() => h.directTurnControllers.size === 0, 'unmuted fixture turn did not close');
  assert.equal(JSON.stringify(st.recentMessages.slice(0, 1)), oldHistory);
  assert.equal(fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8'), roleBefore);
}, { muted: true }));

test('missed early-unmute notice is refreshed within five seconds without replaying muted backlog', () => fixture(async ({ h, receive, members, providerStarts, requests }) => {
  await h.checkGroupSendPermissionV2(GROUP, { force: true });
  await receive(GROUP, 32, 'fixture muted background');
  const st = h.getSocialV2State(GROUP);
  const oldHistory = JSON.stringify(st.recentMessages);
  const suppressedSeq = st.lastUnreadSeq;
  const queriesBefore = requests.filter(entry => entry.action === 'get_group_member_info').length;
  members.get('456').shut_up_timestamp = 0;
  await delay(5150);
  assert.equal(providerStarts.length, 0, 'permission refresh must not independently replay old messages');
  assert.equal(JSON.stringify(st.recentMessages), oldHistory);
  await receive(GROUP, 33, 'fixture current message after early lift');
  assert.equal(h.getGroupSendPermissionV2(GROUP).blocked, false);
  assert.ok(requests.filter(entry => entry.action === 'get_group_member_info').length > queriesBefore);
  const packet = h.buildWakeSnapshotV2(GROUP);
  assert.equal(packet.sendSuppressedThroughSeq, suppressedSeq);
  assert.ok(packet.messages.some(message => message.seq > suppressedSeq));
  await until(() => providerStarts.includes(GROUP), 'new incoming message did not refresh an early lift without notice');
  await until(() => h.directTurnControllers.size === 0, 'early-lift fixture turn did not close');
  assert.equal(JSON.stringify(st.recentMessages.slice(0, 1)), oldHistory);
}, { muted: true }));

test('rebuilding a conversation clears its old suppression sequence but keeps known group mute permission', () => fixture(async ({ h, receive, append, requests }) => {
  await h.checkGroupSendPermissionV2(GROUP, { force: true });
  await receive(GROUP, 34, 'fixture first muted context');
  await receive(GROUP, 35, 'fixture second muted context');
  const oldState = h.getSocialV2State(GROUP);
  const oldCutoff = oldState.lastUnreadSeq;
  assert.equal(h.buildWakeSnapshotV2(GROUP).sendSuppressedThroughSeq, oldCutoff);
  const permissionQueries = requests.filter(entry => entry.action === 'get_group_member_info').length;
  h.socialV2.conversations.delete(GROUP);
  const newState = h.getSocialV2State(GROUP);
  assert.notEqual(newState, oldState);
  assert.equal(newState.lastUnreadSeq, 0);
  assert.equal(h.getGroupSendPermissionV2(GROUP).blocked, true, 'resetting message history must not forget an actual group mute');
  append(GROUP, 36, 'fixture fresh message in a rebuilt conversation');
  const snapshot = h.buildWakeSnapshotV2(GROUP);
  assert.equal(newState.lastUnreadSeq, 1);
  assert.ok(newState.lastUnreadSeq <= oldCutoff, 'fixture must cover reused local sequence numbers');
  assert.equal(snapshot.sendSuppressedThroughSeq, undefined, 'old cutoff must not misclassify reused new-conversation sequences');
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].seq, 1);
  assert.equal(h.getGroupSendPermissionV2(GROUP).blocked, true);
  assert.equal(requests.filter(entry => entry.action === 'get_group_member_info').length, permissionQueries);
}, { muted: true }));

test('disabled inline wake snapshots still expose the concrete cutoff without suppressing fresh sequences', () => fixture(async ({ h,
  receive, members, providerStarts }) => {
  h.cfg.socialV2.context.inlineWakeMessages = false;
  await h.checkGroupSendPermissionV2(GROUP, { force: true });
  await receive(GROUP, 37, 'fixture muted first background');
  await receive(GROUP, 38, 'fixture muted second background');
  const st = h.getSocialV2State(GROUP);
  const cutoff = st.lastUnreadSeq;
  members.get('456').shut_up_timestamp = 0;
  h.observeGroupBanV2(ban(0));
  assert.equal((await h.checkGroupSendPermissionV2(GROUP, { force: true })).blocked, false);
  await receive(GROUP, 39, 'fixture new current conversation');
  assert.equal(h.buildWakeSnapshotV2(GROUP), null);
  assert.ok(st.unread.at(-1).seq > cutoff, 'fresh incoming sequence must remain above the retained background cutoff');
  assert.match(h.buildWakePromptV2(GROUP, 'anyMessage'),
    new RegExp('sendSuppressedThroughSeq["\\s]*[:=]\\s*' + cutoff + '\\b'),
    'tool-only prompts need the numeric cutoff, not only a generic mention of its field name');
  assert.equal(providerStarts.length, 0, 'unmute alone must not dispatch historical messages before the next bounded wake');
}, { muted: true }));

test('expired mute is rechecked and does not permanently silence a group', () => fixture(async ({ h, receive, members, providerStarts }) => {
  members.get('456').shut_up_timestamp = Math.floor(Date.now() / 1000) - 5;
  const permission = await h.checkGroupSendPermissionV2(GROUP, { force: true });
  assert.equal(permission.blocked, false);
  await receive(GROUP, 40);
  await until(() => providerStarts.includes(GROUP), 'expired restriction blocked a new automatic turn');
  await until(() => h.directTurnControllers.size === 0, 'expired-mute fixture turn did not close');
}));

test('whole-group mute blocks ordinary members but respects administrator exemption', async () => {
  await fixture(async ({ h, receive, providerStarts }) => {
    const permission = await h.checkGroupSendPermissionV2(GROUP, { force: true });
    assert.equal(permission.blocked, true);
    assert.equal(permission.reason, 'whole-group');
    await receive(GROUP, 50);
    assert.equal(h.getSocialV2State(GROUP).unread.length, 1);
    assert.equal(h.getSocialV2State(GROUP).pendingWakeTimer, null);
    assert.equal(providerStarts.length, 0);
  }, { whole: true });
  await fixture(async ({ h, receive, providerStarts }) => {
    assert.equal((await h.checkGroupSendPermissionV2(GROUP, { force: true })).blocked, false);
    await receive(GROUP, 51);
    await until(() => providerStarts.includes(GROUP), 'whole-group mute wrongly blocked an exempt administrator');
    await until(() => h.directTurnControllers.size === 0, 'administrator fixture turn did not close');
  }, { whole: true, role: 'admin' });
});

test('a self-ban notice aborts this group turn and prevents its delayed queued sends', () => {
  let holdResolve;
  let holdStarted;
  const held = new Promise(resolve => { holdResolve = resolve; });
  return fixture(async ({ h, request, append, setBeforeSend, sends, members }) => {
    await h.checkGroupSendPermissionV2(GROUP, { force: true });
    const st = h.getSocialV2State(GROUP);
    append(GROUP, 60);
    h.noteModelMessagesV2(st, [...st.unread]);
    const controller = new AbortController();
    h.directTurnControllers.set(GROUP, controller);
    const otherController = new AbortController();
    h.directTurnControllers.set(OTHER, otherController);
    setBeforeSend(async ({ action }) => {
      if (action === 'send_private_msg') { holdStarted = true; await held; }
    });
    const privateSend = request('send-message', PRIVATE, { messages: ['fixture holds the shared gateway lane'] });
    await until(() => holdStarted, 'fixture gateway lane was not held');
    const groupSend = request('send-message', GROUP, { messages: ['fixture queued group response'] });
    await delay(80);
    members.get('456').shut_up_timestamp = Math.floor(Date.now() / 1000) + 3600;
    h.observeGroupBanV2(ban(3600));
    assert.equal(controller.signal.aborted, true, 'known self-mute must stop the current group model loop');
    assert.equal(otherController.signal.aborted, false, 'another conversation must not be aborted');
    assert.equal(st.unread.length, 1);
    holdResolve();
    assert.equal((await privateSend).data.ok, true);
    assert.equal((await groupSend).data.ok, false);
    assert.equal(sends.filter(entry => entry.action === 'send_group_msg').length, 0);
    assert.equal(st.sendTimes.length, 0);
    assert.equal(st.unread.length, 1);
  }).finally(() => holdResolve());
});

test('another member ban is not this bot mute and result120 alone does not fabricate mute state', () => fixture(async ({ h, request, append, setSendResult, sends }) => {
  assert.equal((await h.checkGroupSendPermissionV2(GROUP, { force: true })).blocked, false);
  h.observeGroupBanV2(ban(3600, '888'));
  assert.equal(h.getGroupSendPermissionV2(GROUP).blocked, false);
  append(GROUP, 70);
  h.noteModelMessagesV2(h.getSocialV2State(GROUP), [...h.getSocialV2State(GROUP).unread]);
  setSendResult({ status: 'failed', retcode: 120, wording: 'fixture send rejected, reason unspecified' });
  const result = await request('send-message', GROUP, { messages: ['fixture rejected text'] });
  assert.equal(result.data.ok, false);
  assert.equal(sends.length, 1, 'unknown rejection is observed only at the actual fake gateway');
  const permission = await h.checkGroupSendPermissionV2(GROUP, { force: true });
  assert.equal(permission.blocked, false, 'retcode alone cannot prove a mute');
  assert.equal(h.getSocialV2State(GROUP).sendTimes.length, 0);
}));

test('pausing during a permission query keeps the incoming message without a stale model wake', () => {
  let release;
  let queryStarted = false;
  const held = new Promise(resolve => { release = resolve; });
  return fixture(async ({ h, receive, setBeforePermission, providerStarts }) => {
    setBeforePermission(async () => { queryStarted = true; await held; });
    const receiving = receive(GROUP, 80);
    await until(() => queryStarted, 'incoming permission query was not held');
    h.socialV2.paused = true;
    release();
    await receiving;
    const st = h.getSocialV2State(GROUP);
    assert.equal(st.unread.length, 1);
    assert.equal(st.pendingWakeTimer, null);
    await delay(1100);
    assert.equal(providerStarts.length, 0, 'a stale permission reply cannot bypass a newer pause');
  }).finally(() => release());
});

test('token revoked during the new async send-permission query cannot send or spend quota', () => {
  let release;
  let queryStarted = false;
  const held = new Promise(resolve => { release = resolve; });
  return fixture(async ({ h, request, append, setBeforePermission, sends }) => {
    append(GROUP, 90);
    const st = h.getSocialV2State(GROUP);
    h.noteModelMessagesV2(st, [...st.unread]);
    setBeforePermission(async () => { queryStarted = true; await held; });
    const sending = request('send-message', GROUP, { messages: ['fixture stale response'] });
    await until(() => queryStarted, 'sending permission query was not held');
    st.agentToken = 'fixture-replacement-token';
    release();
    const result = await sending;
    assert.equal(result.data.ok, false);
    assert.equal(sends.length, 0);
    assert.equal(st.sendTimes.length, 0);
    assert.equal(st.unread.length, 1);
  }).finally(() => release());
});

test('persona changed during the new async send-permission query cancels its captured response', () => {
  let release;
  let queryStarted = false;
  const held = new Promise(resolve => { release = resolve; });
  return fixture(async ({ h, request, append, setBeforePermission, sends }) => {
    append(GROUP, 100);
    const st = h.getSocialV2State(GROUP);
    h.noteModelMessagesV2(st, [...st.unread]);
    setBeforePermission(async () => { queryStarted = true; await held; });
    const sending = request('send-message', GROUP, { messages: ['fixture stale persona response'] });
    await until(() => queryStarted, 'persona fixture permission query was not held');
    const replacement = 'fixture-new-selected-role';
    fs.writeFileSync(path.join(h.temp, 'roles', replacement + '.md'), 'A newly selected fixture persona.');
    fs.writeFileSync(path.join(h.temp, 'state/current-role.json'), JSON.stringify({ role: replacement, mode: 'active' }));
    release();
    const result = await sending;
    assert.equal(result.data.ok, false);
    assert.equal(sends.length, 0);
    assert.equal(st.sendTimes.length, 0);
    assert.equal(st.unread.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8')).role, replacement);
  }).finally(() => release());
});

test('account change during a held permission query rechecks the new account before halting a turn', () => {
  let release;
  let queryStarted = false;
  const held = new Promise(resolve => { release = resolve; });
  return fixture(async ({ h, receive, setBeforePermission, accountMembers, permissionSelfIds,
    providerStarts, requests }) => {
    const replacement = '1000';
    permissionSelfIds.add(replacement);
    accountMembers.set('456:' + replacement, { group_id: 456, user_id: Number(replacement),
      role: 'member', shut_up_timestamp: 0 });
    setBeforePermission(async ({ action, params }) => {
      if (action === 'get_group_member_info' && String(params.user_id) === SELF) {
        queryStarted = true;
        await held;
      }
    });
    const checking = h.checkGroupSendPermissionV2(GROUP, { force: true });
    await until(() => queryStarted, 'old-account permission query was not held');
    h.setSelfIdentity('fixture replacement account', replacement);
    const newAccountController = new AbortController();
    h.directTurnControllers.set(GROUP, newAccountController);
    release();
    const permission = await checking;
    assert.equal(permission.known, true);
    assert.equal(permission.blocked, false, 'an old-account ban cannot block the replacement account');
    assert.equal(newAccountController.signal.aborted, false, 'old-account query must not abort a new-account turn');
    assert.ok(requests.some(entry => entry.action === 'get_group_member_info' && entry.user === replacement));
    h.directTurnControllers.delete(GROUP);
    await receive(GROUP, 110, 'fixture replacement account conversation');
    await until(() => providerStarts.includes(GROUP), 'replacement account did not retain automatic participation');
    await until(() => h.directTurnControllers.size === 0, 'replacement fixture turn did not close');
  }, { muted: true }).finally(() => release());
});

test('an old-account ban notice cannot poison the replacement account permission cache', () => fixture(async ({ h,
  accountMembers, permissionSelfIds }) => {
  const replacement = '1000';
  permissionSelfIds.add(replacement);
  accountMembers.set('456:' + replacement, { group_id: 456, user_id: Number(replacement),
    role: 'member', shut_up_timestamp: 0 });
  h.setSelfIdentity('fixture replacement account', replacement);
  assert.equal((await h.checkGroupSendPermissionV2(GROUP, { force: true })).blocked, false);
  const controller = new AbortController();
  h.directTurnControllers.set(GROUP, controller);
  h.observeGroupBanV2(ban(3600));
  assert.equal(h.getGroupSendPermissionV2(GROUP).blocked, false);
  assert.equal(controller.signal.aborted, false);
  h.directTurnControllers.delete(GROUP);
}));
