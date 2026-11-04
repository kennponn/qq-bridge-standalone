import fsNative from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn as spawnNative, execFile as execFileNative } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const winPath = path.win32;
const LOCK_NAME = 'snowluma-launcher.lock.json';
const DEFAULT_STATE_DIR = fileURLToPath(new URL('../state/', import.meta.url));
const MESSAGES = {
  UNSUPPORTED_PLATFORM: 'SnowLuma startup is available only on Windows.',
  INVALID_OPTIONS: 'Only the boolean autoLoad option is accepted.',
  INVALID_INSTALL: 'The configured local SnowLuma installation failed validation.',
  INVALID_STATE_DIR: 'The local launcher state directory failed validation.',
  WEBUI_CONFIG_INVALID: 'SnowLuma management must use supported loopback HTTP settings and a valid port.',
  STATE_UNAVAILABLE: 'The local launcher state could not be updated safely.',
  CLAIM_BUSY: 'Launcher state has an outstanding claim. Inspect and repair local launcher state before retrying.',
  ALREADY_RUNNING: 'A SnowLuma connection or launcher process is already active.',
  PORT_IN_USE: 'A local SnowLuma port is already in use; inspect the running gateway first.',
  COOLDOWN: 'Wait briefly before attempting another SnowLuma launch.',
  PRECHECK_FAILED: 'The existing-connection check failed; no second instance was started.',
  NODE_VERSION_UNSUPPORTED: 'The bundled Node version does not meet SnowLuma requirements.',
  NODE_CHECK_FAILED: 'The bundled SnowLuma Node check failed.',
  START_FAILED: 'SnowLuma could not be started. Check its local logs.',
  START_PENDING: 'SnowLuma startup is pending or unconfirmed. No second instance was started.',
  RUNTIME_EXITED: 'The launched SnowLuma process exited. Check its local logs.',
  LAUNCHING: 'SnowLuma was started; gateway connection is not yet confirmed.',
  IDLE: 'SnowLuma has not been started by this launcher.'
};

function failure(code) {
  const error = new Error(code);
  error.launcherCode = code;
  return error;
}

function localAbsolute(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:[\\/]/.test(value)
    || /[\x00-\x1f\x7f<>"|?*]/.test(value) || value.slice(2).includes(':')
    || value.split(/[\\/]/).some((part) => part === '..' || /[. ]$/.test(part))) {
    throw failure('INVALID_INSTALL');
  }
  const resolved = winPath.normalize(value);
  if (resolved.toLowerCase() === winPath.parse(resolved).root.toLowerCase()) throw failure('INVALID_INSTALL');
  return resolved.replace(/[\\/]+$/, '');
}

function samePath(a, b) {
  return winPath.normalize(a).replace(/[\\/]+$/, '').toLowerCase()
    === winPath.normalize(b).replace(/[\\/]+$/, '').toLowerCase();
}

function assertDirectory(fs, directory, code = 'INVALID_INSTALL') {
  const parsed = winPath.parse(directory);
  let current = parsed.root;
  for (const component of directory.slice(parsed.root.length).split(/[\\/]/).filter(Boolean)) {
    current = winPath.join(current, component);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(current), current)) throw failure(code);
  }
}

function assertFile(fs, file, directory, code = 'INVALID_INSTALL') {
  const stat = fs.lstatSync(file);
  const actual = fs.realpathSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(actual, file)
    || !samePath(winPath.dirname(actual), directory)) throw failure(code);
  return stat;
}

function isSupportedVersion(value) {
  const match = /^v(\d+)\.(\d+)\.(\d+)\s*$/.exec(value);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (major === 24 && (minor > 22 || (minor === 22 && patch >= 1)))
    || (major === 26 && (minor > 12 || (minor === 12 && patch >= 1))) || major > 26;
}

function livePid(pid, kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}

function nativePortProbe(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (busy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(busy);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', (error) => finish(error?.code !== 'ECONNREFUSED'));
    // A timeout cannot prove the port is free, so do not launch another instance.
    socket.setTimeout(timeoutMs, () => finish(true));
  });
}

function boundedPromise(promise, timeoutMs, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

/** Host-configured executable only. The HTTP caller can opt in to auto-load, not supply commands. */
export function createSnowLumaLauncher({
  cfg,
  stateDir = DEFAULT_STATE_DIR,
  platform = process.platform,
  fs = fsNative,
  spawn = spawnNative,
  execFile = execFileNative,
  kill = process.kill.bind(process),
  now = Date.now,
  ownerPid = process.pid,
  isConnected = async () => false,
  portProbe = nativePortProbe,
  env = process.env,
  cooldownMs = 30000,
  checkTimeoutMs = 3000,
  preflightTimeoutMs = 3000,
  spawnTimeoutMs = 5000
} = {}) {
  let busy = false;
  let child = null;
  let childAlive = false;
  let phase = platform === 'win32' ? 'idle' : 'unsupported';
  let errorCode = platform === 'win32' ? null : 'UNSUPPORTED_PLATFORM';
  let lastAttempt = null;
  let autoLoadRequested = false;
  let lock = null;
  let packagePaths = null;

  const retryAfterMs = () => lastAttempt === null ? 0 : Math.max(0, cooldownMs - (now() - lastAttempt));
  const response = (code = errorCode, flags = {}) => ({
    ok: !code || code === 'ALREADY_RUNNING',
    supported: platform === 'win32',
    state: phase,
    started: childAlive && phase === 'launching',
    alreadyRunning: phase === 'alreadyRunning',
    launching: busy || childAlive || phase === 'pending',
    error: code && code !== 'ALREADY_RUNNING' ? code : null,
    message: MESSAGES[code || (phase === 'alreadyRunning' ? 'ALREADY_RUNNING' : phase === 'launching' ? 'LAUNCHING' : 'IDLE')],
    retryAfterMs: retryAfterMs(),
    autoLoadRequested,
    ...webuiStatus(),
    ...flags
  });

  function validate() {
    try {
      const sl = cfg?.snowluma;
      const home = localAbsolute(sl?.homeDir);
      assertDirectory(fs, home);
      const files = {
        home,
        node: winPath.join(home, 'node.exe'),
        index: winPath.join(home, 'index.mjs'),
        checker: winPath.join(home, 'check-node-version.cjs')
      };
      for (const file of [files.node, files.index, files.checker]) assertFile(fs, file, home);
      if (sl.launcherPath !== undefined && sl.launcherPath !== null && sl.launcherPath !== '') {
        const launcher = localAbsolute(sl.launcherPath);
        if (!samePath(launcher, winPath.join(home, 'launcher.bat'))) throw failure('INVALID_INSTALL');
        assertFile(fs, launcher, home);
      }
      return files;
    } catch { throw failure('INVALID_INSTALL'); }
  }

  function validateState() {
    try {
      const directory = localAbsolute(stateDir);
      assertDirectory(fs, directory, 'INVALID_STATE_DIR');
      return { directory, file: winPath.join(directory, LOCK_NAME), guard: winPath.join(directory, `${LOCK_NAME}.claim`) };
    } catch { throw failure('INVALID_STATE_DIR'); }
  }

  function readReceipt(location) {
    if (!fs.existsSync(location.file)) return null;
    try {
      const stat = assertFile(fs, location.file, location.directory, 'STATE_UNAVAILABLE');
      if (stat.size > 4096) throw failure('STATE_UNAVAILABLE');
      const receipt = JSON.parse(fs.readFileSync(location.file, 'utf8'));
      if (receipt?.version !== 1 || typeof receipt.id !== 'string' || receipt.id.length > 80
        || !Number.isSafeInteger(receipt.ownerPid) || receipt.ownerPid <= 0
        || !(receipt.childPid === null || (Number.isSafeInteger(receipt.childPid) && receipt.childPid > 0))
        || !Number.isFinite(receipt.startedAt) || typeof receipt.autoLoadRequested !== 'boolean') {
        throw failure('STATE_UNAVAILABLE');
      }
      return receipt;
    } catch { throw failure('STATE_UNAVAILABLE'); }
  }

  function releaseReceipt() {
    if (!lock) return;
    try {
      const current = readReceipt(lock.location);
      if (current?.id === lock.receipt.id) fs.unlinkSync(lock.location.file);
    } catch { /* A changed or unsafe receipt must never be removed. */ }
    lock = null;
  }

  function claimReceipt() {
    const location = validateState();
    const guardId = randomUUID();
    try {
      fs.writeFileSync(location.guard, guardId, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code === 'EEXIST') throw failure('CLAIM_BUSY');
      throw failure('STATE_UNAVAILABLE');
    }
    try {
      const existing = readReceipt(location);
      if (existing) {
        if (livePid(existing.childPid, kill)) {
          autoLoadRequested = existing.autoLoadRequested;
          return 'active';
        }
        if (livePid(existing.ownerPid, kill) || now() - existing.startedAt < 120000) {
          autoLoadRequested = existing.autoLoadRequested;
          return 'pending';
        }
        // The exclusive claim guard also serializes stale-receipt reclamation across bridge instances.
        fs.unlinkSync(location.file);
      }
      const receipt = { version: 1, id: randomUUID(), ownerPid, childPid: null, startedAt: now(), autoLoadRequested };
      try {
        fs.writeFileSync(location.file, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
        lock = { location, receipt };
        return 'claimed';
      } catch (error) {
        if (error?.code === 'EEXIST') throw failure('CLAIM_BUSY');
        throw failure('STATE_UNAVAILABLE');
      }
    } finally {
      try {
        assertFile(fs, location.guard, location.directory, 'STATE_UNAVAILABLE');
        if (fs.readFileSync(location.guard, 'utf8') === guardId) fs.unlinkSync(location.guard);
      } catch { /* Never remove a replaced guard; a crashed claim requires manual state repair. */ }
    }
  }

  function saveChildPid(pid) {
    if (!lock || !Number.isSafeInteger(pid) || pid <= 0) throw failure('STATE_UNAVAILABLE');
    const current = readReceipt(lock.location);
    if (current?.id !== lock.receipt.id) throw failure('STATE_UNAVAILABLE');
    lock.receipt.childPid = pid;
    // Short numeric PIDs must truncate the old null value instead of leaving trailing JSON.
    fs.writeFileSync(lock.location.file, JSON.stringify(lock.receipt), { flag: 'w', mode: 0o600 });
  }

  function readWebuiConfiguration(home) {
    try {
      const hasEntry = (file) => {
        try { fs.lstatSync(file); return true; }
        catch (error) {
          if (error?.code === 'ENOENT') return false;
          throw failure('WEBUI_CONFIG_INVALID');
        }
      };
      const directory = winPath.join(home, 'config');
      let config = {};
      if (hasEntry(directory)) {
        assertDirectory(fs, directory, 'WEBUI_CONFIG_INVALID');
        const file = winPath.join(directory, 'runtime.json');
        if (hasEntry(file)) {
          const stat = assertFile(fs, file, directory, 'WEBUI_CONFIG_INVALID');
          if (stat.size > 1024 * 1024) throw failure('WEBUI_CONFIG_INVALID');
          config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('WEBUI_CONFIG_INVALID');
        }
      }
      const host = config.webuiHost === undefined ? '127.0.0.1' : config.webuiHost;
      if (typeof host !== 'string' || host.trim() !== '127.0.0.1') {
        throw failure('WEBUI_CONFIG_INVALID');
      }
      const port = config.webuiPort === undefined ? 5099 : config.webuiPort;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('WEBUI_CONFIG_INVALID');
      if (config.webuiTls !== undefined && (!config.webuiTls || typeof config.webuiTls !== 'object'
        || Array.isArray(config.webuiTls) || (config.webuiTls.enabled !== undefined && config.webuiTls.enabled !== false))) {
        throw failure('WEBUI_CONFIG_INVALID');
      }
      return { port, url: `http://127.0.0.1:${port}` };
    } catch { throw failure('WEBUI_CONFIG_INVALID'); }
  }

  function webuiStatus() {
    let webuiUrl = null;
    if (platform === 'win32') {
      try { webuiUrl = readWebuiConfiguration(validate().home).url; } catch { /* Status cannot launch or expose unsafe configuration. */ }
    }
    return {
      webuiUrl,
      webuiUrlSource: webuiUrl ? 'configured' : null,
      webuiHint: 'The configured management address is not a connection check; an external runtime may use a different address.'
    };
  }

  function configuredPorts(home) {
    const ports = new Set([3000, 3001, readWebuiConfiguration(home).port]);
    for (const raw of [cfg?.snowluma?.httpUrl, cfg?.snowluma?.wsUrl]) {
      try {
        const url = new URL(raw);
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
          const port = Number(url.port) || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80);
          if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
        }
      } catch { /* No remote requests or credentials are used for port checks. */ }
    }
    const directory = winPath.join(home, 'config');
    if (!fs.existsSync(directory)) return [...ports];
    assertDirectory(fs, directory);
    const entries = fs.readdirSync(directory).filter((name) => /^onebot_\d+\.json$/i.test(name));
    if (entries.length > 100) throw failure('INVALID_INSTALL');
    for (const name of entries) {
      const file = winPath.join(directory, name);
      const stat = assertFile(fs, file, directory);
      if (stat.size > 1024 * 1024) throw failure('INVALID_INSTALL');
      let config;
      try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      for (const network of ['httpServers', 'wsServers']) {
        for (const server of Array.isArray(config?.networks?.[network]) ? config.networks[network] : []) {
          const port = Number(server?.port);
          if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
          if (ports.size > 128) throw failure('INVALID_INSTALL');
        }
      }
    }
    return [...ports];
  }

  function childEnv(autoLoad) {
    const clean = { ...env };
    const blocked = new Set([
      'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'SNOWLUMA_ACCEPT_EULA', 'SNOWLUMA_ACCEPT_PRIVACY',
      'SNOWLUMA_HOOK_AUTOLOAD', 'SNOWLUMA_WEBUI_PORT', 'SNOWLUMA_WEBUI_HOST', 'SNOWLUMA_WEBUI_TLS', 'SNOWLUMA_WEBUI_TRUST_PROXY'
    ]);
    for (const key of Object.keys(clean)) if (blocked.has(key.toUpperCase())) delete clean[key];
    clean.SNOWLUMA_HOOK_AUTOLOAD = autoLoad ? '1' : '0';
    return clean;
  }

  function runCheck(file, args, environment, code) {
    return boundedPromise(new Promise((resolve, reject) => {
      try {
        execFile(file, args, {
          cwd: packagePaths.home, env: environment, shell: false, windowsHide: true,
          timeout: checkTimeoutMs, maxBuffer: 4096, encoding: 'utf8'
        }, (error, stdout) => error ? reject(failure(code)) : resolve(String(stdout || '')));
      } catch { reject(failure(code)); }
    }), checkTimeoutMs + 250, code);
  }

  function launch(environment) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      let timer;
      try {
        child = spawn(packagePaths.node, [packagePaths.index], {
          cwd: packagePaths.home, env: environment, detached: true,
          shell: false, windowsHide: true, stdio: 'ignore'
        });
        childAlive = true;
        child.once('error', () => {
          childAlive = false;
          phase = 'error';
          errorCode = 'START_FAILED';
          releaseReceipt();
          finish(failure('START_FAILED'));
        });
        child.once('exit', () => {
          childAlive = false;
          phase = 'error';
          errorCode = 'RUNTIME_EXITED';
          releaseReceipt();
          finish(failure('RUNTIME_EXITED'));
        });
        child.once('spawn', () => {
          try {
            if (!childAlive) throw failure('RUNTIME_EXITED');
            saveChildPid(child.pid);
            phase = 'launching';
            errorCode = null;
            finish();
          } catch {
            // Retain the handle and receipt if the process started but its receipt write failed.
            phase = 'error';
            errorCode = 'STATE_UNAVAILABLE';
            finish(failure('STATE_UNAVAILABLE'));
          }
        });
        timer = setTimeout(() => {
          phase = 'launching';
          errorCode = 'START_PENDING';
          finish(failure('START_PENDING'));
        }, spawnTimeoutMs);
        child.unref();
        if (Number.isSafeInteger(child.pid) && child.pid > 0) saveChildPid(child.pid);
      } catch {
        // A live child is retained even if updating its receipt failed.
        if (!childAlive) releaseReceipt();
        finish(failure('START_FAILED'));
      }
    });
  }

  async function start(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => key !== 'autoLoad')
      || (options.autoLoad !== undefined && typeof options.autoLoad !== 'boolean')) {
      return response('INVALID_OPTIONS', { ok: false, started: false });
    }
    if (platform !== 'win32') {
      phase = 'unsupported';
      errorCode = 'UNSUPPORTED_PLATFORM';
      return response();
    }
    if (busy) return response(null, { started: false, launching: true, state: 'checking' });
    if (childAlive) {
      phase = 'alreadyRunning';
      return response('ALREADY_RUNNING', { started: false, alreadyRunning: true });
    }
    if (retryAfterMs() > 0) {
      phase = 'cooldown';
      return response('COOLDOWN', { started: false });
    }
    busy = true;
    phase = 'checking';
    errorCode = null;
    autoLoadRequested = options.autoLoad === true;
    try {
      packagePaths = validate();
      let connected;
      try { connected = await boundedPromise(Promise.resolve().then(isConnected), preflightTimeoutMs, 'PRECHECK_FAILED'); }
      catch { throw failure('PRECHECK_FAILED'); }
      if (typeof connected !== 'boolean') throw failure('PRECHECK_FAILED');
      if (connected === true) {
        phase = 'alreadyRunning';
        return response('ALREADY_RUNNING', { started: false, alreadyRunning: true, launching: false });
      }
      const claim = claimReceipt();
      if (claim === 'active') {
        phase = 'alreadyRunning';
        return response('ALREADY_RUNNING', { started: false, alreadyRunning: true, launching: false });
      }
      if (claim === 'pending') {
        phase = 'pending';
        errorCode = 'START_PENDING';
        return response('START_PENDING', { started: false, alreadyRunning: false, launching: true });
      }
      lastAttempt = now();
      let occupied;
      const ports = configuredPorts(packagePaths.home);
      try {
        occupied = await boundedPromise(Promise.all(ports.map((port) => portProbe(port, 500))), preflightTimeoutMs, 'PRECHECK_FAILED');
      } catch { throw failure('PRECHECK_FAILED'); }
      if (occupied.some((value) => value !== false)) throw failure('PORT_IN_USE');
      const environment = childEnv(autoLoadRequested);
      const version = await runCheck(packagePaths.node, ['--version'], environment, 'NODE_CHECK_FAILED');
      if (!isSupportedVersion(version)) throw failure('NODE_VERSION_UNSUPPORTED');
      await runCheck(packagePaths.node, [packagePaths.checker], environment, 'NODE_CHECK_FAILED');
      validate();
      await launch(environment);
      return response(null, { started: true, launching: true });
    } catch (error) {
      const code = error?.launcherCode && MESSAGES[error.launcherCode] ? error.launcherCode : 'START_FAILED';
      if (!childAlive) releaseReceipt();
      if (phase !== 'launching') phase = 'error';
      errorCode = code;
      return response(code, { started: false, launching: childAlive });
    } finally { busy = false; }
  }

  return { start, getStatus: () => response() };
}
