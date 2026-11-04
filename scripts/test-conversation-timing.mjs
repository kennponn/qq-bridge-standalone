import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConversationTiming, privateReplyPolicy, conversationRecommendations } from '../src/conversation-timing.js';
import { bindDirectTool } from '../src/direct-tools.js';

test('standalone private chats are quick without changing group timing', () => {
  const cfg = { engine: { backend: 'standalone' } };
  const privateTiming = resolveConversationTiming(cfg, 'private:123');
  assert.equal(privateTiming.fastPrivate, true);
  assert.equal(privateTiming.batchMs, 700);
  assert.equal(privateTiming.quietMs, 1500);
  assert.equal(privateTiming.quietMaxMs, 3000);
  assert.equal(privateTiming.preSleepRequired, false);
  assert.equal(privateTiming.replyCheckEnabled, false);
  const groupTiming = resolveConversationTiming(cfg, 'group:456');
  assert.equal(groupTiming.fastPrivate, false);
  assert.equal(groupTiming.batchMs, 8000);
  assert.equal(groupTiming.quietMinMs, 10000);
  assert.equal(groupTiming.preSleepRequired, true);
  assert.equal(groupTiming.replyCheckEnabled, true);
  assert.match(privateReplyPolicy(privateTiming), /Never acknowledge messages you have not seen/);
  assert.equal(privateReplyPolicy(groupTiming), '');
});

test('legacy/private opt-out and explicit opt-in preserve configuration intent', () => {
  assert.equal(resolveConversationTiming({}, 'private:123').fastPrivate, false);
  assert.equal(resolveConversationTiming({ engine: { backend: 'standalone' }, socialV2: { privateChat: { fastReply: false } } }, 'private:123').fastPrivate, false);
  assert.equal(resolveConversationTiming({ socialV2: { privateChat: { fastReply: true } } }, 'private:123').fastPrivate, true);
  assert.equal(resolveConversationTiming({}, 'private:123', { standalone: true }).fastPrivate, true);
  assert.equal(resolveConversationTiming({ engine: { backend: 'standalone' } }, 'invalid:123').fastPrivate, false);
});

test('private knobs are finite and bounded and group settings remain unchanged', () => {
  const cfg = { engine: { backend: 'standalone' }, socialV2: { privateChat: { batchWindowMs: -1, minWaitMs: Infinity,
    maxWaitMs: 50, quietMs: 100000, minQuietMs: 500, maxQuietMs: 2000 }, wait: { defaultQuietMs: 12000, minQuietAfterNewMs: 11000 }, wake: { batchWindowMs: 9000 } } };
  const timing = resolveConversationTiming(cfg, 'private:123');
  assert.equal(timing.batchMs, 100);
  assert.equal(timing.minWaitMs, 100);
  assert.equal(timing.waitMaxMs, 100);
  assert.equal(timing.quietMs, 2000);
  const group = resolveConversationTiming(cfg, 'group:456');
  assert.equal(group.batchMs, 9000);
  assert.equal(group.quietMs, 12000);
  assert.equal(group.quietMinMs, 11000);
});

test('fallbacks obey dependent quiet and wait bounds', () => {
  const profile = resolveConversationTiming({ engine: { backend: 'standalone' }, socialV2: {
    privateChat: { minQuietMs: 5000, maxWaitMs: 10000 }
  } }, 'private:123');
  assert.equal(profile.quietMinMs, 5000);
  assert.equal(profile.quietMaxMs, 5000);
  assert.equal(profile.quietMs, 5000);
  assert.equal(profile.defaultWaitMs, 10000);
});

test('model recommendations match enforced private timings, without changing group defaults', () => {
  const cfg = { engine: { backend: 'standalone' }, socialV2: { wake: { batchWindowMs: 8000,
    preSleepWaitEnabled: true, maxWakePerMinute: 1 }, wait: { minQuietAfterNewMs: 10000 } } };
  const privateRules = conversationRecommendations(cfg, 'private:123');
  assert.equal(privateRules.wake.batchWindowMs, 700);
  assert.equal(privateRules.wake.preSleepWaitEnabled, false);
  assert.equal(privateRules.wake.maxWakePerMinute, 30);
  assert.equal(privateRules.wait.minQuietAfterNewMs, 500);
  assert.equal(privateRules.wait.defaultQuietMs, 1500);
  assert.equal(privateRules.wait.postReplyWaitRequired, false);
  assert.deepEqual(conversationRecommendations(cfg, 'group:456').wake, cfg.socialV2.wake);
  assert.deepEqual(conversationRecommendations(cfg, 'group:456').wait, cfg.socialV2.wait);
  assert.equal(cfg.socialV2.wake.preSleepWaitEnabled, true);
  cfg.socialV2.provideRecommendations = false;
  assert.equal(conversationRecommendations(cfg, 'private:123'), null);
});

test('private tool guidance keeps bound arguments and original schema intact', () => {
  const definition = { name: 'qq_wait_for_messages', description: 'Shared group description.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, token: { type: 'string' },
      timeoutMs: { type: 'number', description: 'Long group wait' }, quietMs: { type: 'number', description: 'Group quiet' } },
    required: ['key', 'token'] } };
  const timing = resolveConversationTiming({ engine: { backend: 'standalone' } }, 'private:123');
  const bound = bindDirectTool(definition, { key: 'private:123', agentToken: 'fixture-only', timing });
  assert.match(bound.tool.function.description, /No five-minute/);
  assert.match(bound.tool.function.parameters.properties.quietMs.description, /1500/);
  assert.ok(!('token' in bound.tool.function.parameters.properties));
  assert.equal(bound.tool.function.parameters.additionalProperties, false);
  assert.throws(() => bound.arguments({ key: 'private:999' }), /cannot be changed/);
  assert.deepEqual(bound.arguments({ quietMs: 1500 }), { quietMs: 1500, key: 'private:123', token: 'fixture-only' });
  assert.equal(definition.inputSchema.properties.quietMs.description, 'Group quiet');
  const group = bindDirectTool(definition, { key: 'group:456', agentToken: 'fixture-only', timing });
  assert.equal(group.tool.function.description, definition.description);
  assert.equal(group.tool.function.parameters.properties.quietMs.description, 'Group quiet');
});
