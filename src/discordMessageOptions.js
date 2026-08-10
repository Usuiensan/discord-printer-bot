import { MessageFlags } from 'discord.js';

export const ERROR_NOTIFY_USER_ID = '363466015683903488';

export function withSilentFlags(payload) {
  return {
    ...payload,
    flags: (payload.flags ?? 0) | MessageFlags.SuppressNotifications
  };
}

export function withErrorMention(payload, additionalUserIds = []) {
  const allowedMentions = payload.allowedMentions ?? {};
  const users = new Set([
    ...(allowedMentions.users ?? []),
    ERROR_NOTIFY_USER_ID,
    ...additionalUserIds
  ]);

  return {
    ...payload,
    content: `<@${ERROR_NOTIFY_USER_ID}> ${payload.content}`,
    allowedMentions: {
      ...allowedMentions,
      users: [...users]
    }
  };
}
