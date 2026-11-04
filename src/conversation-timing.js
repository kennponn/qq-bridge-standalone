function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(number) ? number : fallback)));
}

export function isAlwaysAwakeGroup(cfg, key, { standalone = false } = {}) {
  return cfg.socialV2?.wake?.alwaysAwake === true && /^group:\d+$/.test(key)
    && (standalone === true || cfg.engine?.backend === 'standalone');
}

export function effectiveWakeConfig(cfg, key, wakeConfig, options) {
  if (!isAlwaysAwakeGroup(cfg, key, options)) return wakeConfig;
  // Overlay the host policy without replacing the conversation's saved preferences.
  return {
    ...wakeConfig,
    mode: 'active', infinite: true, sleepUntil: null, alwaysAwake: true,
    triggers: { ...wakeConfig?.triggers, anyMessage: true },
    batchWindowMs: 1000,
  };
}

export function resolveConversationTiming(cfg, key, { standalone = false } = {}) {
  const options = cfg.socialV2?.privateChat || {};
  const wait = cfg.socialV2?.wait || {};
  const wake = cfg.socialV2?.wake || {};
  const fastPrivate = /^private:\d+$/.test(key) && options.fastReply !== false
    && (standalone || cfg.engine?.backend === 'standalone' || options.fastReply === true);
  if (fastPrivate) {
    const minWaitMs = bounded(options.minWaitMs, 100, 100, 5000);
    const waitMaxMs = bounded(options.maxWaitMs, 30000, minWaitMs, 600000);
    const quietMinMs = bounded(options.minQuietMs, 500, 0, 5000);
    const quietMaxMs = bounded(options.maxQuietMs, 3000, quietMinMs, 30000);
    return {
      fastPrivate, batchMs: bounded(options.batchWindowMs, 700, 100, 5000),
      minWaitMs, waitMaxMs, defaultWaitMs: bounded(options.defaultWaitMs, 15000, minWaitMs, waitMaxMs),
      quietMinMs, quietMaxMs, quietMs: bounded(options.quietMs, 1500, quietMinMs, quietMaxMs),
      maxWakePerMinute: bounded(options.maxWakePerMinute, 30, 1, 60),
      maxWakePerHour: bounded(options.maxWakePerHour, 360, 1, 2000),
      preSleepRequired: false, replyCheckEnabled: false
    };
  }
  if (isAlwaysAwakeGroup(cfg, key, { standalone })) {
    return {
      fastPrivate: false, alwaysAwake: true, batchMs: 1000,
      minWaitMs: 100, waitMaxMs: 30000, defaultWaitMs: 15000,
      quietMinMs: 0, quietMaxMs: 3000, quietMs: 1000,
      preSleepRequired: false, replyCheckEnabled: false,
    };
  }
  const minWaitMs = Math.max(100, Number(wait.minMs) || 5000);
  const waitMaxMs = Math.max(minWaitMs, Number(wait.maxMs) || 600000);
  const quietMinMs = Number.isFinite(Number(wait.minQuietAfterNewMs)) ? Math.max(0, Number(wait.minQuietAfterNewMs)) : 10000;
  const quietMaxMs = Math.max(quietMinMs, Math.min(120000, Number(wait.maxMs) || 600000));
  return {
    fastPrivate, batchMs: Math.max(1000, Number(wake.batchWindowMs) || 8000),
    minWaitMs, waitMaxMs, defaultWaitMs: Number(wait.defaultMs) || 30000,
    quietMinMs, quietMaxMs, quietMs: Math.max(quietMinMs, Number(wait.defaultQuietMs) || 8000),
    preSleepRequired: wake.preSleepWaitEnabled !== false, replyCheckEnabled: true
  };
}

export function privateReplyPolicy(profile) {
  if (profile.alwaysAwake) {
    return `\n[GROUP_ALWAYS_AWAKE_POLICY]\nThis group has host-controlled always-on listening. `
      + `A new incoming message can start a new turn; no idle model loop or sleep timer is needed. `
      + `Answer a complete message addressed to you, especially an @ or reply to your message, promptly using a sending tool. `
      + `Decide who was addressed from each message's actual recipient metadata, not from waking up. `
      + `Voluntary group participation remains allowed. If recipient=others (only other accounts are addressed), `
      + `join as a third-person observer, never as that target answering for itself or adopting its identity. `
      + `Your own "I think" opinions remain allowed; mixed @self+@other requests can be answered as yourself. `
      + `Do not impose artificial human-like delays. Only explicitly unfinished messages need a short clarification wait; `
      + `if necessary use qq_wait_for_messages(purpose="reply", quietMs=${profile.quietMs}); `
      + `the host caps quiet waits at ${profile.quietMaxMs}ms. Do not mechanically answer every group message: `
      + `skip irrelevant chatter by safely closing with qq_mark_read using the displayed throughSeq. `
      + `After responding, close with qq_mark_read or qq_set_wake_config using that same displayed safe cursor. `
      + `No post-reply long wait or five-minute pre-sleep observation is required. Do not poll, repeat idle waits, `
      + `or create an artificial sleep loop; the next incoming message will be handled by the host. `
      + `You cannot disable the host's always-on listening with qq_set_wake_config; saved diving preferences only apply when the host turns this mode off. `
      + `Wake and send rate limits, permissions, mute and pause controls still apply. When the complete answer and all relevant messages are already displayed, `
      + `put the sending tool first and the closing tool second in the SAME tool-call response. The host executes them in order `
      + `and will not acknowledge after a failed send. Never acknowledge messages you have not seen.\n[/GROUP_ALWAYS_AWAKE_POLICY]\n`;
  }
  if (!profile.fastPrivate) return '';
  return `\n[PRIVATE_REPLY_POLICY]\nThis is a private conversation, not a group. Answer a complete message promptly using a sending tool. `
    + `Do not wait before a complete answer merely to simulate human timing. If a short clarification/burst wait is actually needed, `
    + `use qq_wait_for_messages(purpose="reply", quietMs=${profile.quietMs}); the host caps private quiet waits at ${profile.quietMaxMs}ms. `
    + `Only explicitly unfinished messages need a messages-purpose wait. After responding, close with qq_mark_read `
    + `or qq_set_wake_config using the displayed throughSeq. Private conversations do not require a five-minute pre-sleep observation `
    + `or a post-reply long wait; the next incoming private message wakes you again. For a complete answer when all needed messages `
    + `are already displayed, put the sending tool first and the closing tool second in the SAME tool-call response. `
    + `The host executes them in order and will not acknowledge after a failed send in that response. `
    + `This avoids an unnecessary extra model round solely to close. Never acknowledge messages you have not seen.\n[/PRIVATE_REPLY_POLICY]\n`;
}

export function conversationRecommendations(cfg, key, options) {
  if (cfg.socialV2?.provideRecommendations === false) return null;
  const social = cfg.socialV2 || {};
  const timing = resolveConversationTiming(cfg, key, options);
  const shortTiming = timing.fastPrivate || timing.alwaysAwake;
  const wake = timing.alwaysAwake ? {
    ...effectiveWakeConfig(cfg, key, social.wake || {}, options),
    defaultMode: 'active', recommendedDefaultInfinite: true, preSleepWaitEnabled: false,
    recommendedHint: 'Host-controlled always-on listening: incoming messages trigger bounded turns. Respond promptly when relevant, then safely close; no artificial sleep or idle waiting is required.',
  } : timing.fastPrivate ? { ...social.wake, batchWindowMs: timing.batchMs,
    maxWakePerMinute: timing.maxWakePerMinute, maxWakePerHour: timing.maxWakePerHour,
    preSleepWaitEnabled: false } : social.wake || {};
  return {
    wake,
    send: social.send || {},
    wait: shortTiming ? { ...social.wait, minMs: timing.minWaitMs, maxMs: timing.waitMaxMs,
      defaultMs: timing.defaultWaitMs, defaultQuietMs: timing.quietMs,
      minQuietAfterNewMs: timing.quietMinMs, maxQuietMs: timing.quietMaxMs,
      postReplyWaitRequired: false } : social.wait || {},
    proactive: timing.alwaysAwake ? { ...social.proactive, enabled: false } : social.proactive || {}
  };
}
