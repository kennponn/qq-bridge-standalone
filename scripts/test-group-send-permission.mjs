import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroupSendPermission } from '../src/group-send-permission.js';

const KEY = 'group:456';
const SELF = '999';
const UNKNOWN = { known: false, blocked: false };
const ALLOWED = { known: true, blocked: false };
const data = ({ role = 'member', until = 0, all = false, userId = SELF, groupId = '456' } = {}) => ({
  member: { user_id: userId, role, shut_up_timestamp: until },
  group: { group_id: groupId, group_all_shut: all },
});
function fixture(initial = data(), options = {}) {
  let time = 1_000_000;
  let result = initial;
  const calls = [];
  const manager = createGroupSendPermission({ now: () => time,
    query: async (...args) => { calls.push(args); if (result instanceof Error) throw result; return result; }, ...options });
  return { manager, calls, advance: ms => { time += ms; }, set: value => { result = value; }, now: () => time };
}

test('private and invalid keys never query; group query uses the exact group and self identifiers', async () => {
  const f = fixture();
  assert.deepEqual(await f.manager.check('private:123', SELF), ALLOWED);
  for (const key of ['', 'group:', 'group:abc', 'group:0', 'group:123:456', 'other:123']) {
    assert.deepEqual(await f.manager.check(key, SELF), UNKNOWN);
  }
  for (const self of [undefined, '', '0', 'abc']) assert.deepEqual(await f.manager.check(KEY, self), UNKNOWN);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.manager.check(KEY, SELF), ALLOWED);
  assert.deepEqual(f.calls, [['456', '999']]);
});

test('individual future mute blocks members, admins and owners until its exact seconds-based deadline', async () => {
  for (const role of ['member', 'admin', 'owner']) {
    const f = fixture(data({ role, until: 1010 }));
    assert.deepEqual(await f.manager.check(KEY, SELF), { known: true, blocked: true, blockedUntil: 1_010_000, reason: 'individual' });
    f.advance(9999);
    assert.equal(f.manager.peek(KEY).blocked, true);
    f.advance(1);
    assert.deepEqual(f.manager.peek(KEY), UNKNOWN, 'elapsed mute deadline with stale query cache requires a fresh lookup');
    f.set(data({ role, until: 0 }));
    assert.deepEqual(await f.manager.check(KEY, SELF), ALLOWED);
    assert.equal(f.calls.length, 2);
  }
});

test('whole-group mute blocks only members; admins and owners remain exempt unless individually muted', async () => {
  for (const all of [true, 1]) {
    for (const role of ['member', 'admin', 'owner']) {
      const f = fixture(data({ role, all }));
      const result = await f.manager.check(KEY, SELF);
      assert.deepEqual(result, role === 'member'
        ? { known: true, blocked: true, blockedUntil: null, reason: 'whole-group' } : ALLOWED);
    }
  }
  const f = fixture(data({ role: 'owner', all: true, until: 1060 }));
  assert.equal((await f.manager.check(KEY, SELF)).reason, 'individual');
});

test('unreliable identities, member/group payloads and mute fields fail open as unknown', async () => {
  const malformed = [null, {}, { member: data().member }, { group: data().group },
    data({ userId: '888' }), data({ groupId: '777' }), data({ role: 'stranger' }),
    data({ all: 'true' }), data({ until: -1 }), data({ until: Infinity }),
    { member: { user_id: SELF, role: 'member' }, group: data().group }];
  for (const payload of malformed) {
    const f = fixture(payload);
    assert.deepEqual(await f.manager.check(KEY, SELF), UNKNOWN, JSON.stringify(payload));
    assert.deepEqual(f.manager.peek(KEY), UNKNOWN);
  }
});

test('allowed query cache lasts 30 seconds; both blocked and unknown lookups refresh after 5 seconds', async () => {
  for (const [payload, ttl] of [[data(), 30000], [data({ until: 1060 }), 5000],
    [data({ all: true }), 5000], [{}, 5000]]) {
    const f = fixture(payload);
    await f.manager.check(KEY, SELF);
    f.advance(ttl - 1);
    await f.manager.check(KEY, SELF);
    assert.equal(f.calls.length, 1);
    f.advance(1);
    if (payload?.member?.shut_up_timestamp > 0) {
      assert.equal(f.manager.peek(KEY).reason, 'individual', 'verified individual deadline stays authoritative past query cache expiry');
    } else assert.deepEqual(f.manager.peek(KEY), UNKNOWN, 'stale positive/whole/unknown cache requires refresh');
    await f.manager.check(KEY, SELF);
    assert.equal(f.calls.length, 2);
  }
});

test('check is single-flight even for forced concurrent refreshes and invalidation forces a fresh lookup', async () => {
  let release;
  let calls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const manager = createGroupSendPermission({ query: async () => { calls++; await hold; return data(); } });
  const a = manager.check(KEY, SELF);
  const b = manager.check(KEY, SELF, { force: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await a, ALLOWED);
  assert.deepEqual(await b, ALLOWED);
  assert.equal(manager.invalidate(KEY), true);
  assert.deepEqual(manager.peek(KEY), UNKNOWN);
  await manager.check(KEY, SELF);
  assert.equal(calls, 2);
  await manager.check(KEY, SELF, { force: true });
  assert.equal(calls, 3);
  manager.clear();
  assert.deepEqual(manager.peek(KEY), UNKNOWN);
});

test('exact self mute notices apply immediately, expire safely and an early lift clears the current mute', async () => {
  const f = fixture();
  await f.manager.check(KEY, SELF);
  assert.equal(f.manager.notice({ notice_type: 'group_ban', group_id: 456, user_id: 999,
    self_id: 999, sub_type: 'ban', duration: 60 }), true);
  assert.deepEqual(f.manager.peek(KEY), { known: true, blocked: true, blockedUntil: 1_060_000, reason: 'individual' });
  f.advance(1000);
  assert.equal(f.manager.notice({ group_id: 456, user_id: 999, self_id: 999, sub_type: 'lift_ban', duration: 0 }), true);
  assert.deepEqual(f.manager.peek(KEY), ALLOWED);
  assert.deepEqual(await f.manager.check(KEY, SELF, { force: true }), ALLOWED);
  assert.equal(f.calls.length, 2);
  assert.equal(f.manager.notice({ group_id: 456, user_id: 999, self_id: 999, sub_type: 'ban', duration: 5 }), true);
  f.advance(5000);
  assert.deepEqual(f.manager.peek(KEY), UNKNOWN);
  assert.deepEqual(await f.manager.check(KEY, SELF), ALLOWED);
});

test('whole-group notices never mistake an admin or unknown role for an ordinary muted member', async () => {
  for (const role of ['member', 'admin', 'owner']) {
    const f = fixture(data({ role }));
    await f.manager.check(KEY, SELF);
    assert.equal(f.manager.notice({ group_id: 456, user_id: 0, self_id: 999, sub_type: 'ban', duration: 60 }), true);
    assert.equal(f.manager.peek(KEY).blocked, role === 'member');
    assert.equal(f.manager.notice({ group_id: 456, user_id: 0, self_id: 999, sub_type: 'lift_ban', duration: 0 }), true);
    assert.deepEqual(f.manager.peek(KEY), ALLOWED);
  }
  const unknown = fixture(data({ role: 'admin', all: true }));
  assert.equal(unknown.manager.notice({ group_id: 456, user_id: 0, self_id: 999, sub_type: 'ban', duration: 60 }), true);
  assert.deepEqual(unknown.manager.peek(KEY), UNKNOWN);
  assert.deepEqual(await unknown.manager.check(KEY, SELF, { force: true }), ALLOWED);
});

test('other people, malformed or other notice types do not alter self permissions', async () => {
  const f = fixture();
  await f.manager.check(KEY, SELF);
  const valid = { group_id: 456, user_id: 999, self_id: 999, sub_type: 'ban', duration: 60 };
  for (const patch of [{ user_id: 888 }, { notice_type: 'group_increase' }, { sub_type: 'other' },
    { group_id: 0 }, { self_id: 0 }, { duration: -1 }, { duration: 'invalid' },
    { duration: undefined }, { sub_type: 'lift_ban', duration: 60 }]) {
    assert.equal(f.manager.notice({ ...valid, ...patch }), false, JSON.stringify(patch));
    assert.deepEqual(f.manager.peek(KEY), ALLOWED);
  }
});

test('newer mute and lift notices win over stale in-flight API results', async () => {
  for (const initialBlocked of [false, true]) {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const manager = createGroupSendPermission({ now: () => 1_000_000,
      query: async () => { await hold; return data({ until: initialBlocked ? 1060 : 0 }); } });
    const pending = manager.check(KEY, SELF);
    await Promise.resolve();
    manager.notice({ group_id: 456, user_id: 999, self_id: 999, sub_type: 'ban', duration: 60 });
    if (initialBlocked) manager.notice({ group_id: 456, user_id: 999, self_id: 999, sub_type: 'lift_ban', duration: 0 });
    release();
    const result = await pending;
    assert.equal(result.blocked, !initialBlocked);
    assert.equal(manager.peek(KEY).blocked, !initialBlocked);
  }
});

test('query errors fail open briefly; cache identity changes, clear and bounded eviction cannot retain old results', async () => {
  const f = fixture(new Error('fixture network error'), { maxEntries: 2 });
  assert.deepEqual(await f.manager.check(KEY, SELF), UNKNOWN);
  await f.manager.check(KEY, SELF);
  assert.equal(f.calls.length, 1);
  f.advance(5000);
  f.set(data());
  assert.deepEqual(await f.manager.check(KEY, SELF), ALLOWED);
  await f.manager.check('group:457', SELF);
  await f.manager.check('group:458', SELF);
  assert.deepEqual(f.manager.peek(KEY), UNKNOWN, 'oldest entry must be evicted at the configured capacity');
  await f.manager.check(KEY, '777');
  assert.deepEqual(f.manager.peek(KEY), UNKNOWN, 'wrong account response cannot reuse previous self permissions');
  f.manager.clear();
  assert.deepEqual(f.manager.peek('group:458'), UNKNOWN);
});

test('invalidating or clearing an in-flight lookup prevents late results from resurrecting cached permissions', async () => {
  for (const action of ['invalidate', 'clear']) {
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const manager = createGroupSendPermission({ query: async () => { await hold; return data({ until: 9999999999 }); } });
    const pending = manager.check(KEY, SELF);
    await Promise.resolve();
    if (action === 'invalidate') manager.invalidate(KEY);
    else manager.clear();
    release();
    assert.deepEqual(await pending, UNKNOWN);
    assert.deepEqual(manager.peek(KEY), UNKNOWN);
  }
});

test('individual notices remain authoritative when whole-group mute is active and lift restores the correct whole policy', async () => {
  const f = fixture(data({ all: true }));
  await f.manager.check(KEY, SELF);
  f.manager.notice({ group_id: 456, self_id: 999, user_id: 999, sub_type: 'ban', duration: 5 });
  assert.equal(f.manager.peek(KEY).reason, 'individual');
  f.manager.notice({ group_id: 456, self_id: 999, user_id: 999, sub_type: 'lift_ban', duration: 0 });
  assert.deepEqual(f.manager.peek(KEY), { known: true, blocked: true, blockedUntil: null, reason: 'whole-group' });
  f.advance(10000);
  assert.deepEqual(f.manager.peek(KEY), UNKNOWN);
});

test('whole-group subtype is authoritative for zero and negative duration sentinels without blocking admins', async () => {
  for (const duration of [0, -1]) {
    for (const role of ['member', 'admin', 'owner']) {
      const f = fixture(data({ role }));
      await f.manager.check(KEY, SELF);
      assert.equal(f.manager.notice({ group_id: 456, self_id: 999, user_id: 0, sub_type: 'ban', duration }), true);
      assert.equal(f.manager.peek(KEY).blocked, role === 'member');
      assert.equal(f.manager.notice({ group_id: 456, self_id: 999, user_id: 0, sub_type: 'lift_ban', duration: -1 }), true);
      assert.deepEqual(f.manager.peek(KEY), ALLOWED);
      assert.equal(f.manager.notice({ group_id: 456, self_id: 999, user_id: 999, sub_type: 'ban', duration: -1 }), false);
      assert.deepEqual(f.manager.peek(KEY), ALLOWED, 'negative individual mute duration is never a ban');
    }
    const unknown = fixture(data({ role: 'admin', all: true }));
    unknown.manager.notice({ group_id: 456, self_id: 999, user_id: 0, sub_type: 'ban', duration });
    assert.deepEqual(unknown.manager.peek(KEY), UNKNOWN);
    assert.deepEqual(await unknown.manager.check(KEY, SELF, { force: true }), ALLOWED);
  }
});

test('whole-group sentinel notices supersede old in-flight permission responses', async () => {
  for (const lift of [false, true]) {
    let release;
    let delayed = false;
    const hold = new Promise(resolve => { release = resolve; });
    const manager = createGroupSendPermission({ query: async () => {
      if (delayed) await hold;
      return data({ all: lift });
    } });
    await manager.check(KEY, SELF);
    delayed = true;
    const pending = manager.check(KEY, SELF, { force: true });
    await Promise.resolve();
    manager.notice({ group_id: 456, self_id: 999, user_id: 0, sub_type: lift ? 'lift_ban' : 'ban', duration: -1 });
    release();
    assert.equal((await pending).blocked, !lift);
    assert.equal(manager.peek(KEY).blocked, !lift);
  }
});

test('verified individual mute remains known even when group-info payload is absent or unreliable', async () => {
  for (const group of [undefined, null, {}, { group_id: '777', group_all_shut: false }]) {
    const f = fixture({ member: data({ until: 1060 }).member, group });
    assert.deepEqual(await f.manager.check(KEY, SELF), { known: true, blocked: true, blockedUntil: 1_060_000, reason: 'individual' });
    assert.equal(f.manager.peek(KEY).blocked, true);
  }
});

test('expired query cache and refresh errors cannot lift a confirmed individual ban before its deadline', async () => {
  const f = fixture(data({ until: 1120 }));
  const blocked = { known: true, blocked: true, blockedUntil: 1_120_000, reason: 'individual' };
  assert.deepEqual(await f.manager.check(KEY, SELF), blocked);
  f.advance(5000);
  assert.deepEqual(f.manager.peek(KEY), blocked);
  f.set(new Error('fixture transient member lookup failure'));
  assert.deepEqual(await f.manager.check(KEY, SELF), blocked);
  assert.deepEqual(f.manager.peek(KEY), blocked);
  f.advance(5000);
  f.set({});
  assert.deepEqual(await f.manager.check(KEY, SELF), blocked, 'incomplete refresh is not evidence of an early unmute');
  f.set(data());
  assert.deepEqual(await f.manager.check(KEY, SELF, { force: true }), ALLOWED, 'verified fresh unmuted member clears old deadline');
  assert.deepEqual(f.manager.peek(KEY), ALLOWED);
});

test('preserved confirmed individual ban becomes unknown when its deadline passes without reliable refreshed group data', async () => {
  const f = fixture(data({ until: 1040 }));
  await f.manager.check(KEY, SELF);
  f.advance(30000);
  f.set(new Error('fixture refresh failure'));
  assert.equal((await f.manager.check(KEY, SELF)).blocked, true);
  f.advance(10000);
  assert.deepEqual(f.manager.peek(KEY), UNKNOWN, 'elapsed individual deadline must not permanently block a failed lookup');
  assert.deepEqual(await f.manager.check(KEY, SELF), UNKNOWN);
});

test('missed early-unmute notice is corrected by the next check after the five-second blocked cache', async () => {
  const f = fixture(data({ until: 1120 }));
  assert.equal((await f.manager.check(KEY, SELF)).blocked, true);
  f.set(data());
  f.advance(4999);
  assert.equal((await f.manager.check(KEY, SELF)).blocked, true);
  assert.equal(f.calls.length, 1, 'no periodic or idle query occurs inside the short block cache');
  f.advance(1);
  assert.deepEqual(await f.manager.check(KEY, SELF), ALLOWED);
  assert.deepEqual(f.manager.peek(KEY), ALLOWED);
  assert.equal(f.calls.length, 2, 'a new permission check refreshes early without waiting for the stored deadline');
});

test('unknown whole-mute notices trigger a default lookup immediately instead of caching unknown role assumptions', async () => {
  for (const role of ['member', 'admin', 'owner']) {
    const f = fixture(data({ role, all: true }));
    f.manager.notice({ group_id: 456, self_id: 999, user_id: 0, sub_type: 'ban', duration: -1 });
    assert.deepEqual(f.manager.peek(KEY), UNKNOWN);
    const result = await f.manager.check(KEY, SELF);
    assert.equal(f.calls.length, 1, 'next default check must discover the role, without force or a five-second wait');
    assert.equal(result.blocked, role === 'member');
  }
  const f = fixture(data());
  f.manager.notice({ group_id: 456, self_id: 999, user_id: 999, sub_type: 'ban', duration: 60 });
  f.manager.notice({ group_id: 456, self_id: 999, user_id: 999, sub_type: 'lift_ban', duration: 0 });
  assert.deepEqual(f.manager.peek(KEY), UNKNOWN);
  assert.deepEqual(await f.manager.check(KEY, SELF), ALLOWED);
  assert.equal(f.calls.length, 1, 'unknown-role individual lift also queries immediately');
});
