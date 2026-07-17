import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapUnicodeText } from '../src/textLayout.js';
import { displayColumns } from '../src/discordContent.js';

test('Unicode wrapping keeps English words together when they fit', () => {
  assert.deepEqual(
    wrapUnicodeText('hello receipt printer world', 15, displayColumns),
    ['hello receipt', 'printer world']
  );
});

test('Unicode wrapping emergency-breaks only a word wider than the line', () => {
  const lines = wrapUnicodeText('supercalifragilistic', 8, displayColumns);
  assert.deepEqual(lines, ['supercal', 'ifragili', 'stic']);
  assert.ok(lines.every((line) => displayColumns(line) <= 8));
});

test('Unicode wrapping observes Japanese opening and closing punctuation rules', () => {
  const lines = wrapUnicodeText('これは「日本語です。」テストです。', 12, displayColumns);
  assert.ok(lines.every((line) => !/^[、。，．！？）］｝」』】]/u.test(line)));
  assert.ok(lines.every((line) => !/[（［｛「『【]$/u.test(line)));
});

test('Unicode wrapping does not split half-width kana from voiced marks', () => {
  assert.deepEqual(
    wrapUnicodeText('ｶﾞｷﾞｸﾞｹﾞｺﾞ', 4, displayColumns),
    ['ｶﾞｷﾞ', 'ｸﾞｹﾞ', 'ｺﾞ']
  );
});

test('Unicode wrapping preserves Discord styles across wrapped lines', () => {
  assert.deepEqual(
    wrapUnicodeText('**hello receipt printer world**', 15, displayColumns),
    ['**hello receipt**', '**printer world**']
  );
});
