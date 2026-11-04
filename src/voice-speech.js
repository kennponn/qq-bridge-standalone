import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnAudioProcess } from './voice-process.js';
import { probeAudio } from './voice-core.js';
import { MIMO_VOICES, runMimoSpeech } from './voice-mimo.js';

export const SPEECH_VOICES = Object.freeze([
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓 · 温柔自然', gender: 'female' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊 · 明亮活泼', gender: 'female' },
  { id: 'zh-TW-HsiaoChenNeural', name: '晓臻 · 台湾女声', gender: 'female' },
  { id: 'zh-HK-HiuGaaiNeural', name: '晓佳 · 粤语女声', gender: 'female' }
]);
const VOICE_IDS = new Set(SPEECH_VOICES.map(v => v.id));
export const speechVoices = provider => provider === 'mimo' ? MIMO_VOICES : SPEECH_VOICES;
const voiceAllowed = (provider, voice) => speechVoices(provider).some(item => item.id === voice);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const bounded = (v, fallback, min, max) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fallback;
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function resolveVoiceSettings(value = {}) {
  const v = object(value) ? value : {};
  const i = object(v.incoming) ? v.incoming : {};
  const t = object(v.tts) ? v.tts : {};
  const provider = t.provider === 'mimo' ? 'mimo' : 'edge';
  return {
    enabled: v.enabled === true,
    incoming: { enabled: i.enabled !== false, timeoutMs: bounded(i.timeoutMs, 22000, 1000, 30000), maxChars: bounded(i.maxChars, 4000, 100, 4000) },
    tts: {
      enabled: t.enabled === true, onlineConsent: t.onlineConsent === true, provider,
      voice: voiceAllowed(provider, t.voice) ? t.voice : provider === 'mimo' ? '冰糖' : 'zh-CN-XiaoxiaoNeural',
      style: typeof t.style === 'string' ? Array.from(t.style.trim()).slice(0, 200).join('') : '', rate: bounded(t.rate, 0, -50, 50),
      randomReplyProbability: typeof t.randomReplyProbability === 'number' ? bounded(t.randomReplyProbability, 0, 0, 100) : 0,
      maxChars: bounded(t.maxChars, 300, 20, 300), timeoutMs: bounded(t.timeoutMs, 45000, 5000, 60000),
      maxSeconds: bounded(t.maxSeconds, 90, 5, 90)
    }
  };
}

// Only this narrow operator API may grant consent; old full-config saves preserve it.
export function mergeVoiceSettings(current, patch) {
  if (!object(patch)) throw error('语音设置必须是对象');
  const allowed = new Set(['enabled', 'incoming', 'tts']);
  if (Object.keys(patch).some(k => !allowed.has(k))) throw error('包含不支持的语音设置');
  const next = { ...(object(current) ? current : {}) };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw error('enabled 必须是布尔值');
    next.enabled = patch.enabled;
  }
  for (const [key, fields] of Object.entries({ incoming: ['enabled', 'timeoutMs', 'maxChars'], tts: ['enabled', 'onlineConsent', 'provider', 'voice', 'style', 'rate', 'randomReplyProbability', 'maxChars', 'timeoutMs', 'maxSeconds'] })) {
    if (patch[key] === undefined) continue;
    if (!object(patch[key]) || Object.keys(patch[key]).some(k => !fields.includes(k))) throw error(`${key} 设置无效`);
    next[key] = { ...(object(current?.[key]) ? current[key] : {}), ...patch[key] };
    for (const bool of ['enabled', 'onlineConsent']) {
      if (patch[key][bool] !== undefined && typeof patch[key][bool] !== 'boolean') throw error(`${key}.${bool} 必须是布尔值`);
    }
    for (const [field, min, max] of key === 'incoming' ? [['timeoutMs', 1000, 30000], ['maxChars', 100, 4000]] : [['rate', -50, 50], ['randomReplyProbability', 0, 100], ['maxChars', 20, 300], ['timeoutMs', 5000, 60000], ['maxSeconds', 5, 90]]) {
      const value = patch[key][field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)) throw error(`${key}.${field} 超出允许范围`);
    }
  }
  if (patch.tts?.provider !== undefined && !['edge', 'mimo'].includes(patch.tts.provider)) throw error('请选择微软或小米 MiMo 语音服务');
  if (patch.tts?.style !== undefined && (typeof patch.tts.style !== 'string' || Array.from(patch.tts.style).length > 200 || /[\x00-\x1f\x7f]/.test(patch.tts.style))) throw error('语音风格最多 200 字，不可含控制字符');
  const provider = resolveVoiceSettings(next).tts.provider;
  if (patch.tts?.voice !== undefined && !voiceAllowed(provider, patch.tts.voice)) throw error('请选择当前服务支持的音色');
  if (provider !== resolveVoiceSettings(current).tts.provider && patch.tts?.onlineConsent !== true) next.tts.onlineConsent = false;
  return { ...next, ...resolveVoiceSettings(next) };
}

export function randomVoiceReplyText(messages, value, { toolEnabled = false, replyToMessageId, atUserId, random = Math.random, onDecision } = {}) {
  const settings = resolveVoiceSettings(value);
  const tts = settings.tts;
  const report = (reason, text = null) => { onDecision?.(reason); return text; };
  if (!settings.enabled || !toolEnabled || !tts.enabled || !tts.onlineConsent || tts.randomReplyProbability === 0) return report('disabled');
  if (!Array.isArray(messages) || messages.length !== 1) return report('burst');
  if (replyToMessageId != null && String(replyToMessageId).trim()) return report('reply');
  if (atUserId) return report('mention');
  let text;
  try { text = validateSpeechText(messages[0], tts.maxChars); } catch { return report('invalid-text'); }
  // Keep rich content and copyable links/code as text; never read CQ instructions aloud.
  if (/\[CQ:|https?:\/\/|www\.|```|`|!\[|\[[^\]]*\]\(/i.test(text)) return report('rich-content');
  return random() < tts.randomReplyProbability / 100 ? report('selected', text) : report('probability-miss');
}

export function validateSpeechText(value, maxChars = 300) {
  if (typeof value !== 'string') throw error('朗读内容必须是文字');
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw error('朗读内容为空或包含控制字符');
  if (Array.from(text).length > maxChars) throw error(`朗读内容最多 ${maxChars} 字，请缩短后再试`);
  return text;
}

function checkedDirectory(root, relative) {
  const base = fs.realpathSync(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) throw error('语音缓存目录不安全', 500);
    const real = fs.realpathSync(current);
    if (!real.startsWith(base + path.sep)) throw error('语音缓存目录越界', 500);
  }
  return current;
}

function childEnvironment(runtimeDir) {
  const env = { PYTHONPATH: runtimeDir, PYTHONNOUSERSITE: '1', PYTHONIOENCODING: 'utf-8' };
  // Never inherit model keys, QQ tokens or arbitrary provider configuration.
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function runSpeechWorker({ root, output, text, voice, rate, timeoutMs, signal, check = false }) {
  const runtimeDir = path.join(root, 'assets', 'voice-runtime', 'vendor');
  const worker = path.join(root, 'scripts', 'edge-speech-worker.py');
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, stdout = '';
    const finish = (err, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (err) { try { child?.kill(); } catch {} reject(err); } else resolve(result);
    };
    const abort = () => finish(error('语音合成已取消', 409));
    if (signal?.aborted) return abort();
    try {
      child = spawnAudioProcess(process.env.QQ_BRIDGE_TTS_PYTHON || 'python', ['-s', '-P', worker, ...(check ? ['--check'] : [])], {
        shell: false, windowsHide: true, cwd: root, env: childEnvironment(runtimeDir), stdio: ['pipe', 'pipe', 'ignore']
      });
    } catch { finish(error('无法启动 Python 语音组件', 503)); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(error('语音服务超时，请稍后重试', 504)), timeoutMs || 5000);
    child.on('error', () => finish(error('Python 语音组件不可用', 503)));
    child.stdout.on('data', data => {
      stdout += data.toString('utf8');
      if (stdout.length > 4096) finish(error('语音组件返回异常', 502));
    });
    child.stdin.on('error', () => finish(error('语音组件输入失败', 502)));
    child.on('close', code => {
      let value;
      try { value = JSON.parse(stdout); } catch { finish(error('语音服务暂时不可用', 502)); return; }
      if (code !== 0 || value.ok !== true) { finish(error(check ? '请安装语音组件' : '在线语音合成失败（服务可能暂不可用）', 503)); return; }
      finish(null, value);
    });
    child.stdin.end(check ? '' : JSON.stringify({ output, text, voice, rate }));
  });
}

export function createSpeechService({ root, getConfig, auditText, run = runSpeechWorker, runMimo = runMimoSpeech, probe = probeAudio, now = Date.now }) {
  const entries = new Map();
  const TTL = 10 * 60000, MAX_BYTES = 3 * 1024 * 1024;
  let active = 0, readiness = null, checkedAt = 0, checking = null;
  const cfg = () => resolveVoiceSettings(getConfig());
  const deleteOwned = file => {
    try {
      const dir = checkedDirectory(root, 'state/voice-previews');
      if (path.dirname(file) !== dir || fs.lstatSync(file).isSymbolicLink() || fs.realpathSync(file) !== file) return;
      fs.unlinkSync(file);
    } catch {}
  };
  const remove = entry => { entries.delete(entry.id); deleteOwned(entry.file); };
  const prune = () => {
    for (const entry of entries.values()) if (entry.expiresAt <= now() && !entry.busy) remove(entry);
  };
  async function status(force = false) {
    if (cfg().tts.provider === 'mimo') {
      try { await runMimo({ root, check: true }); return true; } catch { return false; }
    }
    if (!force && readiness !== null && now() - checkedAt < 60000) return readiness;
    if (checking) return checking;
    checking = (async () => {
      try { await run({ root, check: true, timeoutMs: 5000 }); readiness = true; }
      catch { readiness = false; }
      checkedAt = now(); checking = null; return readiness;
    })();
    return checking;
  }
  async function health() {
    const installed = await status(), settings = cfg();
    const mimo = settings.tts.provider === 'mimo';
    return { ttsInstalled: installed, ttsReady: installed && settings.tts.enabled && settings.tts.onlineConsent,
      provider: settings.tts.provider, reason: !installed ? mimo ? '请保存 MiMo API Key，或检查本机凭据' : '语音组件未安装或 Python 不可用'
        : !settings.tts.onlineConsent ? `请确认允许朗读文字发送到${mimo ? '小米 MiMo' : '微软'}在线语音服务`
        : !settings.tts.enabled ? '文字转语音已关闭' : mimo ? 'MiMo Key 已配置；实际合成取决于账号权限和网络服务' : '在线女声可用，实际合成仍取决于网络服务' };
  }
  async function synthesize(value, { voice, rate, signal, assertAllowed = () => {} } = {}) {
    const settings = cfg();
    if (!settings.tts.enabled || !settings.tts.onlineConsent) throw error('请先启用文字转语音并确认在线服务授权', 403);
    const text = validateSpeechText(value, settings.tts.maxChars);
    const selected = voice ?? settings.tts.voice, speed = rate ?? settings.tts.rate;
    if (!voiceAllowed(settings.tts.provider, selected) || !Number.isInteger(speed) || speed < -50 || speed > 50) throw error('音色或语速无效');
    auditText(text); if (settings.tts.style) auditText(settings.tts.style); assertAllowed();
    const assertProvider = () => { if (cfg().tts.provider !== settings.tts.provider) throw error('语音服务已变化，请重新生成', 409); };
    if (!(await status())) throw error('语音组件不可用，请检查 Python 和 Edge TTS 安装', 503);
    assertAllowed();
    assertProvider();
    if (!cfg().tts.enabled || !cfg().tts.onlineConsent) throw error('在线语音授权已关闭，已取消上传', 409);
    if (signal?.aborted) throw error('语音合成已取消', 409);
    if (active >= 2) throw error('正在生成语音，请稍后再试', 429);
    prune();
    if (entries.size + active >= 20) throw error('试听缓存已满，请稍后再试', 429);
    const dir = checkedDirectory(root, 'state/voice-previews');
    // Remove only expired files minted by this service; never touch user audio or recurse.
    for (const name of fs.readdirSync(dir)) {
      if (!ID_RE.test(name.replace(/\.mp3$/, '')) || !name.endsWith('.mp3')) continue;
      const file = path.join(dir, name), st = fs.lstatSync(file);
      if (st.isFile() && !st.isSymbolicLink() && now() - st.mtimeMs > TTL && ![...entries.values()].some(e => e.file === file)) {
        try { fs.unlinkSync(file); } catch {}
      }
    }
    const id = randomUUID(), file = path.join(dir, id + '.mp3');
    active++;
    try {
      const worker = settings.tts.provider === 'mimo' ? runMimo : run;
      await worker({ root, output: file, text, voice: selected, rate: speed, style: settings.tts.style, timeoutMs: settings.tts.timeoutMs, signal });
      assertAllowed();
      assertProvider();
      const live = cfg();
      if (!live.tts.enabled || !live.tts.onlineConsent) throw error('在线语音授权已关闭，合成结果已丢弃', 409);
      if (signal?.aborted) throw error('语音合成已取消', 409);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.size < 4 || st.size > MAX_BYTES) throw error('生成音频大小或路径异常', 502);
      const header = Buffer.alloc(3), fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, header, 0, header.length, 0); }
      finally { fs.closeSync(fd); }
      if (header.toString() !== 'ID3' && !(header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) throw error('生成结果不是 MP3 音频', 502);
      const info = await probe(file, { timeoutMs: 5000 });
      if (!info.ok || info.codec !== 'mp3' || !(info.duration > 0) || info.duration > settings.tts.maxSeconds) throw error('语音过长或无法校验，请缩短朗读内容', 502);
      assertAllowed();
      assertProvider();
      if (!cfg().tts.enabled || !cfg().tts.onlineConsent) throw error('在线语音授权已关闭，合成结果已丢弃', 409);
      if (signal?.aborted) throw error('语音合成已取消', 409);
      const entry = { id, file, text, provider: settings.tts.provider, voice: selected, rate: speed, chars: Array.from(text).length, duration: info.duration, expiresAt: now() + TTL, busy: false, used: false };
      entries.set(id, entry);
      return entry;
    } catch (err) { deleteOwned(file); throw err; }
    finally { active--; }
  }
  function get(id) {
    prune();
    if (typeof id !== 'string' || !ID_RE.test(id)) throw error('试听编号无效');
    const entry = entries.get(id);
    if (!entry || entry.expiresAt <= now()) throw error('试听已过期，请重新生成', 404);
    if (entry.provider !== cfg().tts.provider) throw error('语音服务已变化，请重新生成试听', 409);
    const dir = checkedDirectory(root, 'state/voice-previews');
    const st = fs.lstatSync(entry.file);
    if (!st.isFile() || st.isSymbolicLink() || fs.realpathSync(entry.file) !== path.join(dir, id + '.mp3')) throw error('试听文件不可用', 404);
    return entry;
  }
  async function use(id, send) {
    const entry = get(id);
    if (entry.busy || entry.used) throw error('这条试听已发送或正在发送，请勿重复提交', 409);
    entry.busy = true;
    try { const result = await send(entry); entry.used = true; return result; }
    finally { entry.busy = false; }
  }
  function discard(id) {
    const entry = entries.get(id);
    if (!entry || entry.busy) return false;
    remove(entry); return true;
  }
  return { health, synthesize, get, use, discard, invalidate: () => { for (const entry of entries.values()) if (!entry.busy) remove(entry); } };
}
