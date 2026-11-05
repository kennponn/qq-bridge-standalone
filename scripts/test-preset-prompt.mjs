// Pure local prompt validation, without network or private state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PRESET_BLOCKING_SUBSTRINGS, PRESET_REQUIRED_MARKERS, presetPromptBlockers, presetPromptWarnings } from '../src/preset-prompt.js';
const prompt = fs.readFileSync(new URL('../prompts/standalone-system.txt', import.meta.url), 'utf8');
test('default standalone prompt satisfies the safety boundary', () => {
  assert.deepEqual(presetPromptBlockers(prompt), []);
  assert.deepEqual(presetPromptWarnings(prompt), []);
});
test('each removed safety invariant blocks saving', () => {
  for (const text of PRESET_BLOCKING_SUBSTRINGS) {
    assert.ok(presetPromptBlockers(prompt.replaceAll(text, '')).some(reason => reason.includes(text)));
  }
  for (const text of ['', '   ', 'short']) assert.ok(presetPromptBlockers(text).length);
});
test('missing section headings warn without altering valid content', () => {
  for (const marker of PRESET_REQUIRED_MARKERS) {
    const content = prompt.replaceAll(marker, '');
    assert.ok(presetPromptWarnings(content).length);
    assert.deepEqual(presetPromptBlockers(content), []);
  }
  assert.deepEqual(presetPromptBlockers(prompt + '\n\nAdditional local instructions.'), []);
});
