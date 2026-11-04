import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hardenFile, icacls, isHardened } from './state-acl.mjs';

export const MIMO_TTS_ENDPOINT = 'https://api.xiaomimimo.com/v1/chat/completions';
export const MIMO_TTS_MODEL = 'mimo-v2.5-tts';
export const MIMO_VOICES = Object.freeze([
  { id: '冰糖', name: '冰糖 · 中文女声', gender: 'female' },
  { id: '茉莉', name: '茉莉 · 中文女声', gender: 'female' },
  { id: 'Mia', name: 'Mia · 英文女声', gender: 'female' },
  { id: 'Chloe', name: 'Chloe · 英文女声', gender: 'female' },
  { id: '苏打', name: '苏打 · 中文男声', gender: 'male' },
  { id: '白桦', name: '白桦 · 中文男声', gender: 'male' },
  { id: 'Milo', name: 'Milo · 英文男声', gender: 'male' },
  { id: 'Dean', name: 'Dean · 英文男声', gender: 'male' }
]);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
export function validateMimoApiKey(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[^\x21-\x7e]/.test(value)) throw fail('MiMo API Key 格式无效');
  return value;
}
function secretPath(root) {
  const base = fs.realpathSync(root), state = path.join(base, 'state');
  if (!fs.existsSync(state)) fs.mkdirSync(state, { mode: 0o700 });
  if (!fs.lstatSync(state).isDirectory() || fs.lstatSync(state).isSymbolicLink() || fs.realpathSync(state) !== state) throw fail('MiMo 凭据目录不安全', 500);
  return path.join(state, 'mimo-tts-secret.json');
}
export function loadMimoApiKey(root, env = process.env) {
  if (env.MIMO_API_KEY) return validateMimoApiKey(env.MIMO_API_KEY);
  try {
    const file = secretPath(root), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw fail('MiMo 凭据文件无效', 500);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.version !== 1 || record.endpoint !== MIMO_TTS_ENDPOINT) throw fail('MiMo 凭据不属于官方接口', 500);
    return record.cleared === true ? '' : validateMimoApiKey(record.apiKey);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw fail('MiMo 凭据不可读取，请重新保存或清除 Key', 500);
  }
}
export function mimoSecretStatus(root, env = process.env) {
  try { return { configured: Boolean(loadMimoApiKey(root, env)), source: env.MIMO_API_KEY ? 'environment' : 'local' }; }
  catch { return { configured: false, source: 'none', error: 'MiMo 凭据不可读取，请重新保存或清除 Key' }; }
}

// Prepare a private file before changing settings; the caller can roll back config on commit failure.
export function prepareMimoKeyUpdate(root, { mimoApiKey, clearMimoApiKey } = {}) {
  if (mimoApiKey !== undefined && typeof mimoApiKey !== 'string') throw fail('MiMo API Key 必须是字符串');
  if (clearMimoApiKey !== undefined && typeof clearMimoApiKey !== 'boolean') throw fail('清除 MiMo Key 必须是布尔值');
  if (clearMimoApiKey && mimoApiKey) throw fail('不能同时设置和清除 MiMo Key');
  if (!mimoApiKey && !clearMimoApiKey) return { commit() {}, cleanup() {} };
  if (process.env.MIMO_API_KEY) throw fail('当前使用 MIMO_API_KEY 环境变量；请先移除该变量，再保存或清除本机 Key');
  if (mimoApiKey) validateMimoApiKey(mimoApiKey);
  const target = secretPath(root), temporary = path.join(path.dirname(target), `.mimo-${randomUUID()}.tmp`);
  let fd;
  const cleanup = () => { try { fs.unlinkSync(temporary); } catch {} };
  try {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw fail('MiMo 凭据路径不安全', 500);
    fd = fs.openSync(temporary, 'wx', 0o600);
    if (!hardenFile(temporary).ok) throw fail('无法保护 MiMo Key 文件权限', 500);
    if (process.platform === 'win32') {
      const result = icacls([temporary, '/remove:g', '*S-1-5-11', '*S-1-5-32-545', '*S-1-1-0', '/Q']);
      if (result.error || result.status !== 0) throw fail('无法保护 MiMo Key 文件权限', 500);
    }
    if (!isHardened(temporary)) throw fail('无法确认 MiMo Key 文件权限', 500);
    fs.writeFileSync(fd, JSON.stringify({ version: 1, endpoint: MIMO_TTS_ENDPOINT,
      ...(clearMimoApiKey ? { cleared: true } : { apiKey: mimoApiKey }) }) + '\n');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    return { commit() {
      if (secretPath(root) !== target) throw fail('MiMo 凭据目录已变化', 500);
      try { fs.renameSync(temporary, target); } catch { throw fail('无法保存 MiMo Key，请稍后重试', 500); }
    }, cleanup };
  } catch (error) { if (fd !== undefined) fs.closeSync(fd); cleanup(); throw error; }
}

async function limitedJson(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw fail('MiMo 未返回有效音频数据', 502);
  const chunks = []; let size = 0;
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 6 * 1024 * 1024) throw fail('MiMo 返回音频过大，请缩短文字', 502);
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('MiMo 返回数据格式无效', 502); }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); }
}

export async function runMimoSpeech({ root, output, text, voice, rate, style = '', timeoutMs = 45000, signal, check = false },
  { fetchImpl = fetch, env = process.env } = {}) {
  const apiKey = loadMimoApiKey(root, env);
  if (!apiKey) throw fail('请先保存小米 MiMo API Key', 503);
  if (check) return { ok: true };
  if (typeof text !== 'string' || !text || Array.from(text).length > 300
      || !MIMO_VOICES.some(item => item.id === voice) || !Number.isInteger(rate) || rate < -50 || rate > 50
      || typeof style !== 'string' || Array.from(style).length > 200
      || !path.isAbsolute(output) || !output.endsWith('.mp3') || fs.existsSync(output)) throw fail('MiMo 朗读参数无效');
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    combined.throwIfAborted();
    const instruction = [style.trim(), rate === 0 ? '' : rate > 0 ? `语速稍快，目标比正常快约 ${rate}%。` : `语速稍慢，目标比正常慢约 ${-rate}%。`].filter(Boolean).join('\n');
    response = await fetchImpl(MIMO_TTS_ENDPOINT, {
      method: 'POST', redirect: 'error', signal: combined,
      headers: { 'content-type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ model: MIMO_TTS_MODEL, stream: false,
        messages: [...(instruction ? [{ role: 'user', content: instruction }] : []), { role: 'assistant', content: text }],
        audio: { format: 'mp3', voice } })
    });
    // Never surface provider bodies, which may contain credentials or spoken text.
    if (!response.ok) throw fail(response.status === 401 ? 'MiMo API Key 无效或已撤销'
      : response.status === 403 ? 'MiMo 账号没有语音模型权限'
      : response.status === 429 ? 'MiMo 额度或请求频率受限，请稍后重试'
      : `MiMo 语音服务暂不可用（HTTP ${response.status}）`, response.status === 429 ? 429 : 503);
    const result = await limitedJson(response, combined), encoded = result?.choices?.[0]?.message?.audio?.data;
    if (typeof encoded !== 'string' || !encoded || encoded.length > 4 * 1024 * 1024
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fail('MiMo 未返回有效音频，请稍后重试', 502);
    const audio = Buffer.from(encoded, 'base64');
    if (audio.length < 4 || audio.length > 3 * 1024 * 1024 || audio.toString('base64') !== encoded) throw fail('MiMo 音频大小或编码异常', 502);
    combined.throwIfAborted();
    fs.writeFileSync(output, audio, { flag: 'wx', mode: 0o600 });
    return { ok: true };
  } catch (error) {
    if (signal?.aborted) throw fail('语音合成已取消', 409);
    if (controller.signal.aborted) throw fail('MiMo 语音服务超时，请稍后重试', 504);
    if (error.statusCode) throw error;
    throw fail('MiMo 在线语音连接失败，请检查网络或稍后重试', 503);
  } finally { clearTimeout(timer); try { await response?.body?.cancel(); } catch {} }
}
