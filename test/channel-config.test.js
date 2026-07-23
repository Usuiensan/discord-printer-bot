import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDiscordChannelIds } from '../src/channelConfig.js';

test('multiple Discord channel IDs are trimmed, merged, and deduplicated', () => {
  assert.deepEqual(
    resolveDiscordChannelIds('111, 222,111', '333'),
    ['111', '222', '333']
  );
});

test('legacy single Discord channel ID remains supported', () => {
  assert.deepEqual(resolveDiscordChannelIds('', '111'), ['111']);
});
