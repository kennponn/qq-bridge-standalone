// No online speech, QQ, provider process, or real audio is used here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSpeechService, resolveVoiceSettings, mergeVoiceSettings, validateSpeechText, SPEECH_VOICES } from '../src/voice-speech.js';

const STAGE = path.resolve(import.meta.dirname, '..');
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MP3 = Buffer.from('ID3FIXTURE-NOT-REAL-AUDIO');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('Fixture did not reach expected state.'); await delay(1); }
}
function allowedConfig() {
  return { enabled: true, tts: { enabled: true, onlineConsent: true, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, maxChars: 300, maxSeconds: 90 } };
}
async function fixture(runTest, { run, probe, audit, config = allowedConfig() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speech-fixture-'));
  fs.mkdirSync(path.join(root, 'state'));
  const calls = { checks: [], synth: [], probes: [], audits: [] };
  let clock = Date.now();
  const service = createSpeechService({ root, getConfig: () => config, now: () => clock,
    auditText: text => { calls.audits.push(text); if (audit) audit(text); },
    run: async options => {
      if (options.check) { calls.checks.push(options); if (run) return run(options); return { ok: true }; }
      calls.synth.push(options);
      if (run) return run(options);
      fs.writeFileSync(options.output, MP3, { flag: 'wx' });
      return { ok: true };
    },
    probe: async (...args) => { calls.probes.push(args); return probe ? probe(...args) : { ok: true, codec: 'mp3', duration: 2 }; },
  });
  try { await runTest({ root, service, calls, config, advance: milliseconds => { clock += milliseconds; } }); }
  finally {
    service.invalidate();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const cacheFiles = root => fs.existsSync(path.join(root, 'state/voice-previews'))
  ? fs.readdirSync(path.join(root, 'state/voice-previews')) : [];

test('speech defaults fail closed and normalized caps cannot grow beyond bounded limits', () => {
  const defaults = resolveVoiceSettings();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.tts.enabled, false);
  assert.equal(defaults.tts.onlineConsent, false);
  assert.ok(SPEECH_VOICES.every(voice => voice.gender === 'female'));
  const large = resolveVoiceSettings({ incoming: { timeoutMs: 999999, maxChars: 999999 },
    tts: { rate: 999, maxChars: 999999, timeoutMs: 999999, maxSeconds: 999999 } });
  assert.equal(large.incoming.timeoutMs, 30000);
  assert.equal(large.incoming.maxChars, 4000);
  assert.equal(large.tts.rate, 50);
  assert.equal(large.tts.maxChars, 300);
  assert.equal(large.tts.timeoutMs, 60000);
  assert.equal(large.tts.maxSeconds, 90);
  const small = resolveVoiceSettings({ incoming: { timeoutMs: -1, maxChars: -1 }, tts: { rate: -99, maxChars: -1, timeoutMs: -1, maxSeconds: -1 } });
  assert.equal(small.incoming.timeoutMs, 1000);
  assert.equal(small.incoming.maxChars, 100);
  assert.equal(small.tts.rate, -50);
  assert.equal(small.tts.maxChars, 20);
  assert.equal(small.tts.timeoutMs, 5000);
  assert.equal(small.tts.maxSeconds, 5);
});

test('operator settings reject unknown paths/provider controls, invalid voice and non-integer limits', () => {
  const cases = [null, [], 'bad', { path: '../outside' }, { enabled: 'yes' },
    { tts: { provider: 'arbitrary' } }, { tts: { voice: '../outside' } }, { tts: { onlineConsent: 'true' } },
    { tts: { rate: 1.5 } }, { tts: { rate: '+5%' } }, { tts: { maxChars: 301 } },
    { tts: { maxSeconds: 91 } }, { tts: { timeoutMs: 60001 } }, { incoming: { maxChars: 4001 } }];
  for (const patch of cases) assert.throws(() => mergeVoiceSettings(allowedConfig(), patch), undefined, JSON.stringify(patch));
  const next = mergeVoiceSettings({ ...allowedConfig(), dir: 'audio', maxBytes: 1000 },
    { tts: { voice: 'zh-CN-XiaoyiNeural', rate: -10 } });
  assert.equal(next.dir, 'audio');
  assert.equal(next.maxBytes, 1000);
  assert.equal(next.tts.voice, 'zh-CN-XiaoyiNeural');
  assert.equal(next.tts.rate, -10);
});

test('plain text validation rejects empty, controls, objects and more than the configured codepoint cap', () => {
  for (const value of [null, {}, 123, '', ' \n ', 'hello\x00', 'x'.repeat(301)]) assert.throws(() => validateSpeechText(value));
  assert.equal(validateSpeechText(' hello\r\nworld '), 'hello\nworld');
  assert.equal(validateSpeechText('🙂'.repeat(300)), '🙂'.repeat(300));
  assert.throws(() => validateSpeechText('🙂'.repeat(301)));
});

test('missing online consent blocks even local worker readiness checks', () => fixture(async ({ service, calls, root }) => {
  await assert.rejects(service.synthesize('fixture speech'), error => error.statusCode === 403);
  assert.equal(calls.checks.length, 0);
  assert.equal(calls.synth.length, 0);
  assert.equal(calls.audits.length, 0);
  assert.deepEqual(cacheFiles(root), []);
}, { config: { enabled: true, tts: { enabled: true, onlineConsent: false } } }));

test('outbound audit and session authorization precede worker/provider access', () => fixture(async ({ service, calls }) => {
  await assert.rejects(service.synthesize('fixture secret'), /audit refused/);
  assert.equal(calls.checks.length, 0);
  assert.equal(calls.synth.length, 0);
}, { audit: () => { throw new Error('audit refused'); } }));

test('invalid voice/rate and configured shorter text cap fail before readiness checks', () => fixture(async ({ service, calls }) => {
  for (const options of [{ voice: 'not-a-voice' }, { rate: 51 }, { rate: -51 }, { rate: 1.5 }, { rate: '+0%' }]) {
    await assert.rejects(service.synthesize('fixture', options), error => error.statusCode === 400);
  }
  await assert.rejects(service.synthesize('x'.repeat(21)), error => error.statusCode === 400);
  assert.equal(calls.checks.length, 0);
  assert.equal(calls.synth.length, 0);
}, { config: { ...allowedConfig(), tts: { ...allowedConfig().tts, maxChars: 20 } } }));

test('health probes only installed worker imports and caches readiness without generating speech', () => fixture(async ({ service, calls, advance }) => {
  assert.equal((await service.health()).ttsInstalled, true);
  assert.equal((await service.health()).ttsReady, true);
  await service.health();
  assert.equal(calls.checks.length, 1);
  assert.equal(calls.checks[0].check, true);
  assert.equal(calls.checks[0].text, undefined);
  assert.equal(calls.checks[0].output, undefined);
  assert.equal(calls.synth.length, 0);
  advance(60001);
  await service.health();
  assert.equal(calls.checks.length, 2);
  const worker = fs.readFileSync(path.join(STAGE, 'scripts/edge-speech-worker.py'), 'utf8');
  assert.match(worker, /if sys\.argv\[1:\] == \["--check"\]:[\s\S]*?return/);
  assert.ok(worker.indexOf('return') < worker.indexOf('edge_tts.Communicate'));
}));

test('revocation or cancellation during readiness prevents any private text upload', async () => {
  for (const kind of ['consent', 'enabled', 'abort']) {
    const gate = deferred();
    const controller = new AbortController();
    await fixture(async ({ service, config, calls, root }) => {
      const pending = service.synthesize('fixture must never leave this process', { signal: controller.signal });
      const rejected = assert.rejects(pending, error => error.statusCode === 409);
      await until(() => calls.checks.length === 1);
      assert.equal(calls.synth.length, 0);
      if (kind === 'consent') config.tts.onlineConsent = false;
      if (kind === 'enabled') config.tts.enabled = false;
      if (kind === 'abort') controller.abort();
      gate.resolve();
      await rejected;
      assert.equal(calls.synth.length, 0, 'Readiness completion cannot upload after authority was revoked.');
      assert.deepEqual(cacheFiles(root), []);
    }, { run: async options => {
      assert.equal(options.check, true, 'A synthesis worker must never start in this fixture.');
      await gate.promise;
      return { ok: true };
    } });
  }
});

test('successful generated output uses opaque IDs, expires in ten minutes and cannot be resent', () => fixture(async ({ service, root, calls, advance }) => {
  const entry = await service.synthesize('A fixture speech.');
  assert.match(entry.id, ID);
  assert.equal(path.basename(entry.file), entry.id + '.mp3');
  assert.ok(entry.file.startsWith(path.join(root, 'state/voice-previews') + path.sep));
  assert.equal(entry.text, 'A fixture speech.');
  assert.equal(entry.duration, 2);
  assert.equal(calls.synth.length, 1);
  assert.equal(calls.synth[0].voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(calls.synth[0].rate, 0);
  assert.equal(service.get(entry.id), entry);
  for (const bad of ['../outside', 'https://example.invalid/file.mp3', 'file:///tmp/test', 'not-a-uuid']) assert.throws(() => service.get(bad));
  const gate = deferred();
  const using = service.use(entry.id, async () => { await gate.promise; return { ok: true }; });
  await assert.rejects(service.use(entry.id, async () => { assert.fail('Duplicate must not call sender.'); }), error => error.statusCode === 409);
  gate.resolve();
  assert.deepEqual(await using, { ok: true });
  await assert.rejects(service.use(entry.id, async () => { assert.fail('Used entry must not call sender.'); }), error => error.statusCode === 409);
  advance(10 * 60000 + 1);
  assert.throws(() => service.get(entry.id), error => error.statusCode === 404);
  assert.equal(fs.existsSync(entry.file), false);
}));

test('third parallel synthesis is refused and at most two workers produce audio', () => fixture(async ({ service, calls }) => {
  const one = service.synthesize('first'), two = service.synthesize('second');
  await until(() => calls.synth.length === 2);
  await assert.rejects(service.synthesize('third'), error => error.statusCode === 429);
  assert.equal(calls.synth.length, 2);
  gates.forEach(gate => gate.resolve());
  await Promise.all([one, two]);
}, { run: async options => {
  if (options.check) return { ok: true };
  const gate = deferred(); gates.push(gate);
  await gate.promise;
  fs.writeFileSync(options.output, MP3);
  return { ok: true };
} }));
const gates = [];

test('concurrent synthesis reserves the twenty-entry preview cache cap', () => {
  const waiting = [];
  let hold = false;
  return fixture(async ({ service, calls }) => {
    for (let i = 0; i < 19; i++) await service.synthesize(`cached-${i}`);
    hold = true;
    const first = service.synthesize('twentieth');
    await until(() => calls.synth.length === 20);
    const second = assert.rejects(service.synthesize('twenty-first'), error => error.statusCode === 429);
    // Resolve any incorrectly admitted worker too so this fixture never leaves pending work behind.
    await delay(1);
    waiting.forEach(gate => gate.resolve());
    await first;
    await second;
    assert.equal(calls.synth.length, 20);
  }, { run: async options => {
    if (options.check) return { ok: true };
    if (hold) { const gate = deferred(); waiting.push(gate); await gate.promise; }
    fs.writeFileSync(options.output, MP3);
    return { ok: true };
  } });
});

test('untrusted generated header, duration, size or failed provider is rejected and cleaned', async () => {
  const cases = [{ bytes: Buffer.from('NOTMP3') }, { bytes: MP3, probe: { ok: false } },
    { bytes: MP3, probe: { ok: true, codec: 'mp3', duration: 0 } },
    { bytes: MP3, probe: { ok: true, codec: 'mp3', duration: 91 } },
    { bytes: MP3, probe: { ok: true, codec: 'aac', duration: 2 } },
    { bytes: Buffer.alloc(3 * 1024 * 1024 + 1) }, { bytes: Buffer.from('ID3'), fail: true }];
  for (const item of cases) await fixture(async ({ service, root }) => {
    await assert.rejects(service.synthesize('fixture'));
    assert.deepEqual(cacheFiles(root), []);
  }, { run: async options => { if (options.check) return { ok: true }; fs.writeFileSync(options.output, item.bytes);
    if (item.fail) throw new Error('fixture interrupted provider'); return { ok: true }; },
    probe: async () => item.probe || { ok: true, codec: 'mp3', duration: 2 } });
});

test('revoked consent or stale session before completion discards generated audio', async () => {
  for (const kind of ['consent', 'session', 'abort']) {
    const gate = deferred();
    let isAllowed = true;
    const controller = new AbortController();
    await fixture(async ({ service, config, calls, root }) => {
      const pending = service.synthesize('fixture', { signal: controller.signal,
        assertAllowed: () => { if (!isAllowed) throw new Error('stale fixture session'); } });
      const checked = assert.rejects(pending);
      await until(() => calls.synth.length === 1);
      if (kind === 'consent') config.tts.onlineConsent = false;
      if (kind === 'session') isAllowed = false;
      if (kind === 'abort') controller.abort();
      gate.resolve();
      await checked;
      assert.deepEqual(cacheFiles(root), []);
    }, { run: async options => { if (options.check) return { ok: true }; await gate.promise;
      fs.writeFileSync(options.output, MP3); return { ok: true }; } });
  }
});

test('consent revoked during audio probe cannot publish a completed preview', () => {
  const gate = deferred();
  return fixture(async ({ service, config, calls, root }) => {
    const pending = service.synthesize('fixture');
    const checked = assert.rejects(pending, error => error.statusCode === 409);
    await until(() => calls.probes.length === 1);
    config.tts.onlineConsent = false;
    gate.resolve();
    await checked;
    assert.deepEqual(cacheFiles(root), []);
  }, { probe: async () => { await gate.promise; return { ok: true, codec: 'mp3', duration: 2 }; } });
});

test('cache directory link escape is blocked before generating any audio', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speech-outside-'));
  try {
    await fixture(async ({ root, service, calls }) => {
      fs.symlinkSync(outside, path.join(root, 'state/voice-previews'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(service.synthesize('fixture'), error => error.statusCode === 500);
      assert.equal(calls.synth.length, 0);
      assert.deepEqual(fs.readdirSync(outside), []);
    });
  } finally { assert.ok(outside.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('replacing a preview cache parent with a link cannot redirect opaque-ID reads outside cache', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-speech-outside-'));
  try {
    await fixture(async ({ root, service }) => {
      const entry = await service.synthesize('fixture');
      const directory = path.join(root, 'state/voice-previews');
      fs.renameSync(directory, path.join(root, 'state/original-previews'));
      fs.writeFileSync(path.join(outside, path.basename(entry.file)), Buffer.from('PRIVATE-OUTSIDE-FIXTURE'));
      fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => service.get(entry.id), undefined, 'A replaced parent must not expose an external file.');
      service.invalidate();
      assert.equal(fs.readFileSync(path.join(outside, path.basename(entry.file)), 'utf8'), 'PRIVATE-OUTSIDE-FIXTURE',
        'Cache invalidation must never delete an external file reached through a replaced parent.');
    });
  } finally { assert.ok(outside.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('worker uses fixed Python arguments and a narrow environment without keys or proxy configuration', () => {
  const source = fs.readFileSync(path.join(STAGE, 'src/voice-speech.js'), 'utf8');
  assert.match(source, /shell:\s*false/);
  assert.match(source, /windowsHide:\s*true/);
  assert.match(source, /\['-s', '-P', worker/);
  const start = source.indexOf('function childEnvironment('), end = source.indexOf('export function runSpeechWorker', start);
  const environment = source.slice(start, end);
  assert.ok(!environment.includes('...process.env'));
  assert.ok(!/HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|API_KEY|ACCESS_TOKEN/i.test(environment));
  assert.match(environment, /PYTHONNOUSERSITE:\s*'1'/);
  assert.match(environment, /PYTHONPATH:\s*runtimeDir/);
});
