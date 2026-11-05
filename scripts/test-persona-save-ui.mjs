// Isolated DOM/API fixtures only. No real persona, QQ, model or credentials are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const helpers = html.slice(html.indexOf('// Saving a card and selecting'), html.indexOf('let simPromptOriginal'));
const handlers = html.slice(html.indexOf("document.getElementById('roleInput').addEventListener"), html.indexOf('// ── 仿真提示词 ──'));

assert.ok(helpers.length > 1000 && !helpers.includes('</script>'));

function fixture({ current = 'alpha', cards = { alpha: 'FIXTURE_A', beta: 'FIXTURE_B' } } = {}) {
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.listeners = {}; this._value = ''; this.textContent = ''; this.disabled = false; }
    get value() { return this._value; }
    set value(value) {
      const text = String(value);
      this._value = this.tag !== 'select' || this.children.some(child => child.value === text) ? text : '';
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    appendChild(child) { this.children.push(child); return child; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this._value = ''; }
    setAttribute(name, value) { this[name] = value; }
  }
  const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
  const nodes = new Map(ids.map(id => [id, new Element(id === 'roleInput' ? 'select' : 'div')]));
  const requests = [];
  const failures = new Map();
  let acceptDiscard = false;
  let hook;
  const state = { cards: { ...cards }, current };
  const context = vm.createContext({
    document: {
      getElementById(id) { assert.ok(nodes.has(id), `Missing ${id}`); return nodes.get(id); },
      createElement(tag) { return new Element(tag); }, activeElement: null,
    },
    async api(path, method, body) {
      requests.push({ path, method: method || 'GET', body: body && JSON.parse(JSON.stringify(body)) });
      if (hook) await hook(path);
      if (failures.has(path)) {
        const failure = failures.get(path);
        if (failure instanceof Error) throw failure;
        return failure;
      }
      if (path === '/api/roles') return { roles: Object.keys(state.cards), current: state.current };
      if (path.startsWith('/api/roles/content?name=')) {
        const name = decodeURIComponent(path.split('=')[1]);
        return { ok: true, content: state.cards[name], chars: state.cards[name].length };
      }
      if (path === '/api/roles/rename') {
        state.cards[body.to] = state.cards[body.from]; delete state.cards[body.from];
        if (state.current === body.from) state.current = body.to;
        return { ok: true };
      }
      if (path === '/api/roles/create' || path === '/api/roles/update') {
        state.cards[body.name] = body.content;
        return { ok: true, role: body.name, warnings: [] };
      }
      if (path === '/api/role') { state.current = body.role; return { ok: true, role: body.role }; }
      throw new Error('Unexpected fixture route: ' + path);
    },
    refresh() { context.controller.sync(state.current); }, prompt() { return null; }, confirm() { return acceptDiscard; },
  });
  vm.runInContext(helpers + '\n' + handlers + `\nthis.controller = {
    refreshRoles, openRoleForEdit, saveRoleEditor, sync: syncCurrentRole,
    editor: () => ({ ...roleEditorState }), busy: () => roleActionBusy,
  };`, context);
  const node = id => nodes.get(id);
  return { state, requests, failures, node, controller: context.controller,
    click: id => node(id).listeners.click(),
    choose(name) { node('roleInput').value = name; node('roleInput').listeners.change(); },
    draft(name = 'gamma', content = 'FIXTURE_G') { node('newRoleName').value = name; node('newRoleContent').value = content; },
    hook(fn) { hook = fn; }, writes: () => requests.filter(request => request.method === 'POST'),
    discard(value) { acceptDiscard = value; },
  };
}

test('role picker is a labelled native select, not a manual text field', () => {
  assert.match(html, /<select id="roleInput" aria-label="选择已保存的人格">/);
  assert.doesNotMatch(html, /<input[^>]+id="roleInput"/);
  assert.match(html, /id="roleSaveOnly"[^>]*>仅保存/);
  assert.equal(new Set([...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1])).size,
    [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].length);
  for (const source of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1])) new Function(source);
});

test('initial options show the active persona and use safe text nodes', async () => {
  const f = fixture({ current: 'alpha', cards: { alpha: 'A', 'beta<fixture>': 'B' } });
  await f.controller.refreshRoles();
  assert.deepEqual(f.node('roleInput').children.map(option => option.value), ['', 'alpha', 'beta<fixture>']);
  assert.equal(f.node('roleInput').value, 'alpha');
  assert.equal(f.node('roleInput').children[1].textContent, 'alpha（当前启用）');
  assert.match(f.node('roleSelectionStatus').textContent, /当前已启用「alpha」/);
});

test('status and list refresh preserve an unapplied dropdown choice', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.choose('beta');
  f.controller.sync('alpha'); await f.controller.refreshRoles();
  assert.equal(f.node('roleInput').value, 'beta');
  assert.equal(f.state.current, 'alpha'); assert.equal(f.writes().length, 0);
});

test('deleted dropdown choice falls back to current persona, empty list remains usable', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.choose('beta'); delete f.state.cards.beta;
  await f.controller.refreshRoles(); assert.equal(f.node('roleInput').value, 'alpha');
  f.state.cards = {}; f.state.current = null; await f.controller.refreshRoles();
  assert.equal(f.node('roleInput').children.length, 1);
  assert.equal(f.node('roleInput').children[0].textContent, '暂无人格，请先新建');
});

test('clicking a role card selects it for enabling but does not switch implicitly', async () => {
  const f = fixture(); await f.controller.refreshRoles(); await f.controller.openRoleForEdit('beta');
  assert.equal(f.node('newRoleName').value, 'beta'); assert.equal(f.node('roleInput').value, 'beta');
  assert.equal(f.state.current, 'alpha'); assert.equal(f.writes().length, 0);
  assert.equal(f.node('roleCreate').textContent, '保存并启用');
});

test('primary save creates then enables the saved persona and updates current selection', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.draft(); await f.click('roleCreate');
  assert.deepEqual(f.writes().map(request => request.path), ['/api/roles/create', '/api/role']);
  assert.deepEqual(f.writes()[1].body, { role: 'gamma' }); assert.equal(f.state.current, 'gamma');
  assert.equal(f.node('roleInput').value, 'gamma'); assert.match(f.node('roleCreateMsg').textContent, /已保存「gamma」并启用/);
});

test('save and enable updates an existing card before selecting it', async () => {
  const f = fixture(); await f.controller.refreshRoles(); await f.controller.openRoleForEdit('beta');
  f.node('newRoleContent').value = 'FIXTURE_NEW'; await f.click('roleCreate');
  assert.deepEqual(f.writes().map(request => request.path), ['/api/roles/update', '/api/role']);
  assert.equal(f.state.cards.beta, 'FIXTURE_NEW'); assert.equal(f.state.current, 'beta');
});

test('save only does not activate an unrelated card, while active edits are reported accurately', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.draft(); await f.click('roleSaveOnly');
  assert.equal(f.state.current, 'alpha'); assert.equal(f.writes().length, 1);
  assert.match(f.node('roleCreateMsg').textContent, /尚未启用/);
  await f.controller.openRoleForEdit('alpha'); await f.click('roleSaveOnly');
  assert.equal(f.writes().at(-1).path, '/api/roles/update');
  assert.match(f.node('roleCreateMsg').textContent, /当前启用的人格，修改已应用/);
});

test('failed save never activates or claims success', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.draft();
  f.failures.set('/api/roles/create', { ok: false, error: 'FIXTURE_REJECTED' }); await f.click('roleCreate');
  assert.equal(f.writes().length, 1); assert.equal(f.state.current, 'alpha');
  assert.match(f.node('roleCreateMsg').textContent, /FIXTURE_REJECTED/); assert.equal(f.controller.busy(), false);
});

test('failed activation truthfully preserves a saved card without claiming it is active', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.draft();
  f.failures.set('/api/role', { ok: false, error: 'FIXTURE_APPLY_REJECTED' }); await f.click('roleCreate');
  assert.equal(f.state.cards.gamma, 'FIXTURE_G'); assert.equal(f.state.current, 'alpha');
  assert.match(f.node('roleCreateMsg').textContent, /已保存「gamma」，但启用失败/);
  assert.equal(f.node('roleInput').value, 'alpha');
});

test('activation connection errors preserve saved state and re-enable controls', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.draft();
  f.failures.set('/api/role', new Error('FIXTURE_CONNECTION')); await f.click('roleCreate');
  assert.equal(f.state.cards.gamma, 'FIXTURE_G'); assert.match(f.node('roleCreateMsg').textContent, /已保存「gamma」/);
  assert.doesNotMatch(f.node('roleCreateMsg').textContent, /并启用/);
  assert.equal(f.node('roleCreate').disabled, false); assert.equal(f.node('roleSaveOnly').disabled, false);
});

test('blank enable is rejected locally; clearing remains an explicit separate action', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.choose(''); await f.click('roleSet');
  assert.equal(f.writes().length, 0); assert.equal(f.state.current, 'alpha');
  await f.click('roleClear'); assert.deepEqual(f.writes()[0].body, { role: null });
  assert.equal(f.state.current, null); assert.equal(Object.keys(f.state.cards).length, 2);
  assert.equal(f.node('roleInput').value, '');
});

test('dropdown enable uses selected existing role without editing or saving it', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.choose('beta'); await f.click('roleSet');
  assert.deepEqual(f.writes().map(request => request.path), ['/api/role']);
  assert.equal(f.state.current, 'beta'); assert.equal(f.node('roleInput').value, 'beta');
});

test('duplicate clicks while saving cannot duplicate activation or change editor cards', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.draft();
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.hook(path => path === '/api/roles/create' ? gate : undefined);
  const job = f.click('roleCreate'); assert.equal(f.controller.busy(), true);
  await f.click('roleCreate'); await f.controller.openRoleForEdit('beta');
  assert.equal(f.node('newRoleName').value, 'gamma'); release(); await job;
  assert.equal(f.writes().length, 2); assert.equal(f.controller.busy(), false);
});

test('successful rename followed by save failure keeps editor bound to renamed file for retry', async () => {
  const f = fixture(); await f.controller.refreshRoles(); await f.controller.openRoleForEdit('beta'); f.draft('gamma');
  f.failures.set('/api/roles/update', { ok: false, error: 'FIXTURE_UPDATE_REJECTED' }); await f.click('roleCreate');
  assert.deepEqual(f.writes().map(request => request.path), ['/api/roles/rename', '/api/roles/update']);
  assert.equal(f.controller.editor().name, 'gamma'); assert.equal(f.state.current, 'alpha');
  f.failures.clear(); await f.click('roleCreate');
  assert.deepEqual(f.writes().slice(2).map(request => request.path), ['/api/roles/update', '/api/role']);
});

test('loading another card and clearing a form require confirmation before discarding a draft', async () => {
  const f = fixture(); await f.controller.refreshRoles(); f.draft('draft', 'KEEP_ME');
  const before = f.requests.length;
  await f.controller.openRoleForEdit('beta'); await f.click('roleFormReset');
  assert.equal(f.node('newRoleContent').value, 'KEEP_ME'); assert.equal(f.requests.length, before);
  f.discard(true); await f.controller.openRoleForEdit('beta');
  assert.equal(f.node('newRoleContent').value, 'FIXTURE_B'); assert.equal(f.writes().length, 0);
});

test('a late card response never overwrites text entered while the request was pending', async () => {
  const f = fixture(); await f.controller.refreshRoles();
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.hook(path => path.includes('/api/roles/content?') ? gate : undefined);
  const pending = f.controller.openRoleForEdit('beta');
  f.draft('draft', 'NEW_DURING_LOAD'); release(); await pending;
  assert.equal(f.node('newRoleContent').value, 'NEW_DURING_LOAD');
  assert.match(f.node('roleCreateMsg').textContent, /保留草稿/); assert.equal(f.writes().length, 0);
});
