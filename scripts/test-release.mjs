import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = process.argv.includes('--voice') ? [
  'test-voice-incoming.mjs', 'test-voice-speech.mjs', 'test-voice-tools.mjs', 'test-voice-bridge.mjs',
] : [
  'test-standalone.mjs', 'test-engine-settings.mjs', 'test-engine-console-ui.mjs',
  'test-direct-engine.mjs', 'test-direct-tools-startup.mjs',
  'test-context-memory-bridge.mjs', 'test-context-memory-ui.mjs',
  'test-always-awake-bridge.mjs', 'test-always-awake-timing.mjs',
  'test-group-send-permission.mjs', 'test-muted-group-bridge.mjs',
  'test-role-card.mjs', 'test-persona-save-ui.mjs', 'test-console-local-access.mjs',
  'test-snowluma-upstream-health.mjs', 'test-preset-local-tools.mjs', 'test-voice-system.mjs',
];
let failed = 0;
for (const file of tests) {
  console.log(`\nOffline regression: ${file}`);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', file)], {
    cwd: root, stdio: 'inherit', timeout: 90000, windowsHide: true,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) { failed++; console.error(`FAILED ${file}: ${result.error?.message || result.status}`); }
}
console.log(`\nOffline release suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
