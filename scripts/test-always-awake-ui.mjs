// Isolated DOM/API fixtures only. No live bridge, model, QQ, or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const configSource = html.slice(html.indexOf('let alwaysAwakeActionBusy ='), html.indexOf('async function viewV2State()'));
const statusSource = html.slice(html.indexOf('function formatWakeStatus(r)'), html.indexOf('function loadV2WakeStatus()'));
const handlers = html.split('\n').filter(line => line.includes("document.getElementById('v2AlwaysAwakeApply').addEventListener") ||
  line.includes("document.getElementById('v2AlwaysAwake').addEventListener")).join('\n');
const text = {
  active: '\u5e38\u9a7b\u76d1\u542c\uff081\u79d2\u5408\u6279\uff09',
  pending: '\u4fee\u6539\u672a\u5e94\u7528',
  unknown: '\u5c1a\u672a\u786e\u8ba4',
  enabled: '\u5df2\u5f00\u542f',
  disabled: '\u5df2\u5173\u95ed',
};

function fixture({ alwaysAwake = false } = {}) {
  class Element {
    constructor() { this.value = ''; this.checked = false; this.disabled = false; this.textContent = ''; this.className = ''; this.listeners = {}; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
  }
  const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
  const nodes = new Map(ids.map(id => [id, new Element()]));
  const state = {
    config: {
      enabled: true, agentPreset: 'FIXTURE_PRESET',
      privateChat: { fastReply: true, batchWindowMs: 700, quietMs: 1500 },
      wake: { alwaysAwake, defaultMode: 'diving', maxWakePerMinute: 30, maxWakePerHour: 120 },
      send: { maxSendPerMinute: 8, maxSendPerHour: 60 },
    },
  };
  const requests = [];
  let hook;
  let failure;
  const context = vm.createContext({
    document: {
      getElementById(id) { assert.ok(nodes.has(id), `Missing ${id}`); return nodes.get(id); },
      querySelectorAll() { return []; },
    },
    async api(path, method = 'GET', body) {
      assert.equal(path, '/api/socialV2/config');
      const snapshot = JSON.parse(JSON.stringify(state.config));
      requests.push({ path, method, body: body && JSON.parse(JSON.stringify(body)) });
      if (hook) await hook({ path, method, body });
      if (failure && method === 'POST') {
        if (failure instanceof Error) throw failure;
        return failure;
      }
      if (method === 'POST') {
        for (const [key, value] of Object.entries(body)) {
          state.config[key] = value && typeof value === 'object' && !Array.isArray(value)
            ? { ...state.config[key], ...JSON.parse(JSON.stringify(value)) } : value;
        }
      }
      return { ok: true, config: method === 'GET' ? snapshot : JSON.parse(JSON.stringify(state.config)) };
    },
    esc(value) { return String(value).replace(/[<>&"]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[character])); },
  });
  vm.runInContext(configSource + '\n' + statusSource + '\n' + handlers + `\nthis.controller = {
    load: loadV2Config, save: saveV2Config, formatWakeStatus,
    busy: () => alwaysAwakeActionBusy || v2ConfigSaveBusy,
  };`, context);
  const node = id => nodes.get(id);
  return {
    state, requests, node, controller: context.controller,
    click: () => node('v2AlwaysAwakeApply').listeners.click(),
    choose(checked) { node('v2AlwaysAwake').checked = checked; node('v2AlwaysAwake').listeners.change(); },
    hook(fn) { hook = fn; }, fail(value) { failure = value; },
    writes: () => requests.filter(request => request.method === 'POST'),
  };
}

test('always-awake control is visible, labelled and separate from AI recommendations', () => {
  const start = html.indexOf('<section id="section-social-v2"');
  const control = html.indexOf('id="v2AlwaysAwake"');
  const recommendations = html.indexOf('id="v2WakeDefaultMode"');
  assert.ok(start < control && control < recommendations);
  assert.match(html, /<label for="v2AlwaysAwake"/);
  assert.match(html, /<input type="checkbox" id="v2AlwaysAwake" aria-describedby="v2AlwaysAwakeHelp"/);
  assert.match(html, /id="v2AlwaysAwakeApply"/);
  const block = html.slice(control, html.indexOf('<div class="row" style="margin-top:6px">', control));
  assert.doesNotMatch(block, /\shidden(?:\s|>|=)/);
  const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const source of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])) new Function(source);
});

test('loading uses a strict boolean and keeps existing private settings', async () => {
  for (const value of [true, false, 'true', 1, undefined]) {
    const f = fixture({ alwaysAwake: value });
    if (value === undefined) delete f.state.config.wake.alwaysAwake;
    await f.controller.load();
    assert.equal(f.node('v2AlwaysAwake').checked, value === true);
    assert.equal(f.node('v2PrivateFastReply').checked, true);
    assert.equal(f.node('v2PrivateBatchMs').value, 700);
    assert.equal(f.writes().length, 0);
  }
});

test('dedicated enable posts only one host-owned boolean and preserves other drafts and limits', async () => {
  const f = fixture(); await f.controller.load();
  const original = JSON.parse(JSON.stringify(f.state.config));
  f.node('v2AgentPreset').value = 'UNSAVED_PRESET';
  f.node('v2MaxWakeMin').value = '99';
  f.node('v2PrivateBatchMs').value = '1200';
  f.choose(true); await f.click();
  assert.deepEqual(f.writes(), [{ path: '/api/socialV2/config', method: 'POST', body: { wake: { alwaysAwake: true } } }]);
  original.wake.alwaysAwake = true;
  assert.deepEqual(f.state.config, original);
  assert.equal(f.node('v2AgentPreset').value, 'UNSAVED_PRESET');
  assert.equal(f.node('v2MaxWakeMin').value, '99');
  assert.equal(f.node('v2PrivateBatchMs').value, '1200');
  assert.ok(f.node('v2AlwaysAwakeStatus').textContent.includes(text.active));
  assert.ok(f.node('v2AlwaysAwakeMsg').textContent.includes(text.enabled));
  assert.equal(f.requests.filter(request => request.method === 'GET').length, 1, 'Applying must not reload the full form');
});

test('dedicated disable posts false without changing wake mode or private behavior', async () => {
  const f = fixture({ alwaysAwake: true }); await f.controller.load();
  f.choose(false); await f.click();
  assert.deepEqual(f.writes()[0].body, { wake: { alwaysAwake: false } });
  assert.equal(f.state.config.wake.defaultMode, 'diving');
  assert.equal(f.state.config.privateChat.fastReply, true);
  assert.ok(f.node('v2AlwaysAwakeMsg').textContent.includes(text.disabled));
});

test('an unapplied change is marked without sending a model or configuration request', async () => {
  const f = fixture(); await f.controller.load(); f.choose(true);
  assert.ok(f.node('v2AlwaysAwakeStatus').textContent.includes(text.pending));
  assert.equal(f.writes().length, 0);
});

test('duplicate apply and full-form saves are blocked while dedicated application is in flight', async () => {
  const f = fixture(); await f.controller.load(); f.choose(true);
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.hook(({ method }) => method === 'POST' ? gate : undefined);
  const job = f.click();
  assert.equal(f.controller.busy(), true);
  for (const id of ['v2AlwaysAwake', 'v2AlwaysAwakeApply', 'v2ConfigSave', 'v2ConfigSaveTop']) assert.equal(f.node(id).disabled, true);
  await f.click(); await f.controller.save(); assert.equal(f.writes().length, 1);
  release(); await job;
  assert.equal(f.controller.busy(), false);
  for (const id of ['v2AlwaysAwake', 'v2AlwaysAwakeApply', 'v2ConfigSave', 'v2ConfigSaveTop']) assert.equal(f.node(id).disabled, false);
});

test('full-form save persists alwaysAwake and blocks conflicting partial applies', async () => {
  const f = fixture(); await f.controller.load(); f.choose(true);
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.hook(({ method }) => method === 'POST' ? gate : undefined);
  const job = f.controller.save();
  assert.equal(f.controller.busy(), true);
  await f.click(); await f.controller.save();
  assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0].body.wake.alwaysAwake, true);
  assert.equal(f.writes()[0].body.privateChat.fastReply, true);
  release(); await job; assert.equal(f.controller.busy(), false);
  assert.equal(f.state.config.wake.alwaysAwake, true);
});

test('server rejection shows no success or raw sensitive error and restores controls', async () => {
  const f = fixture(); await f.controller.load(); f.choose(true);
  f.fail({ ok: false, error: 'FIXTURE_SECRET_MUST_NOT_DISPLAY' }); await f.click();
  assert.equal(f.state.config.wake.alwaysAwake, false);
  assert.equal(f.node('v2AlwaysAwakeMsg').className, 'meta err');
  assert.doesNotMatch(f.node('v2AlwaysAwakeMsg').textContent, /FIXTURE_SECRET_MUST_NOT_DISPLAY/);
  assert.ok(!f.node('v2AlwaysAwakeMsg').textContent.includes(text.enabled));
  assert.ok(f.node('v2AlwaysAwakeStatus').textContent.includes(text.unknown));
  assert.equal(f.controller.busy(), false); assert.equal(f.node('v2AlwaysAwakeApply').disabled, false);
});

test('missing or mismatched effective configuration cannot claim success', async () => {
  for (const response of [{ ok: true }, { ok: true, config: { wake: { alwaysAwake: false } } }, { ok: true, config: { wake: { alwaysAwake: 'true' } } }]) {
    const f = fixture(); await f.controller.load(); f.choose(true); f.fail(response); await f.click();
    assert.equal(f.node('v2AlwaysAwakeMsg').className, 'meta err');
    assert.ok(f.node('v2AlwaysAwakeStatus').textContent.includes(text.unknown));
    assert.equal(f.node('v2AlwaysAwakeApply').disabled, false);
  }
});

test('connection failure is truthfully unconfirmed and does not expose exception data', async () => {
  const f = fixture(); await f.controller.load(); f.choose(true);
  f.fail(new Error('FIXTURE_SECRET_EXCEPTION')); await f.click();
  assert.equal(f.node('v2AlwaysAwakeMsg').className, 'meta err');
  assert.doesNotMatch(f.node('v2AlwaysAwakeMsg').textContent, /FIXTURE_SECRET_EXCEPTION/);
  assert.ok(f.node('v2AlwaysAwakeStatus').textContent.includes(text.unknown));
  assert.equal(f.node('v2AlwaysAwake').disabled, false);
});

test('application preserves pre-disabled controls rather than enabling them accidentally', async () => {
  const f = fixture(); await f.controller.load(); f.choose(true);
  f.node('v2ConfigSaveTop').disabled = true; await f.click();
  assert.equal(f.node('v2ConfigSaveTop').disabled, true);
  assert.equal(f.node('v2AlwaysAwakeApply').disabled, false);
});

test('a late initial GET cannot overwrite an applied always-awake setting', async () => {
  const f = fixture();
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.hook(({ method }) => method === 'GET' ? gate : undefined);
  const oldLoad = f.controller.load();
  f.choose(true); await f.click(); release(); await oldLoad;
  assert.equal(f.node('v2AlwaysAwake').checked, true);
  assert.ok(f.node('v2AlwaysAwakeStatus').textContent.includes(text.active));
});

test('a late GET cannot overwrite an unapplied checkbox change', async () => {
  const f = fixture(); await f.controller.load();
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.hook(({ method }) => method === 'GET' ? gate : undefined);
  const oldLoad = f.controller.load(); f.choose(true); release(); await oldLoad;
  assert.equal(f.node('v2AlwaysAwake').checked, true);
  assert.ok(f.node('v2AlwaysAwakeStatus').textContent.includes(text.pending));
  assert.equal(f.writes().length, 0);
});

test('wake status identifies the effective host override only for a strict true marker', () => {
  const f = fixture();
  assert.ok(f.controller.formatWakeStatus({ ok: true, wakeConfig: { alwaysAwake: true, mode: 'active', infinite: true, triggers: { anyMessage: true } } }).includes(text.active));
  for (const marker of [false, 'true', 1, undefined]) {
    assert.ok(!f.controller.formatWakeStatus({ ok: true, wakeConfig: { alwaysAwake: marker, mode: 'active' } }).includes(text.active));
  }
});
