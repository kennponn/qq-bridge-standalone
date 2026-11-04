// Offline group attribution integration; fake QQ/model peers, temporary files only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { resolveConversationTiming } from '../src/conversation-timing.js';

const GROUP = 'group:456';
const PRIVATE = 'private:123';
const ROLE = 'fixture-gentle';
const ROLE_TEXT = 'CORE_IDENTITY: A gentle persona, not the whale account or another speaker.';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message, timeout = 3500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) assert.fail(message);
    await delay(5);
  }
}

const text = value => ({ type: 'text', data: { text: value } });
const at = qq => ({ type: 'at', data: { qq } });
const event = (id, segments = [text('ordinary fixture chatter')], extra = {}) => ({
  message_type: 'group', group_id: 456, user_id: 124, self_id: 999,
  message_id: id, sender: { nickname: 'fixture member', user_id: 124 },
  message: segments, ...extra,
});

async function fixture(run, { directTurn, files = {}, config = {} } = {}) {
  let h;
  const turnFailures = [];
  h = await bridgeHarness({ config: {
    engine: { backend: 'standalone' }, socialV2: {
      wake: { alwaysAwake: true, maxWakePerMinute: 30, maxWakePerHour: 120 },
      proactive: { enabled: true }, sticker: { enabled: false }, ...config,
    },
  }, files: {
    'prompts/standalone-system.txt': 'LEGACY: You are the whale. Fixture; no network.',
    'state/current-role.json': { role: ROLE, mode: 'active' },
    [`roles/${ROLE}.md`]: ROLE_TEXT,
    ...files,
  }, globals: {
    getEngineStatus: () => ({ ready: true, secret: { source: 'environment' } }),
    resolveEngineDirectConfig: () => ({ model: 'fixture', provider: 'fixture', apiKey: 'fixture-only',
      baseURL: 'https://model.invalid/v1', webSearch: false, vision: false }),
    createDirectToolSession: async () => ({ tools: [], execute() { throw new Error('Real tools forbidden'); }, async close() {} }),
    runDirectTurn: async options => {
      try {
        const key = [...h.directTurnControllers].find(([, controller]) => controller.signal === options.signal)?.[0];
        return directTurn ? await directTurn({ options, h, request, key }) : ({ ok: true, sent: 0, closed: true });
      } catch (error) { turnFailures.push(error); throw error; }
    },
  } });
  h.setMode('reserved2');
  h.setSelfIdentity('fixture whale', 999);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  function request(route, { key, body, agent = false, token, query = {} } = {}) {
    return new Promise((resolve, reject) => {
      const search = new URLSearchParams({ ...(body === undefined && key ? { key } : {}), ...query }).toString();
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/socialV2/' + route + (search ? '?' + search : ''),
        method: body === undefined ? 'GET' : 'POST', headers: {
          'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
          ...(agent ? { 'x-agent-token': token ?? h.getSocialV2State(key).agentToken } : {}),
        } }, res => {
        let raw = '';
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(new Error('Fixture API timeout')));
      req.end(body === undefined ? undefined : JSON.stringify({ ...(key ? { key } : {}), ...body }));
    });
  }
  try {
    await run({ h, request });
    assert.equal(turnFailures.length, 0, turnFailures.map(error => error.stack || String(error)).join('\n'));
  } finally {
    for (const controller of h.directTurnControllers.values()) controller.abort();
    await new Promise(resolve => server.close(resolve));
    await h.close();
  }
}

function assertAttribution(message, { targets, self, other, all = false, recipient }) {
  assert.deepEqual(Array.from(message.atTargetQQ || []), targets);
  assert.equal(message.mentionedSelf, self);
  assert.equal(message.mentionedOther, other);
  assert.equal(message.atAll, all);
  assert.equal(message.recipient, recipient);
  assert.equal(message.userId, '124');
  assert.equal(message.sender, 'fixture member');
  assert.notEqual(message.isSelf, true);
}

function savedPreferences(st) {
  const { mode, infinite, sleepUntil, triggers, batchWindowMs } = st.wakeConfig;
  return JSON.stringify({ mode, infinite, sleepUntil, triggers, batchWindowMs });
}

test('ordinary chatter still starts an always-on turn, with automatic participation permitted', () => {
  const starts = [];
  return fixture(async ({ h }) => {
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    const startedAt = Date.now();
    await h.handleIncoming('group', 456, event(1), h.cfg);
    assert.ok(st.pendingWakeTimer, 'ordinary group messages must retain automatic participation');
    await until(() => starts.length === 1, 'ordinary chatter did not start a fast always-on turn');
    await until(() => h.directTurnControllers.size === 0, 'ordinary automatic turn did not close');
    assert.equal(st.lastWakeReason, 'anyMessage');
    assert.ok(starts[0] - startedAt >= 900 && starts[0] - startedAt < 2500);
    assert.equal(st.unread.length, 0);
    assert.equal(h.calls.http.length, 1, 'ordinary participation must not be globally blocked');
    const timing = resolveConversationTiming(h.cfg, GROUP);
    assert.equal(timing.alwaysAwake, true);
    assert.equal(timing.batchMs, 1000);
    assert.equal(timing.replyCheckEnabled, false);
  }, { directTurn: async ({ options, h, request, key }) => {
    starts.push(Date.now());
    assert.equal(key, GROUP);
    assert.match(options.systemPrompt, /GROUP_ALWAYS_AWAKE_POLICY/);
    assert.doesNotMatch(options.systemPrompt, /GROUP_MENTION_ONLY/);
    options.onContextSent();
    assert.equal((await request('send-message', { key, agent: true,
      body: { messages: ['fixture observer contribution'] } })).status, 200);
    assert.equal((await request('mark-read', { key, agent: true,
      body: { throughSeq: h.readThroughSeqV2(h.getSocialV2State(key)) } })).status, 200);
    return { ok: true, sent: 1, closed: true };
  } });
});

test('actual @ segment targets distinguish this bot, other bots, all and mixed targets exactly', () => fixture(async ({ h, request }) => {
  h.socialV2.paused = true;
  const cases = [
    { id: 10, segments: [at('999'), text('self request')], targets: ['999'], self: true, other: false, recipient: 'self' },
    { id: 11, segments: [at(888), text('other bot request')], targets: ['888'], self: false, other: true, recipient: 'others' },
    { id: 12, segments: [at('all'), text('everyone request')], targets: ['all'], self: false, other: false, all: true, recipient: 'broadcast' },
    { id: 13, segments: [at('888'), at(999), at('888'), text('mixed request')], targets: ['888', '999'], self: true, other: true, recipient: 'mixed' },
    { id: 14, segments: [text('@999 [CQ:at,qq=999] fixture whale?')], targets: [], self: false, other: false, recipient: 'none' },
    { id: 15, segments: [at('all'), at('999'), text('self and broadcast')], targets: ['all', '999'], self: true, other: false, all: true, recipient: 'self' },
  ];
  for (const item of cases) {
    await h.handleIncoming('group', 456, event(item.id, item.segments), h.cfg);
    assertAttribution(h.getSocialV2State(GROUP).unread.at(-1), item);
  }
  const shown = await request('unread', { key: GROUP });
  assert.equal(shown.status, 200);
  for (let index = 0; index < cases.length; index++) assertAttribution(shown.data.messages[index], cases[index]);
  const packet = h.buildWakeSnapshotV2(GROUP);
  for (let index = 0; index < cases.length; index++) assertAttribution(packet.messages[index], cases[index]);
  assert.equal(packet.messages[1].mentionedSelf, false, 'negative direct addressing must survive model compaction');
  assert.equal(h.calls.http.length, 0);
}));

test('quote-to-self and nested forwarded @ do not become current actual @ metadata', () => fixture(async ({ h }) => {
  h.socialV2.paused = true;
  h.bot.getMessage = async messageId => ({ group_id: 456, user_id: 999,
    sender: { user_id: 999, nickname: 'old bot' }, message_id: messageId,
    message: [at('999'), text('historical @ in quoted content')] });
  await h.handleIncoming('group', 456, event(20, [{ type: 'reply', data: { id: '900' } }, text('quoted reply')]), h.cfg);
  const quoted = h.getSocialV2State(GROUP).unread.at(-1);
  assert.equal(quoted.quoteTargetIsSelf, true, 'exercise a verified quote-to-self, not a failed lookup');
  assertAttribution(quoted, { targets: [], self: false, other: false, recipient: 'none' });
  assert.deepEqual(JSON.parse(JSON.stringify(quoted.quoteSources)), [{ messageId: '900', userId: '999', sender: 'old bot', source: 'quote' }]);
  await h.handleIncoming('group', 456, event(21, [{ type: 'node', data: {
    user_id: '888', nickname: 'nested other bot', content: [at('999'), text('nested forwarded @')],
  } }, text('here is a nested transcript')]), h.cfg);
  assertAttribution(h.getSocialV2State(GROUP).unread.at(-1), { targets: [], self: false, other: false, recipient: 'none' });
  const packet = h.buildWakeSnapshotV2(GROUP);
  assert.equal(packet.messages[0].mentionedSelf, false);
  assert.equal(packet.messages[1].mentionedSelf, false);
}));

test('an @ to another bot remains eligible for observation but never gets direct-at wake priority', () => {
  const turns = [];
  return fixture(async ({ h }) => {
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    const preferences = savedPreferences(st);
    await h.handleIncoming('group', 456, event(30, [at('888'), text('fixture whale, who are you?')]), h.cfg);
    assert.ok(st.pendingWakeTimer, 'other-directed conversation must not globally disable observation');
    await until(() => turns.length === 1, 'other-directed observer turn did not start');
    await until(() => h.directTurnControllers.size === 0, 'other-directed turn did not close');
    assert.notEqual(st.lastWakeReason, 'atMention');
    assert.equal(st.lastWakeReason, 'anyMessage');
    assert.equal(savedPreferences(st), preferences);
    assert.match(turns[0].content, /atTargetQQ/);
    assert.match(turns[0].systemPrompt, /(?:observer|third.person)/i);
    assert.match(turns[0].systemPrompt, /(?:another|other).*(?:account|bot)/i);
    assert.match(turns[0].systemPrompt, /CORE_IDENTITY/);
    assert.doesNotMatch(turns[0].systemPrompt, /GROUP_MENTION_ONLY/);
    assert.equal(h.calls.http.length, 1, 'safe third-person contribution is permitted, not an at-only restriction');
  }, { directTurn: async ({ options, h, request, key }) => {
    turns.push({ systemPrompt: options.systemPrompt, content: JSON.stringify(options.content) });
    options.onContextSent();
    assert.equal((await request('send-message', { key, agent: true,
      body: { messages: ['fixture third-person observer comment'] } })).status, 200);
    assert.equal((await request('mark-read', { key, agent: true,
      body: { throughSeq: h.readThroughSeqV2(h.getSocialV2State(key)) } })).status, 200);
    return { ok: true, sent: 1, closed: true };
  } });
});

test('actual self @ retains direct priority and prompt speaker attribution even after other-bot history', () => {
  const prompts = [];
  return fixture(async ({ h }) => {
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    h.socialV2.paused = true;
    await h.handleIncoming('group', 456, event(40, [at('888'), text('I am the whale; low-energy mode is still the whale.')], {
      user_id: 888, sender: { nickname: 'other whale bot', user_id: 888 },
    }), h.cfg);
    h.recordSentMessagesV2(GROUP, ['OLD_PERSONA: an obsolete previous bot output.']);
    const historyBefore = JSON.stringify(st.recentMessages);
    const roleBefore = fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8');
    const cardBefore = fs.readFileSync(path.join(h.temp, 'roles', ROLE + '.md'), 'utf8');
    const preferences = savedPreferences(st);
    h.socialV2.paused = false;
    await h.handleIncoming('group', 456, event(41, [at('999'), text('Answer using your current selected character.')]), h.cfg);
    await until(() => prompts.length === 1, 'self-directed @ did not wake');
    await until(() => h.directTurnControllers.size === 0, 'self-directed turn did not close');
    assert.equal(st.lastWakeReason, 'atMention');
    assert.match(prompts[0], /\[ACTIVE_PERSONA\]/);
    assert.match(prompts[0], /currently selected persona is fixture-gentle/);
    assert.match(prompts[0], /CORE_IDENTITY/);
    assert.match(prompts[0], /only isSelf=true marks this bot's previous output/);
    assert.match(prompts[0], /Other users or bots speaking in first person/);
    assert.match(prompts[0], /(?:Performance|runtime|low.power).*(?:identity|character)/i);
    assert.equal(fs.readFileSync(path.join(h.temp, 'state/current-role.json'), 'utf8'), roleBefore);
    assert.equal(fs.readFileSync(path.join(h.temp, 'roles', ROLE + '.md'), 'utf8'), cardBefore);
    assert.equal(savedPreferences(st), preferences);
    assert.equal(JSON.stringify(st.recentMessages.slice(0, -1)), historyBefore, 'new attribution must not rewrite old history');
  }, { directTurn: async ({ options, h, request, key }) => {
    prompts.push(options.systemPrompt);
    options.onContextSent();
    assert.equal((await request('mark-read', { key, agent: true,
      body: { throughSeq: h.readThroughSeqV2(h.getSocialV2State(key)) } })).status, 200);
    return { ok: true, sent: 0, closed: true };
  } });
});

test('private conversations keep their quick no-at reply behavior and independent quota profile', () => {
  const turns = [];
  return fixture(async ({ h }) => {
    const timing = resolveConversationTiming(h.cfg, PRIVATE);
    assert.equal(timing.fastPrivate, true);
    assert.equal(timing.alwaysAwake, undefined);
    assert.equal(timing.batchMs, 700);
    assert.equal(timing.maxWakePerMinute, 30);
    assert.equal(timing.maxWakePerHour, 360);
    await h.handleIncoming('private', 123, event(50, [text('complete private fixture request')], {
      message_type: 'private', group_id: undefined, user_id: 123,
    }), h.cfg);
    await until(() => turns.length === 1, 'private request stopped replying without @');
    await until(() => h.directTurnControllers.size === 0, 'private fixture did not close');
    assert.equal(turns[0].key, PRIVATE);
    assert.match(turns[0].systemPrompt, /PRIVATE_REPLY_POLICY/);
    assert.doesNotMatch(turns[0].systemPrompt, /GROUP_ALWAYS_AWAKE_POLICY|GROUP_MENTION_ONLY/);
    assert.equal(h.getSocialV2State(PRIVATE).unread.length, 0);
    assert.equal(h.calls.http.length, 1);
  }, { directTurn: async ({ options, h, request, key }) => {
    turns.push({ key, systemPrompt: options.systemPrompt });
    options.onContextSent();
    assert.equal((await request('send-message', { key, agent: true,
      body: { messages: ['fixture private answer'] } })).status, 200);
    assert.equal((await request('mark-read', { key, agent: true,
      body: { throughSeq: h.readThroughSeqV2(h.getSocialV2State(key)) } })).status, 200);
    return { ok: true, sent: 1, closed: true };
  } });
});

test('mixed batch keeps each addressee and source through snapshots, detail tools and observer prompts', () => {
  const observed = [];
  return fixture(async ({ h, request }) => {
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    await h.handleIncoming('group', 456, event(60, [at('888'), text('question to other bot')]), h.cfg);
    await delay(150);
    await h.handleIncoming('group', 456, event(61, [at('999'), text('question to this bot')]), h.cfg);
    assert.equal(st.pendingWakeReason, 'atMention');
    const packet = h.buildWakeSnapshotV2(GROUP);
    assertAttribution(packet.messages[0], { targets: ['888'], self: false, other: true, recipient: 'others' });
    assertAttribution(packet.messages[1], { targets: ['999'], self: true, other: false, recipient: 'self' });
    for (let seq = 1; seq <= 2; seq++) {
      const detail = await request('message-detail', { key: GROUP, agent: true, query: { messageId: String(seq) } });
      assert.equal(detail.status, 200);
      assertAttribution(detail.data.info, seq === 1 ? { targets: ['888'], self: false, other: true, recipient: 'others' }
        : { targets: ['999'], self: true, other: false, recipient: 'self' });
      assert.equal(detail.data.info.isSelf, false, 'detail attribution uses the stored host speaker identity');
    }
    await until(() => observed.length === 1, 'mixed batch did not start once');
    await until(() => h.directTurnControllers.size === 0, 'mixed batch did not close');
    assert.equal(st.lastWakeReason, 'atMention');
    assert.match(observed[0], /In a mixed batch/);
    assert.match(observed[0], /own observer opinions such as "I think" remain allowed/);
    assert.match(observed[0], /If recipient=others \(only other accounts are addressed\)/);
    assert.match(observed[0], /Your own "I think" opinions remain allowed; mixed @self\+@other requests can be answered as yourself/);
    assert.match(observed[0], /NOT an only-@ reply restriction/);
    assert.equal(st.unread.length, 0);
  }, { directTurn: async ({ options, h, request, key }) => {
    observed.push(options.systemPrompt);
    options.onContextSent();
    assert.equal((await request('mark-read', { key, agent: true,
      body: { throughSeq: h.readThroughSeqV2(h.getSocialV2State(key)) } })).status, 200);
    return { ok: true, sent: 0, closed: true };
  } });
});

test('other-directed current @ takes precedence over a quote-to-self and preserves verified quote sources', () => {
  const prompts = [];
  return fixture(async ({ h }) => {
    h.bot.getMessage = async messageId => ({ group_id: 456, user_id: 999,
      sender: { user_id: 999, nickname: 'quoted host bot' }, message_id: messageId,
      message: [text('historical host output')] });
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    await h.handleIncoming('group', 456, event(70, [{ type: 'reply', data: { id: '700' } }, at('888'),
      text('fixture whale, what do you think about this old reply?')]), h.cfg);
    assert.equal(st.unread[0].quoteTargetIsSelf, true);
    assertAttribution(st.unread[0], { targets: ['888'], self: false, other: true, recipient: 'others' });
    assert.equal(st.unread[0].quoteSources[0].userId, '999');
    await until(() => prompts.length === 1, 'quote+other-directed message did not get its voluntary observer turn');
    await until(() => h.directTurnControllers.size === 0, 'quote+other-directed observer turn did not close');
    assert.equal(st.lastWakeReason, 'anyMessage', 'quote-to-self must not steal current explicit other recipient priority');
    assert.match(prompts[0], /recipient=others takes precedence over a quote-to-self/);
  }, { directTurn: async ({ options, h, request, key }) => {
    prompts.push(options.systemPrompt);
    options.onContextSent();
    assert.equal((await request('mark-read', { key, agent: true,
      body: { throughSeq: h.readThroughSeqV2(h.getSocialV2State(key)) } })).status, 200);
    return { ok: true, sent: 0, closed: true };
  } });
});

test('legacy unknown addressing remains unknown; broadcast and each wake include attribution guidance', () => fixture(async ({ h }) => {
  h.appendSocialV2Message(GROUP, 'legacy speaker', 'old record without addressing', 'old record without addressing',
    false, false, '80', [], '124', []);
  const st = h.getSocialV2State(GROUP);
  const old = JSON.stringify(st.unread[0]);
  h.socialV2.paused = true;
  await h.handleIncoming('group', 456, event(81, [at('all'), text('ordinary group broadcast')]), h.cfg);
  assertAttribution(st.unread.at(-1), { targets: ['all'], self: false, other: false, all: true, recipient: 'broadcast' });
  assert.equal(st.unread[0].recipient, undefined, 'old records must not gain invented attribution');
  assert.equal(st.unread[0].mentionedSelf, undefined);
  assert.equal(JSON.stringify(st.unread[0]), old);
  const packet = h.buildWakeSnapshotV2(GROUP);
  assert.equal(packet.messages[0].recipient, undefined);
  assert.equal(packet.messages[0].mentionedSelf, undefined);
  assert.equal(packet.messages[1].mentionedSelf, false);
  const prompt = h.buildWakePromptV2(GROUP, 'anyMessage');
  assert.match(prompt, /\[MESSAGE_ATTRIBUTION\]/);
  assert.match(prompt, /Missing metadata or recipient=unknown in old records is unknown/);
  assert.match(prompt, /broadcast is for the group, not an exclusive call to you/);
  assert.match(prompt, /NOT an only-@ reply restriction/);
}));

test('a self @ beyond the bounded 64-target display still has correct mixed recipient and direct wake priority', () => {
  const turns = [];
  return fixture(async ({ h, request }) => {
    const st = h.getSocialV2State(GROUP);
    st.bootstrapSent = true;
    const firstTargets = Array.from({ length: 64 }, (_, index) => String(1000 + index));
    await h.handleIncoming('group', 456, event(90, [...firstTargets.map(at), at('999'), text('addressed request with long target list')]), h.cfg);
    const stored = st.unread[0];
    assertAttribution(stored, { targets: firstTargets, self: true, other: true, recipient: 'mixed' });
    assert.equal(stored.atTargetsTruncated, true);
    assert.equal(stored.atTargetQQ.includes('999'), false, 'fixture puts actual self target outside displayed prefix');
    const packet = h.buildWakeSnapshotV2(GROUP);
    assert.equal(packet.messages[0].mentionedSelf, true);
    assert.equal(packet.messages[0].recipient, 'mixed');
    assert.equal(packet.messages[0].atTargetsTruncated, true);
    const detail = await request('message-detail', { key: GROUP, agent: true, query: { messageId: '1' } });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.info.mentionedSelf, true);
    assert.equal(detail.data.info.atTargetsTruncated, true);
    assert.equal(detail.data.info.recipient, 'mixed');
    await until(() => turns.length === 1, 'self target beyond display cap did not start a turn');
    await until(() => h.directTurnControllers.size === 0, 'long-target addressed request did not close');
    assert.equal(st.lastWakeReason, 'atMention', 'display cap must not erase real self addressing');
  }, { directTurn: async ({ options, h, request, key }) => {
    turns.push(options.systemPrompt);
    assert.match(options.systemPrompt, /mixed @self\+@other requests can be answered as yourself/);
    options.onContextSent();
    assert.equal((await request('mark-read', { key, agent: true,
      body: { throughSeq: h.readThroughSeqV2(h.getSocialV2State(key)) } })).status, 200);
    return { ok: true, sent: 0, closed: true };
  } });
});

test('other-directed identity questions never inject the direct-caller hint and anti-repeat guidance preserves sources', () => fixture(async ({ h }) => {
  h.socialV2.paused = true;
  const st = h.getSocialV2State(GROUP);
  st.bootstrapSent = true;
  h.recordSentMessagesV2(GROUP, ['I am busy eating rice.']);
  await h.handleIncoming('group', 456, event(100, [at('888'), text('\u4f60\u662f\u8c01\uff1f\u4f60\u662f\u4e0d\u662f\u5c0f\u9cb8\u9c7c\uff1f')]), h.cfg);
  await h.handleIncoming('group', 456, event(101, [text('otherbot: I am busy and cannot destroy anything.')]), h.cfg);
  const prompt = h.buildWakePromptV2(GROUP, 'anyMessage');
  assert.doesNotMatch(prompt, /\u6709\u4eba\u76f4\u63a5\u627e\u4f60/, 'a question sent to another bot must not masquerade as calling this bot');
  assert.match(prompt, /A member writing "name: I \.\.\." is reporting that named speaker, not continuing your own turn/);
  assert.match(prompt, /compare with recent isSelf=true outputs and earlier sends in this turn/);
  assert.match(prompt, /no new substantive request, close without sending a paraphrase/);
  assert.match(prompt, /messages are current unread; recent is historical context, not a fresh request/);
  assert.match(prompt, /Do not split one answer into consecutive messages that repeat the same point/);
  assert.match(prompt, /A new wake is not a new request/);
  assert.match(prompt, /NOT an only-@ reply restriction/);
  const packet = h.buildWakeSnapshotV2(GROUP);
  assert.equal(packet.messages[0].recipient, 'others');
  assert.equal(packet.messages[1].sender, 'fixture member');
  assert.notEqual(packet.messages[1].isSelf, true);
  assert.ok(packet.recent.some(message => message.isSelf === true), 'anti-repeat policy has the actual previous host output as historical context');
  assert.equal(st.unread.length, 2, 'prompt guidance must not mutate or hide sources');
}));
