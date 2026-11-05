import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectReleaseDocs } from './check-release-docs.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
assert.deepEqual(inspectReleaseDocs(root), [], '当前版本文档必须一致');
const temporaryRoot = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(temporaryRoot, 'qq-release-docs-'));
const files = ['package.json', 'package-lock.json', 'plugins/qq-mode-console/package.json', 'plugins/qq-agent-presets/package.json',
  'src/mcp-host-server.js', 'src/mcp-snowluma-safe.js', 'src/mcp-web-search-safe.js',
  'README.md', 'CHANGELOG.md', 'docs/README.md'];
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
files.push(`docs/releases/v${version}.md`);
try {
  for (const file of files) {
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  assert.deepEqual(inspectReleaseDocs(fixture), []);
  for (const [file, transform, expected] of [
    ['package.json', text => text.replace(`"version": "${version}"`, '"version": "invalid"'), 'invalid project version'],
    ['package-lock.json', text => text.replace(`"version": "${version}"`, '"version": "99.0.0"'), 'project version mismatch'],
    ['plugins/qq-mode-console/package.json', text => text.replace(`"version": "${version}"`, '"version": "99.0.0"'), 'project version mismatch'],
    ['plugins/qq-agent-presets/package.json', text => text.replace(`"version": "${version}"`, '"version": "99.0.0"'), 'project version mismatch'],
    ...['src/mcp-host-server.js', 'src/mcp-snowluma-safe.js', 'src/mcp-web-search-safe.js'].map(file => [file, text => text.replace(`version: '${version}'`, "version: '99.0.0'"), 'project version mismatch']),
    ['README.md', text => text.replace('当前版本', '旧版本'), 'missing current version'],
    ['CHANGELOG.md', text => text.replace(/(## \[[^\]]+\] - )\d{4}-\d{2}-\d{2}/, (_, heading) => `${heading}2026-02-30`), 'valid version/date heading'],
    [`docs/releases/v${version}.md`, text => text.replace('发布日期：', '日期：'), 'version or date mismatch'],
  ]) {
    const target = path.join(fixture, file);
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, transform(original));
    assert.ok(inspectReleaseDocs(fixture).some(issue => issue.includes(expected)), `${file}: 应拒绝不一致的发布文档`);
    fs.writeFileSync(target, original);
  }
  fs.unlinkSync(path.join(fixture, 'CHANGELOG.md'));
  assert.ok(inspectReleaseDocs(fixture).some(issue => issue.includes('missing release document')));
  console.log('版本文档检查通过：正常源码、版本漂移、日期错误与缺失文件均已验证。');
} finally {
  const relative = path.relative(temporaryRoot, fs.realpathSync(fixture));
  if (!relative.startsWith('qq-release-docs-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup path');
  fs.rmSync(fixture, { recursive: true, force: true });
}
