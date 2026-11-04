import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { lowerAudioProcessPriority, spawnAudioProcess } from '../src/voice-process.js';

test('priority adjustment waits for spawn and touches only the owned positive PID', () => {
  const child = new EventEmitter(), calls = [];
  lowerAudioProcessPriority(child, (...args) => calls.push(args));
  assert.deepEqual(calls, []);
  child.pid = 123;
  child.emit('spawn');
  child.emit('spawn');
  assert.deepEqual(calls, [[123, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
});

test('missing PID never changes parent priority and denied priority changes are harmless', () => {
  for (const pid of [undefined, 0, -1, NaN]) {
    const child = Object.assign(new EventEmitter(), { pid });
    lowerAudioProcessPriority(child, () => assert.fail('Must not set priority for an invalid child.'));
    child.emit('spawn');
  }
  const child = Object.assign(new EventEmitter(), { pid: 123 });
  lowerAudioProcessPriority(child, () => { throw new Error('EPERM'); });
  assert.doesNotThrow(() => child.emit('spawn'));
});

test('real audio child is below normal without changing the parent process', async () => {
  const parentPriority = os.getPriority();
  const child = spawnAudioProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const closed = once(child, 'close');
  try {
    await once(child, 'spawn');
    assert.ok(os.getPriority(child.pid) >= os.constants.priority.PRIORITY_BELOW_NORMAL);
    assert.equal(os.getPriority(), parentPriority);
  } finally { child.kill(); await closed; }
});

test('worker errors still propagate to the caller', async () => {
  const child = spawnAudioProcess('qq-bridge-nonexistent-audio-executable', [], { stdio: 'ignore' });
  const [error] = await once(child, 'error');
  assert.equal(error.code, 'ENOENT');
});

test('audio probes and both conversion outputs use bounded threads and low-priority spawns', () => {
  const core = fs.readFileSync(new URL('../src/voice-core.js', import.meta.url), 'utf8');
  const speech = fs.readFileSync(new URL('../src/voice-speech.js', import.meta.url), 'utf8');
  assert.match(core, /spawnAudioProcess\(ffprobePath,[\s\S]*?'-threads', '1'/);
  assert.match(core, /const inputArgs = \[[^\n]*'-filter_threads', '1', '-threads', '1', '-i', file/);
  assert.match(core, /const outputArgs = \[[^\n]*'-threads', '1'/);
  assert.match(core, /const wavArgs = \[\.\.\.inputArgs, \.\.\.outputArgs, wavPath\]/);
  assert.equal((core.match(/spawnAudioProcess\(ffmpeg,/g) || []).length, 2);
  assert.match(speech, /spawnAudioProcess\(process\.env\.QQ_BRIDGE_TTS_PYTHON/);
  assert.doesNotMatch(speech, /fs\.readFileSync\(file\)\.subarray/);
  assert.match(speech, /fs\.readSync\(fd, header, 0, header\.length, 0\)/);
  assert.match(speech, /finally \{ fs\.closeSync\(fd\); \}/);
});
