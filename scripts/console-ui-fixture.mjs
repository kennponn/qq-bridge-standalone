// Offline browser fixture backed by the real isolated bridge handlers.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

export async function startConsoleFixture({ port = 0, htmlPath } = {}) {
  const h = await bridgeHarness({
    config: { consolePort: port, socialV2: { enabled: true, tools: { sendVoice: false },
      voice: { enabled: true, tts: { enabled: true, onlineConsent: true, randomReplyProbability: 0 } } } },
    files: {
      'public/console.html': fs.readFileSync(htmlPath || new URL('../public/console.html', import.meta.url), 'utf8'),
      'prompts/standalone-system.txt': fs.readFileSync(new URL('../prompts/standalone-system.txt', import.meta.url), 'utf8'),
      'roles/fixture.md': '# Fixture\n\nFriendly and concise.',
    },
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, token: 'fixture-console-token', h,
    async close() { await new Promise(resolve => server.close(resolve)); await h.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.split('=')[1] || 4173);
  const fixture = await startConsoleFixture({ port });
  console.log(`Offline fixture: ${fixture.url}/?token=${fixture.token}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
