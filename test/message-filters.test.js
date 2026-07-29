import assert from 'node:assert/strict';
import test from 'node:test';
import { isOwnBotMessage } from '../src/messageFilters.js';

test('ignores only messages authored by this bot', () => {
  const client = { user: { id: 'self-bot' } };

  assert.equal(isOwnBotMessage({ author: { id: 'self-bot', bot: true }, client }), true);
  assert.equal(isOwnBotMessage({ author: { id: 'other-bot', bot: true }, client }), false);
  assert.equal(isOwnBotMessage({ author: { id: 'human', bot: false }, client }), false);
});

test('does not ignore bot messages when the client identity is unavailable', () => {
  assert.equal(isOwnBotMessage({ author: { id: 'some-bot', bot: true } }), false);
});
