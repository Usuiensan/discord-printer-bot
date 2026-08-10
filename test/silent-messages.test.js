import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageFlags } from 'discord.js';
import { ERROR_NOTIFY_USER_ID, withErrorMention, withSilentFlags } from '../src/discordMessageOptions.js';

test('bot message payloads suppress notifications while preserving flags', () => {
  const payload = withSilentFlags({ content: '通知なし', flags: MessageFlags.Ephemeral });

  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.SuppressNotifications);
});

test('error payloads mention the configured operator and preserve existing mentions', () => {
  const payload = withErrorMention({
    content: '印刷に失敗しました',
    allowedMentions: { users: ['123'], repliedUser: false }
  }, ['456']);

  assert.equal(payload.content, `<@${ERROR_NOTIFY_USER_ID}> 印刷に失敗しました`);
  assert.deepEqual(payload.allowedMentions, {
    users: ['123', ERROR_NOTIFY_USER_ID, '456'],
    repliedUser: false
  });
});
