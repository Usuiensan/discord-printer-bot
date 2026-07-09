import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDiscordStyleTokens } from '../src/discordContent.js';

test('closed double asterisks are parsed as bold', () => {
  assert.deepEqual(parseDiscordStyleTokens('a **bold** z'), [
    { text: 'a ', bold: false, underline: false },
    { text: 'bold', bold: true, underline: false },
    { text: ' z', bold: false, underline: false }
  ]);
});

test('unclosed double asterisks remain plain text', () => {
  assert.deepEqual(parseDiscordStyleTokens('a **not bold'), [
    { text: 'a **not bold', bold: false, underline: false }
  ]);
});

test('unclosed double underscores remain plain text', () => {
  assert.deepEqual(parseDiscordStyleTokens('a __not underline'), [
    { text: 'a __not underline', bold: false, underline: false }
  ]);
});
