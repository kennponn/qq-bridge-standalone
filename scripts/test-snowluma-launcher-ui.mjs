import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('// SnowLuma launcher accepts'), html.indexOf('\nasync function refresh()'));
assert(source.length > 1000);
assert(!/localStorage|sessionStorage|console\.log|innerHTML/.test(source));
assert.match(html, /id="snowlumaAutoLoad" type="checkbox"(?! checked)/);
assert.match(html, /自动接入所有已打开的 QQ/);
const nodes = new Map(['snowlumaStart', 'snowlumaLaunchMsg', 'snowlumaAutoLoad', 'snowlumaManage'].map(id => [id, {
  disabled: false, checked: false, textContent: '', className: '', listeners: {},
  addEventListener(event, handler) { this.listeners[event] = handler; },
}]));
let response = { ok: true, supported: true, started: true, launching: true, connected: false };
let allowConfirm = true;
let confirms = 0;
let failRequest = false;
const requests = [];
const context = vm.createContext({
  URL,
  document: { getElementById: id => { assert(nodes.has(id)); return nodes.get(id); } },
  async api(path, method, body) { requests.push({ path, method, body }); if (failRequest) throw new Error('secret-must-not-echo'); return response; },
  confirm() { confirms++; return allowConfirm; }, refresh() {},
});
vm.runInContext(source + '\nthis.controller = {renderSnowlumaLauncher, refreshSnowlumaLauncher};', context);
let passed = 0;
async function test(name, body) { await body(); passed++; console.log(`PASS ${name}`); }
const start = () => nodes.get('snowlumaStart').listeners.click();
await test('Default start does not auto-attach any QQ or ask for path/commands', async () => {
  await start();
  assert.equal(requests.at(-1).path, '/api/snowluma/start');
  assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1).body)), { autoLoad: false });
  assert.equal(confirms, 0);
  assert.match(nodes.get('snowlumaLaunchMsg').textContent, /选择需要接入的 QQ/);
});
await test('Auto-attach all QQ requires explicit checkbox and confirmation', async () => {
  nodes.get('snowlumaAutoLoad').checked = true;
  allowConfirm = false;
  const before = requests.length;
  await start();
  assert.equal(requests.length, before);
  allowConfirm = true;
  await start();
  assert.equal(requests.at(-1).body.autoLoad, true);
  assert.match(nodes.get('snowlumaLaunchMsg').textContent, /等待 QQ 网关真实连接/);
});
await test('Existing runtime is not reported as newly auto-configured', async () => {
  response = { ok: true, alreadyRunning: true, connected: false };
  await start();
  assert.match(nodes.get('snowlumaLaunchMsg').textContent, /未改变其自动接入设置/);
});
await test('Spawn confirmation is not shown as QQ connection', () => {
  context.controller.renderSnowlumaLauncher({ started: true, launching: true });
  assert.equal(nodes.get('snowlumaStart').textContent, 'SnowLuma 进程已运行');
  assert.match(nodes.get('snowlumaLaunchMsg').textContent, /尚未连接/);
});
await test('Actual gateway connection disables duplicate launch', () => {
  context.controller.renderSnowlumaLauncher({}, true);
  assert.equal(nodes.get('snowlumaStart').disabled, true);
  assert.equal(nodes.get('snowlumaStart').textContent, 'SnowLuma 已连接');
});
await test('Management URL follows validated local port and never exposes external or credential URLs', () => {
  context.controller.renderSnowlumaLauncher({ webuiUrl: 'http://127.0.0.1:6011' });
  assert.equal(nodes.get('snowlumaManage').hidden, false);
  assert.equal(nodes.get('snowlumaManage').href, 'http://127.0.0.1:6011/');
  for (const webuiUrl of ['https://evil.test', 'http://127.0.0.1:5099/?token=secret', 'http://user:secret@127.0.0.1:5099', 'javascript:alert(1)']) {
    context.controller.renderSnowlumaLauncher({ webuiUrl });
    assert.equal(nodes.get('snowlumaManage').hidden, true);
  }
});
await test('Unsupported platform cannot start from the UI', () => {
  context.controller.renderSnowlumaLauncher({ supported: false, error: 'UNSUPPORTED_PLATFORM' });
  assert.equal(nodes.get('snowlumaStart').disabled, true);
  assert.match(nodes.get('snowlumaLaunchMsg').textContent, /Windows/);
});
await test('Server errors are translated rather than echoing arbitrary secrets', async () => {
  response = { ok: false, error: 'PORT_IN_USE' };
  await start();
  assert.match(nodes.get('snowlumaLaunchMsg').textContent, /端口已被占用/);
  context.controller.renderSnowlumaLauncher({ error: 'secret-must-not-echo' });
  assert(!nodes.get('snowlumaLaunchMsg').textContent.includes('secret-must-not-echo'));
});
await test('Request failures do not expose errors or leave button stuck', async () => {
  failRequest = true;
  await start();
  assert.equal(nodes.get('snowlumaStart').disabled, false);
  assert(!nodes.get('snowlumaLaunchMsg').textContent.includes('secret-must-not-echo'));
  await context.controller.refreshSnowlumaLauncher();
  assert.equal(nodes.get('snowlumaStart').disabled, true);
});
console.log(`${passed}/${passed} SnowLuma UI tests passed`);
