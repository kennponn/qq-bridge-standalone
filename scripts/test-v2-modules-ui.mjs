// Isolated navigation tests: no QQ, provider calls, secrets or live configuration.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('// V2 module navigation:'), html.indexOf('// End V2 module navigation.'));
const names = ['overview', 'wake', 'reply', 'voice', 'memory', 'logs'];
function fixture({ saved, storageUnavailable = false } = {}) {
  const tabs = names.map(name => ({ dataset: { v2Tab: name }, attributes: {}, tabIndex: 0, focused: false, listeners: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, callback) { this.listeners[key] = callback; }, focus() { this.focused = true; } }));
  const panels = names.map(name => ({ dataset: { v2Panel: name }, hidden: false,
    draft: { text: 'unsaved-' + name, checked: true }, audio: {}, detailsOpen: true }));
  const writes = [];
  const context = vm.createContext({ document: { querySelectorAll(selector) {
    if (selector === '#v2ModuleTabs [data-v2-tab]') return tabs;
    if (selector === '#section-social-v2 [data-v2-panel]') return panels;
    if (selector === '[data-v2-open]') return [];
    assert.fail('Unexpected DOM query: ' + selector);
  } }, localStorage: {
    getItem() { if (storageUnavailable) throw new Error('blocked'); return saved; },
    setItem(key, value) { if (storageUnavailable) throw new Error('blocked'); writes.push({ key, value }); }
  } });
  vm.runInContext(source + '\nthis.controls = { setV2Module, revealV2Module };', context);
  return { tabs, panels, writes, ...context.controls };
}
function assertActive(f, index) {
  assert.deepEqual(f.panels.map(p => p.hidden), names.map((_, i) => i !== index));
  assert.deepEqual(f.tabs.map(t => t.attributes['aria-selected']), names.map((_, i) => String(i === index)));
  assert.deepEqual(f.tabs.map(t => t.tabIndex), names.map((_, i) => i === index ? 0 : -1));
}

test('six named tabs have unique paired panels and every console ID remains unique', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const name of names) {
    assert.match(html, new RegExp(`id="v2Tab-${name}" role="tab" data-v2-tab="${name}" aria-controls="v2Panel-${name}"`));
    assert.match(html, new RegExp(`id="v2Panel-${name}" data-v2-panel="${name}" role="tabpanel" aria-labelledby="v2Tab-${name}"`));
  }
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(match[1]);
});

test('overview is the safe default for missing, invalid or blocked saved preferences', () => {
  for (const options of [{}, { saved: 'invalid-module' }, { saved: '__proto__' }, { saved: 'voice', storageUnavailable: true }]) {
    const f = fixture(options); assertActive(f, 0); assert.equal(f.writes.length, 0);
  }
  assertActive(fixture({ saved: 'voice' }), 3);
});

test('switching tabs preserves mounted inputs, audio and open details without any API request', () => {
  const f = fixture(); const drafts = f.panels.map(p => p.draft), audio = f.panels.map(p => p.audio);
  for (let i = 0; i < names.length; i++) {
    f.tabs[i].listeners.click(); assertActive(f, i);
    f.panels.forEach((p, n) => { assert.equal(p.draft, drafts[n]); assert.equal(p.audio, audio[n]); assert.equal(p.detailsOpen, true); });
  }
  assert.equal(f.writes.length, 6);
  assert.ok(f.writes.every(w => w.key === 'qq-console-social-v2-module' && names.includes(w.value)));
});

test('arrow keys wrap, Home/End jump and ordinary Tab is not intercepted', () => {
  const f = fixture();
  for (const [index, key, target] of [[0, 'ArrowLeft', 5], [5, 'ArrowRight', 0], [0, 'End', 5], [5, 'Home', 0]]) {
    let prevented = false; f.tabs[index].listeners.keydown({ key, preventDefault() { prevented = true; } });
    assert.ok(prevented); assertActive(f, target); assert.ok(f.tabs[target].focused);
  }
  f.tabs[0].listeners.keydown({ key: 'Tab', preventDefault() { assert.fail('Tab must use native focus navigation'); } });
});

test('search reveals the correct hidden panel and unrelated search leaves the selection unchanged', () => {
  const f = fixture();
  f.revealV2Module({ closest: () => f.panels[4] }); assertActive(f, 4);
  f.revealV2Module({ closest: () => null }); assertActive(f, 4);
  assert.match(html, /setConsolePage\(entry.page\);\s+revealV2Module\(entry.target\);/);
});

test('denied preference writes never block navigation', () => {
  const f = fixture({ storageUnavailable: true }); f.setV2Module('logs'); assertActive(f, 5);
});
