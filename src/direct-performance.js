function finiteMs(value) {
  return Number.isFinite(value) ? Math.min(86400000, Math.max(0, Math.round(value))) : 0;
}

export function createDirectPerformanceLedger({ limit = 80, now = () => performance.now(), wallNow = Date.now } = {}) {
  const samples = [];
  const capacity = Math.max(1, Math.min(200, Math.round(Number(limit) || 80)));
  function begin(kind, { incomingAt } = {}) {
    const start = now();
    const wallStart = wallNow();
    const arrivalWaitMs = Number.isFinite(incomingAt) && incomingAt > 0 && incomingAt <= wallStart
      ? finiteMs(wallStart - incomingAt) : null;
    const data = { kind: kind === 'private' ? 'private' : 'group', arrivalWaitMs,
      toolSetupMs: 0, modelMs: 0, toolMs: 0, queueMs: 0, gatewayMs: 0,
      modelRequests: 0, modelRetries: 0, requestBytes: 0, firstReplyMs: null,
      executionToFirstReplyMs: null };
    let finished = false;
    return {
      setup(ms) { if (!finished) data.toolSetupMs = finiteMs(ms); },
      timing(event) {
        if (finished || !event || !['model', 'tool'].includes(event.phase)) return;
        const field = event.phase === 'model' ? 'modelMs' : 'toolMs';
        data[field] = finiteMs(data[field] + finiteMs(event.durationMs));
        if (event.phase === 'model') {
          data.modelRequests += 1;
          if (event.attempt > 1) data.modelRetries += 1;
          const bytes = Number(event.requestBytes);
          if (Number.isFinite(bytes)) data.requestBytes = Math.max(data.requestBytes, Math.min(32 * 1024 * 1024, Math.max(0, Math.round(bytes))));
        }
      },
      queued(ms) { if (!finished) data.queueMs = finiteMs(data.queueMs + finiteMs(ms)); },
      gateway(ms) { if (!finished) data.gatewayMs = finiteMs(data.gatewayMs + finiteMs(ms)); },
      ack() {
        if (finished || data.executionToFirstReplyMs !== null) return;
        data.executionToFirstReplyMs = finiteMs(now() - start);
        data.firstReplyMs = arrivalWaitMs === null ? null : finiteMs(arrivalWaitMs + data.executionToFirstReplyMs);
      },
      finish(outcome = 'failed') {
        if (finished) return;
        finished = true;
        samples.push({ ...data, outcome: ['success', 'silent', 'cancelled', 'failed'].includes(outcome) ? outcome : 'failed',
          totalMs: finiteMs(now() - start), completedAt: wallNow() });
        if (samples.length > capacity) samples.splice(0, samples.length - capacity);
      }
    };
  }
  function snapshot() {
    const successfulPrivate = samples.filter(row => row.kind === 'private' && row.outcome === 'success' && row.firstReplyMs !== null);
    const sorted = successfulPrivate.map(row => row.firstReplyMs).sort((a, b) => a - b);
    const percentile = value => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] : null;
    return { sampleCount: samples.length, private: { count: sorted.length, p50ReplyMs: percentile(0.5),
      p95ReplyMs: percentile(0.95), latest: successfulPrivate.length ? { ...successfulPrivate.at(-1) } : null },
      latest: samples.length ? { ...samples.at(-1) } : null };
  }
  return { begin, snapshot };
}
