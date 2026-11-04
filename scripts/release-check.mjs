import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const issues = [];
const forbidden = /^(?:state|audio|node_modules|assets\/voice-runtime|roles\/local|roles\/source-notices)(?:\/|$)|^roles\/(?!README\.md$|assistant\.md$)[^/]+\.md$|(?:^|\/)config\.json$|(?:^|\/)\.env(?:\.|$)|(?:^|\/)privacy-rules\.json$|\.bak(?:[-.]|$)|\.(?:log|pyc|pyd|exe|dll|node|pem|key|p12|pfx|zip|tar|tgz)$/i;
const slash = s => s.replaceAll('\\', '/');
// File-backed output also works where Windows disallows anonymous child pipes.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-release-git-'));
const output = path.join(temporary, 'files');
const descriptor = fs.openSync(output, 'w');
let git;
try {
  git = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, stdio: ['ignore', descriptor, 'ignore'], timeout: 15000, windowsHide: true });
} finally {
  fs.closeSync(descriptor);
}
const gitOutput = fs.readFileSync(output, 'utf8');
fs.unlinkSync(output);
fs.rmdirSync(temporary);
let files;
if (git.status === 0) {
  files = [...new Set(gitOutput.split('\0').filter(Boolean))];
} else {
  files = [];
  const ignoredDirs = new Set(['.git', 'state', 'audio', 'node_modules', '__pycache__', '.npm-cache']);
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isSymbolicLink()) { issues.push(`${rel}: symbolic link`); continue; }
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name) && !['assets/voice-runtime', 'roles/local', 'roles/source-notices'].includes(rel)) walk(path.join(dir, entry.name), rel + '/');
      } else if (!['config.json', 'privacy-rules.json'].includes(entry.name) && !entry.name.startsWith('.env')) {
        files.push(rel);
      }
    }
  }
  walk(root);
}

function duplicateJsonKeys(text, file) {
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)].map(m => m[0]);
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i + 1] === ':' && stack.at(-1) instanceof Set) {
      const key = JSON.parse(token), keys = stack.at(-1);
      if (keys.has(key)) issues.push(`${file}: duplicate JSON key ${key}`);
      keys.add(key);
    }
  }
}

const rules = [
  ['personal Windows user path', /[A-Za-z]:[\\/]+Users[\\/]+(?![<*]|x[\\/]|test[\\/]|example[\\/]|user[\\/])[\w.-]{2,}[\\/]/gi],
  ['personal Unix user path', /\/(?:home|Users)\/(?!<|test\/|user\/|example\/)[\w.-]{2,}\//g],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['known secret token prefix', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,}|AKIA[0-9A-Z]{16})\b/g],
  ['credential string literal', /\b(?:api[_-]?key|access[_-]?token|console[_-]?token|password|secret)["']?\s*[:=]\s*["']([A-Za-z0-9_+/=.\-]{16,})["']/gi],
];
const placeholder = value => /^(?:TEST[_-]|FAKE[_-]|test[_-]|fake[_-]|fixture[_-]|mock[_-]|synthetic[_-]|sk-test-)|-fixture-|^(?:stale-browser-token|not-a-model-field)$/.test(value);
for (const file of files) {
  const rel = slash(file);
  if (forbidden.test(rel)) { issues.push(`${rel}: forbidden private/runtime artifact`); continue; }
  const absolute = path.resolve(root, file);
  if (!absolute.startsWith(path.resolve(root) + path.sep)) { issues.push(`${rel}: path escape`); continue; }
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) { issues.push(`${rel}: symbolic link`); continue; }
  if (stat.size > 5 * 1024 * 1024) { issues.push(`${rel}: oversized source artifact`); continue; }
  const data = fs.readFileSync(absolute);
  if (data.includes(0)) { issues.push(`${rel}: unexpected binary artifact`); continue; }
  const text = data.toString('utf8');
  if (rel.endsWith('.json')) {
    try { JSON.parse(text); duplicateJsonKeys(text, rel); } catch { issues.push(`${rel}: invalid JSON`); }
  }
  for (const [label, regex] of rules) {
    regex.lastIndex = 0;
    for (const match of text.matchAll(regex)) {
      // Synthetic credential literals are allowed only in offline test fixtures.
      if (label === 'credential string literal' && placeholder(match[1]) && /^(?:scripts\/test-|scripts\/audit-bridge-harness|scripts\/console-ui-fixture)/.test(rel)) continue;
      if (label === 'credential string literal' && /^[A-Z][A-Z0-9_]+$/.test(match[1])) continue;
      if (label === 'private key material' && rel.startsWith('scripts/test-') && match[0] === '-----BEGIN ' + 'PRIVATE KEY-----' && /['"]/.test(text[match.index + match[0].length] || ' ')) continue;
      const line = text.slice(0, match.index).split('\n').length;
      issues.push(`${rel}:${line}: ${label} (value redacted)`);
    }
  }
}
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
if (config.ownerQQ !== null || config.allowAllWhenEmpty !== false || config.allow?.groups?.length || config.allow?.private?.length) issues.push('config.example.json: unsafe identity/allowlist defaults');
if (config.consoleToken || config.snowluma?.accessToken || config.dsh?.authToken) issues.push('config.example.json: nonempty administrative credential');
if (config.socialV2?.voice?.tts?.enabled !== false || config.socialV2?.voice?.tts?.onlineConsent !== false) issues.push('config.example.json: online speech must default off without consent');
for (const required of ['README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'roles/assistant.md', 'docs/PUBLISHING.md', 'docs/guides/VOICE.md', '.github/workflows/ci.yml']) {
  if (!files.map(slash).includes(required)) issues.push(`${required}: missing public release file`);
}
if (issues.length) {
  console.error(`Release check failed: ${issues.length} finding(s).`);
  console.error([...new Set(issues)].join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release check passed: ${files.length} source files; no forbidden artifacts or detected secrets; safe sample defaults and unique JSON keys.`);
}
