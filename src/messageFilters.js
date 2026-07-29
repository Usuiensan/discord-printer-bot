export function isOwnBotMessage(message, botUserId = message.client?.user?.id) {
  return Boolean(message.author?.bot && botUserId && message.author.id === botUserId);
}
