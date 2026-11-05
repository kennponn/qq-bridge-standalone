// Offline regression tests. Never connect to production QQ, DSH or an LLM.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { runDirectTurn, normalizeDirectUsage } from '../src/direct-engine.js';
import { bindDirectTool, createDirectToolSession } from '../src/direct-tools.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let callId = 0;
const toolCall = (name, args = {}) => ({ id: `call-${++callId}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolMessage = (...calls) => ({ role: 'assistant', content: null, tool_calls: calls });
const textMessage = (content = '') => ({ role: 'assistant', content });
const tools = ['qq_send_message', 'qq_mark_read', 'qq_set_wake_config', 'qq_wait_for_messages', 'qq_get_unread_messages', 'qq_get_prompt', 'qq_get_message_images'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
const base = { model: 'fixture', apiKey: 'fixture-only', baseURL: 'https://model.invalid/v1', systemPrompt: 'Fixture system', promptText: 'Message snapshot', tools, hasSnapshot: true, maxRetries: 0 };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
function engine(replies, execute = async () => ({ ok: true }), options = {}) {
  const requests = [];
  const executed = [];
  let round = 0;
  return {
    requests, executed,
    run: () => runDirectTurn({
      ...base, ...options,
      executeTool: async (...args) => { executed.push({ name: args[0], args: args[1] }); return execute(...args); },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body), signal: init.signal });
        const reply = typeof replies === 'function' ? await replies(round++, init) : replies[round++];
        return reply instanceof Response ? reply : json({ choices: [{ message: reply }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
      }
    })
  };
}

test('usage normalizes cached tokens without double charging', () => {
  assert.deepEqual(normalizeDirectUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 }, completion_tokens_details: { reasoning_tokens: 5 } }), { cacheMiss: 70, cacheHit: 30, cacheWrite: 0, output: 20, reasoning: 5 });
});

test('pre-read includes actual messages and starts at the oldest unread cursor', async () => {
  const h = engine([toolMessage(toolCall('qq_mark_read', { throughSeq: 1 }))], async (name, args) => name === 'qq_get_unread_messages'
    ? { ok: true, messages: [{ seq: 1, text: 'UNREAD_BODY' }], readThroughSeq: 1 } : { ok: true }, { hasSnapshot: false });
  await h.run();
  assert.deepEqual(h.executed[0].args, { afterSeq: 0, limit: 30 });
  assert.match(JSON.stringify(h.requests[0].body.messages), /UNREAD_BODY/);
});

test('snapshot avoids a redundant unread query and authorizes visibility before tools', async () => {
  let visible = false;
  const h = engine([toolMessage(toolCall('qq_mark_read', { throughSeq: 12 }))], async () => { assert.ok(visible); return { ok: true }; }, { onContextSent: () => { visible = true; } });
  await h.run();
  assert.deepEqual(h.executed.map((call) => call.name), ['qq_mark_read']);
});

test('send does not acknowledge a new arrival or force a default wake configuration', async () => {
  const h = engine([toolMessage(toolCall('qq_send_message', { messages: ['reply'] })), toolMessage(toolCall('qq_mark_read', { throughSeq: 1 }))]);
  const result = await h.run();
  assert.equal(result.closed, true);
  assert.equal(result.sent, 1);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.executed.map((call) => call.name), ['qq_send_message', 'qq_mark_read']);
  assert.equal(h.executed[1].args.throughSeq, 1);
});

test('pre-sleep gate rejection is shown to the model; observation precedes a successful close', async () => {
  let observed = false;
  const h = engine([
    toolMessage(toolCall('qq_send_message', { messages: ['reply'] }), toolCall('qq_mark_read', { throughSeq: 1 })),
    toolMessage(toolCall('qq_wait_for_messages', { timeoutMs: 300000 })),
    toolMessage(toolCall('qq_set_wake_config', { throughSeq: 1, config: { mode: 'diving' } }))
  ], async (name) => {
    if (name === 'qq_wait_for_messages') { observed = true; return { ok: true, canSleepNow: true, readThroughSeq: 1 }; }
    if (name === 'qq_mark_read' && !observed) return { ok: false, error: 'observation required' };
    return { ok: true };
  });
  const result = await h.run();
  assert.equal(result.closed, true);
  assert.match(JSON.stringify(h.requests[1].body.messages), /ERROR:.*observation required/);
});

test('closing tools cannot omit throughSeq and clear unseen unread messages', async () => {
  const h = engine([toolMessage(toolCall('qq_mark_read')), toolMessage(toolCall('qq_mark_read', { throughSeq: 1 }))]);
  await h.run();
  assert.equal(h.executed.length, 1);
  assert.match(JSON.stringify(h.requests[1].body.messages), /explicit throughSeq/);
});

test('plain assistant commentary is private and is not forwarded', async () => {
  const h = engine([textMessage('INTERNAL_COMMENTARY'), toolMessage(toolCall('qq_mark_read', { throughSeq: 1 }))]);
  await h.run();
  assert.ok(!h.executed.some((call) => call.name === 'qq_send_message'));
});

test('silent turns cannot invoke a sending tool even if the model hallucinates it', async () => {
  const h = engine([toolMessage(toolCall('qq_send_message', { messages: ['do not send'] })), textMessage('private')], undefined, { silent: true });
  const result = await h.run();
  assert.equal(result.sent, 0);
  assert.equal(h.executed.length, 0);
  assert.ok(!h.requests[0].body.tools.some((tool) => tool.function.name === 'qq_send_message'));
});

test('round exhaustion is a failure with partial-send information', async () => {
  const h = engine(() => toolMessage(toolCall('qq_get_prompt')), undefined, { maxRounds: 2 });
  await assert.rejects(h.run(), (error) => error.message.includes('DIRECT_ROUND_LIMIT') && error.sentCount === 0);
});

test('HTTP 401 propagates and does not authorize the snapshot', async () => {
  let noted = false;
  const h = engine([json({ error: 'secret must not be logged' }, 401)], undefined, { onContextSent: () => { noted = true; } });
  await assert.rejects(h.run(), /HTTP 401/);
  assert.equal(noted, false);
  assert.equal(h.executed.length, 0);
});

test('transient HTTP retry does not replay previously executed sending tools', async () => {
  const h = engine([
    toolMessage(toolCall('qq_send_message', { messages: ['once'] })),
    json({}, 503),
    toolMessage(toolCall('qq_mark_read', { throughSeq: 1 }))
  ], undefined, { maxRetries: 1, sleepImpl: async () => {} });
  const result = await h.run();
  assert.equal(result.sent, 1);
  assert.equal(h.executed.filter((call) => call.name === 'qq_send_message').length, 1);
});

test('repeated send tool arguments in a turn are idempotent', async () => {
  const h = engine([
    toolMessage(toolCall('qq_send_message', { messages: ['once'] })),
    toolMessage(toolCall('qq_send_message', { messages: ['once'] }), toolCall('qq_mark_read', { throughSeq: 1 }))
  ]);
  const result = await h.run();
  assert.equal(result.sent, 1);
  assert.equal(h.executed.filter((call) => call.name === 'qq_send_message').length, 1);
});

test('an ambiguous transport failure does not allow the same send to execute twice', async () => {
  const h = engine([
    toolMessage(toolCall('qq_send_message', { messages: ['once'], atUserId: 123 })),
    toolMessage(toolCall('qq_send_message', { atUserId: 123, messages: ['once'] }), toolCall('qq_mark_read', { throughSeq: 1 })),
    toolMessage(toolCall('qq_mark_read', { throughSeq: 1 }))
  ], async (name) => { if (name === 'qq_send_message') throw new Error('connection closed after sending'); return { ok: true }; });
  await h.run();
  assert.equal(h.executed.filter((call) => call.name === 'qq_send_message').length, 1);
  assert.equal(h.executed.filter((call) => call.name === 'qq_mark_read').length, 1);
});

test('malformed model envelopes fail without executing tools', async () => {
  const h = engine([json({ choices: [] })]);
  await assert.rejects(h.run(), /malformed assistant/);
  assert.equal(h.executed.length, 0);
});

test('malformed JSON arguments never execute a tool', async () => {
  const bad = toolCall('qq_send_message');
  bad.function.arguments = '{bad json';
  const h = engine([toolMessage(bad), toolMessage(toolCall('qq_mark_read', { throughSeq: 1 }))]);
  await h.run();
  assert.equal(h.executed.length, 1);
});

test('all tool call IDs are validated before any side effect', async () => {
  const first = toolCall('qq_send_message', { messages: ['never'] });
  const h = engine([toolMessage(first, { ...first })]);
  await assert.rejects(h.run(), /duplicate tool call/);
  assert.equal(h.executed.length, 0);
});

test('session invalidation after inference blocks every sending tool', async () => {
  let valid = true;
  const h = engine(() => { valid = false; return toolMessage(toolCall('qq_send_message', { messages: ['stale'] })); }, undefined, { assertCurrent: () => { if (!valid) throw new Error('stale session'); } });
  await assert.rejects(h.run(), /stale session/);
  assert.equal(h.executed.length, 0);
});

test('turn deadline aborts a stalled model request', async () => {
  const h = engine((_, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })), undefined, { turnTimeoutMs: 30 });
  // Keep a fixture handle alive while the deliberately unref'd production timer runs.
  const keeper = setInterval(() => {}, 1000);
  try { await assert.rejects(h.run(), /turn deadline exceeded/); } finally { clearInterval(keeper); }
});

test('inline and tool images are translated to provider image_url content', async () => {
  const h = engine([toolMessage(toolCall('qq_get_message_images', { messageId: 1 })), toolMessage(toolCall('qq_mark_read', { throughSeq: 1 }))], async (name) => name === 'qq_get_message_images'
    ? { content: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] } : { ok: true },
  { content: [{ type: 'text', text: 'look' }, { type: 'image', mediaType: 'image/png', data: 'BB==' }] });
  await h.run();
  assert.match(JSON.stringify(h.requests[0].body.messages), /data:image\/png;base64,BB==/);
  assert.match(JSON.stringify(h.requests[1].body.messages), /data:image\/png;base64,AA==/);
});

test('tool schemas hide credentials and bind each execution to its conversation', () => {
  const bound = bindDirectTool({ name: 'qq_get_unread_messages', inputSchema: { type: 'object', properties: { key: { type: 'string' }, token: { type: 'string' }, afterSeq: { type: 'integer' } }, required: ['key', 'token'] } }, { key: 'group:456', agentToken: 'fixture-token' });
  assert.ok(!('token' in bound.tool.function.parameters.properties));
  assert.ok(!('key' in bound.tool.function.parameters.properties));
  assert.deepEqual(bound.arguments({}), { key: 'group:456', token: 'fixture-token', afterSeq: 0 });
  assert.throws(() => bound.arguments({ key: 'group:999' }), /cannot be changed/);
});

const KEY = 'group:456';
const directConfig = () => ({ model: 'fixture', provider: 'fixture', apiKey: 'fixture', baseURL: 'https://model.invalid/v1', webSearch: false, vision: true });
const files = { 'prompts/standalone-system.txt': 'fixture safety and tool protocol' };
async function integration(run, extra = {}) {
  let closed = 0;
  let toolOptions;
  const h = await bridgeHarness({
    config: { consolePort: 4321, socialV2: { context: { unreadLimit: 100 } } }, files,
    globals: {
      resolveEngineDirectConfig: directConfig,
      getEngineStatus: () => ({ ready: true, secret: { source: 'stored' } }),
      createDirectToolSession: async (options) => { toolOptions = options; return { tools: [], execute() {}, async close() { closed++; } }; },
      runDirectTurn: run, ...extra
    }
  });
  h.setMode('reserved2');
  await h.ensureSession(KEY);
  return { h, closed: () => closed, toolOptions: () => toolOptions };
}

test('bridge failure returns ok:false, closes resources and releases busy state', async () => {
  const fixture = await integration(async () => { throw new Error('fixture model unavailable'); });
  const { h } = fixture;
  try {
    h.pendingWakeKeys.add(KEY);
    const result = await h.deliverPrompt(KEY, 'wake', { wakeReason: 'question' });
    assert.equal(result.ok, false);
    assert.equal(result.direct, true);
    assert.equal(fixture.closed(), 1);
    assert.equal(h.pendingWakeKeys.has(KEY), false);
    assert.equal(h.directTurnControllers.size, 0);
    assert.equal(fixture.toolOptions().consolePort, 4321);
  } finally { await h.close(); }
});

test('bridge registers a 40-message backlog snapshot without tail-read watermarks', async () => {
  let h;
  const fixture = await integration(async (options) => {
    assert.equal(options.hasSnapshot, true);
    assert.equal(h.readThroughSeqV2(h.getSocialV2State(KEY)), 0);
    options.onContextSent();
    const through = h.readThroughSeqV2(h.getSocialV2State(KEY));
    assert.ok(through > 0 && through < 40);
    assert.ok(!JSON.stringify(options.content).includes(h.getSocialV2State(KEY).agentToken));
    return { ok: true, sent: 0, closed: true };
  });
  h = fixture.h;
  try {
    for (let i = 1; i <= 40; i++) h.appendSocialV2Message(KEY, 'fixture', `message ${i}`, `message ${i}`, false, false, i);
    const result = await h.deliverPrompt(KEY, 'wake', { wakeReason: 'question' });
    assert.equal(result.ok, true, result.error);
  } finally { await h.close(); }
});

test('bridge replays a wake accumulated during direct inference after queue release', async () => {
  let h;
  const fixture = await integration(async (options) => {
    options.onContextSent();
    const st = h.getSocialV2State(KEY);
    h.appendSocialV2Message(KEY, 'fixture', 'new question?', 'new question?', false, false, 2);
    st.pendingWakeReasons = [{ reason: 'question', seq: st.lastUnreadSeq }];
    st.unread = st.unread.filter((msg) => msg.seq > 1);
    return { ok: true, sent: 1, closed: true };
  });
  h = fixture.h;
  try {
    h.appendSocialV2Message(KEY, 'fixture', 'first', 'first', false, false, 1);
    await h.deliverPrompt(KEY, 'wake', { wakeReason: 'question' });
    const st = h.getSocialV2State(KEY);
    assert.equal(st.pendingWakeReasons.length, 0);
    assert.ok(st.pendingWakeTimer);
  } finally { await h.close(); }
});

test('direct provider usage is recorded under a separate ledger session', async () => {
  const fixture = await integration(async (options) => {
    options.onUsage({ round: 0, attempt: 0, model: 'fixture', usage: { cacheMiss: 100, cacheHit: 0, output: 10 } });
    return { ok: true, sent: 0, closed: true };
  });
  const { h } = fixture;
  try {
    await h.deliverPrompt(KEY, 'wake', { wakeReason: 'question' });
    const rows = h.tokenLedger.recent(10);
    assert.ok(JSON.stringify(rows).includes(`direct:${KEY}`));
    assert.ok(JSON.stringify(h.tokenLedger.summary()).includes('110'));
  } finally { await h.close(); }
});

test('a stale direct turn cannot release a replacement wake lock after reset', async () => {
  let h;
  const fixture = await integration(async (options) => {
    h.retireSession(KEY);
    assert.equal(options.signal.aborted, true);
    h.pendingWakeKeys.add(KEY);
    options.assertCurrent();
  });
  h = fixture.h;
  try {
    const result = await h.deliverPrompt(KEY, 'wake', { wakeReason: 'question' });
    assert.equal(result.ok, false);
    assert.equal(h.pendingWakeKeys.has(KEY), true);
  } finally { await h.close(); }
});

test('silent background turns stay local and close their own resources', async () => {
  const f = await integration(async options => {
    assert.equal(options.silent, true);
    return { ok: true, sent: 0, closed: false };
  });
  try {
    const result = await f.h.deliverPrompt(KEY, 'background', { silent: true });
    assert.equal(result.ok, true);
    assert.equal(f.closed(), 1);
    assert.equal(f.h.calls.sent.length, 0);
    assert.equal(f.h.directTurnControllers.size, 0);
    assert.throws(() => f.h.setMode('closed-agent'), /removed mode/);
  } finally { await f.h.close(); }
});

test('safe MCP tool discovery restores memory, vision and search without network calls', async () => {
  const session = await createDirectToolSession({ key: KEY, agentToken: 'fixture-token', consolePort: 4321 });
  try {
    const names = session.tools.map((tool) => tool.function.name);
    assert.ok(names.includes('qq_memory_append'));
    assert.ok(names.includes('qq_get_message_images'));
    assert.ok(names.includes('mcp__web-search-safe__web_search'));
    assert.ok(!names.includes('qq_send_group_message'));
    for (const tool of session.tools) assert.ok(!Object.hasOwn(tool.function.parameters.properties, 'token'));
  } finally { await session.close(); }
});

test('safe MCP execution uses the selected mock bridge port, token and long-poll route', async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, key: KEY, messages: [], readThroughSeq: 0, newMessages: [], canSleepNow: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let session;
  try {
    session = await createDirectToolSession({ key: KEY, agentToken: 'fixture-token', consolePort: server.address().port, webSearch: false });
    await session.execute('qq_get_unread_messages', { limit: 1 });
    await session.execute('qq_wait_for_messages', { timeoutMs: 300000 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['x-agent-token'], 'fixture-token');
    assert.equal(calls[0].headers['x-agent-call'], '1');
    assert.match(calls[0].url, /afterSeq=0/);
    assert.equal(calls[1].url, '/api/socialV2/wait');
    assert.equal(calls[1].body.key, KEY);
    await assert.rejects(session.execute('qq_get_unread_messages', { key: 'group:999' }), /cannot be changed/);
    assert.equal(calls.length, 2);
  } finally {
    await session?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
