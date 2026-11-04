import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  conversationRecommendations, effectiveWakeConfig, isAlwaysAwakeGroup,
  privateReplyPolicy, resolveConversationTiming,
} from '../src/conversation-timing.js';

const GROUP = 'group:456';
const PRIVATE = 'private:123';
const cfg = {
  engine: { backend: 'standalone' },
  socialV2: {
    wake: {
      alwaysAwake: true, defaultMode: 'diving', recommendedDefaultInfinite: false,
      batchWindowMs: 8000, preSleepWaitEnabled: true,
      maxWakePerMinute: 30, maxWakePerHour: 120,
      recommendedHint: 'Sleep five minutes after every reply.',
    },
    wait: { minMs: 5000, maxMs: 600000, defaultMs: 30000,
      minQuietAfterNewMs: 10000, defaultQuietMs: 10000 },
    send: { maxSendPerMinute: 8, maxSendPerHour: 60 },
  },
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('always-on group listening accepts only the strict host flag in standalone groups', () => {
  assert.equal(isAlwaysAwakeGroup(cfg, GROUP), true);
  assert.equal(isAlwaysAwakeGroup(cfg, PRIVATE), false);
  for (const key of ['group:', 'group:abc', 'group:123:456', 'unknown:123']) {
    assert.equal(isAlwaysAwakeGroup(cfg, key), false, key);
  }
  for (const flag of [false, undefined, null, 0, 1, 'true', 'false', {}, []]) {
    const changed = { ...cfg, socialV2: { ...cfg.socialV2, wake: { ...cfg.socialV2.wake, alwaysAwake: flag } } };
    assert.equal(isAlwaysAwakeGroup(changed, GROUP), false, `flag ${JSON.stringify(flag)}`);
  }
  const dsh = { ...cfg, engine: { backend: 'dsh' } };
  assert.equal(isAlwaysAwakeGroup(dsh, GROUP), false);
  assert.equal(isAlwaysAwakeGroup(dsh, GROUP, { standalone: true }), true);
  assert.equal(isAlwaysAwakeGroup(dsh, GROUP, { standalone: 'true' }), false);
});

test('effective wake overlay preserves saved preferences and trigger collections', () => {
  const base = deepFreeze({ mode: 'diving', infinite: false,
    sleepUntil: '2030-01-01T00:00:00.000Z', batchWindowMs: 25000,
    triggers: { anyMessage: false, atMention: false, keywords: ['fixture'], speakerIds: ['123'] },
    confirmedBy: 'set_wake_config', wakeCount: 3, lastWakeAt: 10 });
  const before = structuredClone(base);
  const effective = effectiveWakeConfig(deepFreeze(structuredClone(cfg)), GROUP, base);
  assert.notEqual(effective, base);
  assert.notEqual(effective.triggers, base.triggers);
  assert.equal(effective.mode, 'active');
  assert.equal(effective.infinite, true);
  assert.equal(effective.sleepUntil, null);
  assert.equal(effective.alwaysAwake, true);
  assert.equal(effective.batchWindowMs, 1000);
  assert.equal(effective.triggers.anyMessage, true);
  assert.equal(effective.triggers.atMention, false);
  assert.deepEqual(effective.triggers.keywords, ['fixture']);
  assert.deepEqual(effective.triggers.speakerIds, ['123']);
  assert.equal(effective.confirmedBy, 'set_wake_config');
  assert.equal(effective.wakeCount, 3);
  assert.deepEqual(base, before);
  assert.equal(effectiveWakeConfig(cfg, PRIVATE, base), base);
  assert.equal(effectiveWakeConfig({ socialV2: { wake: { alwaysAwake: false } } }, GROUP, base), base);
  assert.equal(effectiveWakeConfig({ ...cfg, engine: { backend: 'dsh' } }, GROUP, base), base);
  assert.equal(effectiveWakeConfig(cfg, PRIVATE, undefined), undefined);
  assert.equal(effectiveWakeConfig(cfg, GROUP, undefined).triggers.anyMessage, true);
});

test('always-on group short timing never opts into private quotas', () => {
  const frozen = deepFreeze(structuredClone(cfg));
  const before = structuredClone(frozen);
  const timing = resolveConversationTiming(frozen, GROUP);
  assert.deepEqual(timing, {
    fastPrivate: false, alwaysAwake: true, batchMs: 1000,
    minWaitMs: 100, waitMaxMs: 30000, defaultWaitMs: 15000,
    quietMinMs: 0, quietMaxMs: 3000, quietMs: 1000,
    preSleepRequired: false, replyCheckEnabled: false,
  });
  assert.equal(Object.hasOwn(timing, 'maxWakePerMinute'), false);
  assert.equal(Object.hasOwn(timing, 'maxWakePerHour'), false);
  assert.deepEqual(frozen, before);
});

test('off and DSH groups retain old sleep timing; private retains its existing fast profile', () => {
  const off = { ...cfg, socialV2: { ...cfg.socialV2, wake: { ...cfg.socialV2.wake, alwaysAwake: false } } };
  const dsh = { ...cfg, engine: { backend: 'dsh' } };
  for (const config of [off, dsh]) {
    const group = resolveConversationTiming(config, GROUP);
    assert.equal(group.fastPrivate, false);
    assert.equal(group.alwaysAwake, undefined);
    assert.equal(group.batchMs, 8000);
    assert.equal(group.quietMs, 10000);
    assert.equal(group.preSleepRequired, true);
    assert.equal(group.replyCheckEnabled, true);
    assert.equal(privateReplyPolicy(group), '');
  }
  const privateTiming = resolveConversationTiming(cfg, PRIVATE);
  assert.equal(privateTiming.fastPrivate, true);
  assert.equal(privateTiming.alwaysAwake, undefined);
  assert.equal(privateTiming.batchMs, 700);
  assert.equal(privateTiming.maxWakePerMinute, 30);
  assert.equal(privateTiming.maxWakePerHour, 360);
  assert.equal(privateTiming.preSleepRequired, false);
  assert.match(privateReplyPolicy(privateTiming), /\[PRIVATE_REPLY_POLICY\]/);
  assert.doesNotMatch(privateReplyPolicy(privateTiming), /GROUP_ALWAYS_AWAKE_POLICY/);
});

test('group policy prioritizes complete direct messages, safe skip and bounded idle behavior', () => {
  const policy = privateReplyPolicy(resolveConversationTiming(cfg, GROUP));
  assert.match(policy, /\[GROUP_ALWAYS_AWAKE_POLICY\]/);
  assert.match(policy, /complete message addressed to you, especially an @/);
  assert.match(policy, /skip irrelevant chatter by safely closing/);
  assert.match(policy, /cannot disable the host's always-on listening/);
  assert.match(policy, /Do not poll, repeat idle waits/);
  assert.match(policy, /No post-reply long wait or five-minute pre-sleep observation/);
  assert.match(policy, /quietMs=1000/);
  assert.match(policy, /caps quiet waits at 3000ms/);
  assert.match(policy, /sending tool first and the closing tool second in the SAME tool-call response/);
  assert.match(policy, /will not acknowledge after a failed send/);
  assert.match(policy, /Never acknowledge messages you have not seen/);
  assert.match(policy, /Wake and send rate limits, permissions, mute and pause controls still apply/);
});

test('recommendations expose effective state and short waits without changing group or send limits', () => {
  const frozen = deepFreeze(structuredClone(cfg));
  const before = structuredClone(frozen);
  const recommended = conversationRecommendations(frozen, GROUP);
  assert.equal(recommended.wake.mode, 'active');
  assert.equal(recommended.wake.defaultMode, 'active');
  assert.equal(recommended.wake.infinite, true);
  assert.equal(recommended.wake.recommendedDefaultInfinite, true);
  assert.equal(recommended.wake.sleepUntil, null);
  assert.equal(recommended.wake.triggers.anyMessage, true);
  assert.equal(recommended.wake.batchWindowMs, 1000);
  assert.equal(recommended.wake.preSleepWaitEnabled, false);
  assert.equal(recommended.wake.maxWakePerMinute, 30);
  assert.equal(recommended.wake.maxWakePerHour, 120);
  assert.doesNotMatch(recommended.wake.recommendedHint, /Sleep five minutes/);
  assert.match(recommended.wake.recommendedHint, /Host-controlled always-on listening/);
  assert.deepEqual(recommended.wait, { ...frozen.socialV2.wait,
    minMs: 100, maxMs: 30000, defaultMs: 15000, defaultQuietMs: 1000,
    minQuietAfterNewMs: 0, maxQuietMs: 3000, postReplyWaitRequired: false });
  assert.equal(recommended.send, frozen.socialV2.send);
  assert.equal(recommended.send.maxSendPerMinute, 8);
  assert.equal(recommended.send.maxSendPerHour, 60);
  assert.deepEqual(frozen, before);
  assert.equal(conversationRecommendations({ ...cfg, socialV2: { ...cfg.socialV2,
    provideRecommendations: false } }, GROUP), null);
});
