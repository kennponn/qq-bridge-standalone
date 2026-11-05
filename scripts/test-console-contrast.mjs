// Offline palette guards; real native popups still require browser visual checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const tokens = source => Object.fromEntries([...source.matchAll(/(--[\w-]+):\s*(#[0-9a-f]+)\s*;/gi)].map(m => [m[1], m[2]]));
const light = tokens(css.match(/:root\s*{([^}]+)}/)[1]);
const dark = { ...light, ...tokens(css.match(/\[data-theme="dark"\]\s*{([^}]+)}/)[1]) };

function luminance(hex) {
  let value = hex.slice(1);
  if (value.length === 3) value = [...value].map(c => c + c).join('');
  assert.equal(value.length, 6, 'Control colors must be opaque');
  return value.match(/../g).map(c => parseInt(c, 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function ratio(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function atLeast(palette, foreground, background, minimum) {
  const actual = ratio(palette[foreground], palette[background]);
  assert.ok(actual >= minimum, `${foreground} / ${background}: ${actual.toFixed(2)} must be >= ${minimum}`);
}

for (const [theme, palette] of Object.entries({ light, dark })) {
  test(`${theme}: labels, hints, menus, disclosures and selected controls remain readable`, () => {
    for (const background of ['--surface', '--control-hover-bg']) {
      for (const foreground of ['--text-input', '--label', '--placeholder']) atLeast(palette, foreground, background, 4.5);
    }
    for (const background of ['--disclosure-bg', '--disclosure-open-bg', '--control-hover-bg']) atLeast(palette, '--text-strong', background, 4.5);
    for (const background of ['--accent-solid-bg', '--accent-solid-hover']) atLeast(palette, '--accent-solid-fg', background, 4.5);
    atLeast(palette, '--control-disabled-fg', '--control-disabled-bg', 4.5);
    atLeast(palette, '--muted', '--surface', 4.5);
  });
  test(`${theme}: input boundaries and keyboard focus do not disappear into the background`, () => {
    for (const border of ['--border-input', '--control-hover-border', '--focus-ring']) {
      for (const background of ['--surface', '--control-hover-bg']) atLeast(palette, border, background, 3);
    }
    for (const background of ['--disclosure-bg', '--disclosure-open-bg']) atLeast(palette, '--focus-ring', background, 3);
  });
}

test('native selects retain explicit popup, selection and disabled colors', () => {
  assert.match(css, /select option,select optgroup\s*{[^}]*background:var\(--surface\);[^}]*color:var\(--text-input\)/);
  assert.match(css, /select option:checked\s*{[^}]*background:var\(--accent-solid-bg\);[^}]*color:var\(--accent-solid-fg\)/);
  assert.match(css, /select:disabled,select option:disabled,input:disabled,textarea:disabled\s*{[^}]*opacity:1/);
  assert.doesNotMatch(css, /appearance\s*:\s*none/);
});

test('mobile select width, disclosure focus and selected-tab hover have dedicated states', () => {
  assert.match(css, /\.settings-content > \.row > select\s*{[^}]*flex-basis:100%!important/);
  assert.match(css, /\.settings-group > summary:focus-visible\s*{[^}]*outline-offset:-4px/);
  assert.match(css, /\.v2-module-tab\[aria-selected="true"\]:hover\s*{[^}]*background:var\(--accent-solid-hover\)/);
  assert.match(css, /@media\s*\(forced-colors:active\)/);
});
