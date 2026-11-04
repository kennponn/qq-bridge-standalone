// Whole jobs retain per-conversation order; only ready gateway actions take the global lane.
import { performance } from 'node:perf_hooks';

export function createOutboundScheduler({ sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const keyTails = new Map();
  let actionTail = Promise.resolve();
  const wait = (ms) => sleep(Math.max(0, Number(ms) || 0));

  function send(action, { cooldownMs = 0, onTiming } = {}) {
    const queuedAt = performance.now();
    const result = actionTail.then(async () => {
      const startedAt = performance.now();
      try {
        return await action();
      } finally {
        try {
          onTiming?.({ queueMs: startedAt - queuedAt, gatewayMs: performance.now() - startedAt });
        } catch {}
        // Legacy transport cooldown is global and also applies after a failed action.
        if (Number(cooldownMs) > 0) await wait(cooldownMs);
      }
    });
    actionTail = result.then(() => {}, () => {});
    return result;
  }

  function enqueue(key, job) {
    const prior = keyTails.get(key) || Promise.resolve();
    const result = prior.then(() => job({ send, wait }));
    const tail = result.then(() => {}, () => {});
    keyTails.set(key, tail);
    tail.then(() => {
      if (keyTails.get(key) === tail) keyTails.delete(key);
    });
    return result;
  }

  return { enqueue };
}
