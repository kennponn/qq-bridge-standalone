// Module and pagination fixtures never load an account, backend or user data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const navigation = html.slice(html.indexOf('// Persona module navigation:'), html.indexOf('let personaLibraryPage = 0;'));
const pagination = html.slice(html.indexOf('let personaLibraryPage = 0;'), html.indexOf("document.getElementById('personaSearch').addEventListener"));
const names = ['library', 'editor', 'advanced'];
function fixture({ saved, blocked = false } = {}) {
  const tabs = names.map(name => ({ dataset: { personaTab: name }, attrs: {}, listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; }, setAttribute(name, value) { this.attrs[name] = value; },
    scrollIntoView() {}, focus() { this.focused = true; } }));
  const panels = names.map(name => ({ dataset: { personaPanel: name }, draft: {} }));
  const writes = [];
  const context = vm.createContext({
    document: { querySelectorAll(selector) { return selector.includes('[data-persona-tab]') ? tabs : panels; } },
    localStorage: {
      getItem() { if (blocked) throw new Error('blocked'); return saved; },
      setItem(key, value) { if (blocked) throw new Error('blocked'); writes.push({ key, value }); },
    },
  });
  vm.runInContext(navigation + '\nthis.controls = { setPersonaModule, revealPersonaModule };', context);
  return { tabs, panels, writes, ...context.controls };
}
function active(f, index) {
  assert.deepEqual(f.panels.map(panel => panel.hidden), names.map((_, i) => i !== index));
  assert.deepEqual(f.tabs.map(tab => tab.attrs['aria-selected']), names.map((_, i) => String(i === index)));
  assert.deepEqual(f.tabs.map(tab => tab.tabIndex), names.map((_, i) => i === index ? 0 : -1));
}

test('three accessible persona tabs keep distinct paired panels and unique control IDs', () => {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const name of names) {
    assert.match(html, new RegExp(`id="personaTab-${name}" role="tab" data-persona-tab="${name}" aria-controls="personaPanel-${name}"`));
    assert.match(html, new RegExp(`id="personaPanel-${name}" role="tabpanel" data-persona-panel="${name}" aria-labelledby="personaTab-${name}"`));
  }
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(script[1]);
});

test('library is the safe default, and denied storage does not block switching', () => {
  for (const options of [{}, { saved: '__proto__' }, { saved: 'editor', blocked: true }]) active(fixture(options), 0);
  active(fixture({ saved: 'advanced' }), 2);
  const f = fixture({ blocked: true }); f.setPersonaModule('editor'); active(f, 1);
});

test('module changes retain mounted drafts and store only a module name', () => {
  const f = fixture(); const drafts = f.panels.map(panel => panel.draft);
  names.forEach((name, i) => { f.tabs[i].listeners.click(); active(f, i); });
  f.panels.forEach((panel, i) => assert.equal(panel.draft, drafts[i]));
  assert.ok(f.writes.every(w => w.key === 'qq-console-persona-module' && names.includes(w.value)));
});

test('keyboard wraps, Home/End work and search opens the relevant persona module', () => {
  const f = fixture();
  for (const [start, key, target] of [[0, 'ArrowLeft', 2], [2, 'ArrowRight', 0], [0, 'End', 2], [2, 'Home', 0]]) {
    let prevented = false;
    f.tabs[start].listeners.keydown({ key, preventDefault() { prevented = true; } });
    assert.ok(prevented); active(f, target); assert.ok(f.tabs[target].focused);
  }
  f.tabs[0].listeners.keydown({ key: 'Tab', preventDefault() { assert.fail('native Tab must remain available'); } });
  f.revealPersonaModule({ closest: () => f.panels[2] }); active(f, 2);
  assert.match(html, /revealV2Module\(entry.target\);\s+revealPersonaModule\(entry.target\);/);
});

test('search and four-card pagination stay bounded across filters, deletion and empty libraries', () => {
  let cards = Array.from({ length: 13 }, (_, i) => ({ hidden: false, querySelector: () => ({ textContent: `Persona-${String(i).padStart(2, '0')}` }) }));
  const nodes = Object.fromEntries(['personaSearch', 'personaNoResults', 'personaPagination', 'personaPageStatus', 'personaPrev', 'personaNext'].map(id => [id, { value: '', hidden: false }]));
  const context = vm.createContext({ document: { querySelectorAll: () => cards, getElementById: id => nodes[id] } });
  vm.runInContext(pagination + '\nthis.filter = filterPersonaLibrary; this.go = n => { personaLibraryPage = n; filterPersonaLibrary(); };', context);
  context.filter(); assert.equal(cards.filter(c => !c.hidden).length, 4); assert.ok(nodes.personaPrev.disabled);
  context.go(3); assert.equal(cards.filter(c => !c.hidden).length, 1); assert.ok(nodes.personaNext.disabled);
  nodes.personaSearch.value = 'PERSONA-12'; context.filter({ reset: true });
  assert.equal(cards.filter(c => !c.hidden).length, 1); assert.ok(!cards[12].hidden);
  nodes.personaSearch.value = 'missing'; context.filter({ reset: true }); assert.ok(!nodes.personaNoResults.hidden);
  assert.equal(cards.filter(c => !c.hidden).length, 0);
  nodes.personaSearch.value = ''; context.go(3); cards = cards.slice(0, 3); context.filter();
  assert.equal(cards.filter(c => !c.hidden).length, 3); assert.ok(nodes.personaPrev.disabled);
  cards = []; context.filter(); assert.ok(nodes.personaNoResults.hidden); assert.ok(nodes.personaPagination.hidden);
});
