import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectReleaseDocs(root) {
  const issues = [];
  const read = file => {
    try { return fs.readFileSync(path.join(root, file), 'utf8'); }
    catch { issues.push(`${file}: missing release document`); return ''; }
  };
  const json = file => {
    try { return JSON.parse(read(file)); }
    catch { issues.push(`${file}: invalid release metadata`); return {}; }
  };
  const pkg = json('package.json');
  const version = pkg.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.test(version)) {
    return [...issues, 'package.json: invalid project version'];
  }
  const lock = json('package-lock.json');
  if (lock.version !== version || lock.packages?.['']?.version !== version) issues.push('package-lock.json: project version mismatch');
  for (const file of ['src/mcp-snowluma-safe.js', 'src/mcp-web-search-safe.js']) {
    const declared = /new McpServer\(\{[^}]*version:\s*'([^']+)'/.exec(read(file))?.[1];
    if (declared !== version) issues.push(`${file}: project version mismatch`);
  }
  const tag = `v${version}`;
  const releaseFile = `docs/releases/${tag}.md`;
  const releaseUrl = `https://github.com/kennponn/qq-bridge-standalone/releases/tag/${tag}`;
  const readme = read('README.md');
  if (!readme.includes(`**当前版本：\`${tag}\``)) issues.push('README.md: missing current version');
  if (!readme.includes(releaseUrl) || !readme.includes('(CHANGELOG.md)')) issues.push('README.md: missing release or changelog link');
  if (!read('docs/README.md').includes(`(releases/${tag}.md)`)) issues.push('docs/README.md: missing current release link');
  const changelog = read('CHANGELOG.md');
  if (!changelog.includes('## [未发布]')) issues.push('CHANGELOG.md: missing unreleased section');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const date = new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})$`, 'm').exec(changelog)?.[1];
  if (!date || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) issues.push('CHANGELOG.md: missing valid version/date heading');
  if (!changelog.includes(`[${version}]: ${releaseUrl}`) || !changelog.includes(`/compare/${tag}...main`)) issues.push('CHANGELOG.md: missing current release comparison links');
  const release = read(releaseFile);
  if (!release.startsWith(`# ${tag}`) || !date || !release.includes(`发布日期：${date}。`)) issues.push(`${releaseFile}: version or date mismatch`);
  return issues;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = inspectReleaseDocs(fileURLToPath(new URL('..', import.meta.url)));
  if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
  else console.log('版本、锁文件、安全工具与中文发布文档检查通过。');
}
