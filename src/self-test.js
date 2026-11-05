// Read-only local diagnostics. Never connect to QQ, a model, or another backend.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEngineStatus, loadStoredEngineKey } from './engine-settings.js';
import { presetPromptBlockers } from './preset-prompt.js';
const root = fileURLToPath(new URL('..', import.meta.url));
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const storedApiKey = loadStoredEngineKey(path.join(root, 'state/direct-engine-secret.json'));
  const status = getEngineStatus({ cfg, storedApiKey });
  const prompt = fs.readFileSync(path.join(root, 'prompts/standalone-system.txt'), 'utf8');
  const promptOk = presetPromptBlockers(prompt).length === 0;
  const allowlist = ['private', 'groups'].some(key => Array.isArray(cfg.allow?.[key]) && cfg.allow[key].length > 0);
  console.log(JSON.stringify({ backend: 'standalone', configValid: status.ok,
    modelConfigured: status.ready, keyConfigured: status.secret.configured,
    promptOk, allowlistConfigured: allowlist, networkTested: false }, null, 2));
  console.log('仅检查本地配置；不回显密钥、账号、人格或聊天内容，也不发送消息。');
  process.exitCode = status.ok && status.ready && promptOk && allowlist ? 0 : 1;
} catch {
  console.error('本地自检未通过：请检查 config.json、模型密钥和独立提示词文件。可在本地控制台修复。');
  process.exitCode = 1;
}
