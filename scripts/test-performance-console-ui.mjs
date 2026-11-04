// Pure DOM-controller checks: no live bridge, model, gateway or extra polling.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function renderDirectPerformance('), html.indexOf('function updateOverview('));
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map(match => match[1]);
const nodes = new Map(ids.map(id => [id, { hidden: false, textContent: '' }]));
const context = vm.createContext({ document: { getElementById(id) {
  assert.ok(nodes.has(id), `Missing element ${id}`);
  return nodes.get(id);
} } });
vm.runInContext(source + '\nthis.render = renderDirectPerformance;', context);
const render = context.render;

test('performance controller uses the existing status refresh and never renders HTML or private fields', () => {
  assert.ok(source.length > 1000);
  assert.doesNotMatch(source, /\b(?:api|fetch|setInterval|setTimeout)\s*\(|innerHTML|localStorage|sessionStorage/);
  assert.equal(ids.length, new Set(ids).size);
  assert.match(html, /renderDirectPerformance\(status\.performance, standalone\)/);
  assert.match(html, /performance-grid \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('empty, failed and unavailable samples do not invent a first reply', () => {
  render(undefined, true);
  assert.equal(nodes.get('performancePanel').hidden, false);
  assert.match(nodes.get('performanceSummary').textContent, /等待新样本/);
  assert.equal(nodes.get('perfGateway').textContent, '—');
  render({ private: { count: 0 }, latest: { kind: 'private', outcome: 'failed', firstReplyMs: null,
    totalMs: 1000, modelRequests: 2, modelRetries: 1, arrivalWaitMs: null, toolSetupMs: 20,
    modelMs: 700, toolMs: 0, queueMs: 0, gatewayMs: 0 } }, true);
  assert.match(nodes.get('performanceLatest').textContent, /失败 · 首回 —/);
  assert.match(nodes.get('performanceLatest').textContent, /2 次请求 \/ 1 次重试/);
  assert.equal(nodes.get('perfSetup').textContent, '0.02 秒');
  render(undefined, false);
  assert.equal(nodes.get('performancePanel').hidden, true);
});

test('first reply, complete turn and overlapping stage totals remain distinct', () => {
  render({ private: { count: 5, p50ReplyMs: 4300, p95ReplyMs: 9800 }, latest: {
    kind: 'private', outcome: 'success', firstReplyMs: 4900, totalMs: 6100,
    modelRequests: 1, modelRetries: 0, arrivalWaitMs: 700, toolSetupMs: 350,
    modelMs: 3000, toolMs: 1200, queueMs: 100, gatewayMs: 900,
    text: 'must-not-display', key: 'must-not-display', token: 'must-not-display',
  } }, true);
  assert.match(nodes.get('performanceSummary').textContent, /中位 4\.30 秒 · P95 9\.80 秒 · 5 个成功样本/);
  assert.match(nodes.get('performanceLatest').textContent, /首回 4\.90 秒 · 回合执行 6\.10 秒/);
  assert.equal(nodes.get('perfTools').textContent, '1.20 秒');
  assert.equal(nodes.get('perfQueue').textContent, '0.10 秒');
  assert.equal(nodes.get('perfGateway').textContent, '0.90 秒');
  assert.ok([...nodes.values()].every(node => !node.textContent.includes('must-not-display')));
  assert.match(html, /不可相加/);
});

test('malformed duration fields fail closed without NaN or Infinity labels', () => {
  render({ latest: { kind: 'group', outcome: 'silent', firstReplyMs: NaN, totalMs: Infinity,
    arrivalWaitMs: -1, toolSetupMs: '200', modelMs: null, toolMs: undefined,
    queueMs: NaN, gatewayMs: Infinity, modelRequests: 0, modelRetries: 0 } }, true);
  for (const id of ['perfArrival', 'perfSetup', 'perfModel', 'perfTools', 'perfQueue', 'perfGateway']) {
    assert.equal(nodes.get(id).textContent, '—');
  }
});
