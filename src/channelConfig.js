export function resolveDiscordChannelIds(channelIdsValue, channelIdValue) {
  const values = [
    ...String(channelIdsValue ?? '').split(','),
    String(channelIdValue ?? '')
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(values)];
}
