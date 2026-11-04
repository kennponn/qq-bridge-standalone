import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSnowLumaLauncher } from '../src/snowluma-launcher.js';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-snowluma-launcher-test-'));
const tests = [];
let sequence = 0;
function test(name, run) { tests.push({ name, run }); }

function fixture(overrides = {}) {
  const root = path.join(testRoot, `case-${++sequence}`);
  const home = path.join(root, 'SnowLuma');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(stateDir);
  for (const file of ['node.exe', 'index.mjs', 'check-node-version.cjs', 'launcher.bat']) {
    fs.writeFileSync(path.join(home, file), 'offline fixture only\n');
  }
  const cfg = { snowluma: { homeDir: home, launcherPath: path.join(home, 'launcher.bat'), httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' } };
  const calls = { spawn: [], exec: [], ports: [] };
  const alive = new Set();
  const ownerPid = 800000 + sequence;
  alive.add(ownerPid);
  let clock = 200000;
  let version = 'v24.22.1\n';
  let connected = false;
  let child;
  const settings = {
    cfg, stateDir, platform: 'win32', ownerPid, now: () => clock,
    isConnected: async () => connected,
    kill: (pid) => {
      if (!alive.has(pid)) throw Object.assign(new Error('offline dead pid'), { code: 'ESRCH' });
    },
    env: {
      PATH: 'fixture-path', SNOWLUMA_HOOK_AUTOLOAD: '1', NODE_OPTIONS: '--require unsafe',
      NODE_PATH: 'unsafe', ELECTRON_RUN_AS_NODE: '1', SNOWLUMA_ACCEPT_EULA: '1', SNOWLUMA_ACCEPT_PRIVACY: '1',
      SNOWLUMA_WEBUI_HOST: '0.0.0.0', SNOWLUMA_WEBUI_PORT: '9999', SNOWLUMA_WEBUI_TLS: '1',
      SNOWLUMA_WEBUI_TRUST_PROXY: 'unsafe-proxy', snowluma_webui_port: '9988', snowluma_hook_autoload: '1'
    },
    portProbe: async (port) => { calls.ports.push(port); return false; },
    execFile: (file, args, options, callback) => {
      calls.exec.push({ file, args, options });
      queueMicrotask(() => callback(null, args[0] === '--version' ? version : '', 'not exposed'));
      return new EventEmitter();
    },
    spawn: (file, args, options) => {
      calls.spawn.push({ file, args, options });
      child = new EventEmitter();
      child.pid = 900000 + sequence;
      child.unref = () => { child.unrefCalled = true; };
      alive.add(child.pid);
      child.once('exit', () => alive.delete(child.pid));
      child.once('error', () => alive.delete(child.pid));
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    ...overrides
  };
  const create = (extra = {}) => createSnowLumaLauncher({ ...settings, ...extra });
  return {
    root, home, stateDir, cfg, calls, alive, ownerPid, settings, create,
    get child() { return child; },
    setClock: (value) => { clock = value; },
    setVersion: (value) => { version = value; },
    setConnected: (value) => { connected = value; },
    receiptFile: path.join(stateDir, 'snowluma-launcher.lock.json'),
    writeReceipt: (extra = {}) => fs.writeFileSync(path.join(stateDir, 'snowluma-launcher.lock.json'), JSON.stringify({
      version: 1, id: 'offline-existing', ownerPid: 777701, childPid: 777702, startedAt: 0,
      autoLoadRequested: false, ...extra
    }))
  };
}

test('startup uses only fixed absolute bundled executables without a shell or visible window', async () => {
  const f = fixture();
  const launcher = f.create();
  const result = await launcher.start();
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  assert.equal(result.launching, true);
  assert.equal(result.alreadyRunning, false);
  assert.equal('connected' in result, false);
  assert.equal(result.webuiUrl, 'http://127.0.0.1:5099');
  assert.equal(result.webuiUrlSource, 'configured');
  assert.equal(f.calls.exec.length, 2);
  assert.deepEqual(f.calls.exec.map(({ args }) => args), [['--version'], [path.join(f.home, 'check-node-version.cjs')]]);
  for (const call of f.calls.exec) {
    assert.equal(call.file, path.join(f.home, 'node.exe'));
    assert.equal(call.options.cwd, f.home);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 3000);
    assert.equal(call.options.maxBuffer, 4096);
  }
  assert.equal(f.calls.spawn.length, 1);
  const call = f.calls.spawn[0];
  assert.equal(call.file, path.join(f.home, 'node.exe'));
  assert.deepEqual(call.args, [path.join(f.home, 'index.mjs')]);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(f.child.unrefCalled, true);
  assert.equal(JSON.parse(fs.readFileSync(f.receiptFile, 'utf8')).childPid, f.child.pid);
});

test('default and false auto-load do not attach all open QQ clients; consent and Node injection env are removed', async () => {
  for (const options of [{}, { autoLoad: false }]) {
    const f = fixture();
    const result = await f.create().start(options);
    assert.equal(result.autoLoadRequested, false);
    for (const call of [...f.calls.exec, ...f.calls.spawn]) {
      assert.equal(call.options.env.SNOWLUMA_HOOK_AUTOLOAD, '0');
      for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'SNOWLUMA_ACCEPT_EULA', 'SNOWLUMA_ACCEPT_PRIVACY']) {
        assert.equal(Object.hasOwn(call.options.env, key), false);
      }
      for (const key of Object.keys(call.options.env)) {
        assert.equal(key.toUpperCase().startsWith('SNOWLUMA_WEBUI_'), false);
      }
      assert.equal(Object.hasOwn(call.options.env, 'snowluma_hook_autoload'), false);
    }
  }
});

test('only an explicit true autoLoad flag opts into attaching all clients', async () => {
  const f = fixture();
  const result = await f.create().start({ autoLoad: true });
  assert.equal(result.autoLoadRequested, true);
  assert.equal(f.calls.spawn[0].options.env.SNOWLUMA_HOOK_AUTOLOAD, '1');
});

test('invalid flags and arbitrary executable or argument fields are refused', async () => {
  const f = fixture();
  const launcher = f.create();
  for (const options of [null, [], 'true', true, { autoLoad: '1' }, { autoLoad: 1 }, { autoLoad: null }, { command: 'cmd.exe' }, { args: ['/c', 'calc'] }, { autoLoad: true, homeDir: 'D:/other' }]) {
    assert.equal((await launcher.start(options)).error, 'INVALID_OPTIONS');
  }
  assert.equal(f.calls.spawn.length, 0);
  assert.equal(f.calls.exec.length, 0);
});

test('non-Windows status and startup are unsupported without subprocesses', async () => {
  const f = fixture();
  const launcher = f.create({ platform: 'linux' });
  assert.equal(launcher.getStatus().supported, false);
  assert.equal(launcher.getStatus().ok, false);
  assert.equal((await launcher.start()).error, 'UNSUPPORTED_PLATFORM');
  assert.equal(f.calls.exec.length + f.calls.spawn.length, 0);
});

test('relative, UNC, drive-root, traversal and device-like installations are rejected', async () => {
  for (const homeDir of ['SnowLuma', '../SnowLuma', '\\\\server\\SnowLuma', 'D:\\', 'D:/SnowLuma/../other', 'D:/SnowLuma:stream', '\\\\?\\D:\\SnowLuma', 'D:/SnowLuma.']) {
    const f = fixture();
    f.cfg.snowluma.homeDir = homeDir;
    assert.equal((await f.create().start()).error, 'INVALID_INSTALL');
    assert.equal(f.calls.spawn.length, 0);
  }
});

test('launcherPath must name the installed launcher.bat and is never executed', async () => {
  const f = fixture();
  f.cfg.snowluma.launcherPath = path.join(f.home, 'different.bat');
  assert.equal((await f.create().start()).error, 'INVALID_INSTALL');
  assert.equal(f.calls.exec.length, 0);
  f.cfg.snowluma.launcherPath = path.join(f.home, 'launcher.bat');
  fs.unlinkSync(f.cfg.snowluma.launcherPath);
  assert.equal((await f.create().start()).error, 'INVALID_INSTALL');
});

test('all executable, entrypoint and checker files are required regular files', async () => {
  for (const name of ['node.exe', 'index.mjs', 'check-node-version.cjs']) {
    const missing = fixture();
    fs.unlinkSync(path.join(missing.home, name));
    assert.equal((await missing.create().start()).error, 'INVALID_INSTALL');
    const directory = fixture();
    fs.unlinkSync(path.join(directory.home, name));
    fs.mkdirSync(path.join(directory.home, name));
    assert.equal((await directory.create().start()).error, 'INVALID_INSTALL');
  }
});

test('symlinks or junction-like required files are refused', async () => {
  const f = fixture();
  const target = path.join(f.home, 'node.exe');
  const guardedFs = new Proxy(fs, { get(base, key) {
    if (key === 'lstatSync') return (file) => {
      const stat = base.lstatSync(file);
      if (file === target) stat.isSymbolicLink = () => true;
      return stat;
    };
    return base[key];
  } });
  assert.equal((await f.create({ fs: guardedFs }).start()).error, 'INVALID_INSTALL');
  assert.equal(f.calls.spawn.length, 0);
});

test('realpath escapes from the installation or its ancestors are refused', async () => {
  for (const ancestor of [false, true]) {
    const f = fixture();
    const target = ancestor ? path.dirname(f.home) : path.join(f.home, 'index.mjs');
    const guardedFs = new Proxy(fs, { get(base, key) {
      if (key === 'realpathSync') return (file) => file === target ? 'D:\\outside\\escaped' : base.realpathSync(file);
      return base[key];
    } });
    assert.equal((await f.create({ fs: guardedFs }).start()).error, 'INVALID_INSTALL');
    assert.equal(f.calls.spawn.length, 0);
  }
});

test('launcher state must stay in a real local directory', async () => {
  const f = fixture();
  assert.equal((await f.create({ stateDir: 'relative-state' }).start()).error, 'INVALID_STATE_DIR');
  const guardedFs = new Proxy(fs, { get(base, key) {
    if (key === 'realpathSync') return (file) => file === f.stateDir ? 'D:\\outside\\state' : base.realpathSync(file);
    return base[key];
  } });
  assert.equal((await f.create({ fs: guardedFs }).start()).error, 'INVALID_STATE_DIR');
});

test('an already connected gateway is not restarted', async () => {
  const f = fixture();
  f.setConnected(true);
  const result = await f.create().start({ autoLoad: true });
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.started, false);
  assert.equal(result.launching, false);
  assert.equal(f.calls.exec.length + f.calls.spawn.length, 0);
  assert.equal(fs.existsSync(f.receiptFile), false);
});

test('failed, invalid or hung existing-connection checks conservatively prevent launching', async () => {
  for (const isConnected of [async () => { throw new Error('secret connection detail'); }, async () => null, () => new Promise(() => {})]) {
    const f = fixture();
    const result = await f.create({ isConnected, preflightTimeoutMs: 5 }).start();
    assert.equal(result.error, 'PRECHECK_FAILED');
    assert.equal(f.calls.spawn.length, 0);
  }
});

test('simultaneous clicks launch once and a live child prevents all further launches', async () => {
  const f = fixture();
  let resume;
  const launcher = f.create({ isConnected: () => new Promise((resolve) => { resume = resolve; }) });
  const first = launcher.start();
  await Promise.resolve();
  const second = await launcher.start({ autoLoad: true });
  assert.equal(second.launching, true);
  assert.equal(second.started, false);
  resume(false);
  assert.equal((await first).started, true);
  assert.equal((await launcher.start({ autoLoad: true })).alreadyRunning, true);
  assert.equal(launcher.getStatus().autoLoadRequested, false);
  assert.equal(f.calls.spawn.length, 1);
});

test('persisted live PID receipts prevent duplicate instances across bridge restarts', async () => {
  const f = fixture();
  await f.create().start({ autoLoad: true });
  const restarted = f.create();
  const result = await restarted.start({ autoLoad: false });
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.started, false);
  assert.equal(result.autoLoadRequested, true);
  assert.equal(f.calls.spawn.length, 1);
});

test('PID access-denied checks are conservatively treated as an existing process', async () => {
  const f = fixture();
  f.writeReceipt({ autoLoadRequested: true });
  const result = await f.create({ kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }).start();
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.autoLoadRequested, true);
  assert.equal(f.calls.spawn.length, 0);
});

test('dead old receipts are safely replaced but recent incomplete launch receipts stay busy', async () => {
  const stale = fixture();
  stale.writeReceipt();
  assert.equal((await stale.create().start()).started, true);
  const recent = fixture();
  recent.writeReceipt({ childPid: null, startedAt: 199000 });
  const pending = await recent.create().start();
  assert.equal(pending.error, 'START_PENDING');
  assert.equal(pending.ok, false);
  assert.equal(pending.alreadyRunning, false);
  assert.equal(recent.calls.spawn.length, 0);
});

test('a concurrent or abandoned claim guard prevents unsafe receipt replacement', async () => {
  const f = fixture();
  fs.writeFileSync(`${f.receiptFile}.claim`, 'another-claim');
  const result = await f.create().start();
  assert.equal(result.error, 'CLAIM_BUSY');
  assert.equal(result.ok, false);
  assert.equal(result.alreadyRunning, false);
  assert.equal(f.calls.spawn.length, 0);
  assert.equal(fs.readFileSync(`${f.receiptFile}.claim`, 'utf8'), 'another-claim');
});

test('corrupt, oversized or reparse-like receipts are not overwritten', async () => {
  for (const content of ['not-json', '{}', 'x'.repeat(4097)]) {
    const f = fixture();
    fs.writeFileSync(f.receiptFile, content);
    assert.equal((await f.create().start()).error, 'STATE_UNAVAILABLE');
    assert.equal(fs.readFileSync(f.receiptFile, 'utf8'), content);
    assert.equal(f.calls.spawn.length, 0);
  }
  const f = fixture();
  f.writeReceipt();
  const guardedFs = new Proxy(fs, { get(base, key) {
    if (key === 'realpathSync') return (file) => file === f.receiptFile ? 'D:\\escaped.json' : base.realpathSync(file);
    return base[key];
  } });
  assert.equal((await f.create({ fs: guardedFs }).start()).error, 'STATE_UNAVAILABLE');
});

test('native local port checks cover defaults, configured URLs and all account ports without exposing tokens', async () => {
  const f = fixture();
  f.cfg.snowluma.httpUrl = 'http://localhost:4312';
  f.cfg.snowluma.wsUrl = 'ws://example.invalid:1234';
  fs.writeFileSync(path.join(f.home, 'config', 'onebot_123456.json'), JSON.stringify({
    networks: { httpServers: [{ host: '0.0.0.0', port: 6123, accessToken: 'synthetic-secret-not-for-output' }], wsServers: [{ port: 6124 }] }
  }));
  const result = await f.create().start();
  for (const port of [3000, 3001, 5099, 4312, 6123, 6124]) assert.equal(f.calls.ports.includes(port), true);
  assert.equal(f.calls.ports.includes(1234), false);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('status safely reports the configured custom management port without launching or probing', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'config', 'runtime.json'), JSON.stringify({
    webuiHost: '127.0.0.1', webuiPort: 6623, hookAutoLoad: true,
    password: 'synthetic-management-secret', unexpectedField: { anything: 'ignored' }
  }));
  const status = f.create().getStatus();
  assert.equal(status.webuiUrl, 'http://127.0.0.1:6623');
  assert.equal(status.webuiUrlSource, 'configured');
  assert.equal(JSON.stringify(status).includes('synthetic-management-secret'), false);
  assert.equal(f.calls.exec.length + f.calls.spawn.length + f.calls.ports.length, 0);
  assert.equal(fs.existsSync(f.receiptFile), false);
});

test('the configured custom WebUI port prevents spawning an externally started unloaded runtime', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, 'config', 'runtime.json'), JSON.stringify({ webuiHost: '127.0.0.1', webuiPort: 6631 }));
  const seenPorts = [];
  const result = await f.create({ portProbe: async (port) => { seenPorts.push(port); return port === 6631; } }).start();
  assert.equal(result.error, 'PORT_IN_USE');
  assert.equal(result.ok, false);
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.webuiUrl, 'http://127.0.0.1:6631');
  assert.equal(seenPorts.includes(6631), true);
  assert.equal(f.calls.exec.length + f.calls.spawn.length, 0);
});

test('runtime settings are read only and unrelated fields are never exposed or changed', async () => {
  const f = fixture();
  const file = path.join(f.home, 'config', 'runtime.json');
  const original = JSON.stringify({
    webuiPort: 6641, webuiHost: '127.0.0.1', webuiTls: { enabled: false, secretPath: 'synthetic-secret-path' },
    hookAutoLoad: true, logRetainDays: 9, privateField: 'synthetic-config-secret'
  }, null, 2);
  fs.writeFileSync(file, original);
  const result = await f.create().start({ autoLoad: false });
  assert.equal(result.started, true);
  assert.equal(result.webuiUrl, 'http://127.0.0.1:6641');
  assert.equal(JSON.stringify(result).includes('synthetic-'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(f.calls.ports.includes(6641), true);
});

test('runtime JSON UTF-8 BOM and missing port fields safely use supported defaults', async () => {
  for (const contents of ['\uFEFF{"webuiPort":6651,"webuiHost":"127.0.0.1"}', '{}', '{"webuiHost":"127.0.0.1"}']) {
    const f = fixture();
    fs.writeFileSync(path.join(f.home, 'config', 'runtime.json'), contents);
    const result = await f.create().start();
    assert.equal(result.started, true);
    assert.equal(result.webuiUrl, contents.includes('6651') ? 'http://127.0.0.1:6651' : 'http://127.0.0.1:5099');
  }
});

test('unsupported management bind hosts, TLS and invalid ports are rejected without opening remote URLs', async () => {
  const configs = [
    ...['0.0.0.0', '192.168.1.2', 'example.invalid', 'localhost', '::1', '127.0.0.2', '', null].map((webuiHost) => ({ webuiHost, webuiPort: 6661 })),
    ...[0, -1, 65536, 1.5, '6661', null].map((webuiPort) => ({ webuiHost: '127.0.0.1', webuiPort })),
    { webuiHost: '127.0.0.1', webuiPort: 6661, webuiTls: { enabled: true } },
    { webuiHost: '127.0.0.1', webuiPort: 6661, webuiTls: { enabled: 'false' } }
  ];
  for (const config of configs) {
    const f = fixture();
    fs.writeFileSync(path.join(f.home, 'config', 'runtime.json'), JSON.stringify(config));
    const launcher = f.create();
    assert.equal(launcher.getStatus().webuiUrl, null);
    const result = await launcher.start();
    assert.equal(result.error, 'WEBUI_CONFIG_INVALID');
    assert.equal(result.webuiUrl, null);
    assert.equal(f.calls.exec.length + f.calls.spawn.length, 0);
  }
});

test('malformed, oversized or non-regular runtime files do not silently fall back to the default port', async () => {
  for (const contents of ['not-json', 'null', '[]', ' '.repeat(1024 * 1024 + 1)]) {
    const f = fixture();
    fs.writeFileSync(path.join(f.home, 'config', 'runtime.json'), contents);
    const launcher = f.create();
    assert.equal(launcher.getStatus().webuiUrl, null);
    assert.equal((await launcher.start()).error, 'WEBUI_CONFIG_INVALID');
    assert.equal(f.calls.spawn.length, 0);
  }
  const directory = fixture();
  fs.mkdirSync(path.join(directory.home, 'config', 'runtime.json'));
  assert.equal((await directory.create().start()).error, 'WEBUI_CONFIG_INVALID');
  const escaped = fixture();
  const file = path.join(escaped.home, 'config', 'runtime.json');
  fs.writeFileSync(file, '{}');
  const guardedFs = new Proxy(fs, { get(base, key) {
    if (key === 'realpathSync') return (target) => target === file ? 'D:\\outside\\runtime.json' : base.realpathSync(target);
    return base[key];
  } });
  const launcher = escaped.create({ fs: guardedFs });
  assert.equal(launcher.getStatus().webuiUrl, null);
  assert.equal((await launcher.start()).error, 'WEBUI_CONFIG_INVALID');
});

test('an owner-only incomplete receipt does not claim that SnowLuma is already running', async () => {
  const f = fixture();
  f.writeReceipt({ ownerPid: f.ownerPid, childPid: null, startedAt: 0 });
  const launcher = f.create();
  const result = await launcher.start();
  assert.equal(result.error, 'START_PENDING');
  assert.equal(result.ok, false);
  assert.equal(result.started, false);
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.launching, true);
  assert.equal(launcher.getStatus().state, 'pending');
  assert.equal(launcher.getStatus().error, 'START_PENDING');
  assert.equal(f.calls.spawn.length, 0);
});

test('broken optional runtime or config symlinks are not mistaken for missing defaults', async () => {
  for (const entry of ['config', 'runtime.json']) {
    const f = fixture();
    const runtimeFile = path.join(f.home, 'config', 'runtime.json');
    fs.writeFileSync(runtimeFile, '{}');
    const target = entry === 'config' ? path.dirname(runtimeFile) : runtimeFile;
    const guardedFs = new Proxy(fs, { get(base, key) {
      if (key === 'existsSync') return (file) => file === target ? false : base.existsSync(file);
      if (key === 'lstatSync') return (file) => {
        const stat = base.lstatSync(file);
        if (file === target) stat.isSymbolicLink = () => true;
        return stat;
      };
      return base[key];
    } });
    const launcher = f.create({ fs: guardedFs });
    assert.equal(launcher.getStatus().webuiUrl, null);
    assert.equal((await launcher.start()).error, 'WEBUI_CONFIG_INVALID');
    assert.equal(f.calls.spawn.length, 0);
  }
});

test('an occupied or uncertain local port never causes a second instance to start', async () => {
  for (const portProbe of [async () => true, async () => undefined, async () => { throw new Error('raw port error'); }]) {
    const f = fixture();
    const result = await f.create({ portProbe }).start();
    assert.equal(['PORT_IN_USE', 'PRECHECK_FAILED'].includes(result.error), true);
    assert.equal(f.calls.exec.length + f.calls.spawn.length, 0);
    assert.equal(fs.existsSync(f.receiptFile), false);
  }
});

test('SnowLuma required Node range is checked independently of the bundled checker', async () => {
  for (const version of ['v24.22.1', 'v24.23.0', 'v26.12.1', 'v26.13.0', 'v27.0.0']) {
    const f = fixture();
    f.setVersion(version);
    assert.equal((await f.create().start()).started, true, version);
  }
  for (const version of ['v18.20.8', 'v24.22.0', 'v25.0.0', 'v26.12.0', 'v24.22.1-beta', '24.22.1', 'v24.22.1\nextra-output']) {
    const f = fixture();
    f.setVersion(version);
    assert.equal((await f.create().start()).error, 'NODE_VERSION_UNSUPPORTED', version);
    assert.equal(f.calls.spawn.length, 0);
  }
});

test('checker failures and raw subprocess output are sanitized and never start QQ', async () => {
  const f = fixture();
  let calls = 0;
  const result = await f.create({ execFile: (_file, _args, _options, callback) => {
    calls++;
    queueMicrotask(() => calls === 1 ? callback(null, 'v24.22.1\n') : callback(new Error('D:/raw-path secret-token'), 'raw secret stdout', 'raw secret stderr'));
  } }).start();
  assert.equal(result.error, 'NODE_CHECK_FAILED');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('D:/raw-path'), false);
  assert.equal(f.calls.spawn.length, 0);
});

test('a checker that never completes is bounded by a short host timeout', async () => {
  const f = fixture();
  const result = await f.create({ execFile: () => {}, checkTimeoutMs: 5 }).start();
  assert.equal(result.error, 'NODE_CHECK_FAILED');
  assert.equal(f.calls.spawn.length, 0);
});

test('installation paths are revalidated after the checker and before runtime startup', async () => {
  const f = fixture();
  const originalExec = f.settings.execFile;
  const result = await f.create({ execFile: (file, args, options, callback) => originalExec(file, args, options, (error, output) => {
    if (args[0] !== '--version') fs.unlinkSync(path.join(f.home, 'index.mjs'));
    callback(error, output);
  }) }).start();
  assert.equal(result.error, 'INVALID_INSTALL');
  assert.equal(f.calls.spawn.length, 0);
});

test('synchronous spawn failures are sanitized, release the receipt and enter a finite cooldown', async () => {
  const f = fixture();
  const launcher = f.create({ spawn: () => { throw new Error('secret failure command-line'); } });
  const result = await launcher.start();
  assert.equal(result.error, 'START_FAILED');
  assert.equal(result.launching, false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(fs.existsSync(f.receiptFile), false);
  assert.equal((await launcher.start()).error, 'COOLDOWN');
});

test('asynchronous spawn errors are handled without emitting raw output or auto-restarting', async () => {
  const f = fixture();
  let spawnCalls = 0;
  const launcher = f.create({ spawn: () => {
    spawnCalls++;
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit('error', new Error('secret child error')));
    return child;
  } });
  assert.equal((await launcher.start()).error, 'START_FAILED');
  assert.equal(fs.existsSync(f.receiptFile), false);
  assert.equal((await launcher.start()).error, 'COOLDOWN');
  assert.equal(spawnCalls, 1);
});

test('pending starts retain their process guard and do not create another instance', async () => {
  const f = fixture();
  let child;
  let spawnCalls = 0;
  const launcher = f.create({ spawnTimeoutMs: 5, spawn: () => {
    spawnCalls++;
    child = new EventEmitter();
    child.pid = 991234;
    child.unref = () => {};
    f.alive.add(child.pid);
    return child;
  } });
  const pending = await launcher.start();
  assert.equal(pending.error, 'START_PENDING');
  assert.equal(pending.launching, true);
  assert.equal((await launcher.start()).alreadyRunning, true);
  assert.equal(spawnCalls, 1);
  child.emit('spawn');
  assert.equal(launcher.getStatus().error, null);
});

test('receipt-write failures after spawn keep listeners, unref and duplicate protection intact', async () => {
  const f = fixture();
  const guardedFs = new Proxy(fs, { get(base, key) {
    if (key === 'writeFileSync') return (file, content, options) => {
      if (file === f.receiptFile && options?.flag === 'r+') throw new Error('synthetic receipt write error');
      return base.writeFileSync(file, content, options);
    };
    return base[key];
  } });
  const launcher = f.create({ fs: guardedFs });
  const result = await launcher.start();
  assert.equal(result.ok, false);
  assert.equal(result.launching, true);
  assert.equal(f.child.unrefCalled, true);
  assert.equal(f.child.listenerCount('error') > 0, true);
  assert.equal((await launcher.start()).alreadyRunning, true);
  f.child.emit('error', new Error('no unhandled event'));
  assert.equal(launcher.getStatus().error, 'START_FAILED');
});

test('runtime exits are recorded without infinite restart and the explicit retry cooldown expires', async () => {
  const f = fixture();
  const launcher = f.create();
  await launcher.start();
  f.child.emit('exit', 1, null);
  assert.equal(launcher.getStatus().error, 'RUNTIME_EXITED');
  assert.equal(fs.existsSync(f.receiptFile), false);
  assert.equal((await launcher.start()).error, 'COOLDOWN');
  assert.equal(f.calls.spawn.length, 1);
  f.setClock(230001);
  assert.equal((await launcher.start()).started, true);
  assert.equal(f.calls.spawn.length, 2);
});

test('a replaced receipt is never deleted by a previous child exit callback', async () => {
  const f = fixture();
  await f.create().start();
  f.writeReceipt({ id: 'replacement-id' });
  f.child.emit('exit', 0, null);
  assert.equal(JSON.parse(fs.readFileSync(f.receiptFile, 'utf8')).id, 'replacement-id');
});

let passed = 0;
try {
  for (const { name, run } of tests) {
    try {
      await run();
      passed++;
      console.log(`PASS ${name}`);
    } catch (error) {
      console.error(`FAIL ${name}`);
      console.error(error);
      process.exitCode = 1;
    }
  }
  console.log(`SnowLuma launcher: ${passed}/${tests.length} offline tests passed; no QQ or model process was started.`);
} finally {
  const resolved = path.resolve(testRoot);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('qq-snowluma-launcher-test-')) {
    throw new Error('Refusing cleanup outside the named launcher test directory');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
