// Real bridge storage, snapshot, and HTTP integration against isolated peers/files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const OTHER_GROUP = 'group:457';
const PRIVATE = 'private:123';
const plain = value => JSON.parse(JSON.stringify(value));
const seqs = list => Array.from(list, message => message.seq);
const text = value => ({ type: 'text', data: { text: value } });
const at = qq => ({ type: 'at', data: { qq } });
const groupEvent = (id, segments, userId = 124) => ({ message_type: 'group', group_id: 456,
  user_id: userId, self_id: 999, message_id: id, sender: { user_id: userId, nickname: `member-${userId}` }, message: segments });

async function fixture(run, { context = {}, files = {}, startServer = true } = {}) {
  let forbiddenCalls = 0;
  const h = await bridgeHarness({ config: {
    engine: { backend: 'standalone' }, allow: { groups: ['456', '457'], private: ['123', '124'] },
    socialV2: { context, wake: { alwaysAwake: true }, proactive: { enabled: false }, sticker: { enabled: false } },
  }, files, globals: {
    getEngineStatus: () => ({ ready: true, secret: { source: 'fixture' } }),
    resolveEngineDirectConfig: () => ({ model: 'fixture', provider: 'fixture', apiKey: 'fixture-only',
      baseURL: 'https://provider.invalid/v1', webSearch: false, vision: false }),
    createDirectToolSession: async () => { forbiddenCalls++; throw new Error('Provider/tool initialization forbidden in this test.'); },
    runDirectTurn: async () => { forbiddenCalls++; throw new Error('Model call forbidden in this test.'); },
  } });
  h.setMode('reserved2');
  h.setSelfIdentity('fixture-bot', 999);
  // Input parsing and host memory remain real; pausing prevents paid turns/send paths.
  h.socialV2.paused = true;
  const server = startServer ? h.startConsoleServer() : null;
  if (server && !server.listening) await new Promise(resolve => server.once('listening', resolve));
  const request = (route, { key = GROUP, body, agent = false, headers = {}, query = {} } = {}) => new Promise((resolve, reject) => {
    assert.ok(server, 'This fixture needs a local API server.');
    const params = new URLSearchParams({ ...(body === undefined && key ? { key } : {}), ...query });
    const endpoint = route.startsWith('/') ? route : '/api/socialV2/' + route;
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: endpoint + (params.size ? '?' + params.toString() : ''), method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        ...(agent ? { 'x-agent-token': h.getSocialV2State(key).agentToken } : {}), ...headers } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Fixture API timeout.')));
    req.end(body === undefined ? undefined : JSON.stringify({ ...(key ? { key } : {}), ...body }));
  });
  const append = (content, { key = GROUP, userId = 124, sender = `member-${userId}`, own = content,
    id = `fixture-${h.getSocialV2State(key).lastUnreadSeq + 1}`, attribution = {} } = {}) => {
    h.appendSocialV2Message(key, sender, content, own, false, false, id, [], userId, [], attribution);
    return h.getSocialV2State(key).lastUnreadSeq;
  };
  const markRead = async (key = GROUP) => {
    // Administrative browsing is deliberately used here, not an invented model receipt.
    const result = await request('mark-read', { key, body: {} });
    assert.equal(result.status, 200);
    assert.equal(h.getSocialV2State(key).unread.length, 0);
  };
  const getMemory = async (key = GROUP) => {
    const result = await request('memory', { key });
    assert.equal(result.status, 200);
    assert.ok(result.data.raw.conversationMemory);
    return result.data.raw.conversationMemory;
  };
  try {
    await run({ h, request, append, markRead, getMemory });
    assert.equal(forbiddenCalls, 0, 'Memory/context operations must not invoke any model/tool provider.');
    assert.equal(h.calls.sent.length, 0, 'This test must not send QQ messages.');
    assert.equal(h.calls.prompts.length, 0, 'This test must not invoke a DSH model.');
  } finally {
    for (const controller of h.directTurnControllers.values()) controller.abort();
    if (server) await new Promise(resolve => server.close(resolve));
    await h.close();
  }
}

test('default wake snapshot has twenty chronological historical messages, not legacy four', () => fixture(async ({ h, append, markRead }) => {
  for (let i = 1; i <= 25; i++) append(`history-${i}`);
  await markRead();
  append('current message');
  const snapshot = h.buildWakeSnapshotV2(GROUP);
  assert.equal(h.cfg.socialV2.context.contextWindow, 20);
  assert.equal(h.cfg.socialV2.context.wakeMaxChars, 12000);
  assert.deepEqual(seqs(snapshot.messages), [26]);
  assert.deepEqual(seqs(snapshot.recent), Array.from({ length: 20 }, (_, index) => index + 6));
  assert.equal(snapshot.partial, false);
  assert.equal(snapshot.readThroughSeq, 26);
  assert.ok(JSON.stringify(snapshot).length <= 12000);
}, { context: { wakeRecentLimit: 4 } }));

test('context API changes affect next snapshot without overriding explicit inline=false', () => fixture(async ({ h, append, markRead, request }) => {
  for (let i = 1; i <= 25; i++) append(`history-${i}`);
  await markRead();
  append('new unread');
  let response = await request('config', { body: { context: { contextWindow: 7 } } });
  assert.equal(response.status, 200);
  assert.equal(h.cfg.socialV2.context.contextWindow, 7);
  assert.deepEqual(seqs(h.buildWakeSnapshotV2(GROUP).recent), [19, 20, 21, 22, 23, 24, 25]);
  response = await request('config', { body: { context: { inlineWakeMessages: false } } });
  assert.equal(response.status, 200);
  assert.equal(h.buildWakeSnapshotV2(GROUP), null);
  response = await request('config', { body: { context: { contextWindow: 10 } } });
  assert.equal(response.status, 200);
  assert.equal(h.cfg.socialV2.context.inlineWakeMessages, false);
  assert.equal(h.buildWakeSnapshotV2(GROUP), null);
  const config = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
  assert.equal(config.socialV2.context.inlineWakeMessages, false);
}));

test('startup and live API context settings clamp large, negative, and non-numeric values', () => fixture(async ({ h, request }) => {
  assert.equal(h.cfg.socialV2.context.contextWindow, 100);
  assert.equal(h.cfg.socialV2.context.recentLimit, 100);
  assert.equal(h.cfg.socialV2.context.unreadLimit, 100);
  assert.equal(h.cfg.socialV2.context.wakeMaxChars, 20000);
  assert.equal(h.cfg.socialV2.context.messageMaxChars, 12000);
  assert.equal(h.cfg.socialV2.context.wakeMessageLimit, 1);
  assert.equal(h.cfg.socialV2.context.wakeRecentLimit, undefined);
  let response = await request('config', { body: { context: { contextWindow: -8, recentLimit: -1,
    unreadLimit: -1, wakeMessageLimit: -1, wakeMaxChars: -1, messageMaxChars: -1 } } });
  assert.equal(response.status, 200);
  assert.equal(h.cfg.socialV2.context.contextWindow, 1);
  assert.equal(h.cfg.socialV2.context.recentLimit, 20);
  assert.equal(h.cfg.socialV2.context.unreadLimit, 1);
  assert.equal(h.cfg.socialV2.context.wakeMessageLimit, 1);
  assert.equal(h.cfg.socialV2.context.wakeMaxChars, 500);
  assert.equal(h.cfg.socialV2.context.messageMaxChars, 200);
  response = await request('config', { body: { context: { contextWindow: 'nope', recentLimit: 'nope',
    unreadLimit: 'nope', wakeMessageLimit: 'nope', wakeMaxChars: 'nope', messageMaxChars: 'nope' } } });
  assert.equal(response.status, 200);
  assert.equal(h.cfg.socialV2.context.contextWindow, 20);
  assert.equal(h.cfg.socialV2.context.recentLimit, 100);
  assert.equal(h.cfg.socialV2.context.unreadLimit, 30);
  assert.equal(h.cfg.socialV2.context.wakeMessageLimit, 12);
  assert.equal(h.cfg.socialV2.context.wakeMaxChars, 12000);
  assert.equal(h.cfg.socialV2.context.messageMaxChars, 4000);
}, { context: { contextWindow: 999999, recentLimit: 0, unreadLimit: 999999, wakeMaxChars: 999999,
  messageMaxChars: 999999, wakeMessageLimit: -30, wakeRecentLimit: 4 } }));

const longMessage = 'HEAD-'.padEnd(2100, 'a') + 'MIDDLE-IMPORTANT-'.padEnd(1895, 'b') + '-TAIL';
assert.equal(longMessage.length, 4000);
test('incoming and sent four-thousand-character text retains the middle and persists exactly', () => fixture(async ({ h, append, request }) => {
  append(longMessage);
  const st = h.getSocialV2State(GROUP);
  assert.equal(st.unread[0].text, longMessage);
  assert.equal(st.unread[0].plain, longMessage);
  assert.ok(st.unread[0].text.includes('MIDDLE-IMPORTANT-'));
  const recent = await request('recent');
  assert.equal(recent.status, 200);
  assert.equal(recent.data.messages[0].text, longMessage);
  const snapshot = h.buildWakeSnapshotV2(GROUP);
  assert.equal(snapshot.messages[0].text, longMessage);
  h.recordSentMessagesV2(GROUP, [longMessage]);
  const sent = st.recentMessages.find(message => message.isSelf);
  assert.equal(sent.text, longMessage);
  assert.equal(sent.plain, longMessage);
  const stored = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8')).conversations[GROUP];
  assert.equal(stored.unread[0].text, longMessage);
  assert.equal(stored.recentMessages.find(message => message.isSelf).text, longMessage);
}));

test('overall twelve-thousand-character snapshot budget does not mutilate historical or unread text', () => fixture(async ({ h, append, markRead }) => {
  for (let i = 0; i < 8; i++) append(longMessage);
  await markRead();
  append(longMessage);
  const before = plain(h.getSocialV2State(GROUP));
  const snapshot = h.buildWakeSnapshotV2(GROUP);
  assert.ok(JSON.stringify(snapshot).length <= 12000);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].text, longMessage);
  assert.ok(snapshot.recent.length < 8, 'Character budget must take precedence over the twenty-message count.');
  for (const message of snapshot.recent) assert.equal(message.text, longMessage);
  assert.deepEqual(plain(h.getSocialV2State(GROUP).recentMessages), before.recentMessages);
  assert.deepEqual(plain(h.getSocialV2State(GROUP).unread), before.unread);
}));

test('too-large oldest unread cannot be skipped or marked read by a budgeted snapshot', () => fixture(async ({ h, append }) => {
  append(longMessage); append('later small question');
  const before = plain(h.getSocialV2State(GROUP).unread);
  const snapshot = h.buildWakeSnapshotV2(GROUP);
  assert.equal(snapshot.messages.length, 0);
  assert.equal(snapshot.partial, true);
  assert.equal(snapshot.readThroughSeq, 0);
  assert.ok(JSON.stringify(snapshot).length <= 500);
  assert.deepEqual(plain(h.getSocialV2State(GROUP).unread), before);
}, { context: { wakeMaxChars: 500 } }));

test('explicit current private/group memory respects actual recipient and quote authorship', () => fixture(async ({ h, getMemory }) => {
  await h.handleIncoming('private', 123, { message_type: 'private', user_id: 123, self_id: 999,
    message_id: 1, message: [text('记住：我的项目叫 PRIVATE-ALPHA。')] }, h.cfg);
  assert.ok((await getMemory(PRIVATE)).facts.some(fact => fact.text.includes('PRIVATE-ALPHA') && fact.userId === '123'));
  await h.handleIncoming('group', 456, groupEvent(2, [at('999'), text('记住：我偏好 GROUP-BETA。')]), h.cfg);
  await h.handleIncoming('group', 456, groupEvent(3, [at('222'), text('记住：NOT-YOUR-FACT。')]), h.cfg);
  await h.handleIncoming('group', 456, groupEvent(4, [at('all'), text('记住：BROADCAST-NOT-A-FACT。')]), h.cfg);
  await h.handleIncoming('group', 456, groupEvent(5, [at('999'), at('222'), text('记住：MIXED-NOT-A-FACT。')]), h.cfg);
  await h.handleIncoming('group', 456, groupEvent(51, [text('记住：DIRECT-NO-AT-FACT。')]), h.cfg);
  const facts = (await getMemory()).facts;
  assert.ok(facts.some(fact => fact.text.includes('GROUP-BETA') && fact.userId === '124'));
  assert.ok(facts.some(fact => fact.text.includes('DIRECT-NO-AT-FACT') && fact.userId === '124'));
  assert.ok(!JSON.stringify(facts).includes('NOT-YOUR-FACT'));
  assert.ok(!JSON.stringify(facts).includes('BROADCAST-NOT-A-FACT'));
  assert.ok(!JSON.stringify(facts).includes('MIXED-NOT-A-FACT'));
  // The actual quote resolver is mocked only at the gateway boundary, not in memory logic.
  h.bot.getMessage = async () => ({ group_id: 456, user_id: 222, sender: { user_id: 222, nickname: 'quoted-other' },
    message: [text('记住：QUOTED-OTHER-PRIVATE。')] });
  await h.handleIncoming('group', 456, groupEvent(6, [{ type: 'reply', data: { id: '300' } }, at('999'), text('这个怎么看？')]), h.cfg);
  assert.ok(!JSON.stringify((await getMemory()).facts).includes('QUOTED-OTHER-PRIVATE'));
  h.recordSentMessagesV2(GROUP, ['记住：BOT-OUTPUT-NOT-A-FACT。']);
  assert.ok(!JSON.stringify((await getMemory()).facts).includes('BOT-OUTPUT-NOT-A-FACT'));
}));

test('remember and forget are per-sender and per-conversation, not a global shared identity', () => fixture(async ({ h, getMemory }) => {
  await h.handleIncoming('group', 456, groupEvent(10, [at('999'), text('记住：SENDER-A-FACT。')], 124), h.cfg);
  await h.handleIncoming('group', 456, groupEvent(11, [at('999'), text('记住：SENDER-B-FACT。')], 125), h.cfg);
  await h.handleIncoming('private', 123, { message_type: 'private', user_id: 123, self_id: 999,
    message_id: 12, message: [text('记住：SEPARATE-PRIVATE-FACT。')] }, h.cfg);
  await h.handleIncoming('group', 456, groupEvent(13, [at('999'), text('忘记：SENDER-A-FACT。')], 124), h.cfg);
  const groupMemory = await getMemory();
  assert.ok(!groupMemory.facts.some(fact => fact.userId === '124'));
  assert.ok(groupMemory.facts.some(fact => fact.userId === '125' && fact.text.includes('SENDER-B-FACT')));
  assert.ok((await getMemory(PRIVATE)).facts.some(fact => fact.text.includes('SEPARATE-PRIVATE-FACT')));
  assert.ok(!h.buildWakePromptV2(GROUP, 'admin').includes('SEPARATE-PRIVATE-FACT'));
  assert.ok(!h.buildWakePromptV2(PRIVATE, 'admin').includes('SENDER-B-FACT'));
}));

test('admin memory edit/remove/clear is scoped; agent requests cannot mutate it', () => fixture(async ({ h, request, getMemory }) => {
  const upsert = async (key, content, userId = '124') => {
    const result = await request('conversation-memory', { key, body: { action: 'upsert', category: 'fact',
      text: content, sender: `member-${userId}`, userId } });
    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);
    return (await getMemory(key)).facts.find(fact => fact.text === content).id;
  };
  const factA = await upsert(GROUP, 'GROUP-ADMIN-FACT');
  const factB = await upsert(GROUP, 'GROUP-OTHER-SENDER', '125');
  await upsert(PRIVATE, 'PRIVATE-ADMIN-FACT', '123');
  const privateBefore = plain(await getMemory(PRIVATE));
  const groupBefore = plain(await getMemory());
  for (const headers of [{ 'x-agent-token': h.getSocialV2State(GROUP).agentToken },
    { 'x-agent-token': h.getSocialV2State(GROUP).agentToken, 'x-agent-call': '1' }, { 'x-agent-call': '1' }]) {
    for (const action of ['upsert', 'remove', 'clear']) {
      const result = await request('conversation-memory', { headers, body: { action, category: 'all', id: factA,
        text: 'UNAUTHORIZED-FACT', sender: 'member-124', userId: '124' } });
      assert.equal(result.status, 403, `${JSON.stringify(headers)} ${action}`);
    }
  }
  assert.deepEqual(await getMemory(), groupBefore);
  assert.deepEqual(await getMemory(PRIVATE), privateBefore);
  let result = await request('conversation-memory', { body: { action: 'upsert', category: 'fact', id: factA,
    text: 'GROUP-ADMIN-EDITED', sender: 'wrong-sender', userId: '99999' } });
  assert.equal(result.status, 200);
  const edited = (await getMemory()).facts.find(fact => fact.id === factA);
  assert.equal(edited.text, 'GROUP-ADMIN-EDITED');
  assert.equal(edited.userId, '124', 'An edit must retain the original attribution.');
  result = await request('conversation-memory', { body: { action: 'remove', category: 'fact', id: factA } });
  assert.equal(result.status, 200);
  assert.ok(!(await getMemory()).facts.some(fact => fact.id === factA));
  assert.ok((await getMemory()).facts.some(fact => fact.id === factB));
  assert.deepEqual(await getMemory(PRIVATE), privateBefore);
  result = await request('conversation-memory', { body: { action: 'clear', category: 'all' } });
  assert.equal(result.status, 200);
  assert.deepEqual((await getMemory()).facts, []);
  assert.deepEqual((await getMemory()).archive, []);
  assert.deepEqual(await getMemory(PRIVATE), privateBefore);
}));

test('legacy agent memory-clear cannot bypass admin-only host durable-memory management', () => fixture(async ({ h, request, getMemory }) => {
  const created = await request('conversation-memory', { body: { action: 'upsert', category: 'fact',
    text: 'HOST-PROTECTED-DURABLE-FACT', sender: 'member-124', userId: '124' } });
  assert.equal(created.status, 200);
  const before = plain(await getMemory());
  h.socialV2.paused = false;
  const result = await request('memory-clear', { agent: true, body: {} });
  assert.equal(result.status, 200, 'Legacy agent memory API may clear only the old agent-authored categories.');
  assert.deepEqual(await getMemory(), before, 'Host durable fact/archive store remains admin managed.');
}));

test('durable-memory write failure returns an error and restores only the in-memory edit', () => fixture(async ({ h, request, getMemory }) => {
  const created = await request('conversation-memory', { body: { action: 'upsert', category: 'fact',
    text: 'PRESERVED-FACT-BEFORE-WRITE-FAILURE', sender: 'member-124', userId: '124' } });
  assert.equal(created.status, 200);
  const memoryBefore = plain(await getMemory());
  const configPath = path.join(h.temp, 'config.json');
  const rolePath = path.join(h.temp, 'state/current-role.json');
  const roleBefore = fs.existsSync(rolePath) ? fs.readFileSync(rolePath) : null;
  const configBefore = fs.readFileSync(configPath);
  const statePath = path.join(h.temp, 'state/social-v2.json');
  assert.ok(path.resolve(statePath).startsWith(path.resolve(h.temp) + path.sep));
  assert.equal(fs.lstatSync(statePath).isFile(), true);
  // Rename just this fixture's state file; a directory in its place makes atomic replacement fail.
  fs.renameSync(statePath, path.join(h.temp, 'state/social-v2.before-write-failure.json'));
  fs.mkdirSync(statePath);
  const result = await request('conversation-memory', { body: { action: 'upsert', category: 'fact',
    text: 'UNSAVED-FACT-MUST-NOT-APPEAR', sender: 'member-124', userId: '124' } });
  assert.equal(result.status, 500);
  assert.equal(result.data.ok, false);
  assert.deepEqual(await getMemory(), memoryBefore);
  assert.deepEqual(fs.readFileSync(configPath), configBefore);
  assert.equal(fs.existsSync(rolePath), roleBefore !== null);
  if (roleBefore !== null) assert.deepEqual(fs.readFileSync(rolePath), roleBefore);
  assert.equal(fs.lstatSync(statePath).isDirectory(), true, 'Failure must not delete or replace an unrelated blocking path.');
}));

test('cleared archive does not regenerate from old buffered history and its cutoff survives restart', () => fixture(async ({ h, request, append, markRead, getMemory }) => {
  append('CLEAR-ARCHIVE-OLD-EXCERPT');
  await markRead();
  for (let i = 0; i < 20; i++) append(`old-buffer-${i}`);
  assert.ok((await getMemory()).archive.some(entry => entry.text.includes('CLEAR-ARCHIVE-OLD-EXCERPT')));
  let result = await request('conversation-memory', { body: { action: 'clear', category: 'archive' } });
  assert.equal(result.status, 200);
  const cutoff = h.getSocialV2State(GROUP).archiveClearedBefore;
  assert.ok(cutoff > 0);
  assert.deepEqual((await getMemory()).archive, []);
  await markRead();
  for (let i = 0; i < 22; i++) append(`new-after-clear-${i}`);
  await markRead();
  assert.ok(!(await getMemory()).archive.some(entry => entry.text.includes('CLEAR-ARCHIVE-OLD-EXCERPT')));
  const persisted = fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8');
  assert.equal(JSON.parse(persisted).conversations[GROUP].archiveClearedBefore, cutoff);
  await fixture(async ({ h: resumed, append: add, markRead: read, getMemory: get }) => {
    assert.equal(resumed.getSocialV2State(GROUP).archiveClearedBefore, cutoff);
    for (let i = 0; i < 22; i++) add(`after-restart-${i}`);
    await read();
    assert.ok(!(await get()).archive.some(entry => entry.text.includes('CLEAR-ARCHIVE-OLD-EXCERPT')));
  }, { files: { 'state/social-v2.json': persisted } });
  result = await request('memory-clear', { body: {} });
  assert.equal(result.status, 200);
  assert.deepEqual((await getMemory()).archive, []);
  assert.ok(h.getSocialV2State(GROUP).archiveClearedBefore >= cutoff);
}));

test('mark-read catches up a message that crossed the context window while still unread', () => fixture(async ({ append, markRead, getMemory }) => {
  append('LATE-READ-ARCHIVE-EXCERPT');
  for (let i = 0; i < 20; i++) append(`unread-crossing-${i}`);
  assert.ok(!(await getMemory()).archive.some(entry => entry.text.includes('LATE-READ-ARCHIVE-EXCERPT')),
    'Unread border message is not prematurely archived as observed context.');
  await markRead();
  assert.ok((await getMemory()).archive.some(entry => entry.text.includes('LATE-READ-ARCHIVE-EXCERPT')),
    'Safe acknowledgement must catch up read history outside the active window.');
}));

test('memory endpoint rejects invalid inputs atomically, with no cross-key file or prototype injection', () => fixture(async ({ request, getMemory }) => {
  const before = plain(await getMemory());
  const cases = [{ key: '../outside', action: 'upsert', text: 'NO' }, { key: 'group:0', action: 'clear', category: 'all' },
    { action: 'not-real', category: 'fact', text: 'NO' }, { action: 'upsert', category: 'not-real', text: 'NO' },
    { action: 'upsert', category: 'fact', text: 'x'.repeat(501) }, { action: 'upsert', category: 'fact', text: {} },
    { action: 'upsert', category: 'fact', text: '' }];
  for (const body of cases) {
    const result = await request('conversation-memory', { body });
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.deepEqual(await getMemory(), before);
  }
}));

test('read history leaving the model window is archived before storage eviction and survives restart', () => fixture(async ({ h, request, append, markRead, getMemory }) => {
  const savedFact = await request('conversation-memory', { body: { action: 'upsert', category: 'fact',
    text: 'PERSISTED-GROUP-FACT', sender: 'member-124', userId: '124' } });
  assert.equal(savedFact.status, 200);
  append('ARCHIVE-ORIGINAL-PHRASE from the actual member.', { attribution: { recipient: 'others',
    atTargetQQ: ['222'], mentionedSelf: false, mentionedOther: true } });
  await markRead();
  for (let i = 0; i < 20; i++) append(`new-line-${i}`);
  const memory = await getMemory();
  const archived = memory.archive.find(entry => entry.text.includes('ARCHIVE-ORIGINAL-PHRASE'));
  assert.ok(archived, 'A read message leaving contextWindow=20 must already retain a real historical excerpt.');
  assert.equal(archived.userId, '124');
  assert.equal(archived.recipient, 'others');
  assert.deepEqual(archived.atTargetQQ, ['222']);
  assert.ok(h.getSocialV2State(GROUP).recentMessages.some(message => message.text.includes('ARCHIVE-ORIGINAL-PHRASE')),
    'Memory must exist before the larger storage buffer evicts that message.');
  assert.ok(h.buildWakePromptV2(GROUP, 'admin').includes('PERSISTED-GROUP-FACT'));
  assert.ok(h.buildWakePromptV2(GROUP, 'admin').includes('ARCHIVE-ORIGINAL-PHRASE'));
  assert.ok(!h.buildWakePromptV2(OTHER_GROUP, 'admin').includes('ARCHIVE-ORIGINAL-PHRASE'));
  const persisted = fs.readFileSync(path.join(h.temp, 'state/social-v2.json'), 'utf8');
  const raw = JSON.parse(persisted).conversations[GROUP].conversationMemory;
  assert.deepEqual(raw, memory);
  await fixture(async ({ h: resumed, getMemory: readRestored }) => {
    const restored = await readRestored();
    assert.deepEqual(restored.facts, memory.facts);
    assert.deepEqual(restored.archive, memory.archive);
    assert.ok(resumed.buildWakePromptV2(GROUP, 'admin').includes('PERSISTED-GROUP-FACT'));
    assert.ok(!resumed.buildWakePromptV2(PRIVATE, 'admin').includes('PERSISTED-GROUP-FACT'));
  }, { files: { 'state/social-v2.json': persisted } });
}));
