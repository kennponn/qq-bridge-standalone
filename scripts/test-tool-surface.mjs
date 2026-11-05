// Session-bound group member tools: authorization, schema, and gateway fallback.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'group:456';
let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

async function withBridge(run, config = {}, globals = {}) {
  const h = await bridgeHarness({ config: { socialV2: { sticker: { enabled: false }, proactive: { enabled: false }, ...config } }, globals });
  h.setMode('reserved2');
  const st = h.getSocialV2State(KEY);
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const request = (route, { token = st.agentToken, consoleToken = 'fixture-console-token', key = KEY, query = '' } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    if (consoleToken) headers['x-console-token'] = consoleToken;
    if (token) headers['x-agent-token'] = token;
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${route.startsWith('/') ? route : `/api/socialV2/${route}`}?key=${encodeURIComponent(key)}${query}`,
      method: 'GET', headers }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(data) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
  try { await run({ h, st, request }); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── 1. 端点行为 ────────────────────────────────────────────────────────────
await test('group-members 返回 userId/nickname/card，并带 count/truncated', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('group-members');
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.count, 3);
    assert.equal(out.data.returned, 3);
    assert.equal(out.data.truncated, false);
    assert.deepEqual(out.data.members.map((m) => m.userId), ['111', '222', '123'], 'userId 必须是字符串（模型要拿它 @ 人）');
    assert.equal(out.data.members[0].nickname, '小明');
    assert.equal(out.data.members[2].role, 'owner');
  });
});

await test('group-members 尊重 limit 上限并标记 truncated', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('group-members', { query: '&limit=2' });
    assert.equal(out.status, 200);
    assert.equal(out.data.returned, 2);
    assert.equal(out.data.truncated, true);
  });
});

await test('group-members 令牌校验：代理令牌错 / 什么令牌都没有，都必须拒', async () => {
  await withBridge(async ({ st, request }) => {
    // 代理令牌存在但不对 → 403（这是 v2 读工具的统一口径）
    const badToken = await request('group-members', { token: 'deadbeef' });
    assert.equal(badToken.status, 403, JSON.stringify(badToken.data));
    // 既没有代理令牌、也没有控制台令牌 → 不该被当成操作者放行
    const nothing = await request('group-members', { token: '', consoleToken: '' });
    assert.ok([401, 403].includes(nothing.status), `无凭据必须拒绝，实际 ${nothing.status}`);
    const privateKey = await request('group-members', { key: 'private:123', token: st.agentToken });
    assert.equal(privateKey.status, 400, '私聊没有群成员概念，必须明确报错而不是瞎查');
    const badKey = await request('group-members', { key: 'group:not-a-number' });
    assert.equal(badKey.status, 400);
  });
});

await test('group-members 不在白名单的群被拒（不会变成任意群枚举入口）', async () => {
  await withBridge(async ({ st, request }) => {
    const out = await request('group-members', { key: 'group:999999', token: st.agentToken });
    assert.equal(out.status, 403, JSON.stringify(out.data));
    // 关键：**不带令牌**也不能绕过白名单（管理端也必须遵守白名单）
    const noToken = await request('group-members', { key: 'group:999999', token: '' });
    assert.equal(noToken.status, 403, `无令牌也不得枚举非白名单群：${JSON.stringify(noToken.data)}`);
  });
});



await test('工具开关能关掉 group-members（getGroupMembers=false）', async () => {
  await withBridge(async ({ request }) => {
    const out = await request('group-members');
    assert.equal(out.status, 403);
    assert.match(out.data.error, /qq_get_group_members/);
  }, { tools: { getGroupMembers: false } });
});

// ── 2. WS 不可用时走 HTTP 兜底 ─────────────────────────────────────────────
class WsDownBot {
  onPrivateMessage() {} onGroupMessage() {} onNotice() {} onEvent() {} onEventError() {}
  async request() { throw new Error('SnowLuma WebSocket closed before opening'); }
  async getImage() { return null; }
  async fetchFaceEntity() { return null; }
  async connect() {} close() {}
}

await test('WS 挂了，群成员查询仍然可用（HTTP 兜底）', async () => {
  // 这个 fakeFetch 同时服务两条路：WS 抛错后 onebotHttpAction 会打 HTTP 拿成员数组。
  const fetchStub = async (url) => {
    if (String(url).endsWith('/get_group_member_list')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: [{ user_id: 999, nickname: 'HTTP 成员', card: '' }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
  };
  await withBridge(async ({ request }) => {
    const out = await request('group-members');
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.deepEqual(out.data.members.map((m) => m.nickname), ['HTTP 成员']);
  }, {}, { SnowLumaWebSocketClient: WsDownBot, fetch: fetchStub });
});

// ── 3. 源码级断言：注册期按模式收敛 ────────────────────────────────────────


console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
