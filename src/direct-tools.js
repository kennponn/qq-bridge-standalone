import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEND_TOOLS = new Set(['qq_send_message', 'qq_reply', 'qq_send_sticker', 'qq_send_poke', 'qq_send_voice', 'qq_speak_text']);

export function bindDirectTool(definition, { key, agentToken, timing }) {
  const schema = definition.inputSchema || { type: 'object', properties: {} };
  const properties = { ...(schema.properties || {}) };
  const bound = {};
  if ('key' in properties) bound.key = key;
  if ('token' in properties) bound.token = agentToken;
  if (definition.name === 'qq_reply') bound.groupId = key.slice('group:'.length);
  for (const field of Object.keys(bound)) delete properties[field];
  let description = definition.description || '';
  // Keep the shared authorization/schema contract; specialize only model-facing timing guidance.
  if (timing?.fastPrivate && key.startsWith('private:')) {
    if (['qq_mark_read', 'qq_set_wake_config', 'qq_wait_for_messages'].includes(definition.name)) {
      description = 'PRIVATE SESSION OVERRIDE: Group timing below does not apply here. '
        + 'No five-minute pre-sleep observation or post-reply wait is required. '
        + 'Answer complete messages promptly, then close using only the displayed throughSeq. '
        + `If a reply wait is needed, quietMs defaults to ${timing.quietMs} and is capped at ${timing.quietMaxMs}; `
        + `messages-purpose waits default to ${timing.defaultWaitMs}ms and are capped at ${timing.waitMaxMs}ms.\n`
        + description;
    }
    if (definition.name === 'qq_wait_for_messages') {
      if (properties.timeoutMs) properties.timeoutMs = { ...properties.timeoutMs,
        description: `Private message wait timeout in milliseconds, default ${timing.defaultWaitMs}, range ${timing.minWaitMs}..${timing.waitMaxMs}.` };
      if (properties.quietMs) properties.quietMs = { ...properties.quietMs,
        description: `Private quiet window in milliseconds, default ${timing.quietMs}, range ${timing.quietMinMs}..${timing.quietMaxMs}. Reply waits count from the last incoming message and return immediately when already quiet.` };
    }
  }
  if (timing?.alwaysAwake && key.startsWith('group:')) {
    if (['qq_mark_read', 'qq_set_wake_config', 'qq_wait_for_messages'].includes(definition.name)) {
      description = 'HOST ALWAYS-ON GROUP OVERRIDE: Ignore legacy sleep timing below. '
        + 'Always-on listening cannot be disabled by model wake settings. No five-minute observation or post-reply wait is needed. '
        + 'Answer relevant complete messages promptly, then safely close with the displayed throughSeq; do not poll or repeatedly wait while idle. '
        + `Quiet waits default to ${timing.quietMs}ms and are capped at ${timing.quietMaxMs}ms; `
        + `future-message waits are capped at ${timing.waitMaxMs}ms.\n` + description;
    }
    if (definition.name === 'qq_wait_for_messages') {
      if (properties.timeoutMs) properties.timeoutMs = { ...properties.timeoutMs,
        description: `Always-on group clarification timeout in milliseconds, default ${timing.defaultWaitMs}, range ${timing.minWaitMs}..${timing.waitMaxMs}. Do not use idle wait loops.` };
      if (properties.quietMs) properties.quietMs = { ...properties.quietMs,
        description: `Always-on group quiet window in milliseconds, default ${timing.quietMs}, range ${timing.quietMinMs}..${timing.quietMaxMs}. Counts from the last incoming message.` };
    }
  }
  return {
    tool: { type: 'function', function: { name: definition.name, description, parameters: {
      ...schema, properties, required: (schema.required || []).filter((field) => !(field in bound)), additionalProperties: false
    } } },
    arguments: (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
      for (const field of Object.keys(bound)) {
        if (field in args) throw new Error(`Session-bound argument cannot be changed: ${field}`);
      }
      if (definition.name === 'qq_get_unread_messages' && !('afterSeq' in args)) args = { ...args, afterSeq: 0 };
      return { ...args, ...bound };
    }
  };
}

export async function connectDirectToolServers(connect, { webSearch = true } = {}) {
  const scripts = ['mcp-snowluma-safe.js', ...(webSearch ? ['mcp-web-search-safe.js'] : [])];
  // Do not tear down after an early rejection while another client is still initializing.
  const results = await Promise.allSettled(scripts.map((script) => Promise.resolve().then(() => connect(script))));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return { qq: results[0].value, web: results[1]?.value };
}

export async function closeDirectToolClients(clients) {
  await Promise.allSettled(clients.map(async ({ client, transport }) => {
    try { await client.close(); }
    finally { await transport.close(); }
  }));
}

export async function createDirectToolSession({ key, agentToken, consolePort, silent = false, webSearch = true, vision = true, timing }) {
  if (!/^(group|private):[1-9]\d*$/.test(key) || !agentToken) throw new Error('DIRECT_TOOLS: valid session key and token are required');
  if (!Number.isInteger(consolePort) || consolePort < 1 || consolePort > 65535) throw new Error('DIRECT_TOOLS: invalid console port');
  const clients = [];
  const registry = new Map();
  let closing;
  const close = () => closing ??= closeDirectToolClients(clients);
  async function connect(script) {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(ROOT, 'src', script)], cwd: ROOT, stderr: 'pipe',
      env: { QQ_BRIDGE_DIRECT_PORT: String(consolePort) }, maxBufferSize: 24 * 1024 * 1024
    });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'qq-direct-engine', version: '0.4.0-r1' });
    clients.push({ client, transport });
    await client.connect(transport, { timeout: 15000 });
    const definitions = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15000 });
      definitions.push(...page.tools);
      cursor = page.nextCursor;
      if (definitions.length > 200) throw new Error('DIRECT_TOOLS: excessive tool definitions');
    } while (cursor);
    return { client, definitions };
  }
  try {
    const { qq, web } = await connectDirectToolServers(connect, { webSearch });
    for (const definition of qq.definitions) {
      // Reuse the safe MCP schemas; do not create a second, weaker endpoint map.
      const sessionBound = Object.hasOwn(definition.inputSchema?.properties || {}, 'key');
      if (!sessionBound && !(definition.name === 'qq_reply' && key.startsWith('group:'))) continue;
      if (silent && SEND_TOOLS.has(definition.name)) continue;
      if (!vision && /image/.test(definition.name)) continue;
      const bound = bindDirectTool(definition, { key, agentToken, timing });
      registry.set(definition.name, { ...bound, client: qq.client, rawName: definition.name });
    }
    if (web) {
      for (const definition of web.definitions) {
        if (!['web_search', 'web_fetch'].includes(definition.name)) continue;
        const alias = `mcp__web-search-safe__${definition.name}`;
        const bound = bindDirectTool({ ...definition, name: alias }, { key, agentToken });
        registry.set(alias, { ...bound, client: web.client, rawName: definition.name });
      }
    }
    return {
      tools: [...registry.values()].map((entry) => entry.tool), close,
      async execute(name, args, { signal } = {}) {
        const entry = registry.get(name);
        if (!entry) throw new Error('DIRECT_TOOLS: tool is not enabled');
        signal?.throwIfAborted();
        const timeout = name === 'qq_wait_for_messages' ? 750000 : /image/.test(name) ? 210000 : 90000;
        return entry.client.callTool({ name: entry.rawName, arguments: entry.arguments(args) }, undefined, { timeout, signal });
      }
    };
  } catch (error) { await close(); throw error; }
}
