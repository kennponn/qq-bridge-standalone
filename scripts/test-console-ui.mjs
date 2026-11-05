// Browser round trips use real handlers with fake gateways and disposable state.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startConsoleFixture } from './console-ui-fixture.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fixture = await startConsoleFixture();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.url ? route.continue() : route.abort());
  await context.addInitScript(token => localStorage.setItem('consoleToken', token), fixture.token);
  const page = await context.newPage();
  const errors = [], failures = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400) failures.push([new URL(r.url()).pathname, r.status()]); });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(`${fixture.url}/?token=${fixture.token}`, { waitUntil: 'networkidle' });
  const show = async (view, module) => page.evaluate(({ view, module }) => {
    setConsolePage(view);
    if (module && view === 'persona') setPersonaModule(module);
    if (module && view === 'social-v2') setV2Module(module);
  }, { view, module });
  const reveal = async id => page.locator(id).evaluate(el => { for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true; });
  for (const view of ['overview','sessions','persona','social-v2','slang','usage','access','operations','reference']) await show(view);
  await show('slang'); await reveal('#slangConfigSave');
  await page.locator('#slangConfigSave').click();
  await page.waitForFunction(() => document.getElementById('slangConfigMsg').textContent.includes('已保存'));
  await show('social-v2', 'voice');
  await page.locator('#v2ConfigSaveTop').click();
  await page.waitForFunction(() => document.getElementById('v2ConfigMsg').textContent.includes('已保存'));
  await show('persona', 'advanced'); await reveal('#simPromptEdit');
  const original = await page.locator('#simPromptText').inputValue();
  await page.locator('#simPromptEdit').click();
  await page.locator('#simPromptText').fill(original + '\n\nFixture prompt round trip.');
  await page.locator('#simPromptSave').click();
  await page.waitForFunction(() => document.getElementById('simPromptMsg').textContent.includes('已保存'));
  await page.locator('#simPromptRestore').click();
  await page.waitForFunction(original => document.getElementById('simPromptText').value === original, original);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [view, module] of [['persona','library'],['persona','editor'],['social-v2','voice']]) {
      await show(view, module);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view}/${module} overflow at ${width}`);
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(failures, []);
  assert.equal(fixture.h.calls.sent.length, 0);
  assert.equal(fixture.h.calls.http.filter(call => /send_(private|group)_msg$/.test(call.url)).length, 0);
  console.log('PASS standalone browser: navigation, settings save, prompt save/restore, responsive layout; zero QQ sends');
} finally {
  await browser?.close();
  await fixture.close();
}
