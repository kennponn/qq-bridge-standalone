// Static MCP registration and real direct-engine behavior with local mocks only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { runDirectTurn } from '../src/direct-engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const KEY = 'private:123';
const TOKEN = 'fixture-speech-token';
const speakName = 'qq_speak_text';
const speakDefinition = { name: speakName, description: 'fixture-speech', inputSchema: { type: 'object',
  properties: { key: { type: 'string' }, token: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 300 } },
  required: ['key', 'token', 'text'] } };

function registerSpeech(config, reply = { ok: true, verified: true }) {
  const source = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  const start = source.indexOf("if (cfg.socialV2?.voice?.enabled === true && cfg.socialV2?.tools?.sendVoice === true");
  const end = source.indexOf("if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false)", start);
  assert.ok(start >= 0 && end > start);
  const registrations = [];
  const calls = [];
  const string = () => {
    const definition = { type: 'string' };
    definition.min = value => { definition.minLength = value; return definition; };
    definition.max = value => { definition.maxLength = value; return definition; };
    definition.describe = value => { definition.description = value; return definition; };
    return definition;
  };
  vm.runInNewContext(source.slice(start, end), { cfg: config, z: { string }, JSON,
    serializeModelData: JSON.stringify,
    server: { tool: (...values) => registrations.push(values) },
    agentApi: async (...args) => { calls.push(args); if (reply instanceof Error) throw reply; return reply; } });
  return { registrations, calls, source };
}
const enabledConfig = () => ({ socialV2: { voice: { enabled: true, tts: { enabled: true, onlineConsent: true } }, tools: { sendVoice: true } } });

test('text tools budget for random synthesis and guide the model not to duplicate unverified speech', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/mcp-snowluma-safe.js'), 'utf8');
  for (const endpoint of ['/api/send/group', '/api/send/private']) {
    const start = source.indexOf(`agentApi('${endpoint}', {`);
    const block = source.slice(start, source.indexOf('\n      });', start));
    assert.match(block, /timeoutMs: 90000/);
  }
  const start = source.indexOf("  'qq_send_message',");
  assert.match(source.slice(start, source.indexOf('\n  {', start)), /delivery\/verified/);
});

test('speech tool registration requires explicit enablement and online consent', () => {
  const cases = [{}, { socialV2: {} }, ...['voice', 'tool', 'tts', 'consent'].map(field => {
    const cfg = enabledConfig();
    if (field === 'voice') cfg.socialV2.voice.enabled = false;
    if (field === 'tool') cfg.socialV2.tools.sendVoice = false;
    if (field === 'tts') cfg.socialV2.voice.tts.enabled = false;
    if (field === 'consent') cfg.socialV2.voice.tts.onlineConsent = false;
    return cfg;
  })];
  for (const config of cases) assert.equal(registerSpeech(config).registrations.length, 0);
  assert.equal(registerSpeech(enabledConfig()).registrations.length, 1);
});

test('speech schema has only host identity plus bounded text, no model voice/path/rate controls', () => {
  const { registrations, source } = registerSpeech(enabledConfig());
  const [name, description, schema] = registrations[0];
  assert.equal(name, speakName);
  assert.deepEqual(Object.keys(schema), ['key', 'token', 'text']);
  assert.equal(schema.text.minLength, 1);
  assert.equal(schema.text.maxLength, 300);
  assert.match(description, /verified=true/);
  assert.match(description, /verified=false/);
  assert.match(description, /不另发重复文字/);
  assert.match(source, /qq_speak_text:\s*'sendVoice'/);
  assert.ok(source.includes("'qq_send_voice'") && source.includes("'qq_list_voices'"), 'Library speech tools remain available.');
});

test('speech MCP calls only bound host route with ninety-second deadline and reports failures', async () => {
  const h = registerSpeech(enabledConfig());
  const handler = h.registrations[0][3];
  const result = await handler({ key: KEY, token: TOKEN, text: 'A short fixture speech.' });
  assert.equal(result.isError, undefined);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], '/api/socialV2/speak-text');
  assert.equal(h.calls[0][1].timeoutMs, 90000);
  assert.deepEqual(JSON.parse(h.calls[0][1].body), { key: KEY, token: TOKEN, text: 'A short fixture speech.' });
  assert.equal(h.calls[0][1].headers['x-agent-token'], TOKEN);
  assert.equal(JSON.parse(result.content[0].text).verified, true);
  const rejected = registerSpeech(enabledConfig(), { ok: false, error: 'fixture denied' });
  assert.equal((await rejected.registrations[0][3]({ key: KEY, token: TOKEN, text: 'fixture' })).isError, true);
  const interrupted = registerSpeech(enabledConfig(), new Error('fixture interruption'));
  const failure = await interrupted.registrations[0][3]({ key: KEY, token: TOKEN, text: 'fixture' });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /fixture interruption/);
});

function directToolsFixture() {
  const called = [];
  class Transport {
    constructor(options) { this.script = path.basename(options.args[0]); }
    async close() {}
  }
  class Client {
    async connect(transport) { this.transport = transport; }
    async listTools() { return { tools: [speakDefinition, { name: 'qq_send_voice', inputSchema: speakDefinition.inputSchema },
      { name: 'qq_mark_read', inputSchema: { type: 'object', properties: { key: {}, token: {}, throughSeq: {} },
        required: ['key', 'token', 'throughSeq'] } }] }; }
    async callTool(request) { called.push(request); return { ok: true, verified: true }; }
    async close() {}
  }
  const source = fs.readFileSync(path.join(ROOT, 'src/direct-tools.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^const ROOT = .*;$/m, "const ROOT = '/fixture';").replace(/^export /gm, '');
  const context = vm.createContext({ path, process: { execPath: '/fixture/node' }, Client,
    StdioClientTransport: Transport, Promise, Map, Set, Object, Number, Error });
  vm.runInContext(source + '\nglobalThis.fixture = { createDirectToolSession };', context);
  return { ...context.fixture, called };
}

test('direct speech tools bind key/token and disappear in silent sessions', async () => {
  const h = directToolsFixture();
  const session = await h.createDirectToolSession({ key: KEY, agentToken: TOKEN, consolePort: 4321, webSearch: false });
  try {
    const tool = session.tools.find(entry => entry.function.name === speakName);
    assert.deepEqual(Object.keys(tool.function.parameters.properties), ['text']);
    assert.deepEqual(Array.from(tool.function.parameters.required), ['text']);
    assert.equal(tool.function.parameters.additionalProperties, false);
    await session.execute(speakName, { text: 'fixture' });
    assert.equal(h.called[0].arguments.key, KEY);
    assert.equal(h.called[0].arguments.token, TOKEN);
    await assert.rejects(session.execute(speakName, { text: 'fixture', key: 'private:999' }), /cannot be changed/);
    await assert.rejects(session.execute(speakName, { text: 'fixture', token: 'wrong' }), /cannot be changed/);
  } finally { await session.close(); }
  const silent = await h.createDirectToolSession({ key: KEY, agentToken: TOKEN, consolePort: 4321, webSearch: false, silent: true });
  try {
    assert.ok(!silent.tools.some(entry => entry.function.name === speakName));
    await assert.rejects(silent.execute(speakName, { text: 'fixture' }), /not enabled/);
  } finally { await silent.close(); }
});

const calls = (...items) => ({ role: 'assistant', content: null, tool_calls: items.map(([name, args], index) => ({
  id: `fixture-call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) });
const tools = [speakName, 'qq_mark_read'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: {} } } }));
function engineFixture(replies, executeTool = async () => ({ ok: true }), options = {}) {
  const executions = [];
  const requests = [];
  let index = 0;
  return { executions, requests, run: () => runDirectTurn({ model: 'fixture', apiKey: 'fixture-only', baseURL: 'https://provider.invalid/v1',
    hasSnapshot: true, promptText: 'Fixture', systemPrompt: 'Fixture', tools, maxRetries: 0, maxRounds: 3, ...options,
    executeTool: async (name, args) => { executions.push({ name, args }); return executeTool(name, args); },
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({
      choices: [{ message: replies[index++] }] }), { headers: { 'content-type': 'application/json' } }); } }) };
}

test('direct engine de-duplicates text-to-speech sends and closes only after sending', async () => {
  const h = engineFixture([calls([speakName, { text: 'fixture' }], [speakName, { text: 'fixture' }],
    ['qq_mark_read', { throughSeq: 1 }])], async () => ({ ok: true, verified: true }));
  const result = await h.run();
  assert.equal(result.sent, 1);
  assert.equal(result.closed, true);
  assert.deepEqual(h.executions.map(entry => entry.name), [speakName, 'qq_mark_read']);
});

test('failed speech prevents same-response acknowledgement and silent engine never executes speech', async () => {
  const failed = engineFixture([calls([speakName, { text: 'fixture' }], ['qq_mark_read', { throughSeq: 1 }]),
    calls(['qq_mark_read', { throughSeq: 1 }])], async name => name === speakName ? { ok: false, error: 'fixture synthesis failed' } : { ok: true });
  const result = await failed.run();
  assert.equal(result.sent, 0);
  assert.deepEqual(failed.executions.map(entry => entry.name), [speakName, 'qq_mark_read']);
  assert.ok(JSON.stringify(failed.requests[1].messages).includes('An earlier send failed'));
  const silent = engineFixture([{ role: 'assistant', content: 'Do not send.' }], undefined, { silent: true });
  assert.equal((await silent.run()).sent, 0);
  assert.ok(!silent.requests[0].tools.some(tool => tool.function.name === speakName));
  assert.equal(silent.executions.length, 0);
});
