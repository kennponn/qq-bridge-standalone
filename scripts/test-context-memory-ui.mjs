// Offline DOM/API fixtures. No live bridge, model, QQ, browser, or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const configSource = html.slice(html.indexOf('let alwaysAwakeActionBusy ='), html.indexOf('async function viewV2State()'));
const memorySource = html.slice(html.indexOf('let v2MemoryLoadRevision ='), html.indexOf('function formatWakeStatus(r)'));
const pickerStart = html.indexOf("document.getElementById('v2SessionSelect').addEventListener('change'");
const pickerSource = html.slice(pickerStart, html.indexOf('\n});', pickerStart) + 4);
const escSource = html.match(/^function esc\(s\).+$/m)?.[0];
const clone = value => JSON.parse(JSON.stringify(value));

function fixture({ config = {}, memories = {} } = {}) {
  class Element {
    constructor() { this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.innerHTML = ''; this.className = ''; this.listeners = {}; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
  }
  const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
  const nodes = new Map(ids.map(id => [id, new Element()]));
  const state = { config: clone(config), memories: clone(memories) };
  const requests = [];
  const confirms = [];
  let hook;
  let answer = 'updated fact';
  let nextId = 1;
  const context = vm.createContext({
    document: {
      getElementById(id) { assert.ok(nodes.has(id), `Missing element ${id}`); return nodes.get(id); },
      querySelectorAll() { return []; }
    },
    confirm(text) { confirms.push(text); return true; },
    prompt() { return answer; },
    async api(path, method = 'GET', body) {
      const request = { path, method, body: body && clone(body) };
      requests.push(request);
      const snapshot = path === '/api/socialV2/config' ? clone(state.config) : null;
      if (hook) {
        const result = await hook(request);
        if (result !== undefined) return result;
      }
      if (path === '/api/socialV2/config') {
        if (method === 'POST') for (const [key, value] of Object.entries(body)) {
          state.config[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? { ...state.config[key], ...clone(value) } : value;
        }
        return { ok: true, config: method === 'GET' ? snapshot : clone(state.config) };
      }
      if (path.startsWith('/api/socialV2/memory?key=')) {
        const key = decodeURIComponent(path.split('=')[1]);
        return { ok: true, key, raw: clone(state.memories[key] || {}), memoryPolicy: { contextWindow: 20, wakeMaxChars: 12000, messageMaxChars: 4000, memoryMaxChars: 3500, autoRemember: true } };
      }
      assert.equal(method, 'POST');
      const raw = state.memories[body.key] ||= {};
      if (path === '/api/socialV2/conversation-memory') {
        const memory = raw.conversationMemory ||= { facts: [], archive: [] };
        const field = body.category === 'fact' ? 'facts' : 'archive';
        if (body.action === 'clear') {
          if (body.category === 'all') { memory.facts = []; memory.archive = []; }
          else memory[field] = [];
        } else if (body.action === 'remove') memory[field] = memory[field].filter(entry => entry.id !== body.id);
        else {
          const existing = memory[field].find(entry => entry.id === body.id);
          if (existing) Object.assign(existing, clone(body));
          else memory[field].push({ id: `fixture-${nextId++}`, text: body.text, sender: body.sender || 'console-admin', userId: body.userId || null, time: 1000 });
        }
      } else assert.ok(['/api/socialV2/memory-clear', '/api/socialV2/memory-update', '/api/socialV2/memory-remove'].includes(path), `Unexpected endpoint ${path}`);
      return { ok: true, key: body.key };
    }
  });
  vm.runInContext(escSource + '\n' + configSource + '\n' + memorySource + '\n' + pickerSource + `
    this.controller = { loadConfig: loadV2Config, saveConfig: saveV2Config, normalizeContext: normalizeV2ContextFields,
      readContext: readV2ContextFields, loadMemory: loadV2Memory, renderMemory: renderV2Memory,
      renderConversation: renderV2ConversationMemory, invalidate: invalidateV2MemoryView,
      busy: () => v2MemoryMutationBusy, loadedKey: () => v2MemoryLoadedKey };
  `, context);
  const node = id => nodes.get(id);
  return {
    state, requests, confirms, node, controller: context.controller,
    hook(fn) { hook = fn; }, answer(value) { answer = value; },
    writes: () => requests.filter(request => request.method === 'POST'),
    click(id) { return node(id).listeners.click(); },
    choose(key) { node('v2SessionSelect').listeners.change({ target: { value: key } }); },
    inputKey(key) { node('v2MemoryKey').value = key; node('v2MemoryKey').listeners.input(); },
    action(dataset, durable = true) {
      const button = { dataset };
      return node('v2MemoryOutput').listeners.click({ target: { closest(selector) {
        return selector === (durable ? 'button[data-cm-action]' : 'button[data-action]') ? button : null;
      } } });
    }
  };
}

test('HTML has unique IDs, labelled context limits, and parseable scripts', () => {
  const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [id, min, max] of [['v2ContextWindow', 1, 100], ['v2ContextRecentLimit', 20, 500], ['v2ContextUnreadLimit', 1, 100], ['v2ContextWakeMaxChars', 500, 20000], ['v2ContextMessageMaxChars', 200, 12000]]) {
    assert.match(html, new RegExp(`<label for="${id}"`));
    assert.match(html, new RegExp(`id="${id}" min="${min}" max="${max}"`));
  }
  assert.match(html, /id="v2MemoryMsg" role="status" aria-live="polite"/);
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Function(match[1]);
});

test('context normalization clamps actual fields, rejects empty/nonfinite, and omits deprecated overrides', () => {
  const f = fixture();
  const defaults = { recentLimit: 100, unreadLimit: 30, contextWindow: 20, wakeMaxChars: 12000, messageMaxChars: 4000 };
  assert.deepEqual(clone(f.controller.normalizeContext()), defaults);
  assert.deepEqual(clone(f.controller.normalizeContext({ recentLimit: 0, unreadLimit: -1, contextWindow: -100, wakeMaxChars: 1, messageMaxChars: 1 })), { recentLimit: 20, unreadLimit: 1, contextWindow: 1, wakeMaxChars: 500, messageMaxChars: 200 });
  assert.deepEqual(clone(f.controller.normalizeContext({ recentLimit: 9999, unreadLimit: 9999, contextWindow: 9999, wakeMaxChars: 99999, messageMaxChars: 99999 })), { recentLimit: 500, unreadLimit: 100, contextWindow: 100, wakeMaxChars: 20000, messageMaxChars: 12000 });
  for (const value of ['', '  ', null, undefined, 'NaN', Infinity]) assert.equal(f.controller.normalizeContext({ contextWindow: value }).contextWindow, 20);
  assert.equal(f.controller.normalizeContext({ contextWindow: 23.6 }).contextWindow, 24);
  assert.doesNotMatch(configSource, /wakeRecentLimit|inlineWakeMessages/);
});

test('full config load/save preserves host inline setting and other controls', async () => {
  const f = fixture({ config: { context: { contextWindow: 33, recentLimit: 180, unreadLimit: 50, wakeMaxChars: 15000, messageMaxChars: 6000, inlineWakeMessages: false, wakeRecentLimit: 4 }, wake: { alwaysAwake: true }, privateChat: { fastReply: true, batchWindowMs: 700, quietMs: 1500 } } });
  await f.controller.loadConfig();
  assert.equal(Number(f.node('v2ContextWindow').value), 33);
  assert.equal(Number(f.node('v2ContextMessageMaxChars').value), 6000);
  f.node('v2ContextWindow').value = '999';
  await f.controller.saveConfig();
  const body = f.writes()[0].body;
  assert.equal(body.context.contextWindow, 100);
  assert.deepEqual(Object.keys(body.context).sort(), ['contextWindow', 'messageMaxChars', 'recentLimit', 'unreadLimit', 'wakeMaxChars'].sort());
  assert.equal(f.state.config.context.inlineWakeMessages, false);
  assert.equal(f.state.config.context.wakeRecentLimit, 4);
  assert.equal(body.privateChat.fastReply, true);
  assert.equal(body.wake.alwaysAwake, true);
  assert.equal(f.node('v2ConfigMsg').className, 'meta ok');
});

test('durable and lightweight memory rendering escapes all untrusted text and metadata', () => {
  const f = fixture();
  const evil = '<img src=x onerror="attack()">\'&';
  f.controller.renderMemory({ ok: true, raw: {
    conversationMemory: { facts: [{ id: evil, text: evil, sender: evil, userId: evil, time: 'invalid' }], archive: [{ id: 'archive-1', text: evil, sourceSeq: 5 }] },
    activeTopics: [{ text: evil, pendingQuestion: evil }], pendingThoughts: [{ text: evil, motivation: evil }], memberImpressions: { [evil]: { traits: [evil] } }
  }, memoryPolicy: { contextWindow: evil, memoryMaxChars: 3500, autoRemember: true } });
  const output = f.node('v2MemoryOutput').innerHTML;
  assert.ok(output.includes('&lt;img'));
  assert.ok(output.includes('&quot;attack()&quot;'));
  assert.ok(output.includes('&#39;'));
  assert.ok(!output.includes('<img'));
  assert.ok(!output.includes('data-cm-id="<'));
  assert.ok(output.includes('3500'));
  assert.ok(!output.includes('Invalid Date'));
  assert.ok(output.includes('data-cat="activeTopic"'));
});

test('duplicate or missing source IDs never create ambiguous edit/delete controls', () => {
  const f = fixture();
  const output = f.controller.renderConversation({ facts: [{ id: 'same', text: 'first' }, { id: 'same', text: 'second' }, { text: 'legacy' }], archive: [] });
  assert.equal((output.match(/data-cm-id="same"/g) || []).length, 2);
  assert.ok(output.includes('second'));
  assert.ok(output.includes('legacy'));
});

test('memory load is scoped, read-only, and shows actual policy budgets', async () => {
  const f = fixture({ memories: { 'group:456': { conversationMemory: { facts: [{ id: 'f1', text: 'group fact' }], archive: [] } }, 'private:789': { conversationMemory: { facts: [{ id: 'f2', text: 'private fact' }], archive: [] } } } });
  f.choose('group:456');
  await f.controller.loadMemory();
  assert.equal(f.controller.loadedKey(), 'group:456');
  assert.ok(f.node('v2MemoryOutput').innerHTML.includes('group fact'));
  assert.ok(!f.node('v2MemoryOutput').innerHTML.includes('private fact'));
  assert.ok(f.node('v2MemoryOutput').innerHTML.includes('12000'));
  assert.equal(f.node('v2MemoryMsg').className, 'meta ok');
  assert.equal(f.writes().length, 0);
});

test('add sends admin endpoint with explicit fact, scoped key, optional metadata, and clears saved draft', async () => {
  const f = fixture();
  f.choose('private:789');
  f.node('v2FactText').value = '  fixture fact  ';
  await f.click('v2FactAdd');
  assert.deepEqual(f.writes()[0], { path: '/api/socialV2/conversation-memory', method: 'POST', body: { action: 'upsert', category: 'fact', text: 'fixture fact', key: 'private:789' } });
  assert.equal(f.node('v2FactText').value, '');
  assert.equal(f.state.memories['private:789'].conversationMemory.facts[0].sender, 'console-admin');
  assert.equal(f.node('v2MemoryMsg').className, 'meta ok');
  f.node('v2FactText').value = 'second';
  f.node('v2FactSender').value = 'fixture user';
  f.node('v2FactUserId').value = '123';
  await f.click('v2FactAdd');
  assert.equal(f.writes()[1].body.sender, 'fixture user');
  assert.equal(f.writes()[1].body.userId, '123');
});

test('edit/remove use loaded IDs and preserve source metadata when omitted', async () => {
  const f = fixture({ memories: { 'group:456': { conversationMemory: { facts: [{ id: 'f1', text: 'old', sender: 'original', userId: '123', time: 1000 }], archive: [{ id: 'a1', text: 'excerpt', sourceSeq: 10 }] } } } });
  f.choose('group:456');
  await f.controller.loadMemory();
  await f.action({ cmAction: 'edit', cmCategory: 'fact', cmId: 'f1' });
  assert.deepEqual(f.writes()[0].body, { action: 'upsert', category: 'fact', id: 'f1', text: 'updated fact', key: 'group:456' });
  assert.equal(f.state.memories['group:456'].conversationMemory.facts[0].sender, 'original');
  await f.action({ cmAction: 'remove', cmCategory: 'archive', cmId: 'a1' });
  assert.equal(f.state.memories['group:456'].conversationMemory.archive.length, 0);
  assert.equal(f.writes()[1].body.category, 'archive');
});

test('original archive excerpts are immutable: no edit control or archive upsert request', async () => {
  const f = fixture({ memories: { 'group:456': { conversationMemory: { facts: [{ id: 'f1', text: 'fact' }], archive: [{ id: 'a1', text: 'original excerpt', sourceSeq: 10 }] } } } });
  f.choose('group:456');
  await f.controller.loadMemory();
  const output = f.node('v2MemoryOutput').innerHTML;
  assert.ok(output.includes('data-cm-action="edit" data-cm-category="fact"'));
  assert.ok(!output.includes('data-cm-action="edit" data-cm-category="archive"'));
  assert.ok(output.includes('data-cm-action="remove" data-cm-category="archive"'));
  await f.action({ cmAction: 'edit', cmCategory: 'archive', cmId: 'a1' });
  assert.equal(f.writes().length, 0);
  assert.equal(f.state.memories['group:456'].conversationMemory.archive[0].text, 'original excerpt');
  assert.ok(html.includes('\u53ea\u5220\u9664\u5339\u914d\u7684\u957f\u671f\u4e8b\u5b9e'));
  assert.ok(html.includes('\u4e0d\u5220\u9664\u539f\u59cb\u804a\u5929\u5386\u53f2'));
});

test('specialized clear and legacy lightweight controls keep their distinct API contracts', async () => {
  const f = fixture();
  f.choose('group:456');
  await f.controller.loadMemory();
  await f.click('v2ConversationMemoryClearAll');
  assert.deepEqual(f.writes()[0].body, { action: 'clear', category: 'all', key: 'group:456' });
  await f.action({ action: 'clear', cat: 'activeTopic' }, false);
  assert.equal(f.writes()[1].path, '/api/socialV2/memory-clear');
  assert.equal(f.writes()[1].body.category, 'activeTopic');
  await f.click('v2MemoryClearAll');
  assert.equal(f.writes()[2].body.category, '');
  assert.ok(f.confirms.every(message => message.includes('group:456')));
});

test('missing/invalid key, blank draft, and stale rendered controls cannot mutate', async () => {
  const f = fixture();
  f.node('v2FactText').value = 'fact';
  await f.click('v2FactAdd');
  f.inputKey('../invalid');
  await f.controller.loadMemory();
  f.choose('group:456');
  await f.click('v2FactAdd');
  await f.action({ cmAction: 'remove', cmCategory: 'fact', cmId: 'stale' });
  assert.equal(f.writes().length, 0);
  assert.equal(f.node('v2MemoryMsg').className, 'meta err');
});

test('rejected/failed mutations retain draft, report error, and restore controls', async () => {
  for (const failure of [{ ok: false, error: 'fixture denied' }, new Error('fixture transport failure')]) {
    const f = fixture();
    f.choose('group:456');
    f.node('v2FactText').value = 'unsaved fact';
    f.hook(request => { if (request.method === 'POST') { if (failure instanceof Error) throw failure; return failure; } });
    await f.click('v2FactAdd');
    assert.equal(f.node('v2FactText').value, 'unsaved fact');
    assert.equal(f.node('v2MemoryMsg').className, 'meta err');
    assert.equal(f.controller.busy(), false);
    for (const id of ['v2MemoryLoad', 'v2MemoryClearAll', 'v2FactAdd', 'v2ConversationMemoryClearAll']) assert.equal(f.node(id).disabled, false);
  }
});

test('stale GET never renders another conversation after key changes', async () => {
  const f = fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.hook(request => request.path.includes('memory?') ? pending : undefined);
  f.choose('group:456');
  const load = f.controller.loadMemory();
  f.choose('private:789');
  release({ ok: true, raw: { conversationMemory: { facts: [{ id: 'old', text: 'old private content' }] } } });
  await load;
  assert.ok(!f.node('v2MemoryOutput').innerHTML.includes('old private content'));
  assert.equal(f.controller.loadedKey(), '');
  assert.equal(f.writes().length, 0);
});

test('stale POST acknowledgement never clears or reloads new conversation draft', async () => {
  const f = fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.hook(request => request.method === 'POST' ? pending : undefined);
  f.choose('group:456');
  f.node('v2FactText').value = 'old fact';
  const save = f.click('v2FactAdd');
  f.choose('private:789');
  f.node('v2FactText').value = 'new fact';
  release({ ok: true });
  await save;
  assert.equal(f.writes()[0].body.key, 'group:456');
  assert.equal(f.requests.length, 1);
  assert.equal(f.node('v2FactText').value, 'new fact');
  assert.equal(f.node('v2MemoryMsg').className, 'meta');
  assert.equal(f.controller.busy(), false);
});

test('double submit serializes writes and reports saved-but-refresh-failed truthfully', async () => {
  const f = fixture();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.hook(request => request.method === 'POST' ? pending : { ok: false, error: 'fixture refresh failure' });
  f.choose('group:456');
  f.node('v2FactText').value = 'fact';
  const save = f.click('v2FactAdd');
  await f.click('v2FactAdd');
  assert.equal(f.writes().length, 1);
  release({ ok: true });
  await save;
  assert.equal(f.node('v2FactText').value, '');
  assert.equal(f.node('v2MemoryMsg').className, 'meta err');
  assert.ok(f.node('v2MemoryMsg').textContent.includes('\u5df2\u4fdd\u5b58'));
});
