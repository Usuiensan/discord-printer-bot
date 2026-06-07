import 'dotenv/config';

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function intEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalEnv(name, fallback) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

export const config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  guildId: optionalEnv('DISCORD_GUILD_ID', ''),
  channelId: requireEnv('DISCORD_CHANNEL_ID'),
  printerName: requireEnv('PRINTER_NAME'),
  printWidthDots: intEnv('PRINT_WIDTH_DOTS', 384),
  cutAfterPrint: boolEnv('CUT_AFTER_PRINT', true),
  cutMode: optionalEnv('CUT_MODE', boolEnv('CUT_AFTER_PRINT', true) ? 'partial' : 'none'),
  printHeader: boolEnv('PRINT_HEADER', true),
  mergeSameUserWindowMs: intEnv('MERGE_SAME_USER_WINDOW_MS', 3000),
  printAuthorAvatar: boolEnv('PRINT_AUTHOR_AVATAR', true),
  authorAvatarWidthDots: intEnv('AUTHOR_AVATAR_WIDTH_DOTS', 96),
  imageDitherMode: optionalEnv('IMAGE_DITHER_MODE', 'ordered'),
  imageMaxBytes: intEnv('IMAGE_MAX_BYTES', 32 * 1024 * 1024),
  printUrlQr: boolEnv('PRINT_URL_QR', true),
  qrModuleSize: intEnv('QR_MODULE_SIZE', 6),
  qrErrorCorrection: optionalEnv('QR_ERROR_CORRECTION', 'M'),
  messageCommandPrefix: optionalEnv('MESSAGE_COMMAND_PREFIX', '!'),
  printedReaction: optionalEnv('PRINTED_REACTION', '✅'),
  printErrorReaction: optionalEnv('PRINT_ERROR_REACTION', '⚠️')
};
