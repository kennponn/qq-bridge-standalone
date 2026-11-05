// Pure bridge fixtures: no real QQ, provider, launcher, or user configuration.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const GROUP = 'group:456';
const PRIVATE = 'private:123';
const SECOND_GROUP = 'group:789';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}

async function fixture(run) {
  let ready = false;
  const starts = [];
  const finishes = [];
  const h = await bridgeHarness({
    config: {
      allow: { private: [123], groups: [456, 789] },
      consolePort: 0,
    },
    files: {
      'prompts/standalone-system.txt':
        '- id: persona\n  name: fixture\n  config:\n    prefix: fixture tool protocol\n',
    },
    globals: {
      getEngineStatus: () => ({ ready, secret: { source: 'stored' } }),
      resolveEngineDirectConfig: () => ({ model: 'fixture', provider: 'fixture', apiKey: 'fixture',
        baseURL: 'https://model.invalid/v1', webSearch: false, vision: false }),
      createDirectToolSession: async () => ({ tools: [], execute() {}, async close() {} }),
      runDirectTurn: async (options) => {
        const content = JSON.stringify(options.content);
        const key = [GROUP, PRIVATE, SECOND_GROUP].find((candidate) => content.includes(candidate));
        assert.ok(key, 'Fixture prompt identifies its conversation');
        starts.push({ key, content });
        const result = await run?.({ key, content, options, starts });
        finishes.push(key);
        return result ?? { ok: true, sent: 0, closed: true };
      },
    },
  });
  h.setReady = value => { ready = value; };
  h.setMode('reserved2');
  h.setReady(false);
  return { h, starts, finishes, async close() { await h.close(); } };
}

async function enqueue(h, key, text = `fixture:${key}`, options = { wakeReason: 'bootstrap' }) {
  const result = await h.deliverPrompt(key, text, options);
  assert.equal(result.queued, true);
}

async function api(h, pathname, body) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port,
        path: pathname, method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.on('error', reject);
      request.setTimeout(2000, () => request.destroy(new Error('Fixture API timed out')));
      request.end(JSON.stringify(body));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('offline recovery starts private turns while an earlier group turn is waiting', async () => {
  const hold = deferred();
  const f = await fixture(async ({ key }) => { if (key === GROUP) await hold.promise; });
  try {
    await enqueue(f.h, GROUP);
    await enqueue(f.h, PRIVATE);
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.starts.some((entry) => entry.key === PRIVATE),
      'A full group model/tool wait must not block the private offline wake');
    assert.ok(!f.finishes.includes(GROUP), 'The group is still waiting when private starts');
    assert.ok(f.finishes.includes(PRIVATE));
  } finally {
    hold.resolve();
    await until(() => f.h.directTurnControllers.size === 0, 'Fixture direct turns did not finish');
    await f.close();
  }
});

test('a newly recovered conversation can join while another replay is still active', async () => {
  const hold = deferred();
  const f = await fixture(async ({ key }) => { if (key === GROUP) await hold.promise; });
  try {
    await enqueue(f.h, GROUP);
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.starts.length === 1, 'Group replay did not start');
    f.h.setReady(false);
    await enqueue(f.h, PRIVATE);
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.starts.some((entry) => entry.key === PRIVATE),
      'The global replay lock must not live for the duration of an earlier direct turn');
    assert.ok(!f.finishes.includes(GROUP));
  } finally {
    hold.resolve();
    await until(() => f.h.directTurnControllers.size === 0, 'Fixture direct turns did not finish');
    await f.close();
  }
});

test('repeated flush requests preserve FIFO and exactly one active turn per conversation', async () => {
  const hold = deferred();
  const f = await fixture(async ({ content }) => { if (content.includes('FIRST_ITEM')) await hold.promise; });
  try {
    await enqueue(f.h, GROUP, `FIRST_ITEM ${GROUP}`, {});
    await enqueue(f.h, GROUP, `SECOND_ITEM ${GROUP}`, {});
    f.h.setReady(true);
    for (let i = 0; i < 10; i++) void f.h.flushQueue();
    await until(() => f.starts.length === 1, 'First replay did not start');
    await delay(50);
    assert.equal(f.starts.length, 1, 'Same-key queued turns remain serial');
    hold.resolve();
    await until(() => f.finishes.length === 2, 'Second replay did not finish');
    assert.ok(f.starts[0].content.includes('FIRST_ITEM'));
    assert.ok(f.starts[1].content.includes('SECOND_ITEM'));
    assert.equal(f.h.queued.size, 0);
  } finally {
    hold.resolve();
    await until(() => f.h.directTurnControllers.size === 0, 'Fixture direct turns did not finish');
    await f.close();
  }
});

test('unconfigured engine retains one wake without replay polling or duplication', async () => {
  const f = await fixture();
  try {
    await enqueue(f.h, PRIVATE);
    for (let i = 0; i < 10; i++) await f.h.flushQueue();
    await delay(250);
    assert.equal(f.starts.length, 0);
    assert.equal(f.h.queued.get(PRIVATE).length, 1);
    assert.equal(f.h.queueRetries.size, 0, 'Unavailable model configuration is not a failed turn');
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.finishes.length === 1, 'Configured wake did not resume');
    assert.equal(f.starts.length, 1);
    assert.equal(f.h.queued.size, 0);
  } finally { await f.close(); }
});

test('a failing group retains its queue and backoff without blocking private recovery', async () => {
  const f = await fixture(async ({ key }) => {
    if (key === GROUP) throw new Error('fixture provider unavailable');
  });
  try {
    await enqueue(f.h, GROUP);
    await enqueue(f.h, PRIVATE);
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.finishes.includes(PRIVATE) && f.h.queueRetries.get(GROUP) === 1,
      'Private wake did not proceed after the independent group failure');
    const calls = f.starts.filter((entry) => entry.key === GROUP).length;
    assert.equal(calls, 1);
    for (let i = 0; i < 10; i++) void f.h.flushQueue();
    await delay(250);
    assert.equal(f.starts.filter((entry) => entry.key === GROUP).length, calls,
      'External flush events must not bypass this conversation retry deadline');
    assert.equal(f.h.queued.get(GROUP).length, 1);
  } finally { await f.close(); }
});

test('engine unavailability between replayed items retains the tail without busy retry', async () => {
  let h;
  const f = await fixture(async ({ content }) => {
    if (content.includes('FIRST_ITEM')) h.setReady(false);
  });
  h = f.h;
  try {
    await enqueue(h, GROUP, `FIRST_ITEM ${GROUP}`, {});
    await enqueue(h, GROUP, `SECOND_ITEM ${GROUP}`, {});
    h.setReady(true);
    await h.flushQueue();
    assert.equal(f.starts.length, 1);
    assert.equal(h.queued.get(GROUP).length, 1);
    assert.ok(h.queued.get(GROUP)[0].promptText.includes('SECOND_ITEM'));
    for (let i = 0; i < 10; i++) await h.flushQueue();
    await delay(100);
    assert.equal(f.starts.length, 1);
    assert.equal(h.queueRetryTimers.size, 0);
    h.setReady(true);
    await h.flushQueue();
    assert.equal(f.starts.length, 2);
    assert.equal(h.queued.size, 0);
  } finally { await f.close(); }
});

test('a ready flush racing a deferred replay dispatch survives owner cleanup', async () => {
  const hold = deferred();
  const f = await fixture(async ({ content }) => {
    if (content.includes('BLOCKER_ITEM')) await hold.promise;
  });
  try {
    await enqueue(f.h, PRIVATE, `DEFERRED_ITEM ${PRIVATE}`, {});
    f.h.setReady(true);
    const blocker = f.h.deliverPrompt(PRIVATE, `BLOCKER_ITEM ${PRIVATE}`, {});
    await until(() => f.starts.length === 1, 'Blocking direct turn did not start');
    void f.h.flushQueue();
    assert.ok(f.h.queuedReplayJobs.has(PRIVATE));
    // The already claimed replay dispatch is queued behind the current turn.
    // It sees not-ready, then the caller's recovery flush races its cleanup.
    f.h.setReady(false);
    const recovered = blocker.then(() => {
      f.h.setReady(true);
      void f.h.flushQueue();
    });
    hold.resolve();
    await recovered;
    await until(() => f.starts.length === 2 && f.h.queuedReplayJobs.size === 0,
      'A ready flush received before deferred owner cleanup must replay the retained item');
    assert.ok(f.starts[1].content.includes('DEFERRED_ITEM'));
    assert.equal(f.h.queued.size, 0);
    assert.equal(f.h.queueRetryTimers.size, 0);
  } finally { hold.resolve(); await f.close(); }
});

test('a partially sent failed turn is consumed and only its unsent tail retries after backoff', async () => {
  const f = await fixture(async ({ content }) => {
    if (content.includes('ALREADY_SENT_ITEM')) {
      const error = new Error('fixture failure after one successful sending tool');
      error.sentCount = 1;
      throw error;
    }
  });
  try {
    await enqueue(f.h, GROUP, `ALREADY_SENT_ITEM ${GROUP}`, {});
    await enqueue(f.h, GROUP, `UNSENT_TAIL_ITEM ${GROUP}`, {});
    f.h.setReady(true);
    await f.h.flushQueue();
    assert.equal(f.starts.length, 1);
    assert.equal(f.h.queued.get(GROUP).length, 1,
      'A failed turn that already sent QQ messages must not be replayed from scratch');
    assert.ok(f.h.queued.get(GROUP)[0].promptText.includes('UNSENT_TAIL_ITEM'));
    assert.equal(f.h.queueRetries.get(GROUP), 1);
    const retryAt = f.h.queueRetryTimers.get(GROUP).until;
    for (let i = 0; i < 10; i++) void f.h.flushQueue();
    await delay(100);
    assert.equal(f.starts.length, 1);
    await until(() => f.finishes.length === 1 && f.h.queuedReplayJobs.size === 0,
      'Retry timer did not automatically recover the untouched tail', 4500);
    assert.ok(Date.now() >= retryAt, 'Tail replay observes the original retry deadline');
    assert.equal(f.starts.filter((entry) => entry.content.includes('ALREADY_SENT_ITEM')).length, 1);
    assert.equal(f.starts.filter((entry) => entry.content.includes('UNSENT_TAIL_ITEM')).length, 1);
    assert.equal(f.h.queued.size, 0);
    assert.equal(f.h.queueRetries.size, 0);
    assert.equal(f.h.queueRetryTimers.size, 0);
  } finally { await f.close(); }
});

test('pausing while an offline replay is active invalidates its unstarted tail', async () => {
  const hold = deferred();
  const f = await fixture(async () => { await hold.promise; });
  try {
    await enqueue(f.h, GROUP, `FIRST_ITEM ${GROUP}`, {});
    await enqueue(f.h, GROUP, `SECOND_ITEM ${GROUP}`, { wakeReason: 'admin' });
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.starts.length === 1, 'First replay did not start');
    const paused = await api(f.h, '/api/socialV2/activity', { paused: true });
    assert.equal(paused.status, 200);
    hold.resolve();
    await until(() => f.h.queuedReplayJobs.size === 0, 'Paused replay owner did not finish');
    void f.h.flushQueue();
    await delay(100);
    assert.equal(f.starts.length, 1, 'Paused old snapshot may not make another model request');
    assert.equal(f.h.queued.size, 0, 'Cancelled tail must not resurrect as a retry after pause');
  } finally { hold.resolve(); await f.close(); }
});

test('session reset cannot resurrect a failed replay or its detached snapshot tail', async () => {
  const hold = deferred();
  const f = await fixture(async ({ options }) => {
    await hold.promise;
    options.assertCurrent();
  });
  try {
    await enqueue(f.h, PRIVATE, `FIRST_ITEM ${PRIVATE}`, {});
    await enqueue(f.h, PRIVATE, `SECOND_ITEM ${PRIVATE}`, {});
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.starts.length === 1, 'First replay did not start');
    const reset = await api(f.h, '/api/session/reset', { key: PRIVATE });
    assert.equal(reset.status, 200);
    hold.resolve();
    await until(() => f.h.queuedReplayJobs.size === 0, 'Reset replay owner did not finish');
    await delay(100);
    void f.h.flushQueue();
    await delay(100);
    assert.equal(f.starts.length, 1, 'Reset forbids executing an old detached snapshot tail');
    assert.equal(f.h.queued.size, 0, 'Reset failure must not restore old items');
    assert.equal(f.h.state.sessions[PRIVATE], undefined, 'Old replay cannot recreate the reset session');
    assert.equal(f.h.queueRetries.has(PRIVATE), false);
  } finally { hold.resolve(); await f.close(); }
});

test('workspace reset revokes every captured replay without re-enqueuing failed old turns', async () => {
  const hold = deferred();
  const f = await fixture(async ({ options }) => {
    await hold.promise;
    options.assertCurrent();
  });
  try {
    await enqueue(f.h, GROUP);
    await enqueue(f.h, PRIVATE);
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.starts.length === 2, 'Independent captured replays did not both start');
    const reset = await api(f.h, '/api/workspace/reset', {});
    assert.equal(reset.status, 200);
    hold.resolve();
    await until(() => f.h.queuedReplayJobs.size === 0, 'Reset replay owners did not finish');
    await delay(100);
    void f.h.flushQueue();
    await delay(100);
    assert.equal(f.starts.length, 2);
    assert.equal(f.h.queued.size, 0);
    assert.equal(Object.keys(f.h.state.sessions).length, 0);
    assert.equal(f.h.queueRetries.size, 0);
  } finally { hold.resolve(); await f.close(); }
});

test('a reset replacement queue waits for revoked owner cleanup and cannot be deleted by it', async () => {
  const hold = deferred();
  const f = await fixture(async ({ content, options }) => {
    if (content.includes('OLD_ITEM')) {
      await hold.promise;
      options.assertCurrent();
    }
  });
  try {
    await enqueue(f.h, PRIVATE, `OLD_ITEM ${PRIVATE}`, {});
    f.h.setReady(true);
    void f.h.flushQueue();
    await until(() => f.starts.length === 1, 'Old replay did not start');
    const oldJob = f.h.queuedReplayJobs.get(PRIVATE);
    const reset = await api(f.h, '/api/session/reset', { key: PRIVATE });
    assert.equal(reset.status, 200);
    assert.equal(oldJob.cancelled, true);
    f.h.setReady(false);
    await enqueue(f.h, PRIVATE, `NEW_ITEM ${PRIVATE}`, {});
    const replacement = f.h.queued.get(PRIVATE);
    assert.notEqual(replacement, oldJob.items);
    f.h.setReady(true);
    void f.h.flushQueue();
    await delay(50);
    assert.equal(f.starts.length, 1, 'A revoked replay owner retains its lock until its finally');
    assert.equal(f.h.queued.get(PRIVATE), replacement);
    hold.resolve();
    await until(() => f.starts.length === 2 && f.h.queuedReplayJobs.size === 0,
      'Replacement queue did not automatically resume after old owner cleanup');
    assert.ok(f.starts[1].content.includes('NEW_ITEM'));
    assert.equal(f.h.queued.size, 0);
    assert.equal(f.h.queueRetries.size, 0);
  } finally { hold.resolve(); await f.close(); }
});
