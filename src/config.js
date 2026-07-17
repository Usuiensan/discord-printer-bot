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

function enumEnv(name, fallback, allowed) {
  const value = optionalEnv(name, fallback).toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function listEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const urlQrMode = process.env.URL_QR_MODE?.trim()
  ? enumEnv('URL_QR_MODE', 'manual', ['manual', 'auto'])
  : (boolEnv('PRINT_URL_QR', false) ? 'auto' : 'manual');

const printerBackend = process.env.PRINTER_BACKEND?.trim()
  ? enumEnv('PRINTER_BACKEND', 'windows', ['windows', 'bridge', 'linux-usb'])
  : (optionalEnv('PRINT_BRIDGE_URL', '') ? 'bridge' : 'windows');

export const config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  guildId: optionalEnv('DISCORD_GUILD_ID', ''),
  channelId: requireEnv('DISCORD_CHANNEL_ID'),
  printerName: printerBackend === 'linux-usb' ? optionalEnv('PRINTER_NAME', '') : requireEnv('PRINTER_NAME'),
  printerBackend,
  printBridgeUrl: optionalEnv('PRINT_BRIDGE_URL', ''),
  printBridgeToken: optionalEnv('PRINT_BRIDGE_TOKEN', ''),
  linuxPrinterDevice: optionalEnv('LINUX_PRINTER_DEVICE', '/dev/usb/lp0'),
  linuxStatusEnabled: boolEnv('LINUX_STATUS_ENABLED', true),
  linuxStatusTimeoutMs: intEnv('LINUX_STATUS_TIMEOUT_MS', 1000),
  printRetryAttempts: intEnv('PRINT_RETRY_ATTEMPTS', 8),
  printRetryDelayMs: intEnv('PRINT_RETRY_DELAY_MS', 1500),
  printerMonitorEnabled: boolEnv('PRINTER_MONITOR_ENABLED', true),
  printerMonitorIntervalMs: intEnv('PRINTER_MONITOR_INTERVAL_MS', 10000),
  memberJoinPrintEnabled: boolEnv('MEMBER_JOIN_PRINT_ENABLED', true),
  oposStatusEnabled: boolEnv('OPOS_STATUS_ENABLED', false),
  oposLogicalName: optionalEnv('OPOS_LOGICAL_NAME', ''),
  oposClaimTimeoutMs: intEnv('OPOS_CLAIM_TIMEOUT_MS', 1000),
  printWidthDots: intEnv('PRINT_WIDTH_DOTS', 384),
  cutAfterPrint: boolEnv('CUT_AFTER_PRINT', true),
  cutMode: optionalEnv('CUT_MODE', boolEnv('CUT_AFTER_PRINT', true) ? 'partial' : 'none'),
  printHeader: boolEnv('PRINT_HEADER', true),
  mergeSameUserWindowMs: intEnv('MERGE_SAME_USER_WINDOW_MS', 3000),
  printAuthorAvatar: boolEnv('PRINT_AUTHOR_AVATAR', true),
  authorAvatarWidthDots: intEnv('AUTHOR_AVATAR_WIDTH_DOTS', 96),
  printFontPath: optionalEnv('PRINT_FONT_PATH', ''),
  printFontFamily: optionalEnv('PRINT_FONT_FAMILY', 'HeaderFont'),
  textRenderMode: enumEnv('TEXT_RENDER_MODE', 'auto', ['auto', 'text', 'image']),
  textImageFontPath: optionalEnv('TEXT_IMAGE_FONT_PATH', ''),
  textImageFontFamily: optionalEnv('TEXT_IMAGE_FONT_FAMILY', 'Noto Sans Mono CJK JP'),
  textImageFontSizeDots: intEnv('TEXT_IMAGE_FONT_SIZE_DOTS', 28),
  textImageLineHeightDots: intEnv('TEXT_IMAGE_LINE_HEIGHT_DOTS', 30),
  textImageLineGapDots: intEnv('TEXT_IMAGE_LINE_GAP_DOTS', 6),
  textImageDitherMode: enumEnv('TEXT_IMAGE_DITHER_MODE', 'threshold', ['ordered', 'threshold']),
  textImageThreshold: intEnv('TEXT_IMAGE_THRESHOLD', 170),
  cutFeedLines: intEnv('CUT_FEED_LINES', 3),
  imageDitherMode: optionalEnv('IMAGE_DITHER_MODE', 'ordered'),
  imageMaxBytes: intEnv('IMAGE_MAX_BYTES', 32 * 1024 * 1024),
  textAttachmentMaxBytes: intEnv('TEXT_ATTACHMENT_MAX_BYTES', 256 * 1024),
  urlQrMode,
  printUrlQr: urlQrMode === 'auto',
  emojiRenderMode: enumEnv('EMOJI_RENDER_MODE', 'inline_image', ['inline_image', 'alias_append', 'text']),
  emojiImageWidthDots: intEnv('EMOJI_IMAGE_WIDTH_DOTS', 96),
  qrModuleSize: intEnv('QR_MODULE_SIZE', 6),
  qrErrorCorrection: optionalEnv('QR_ERROR_CORRECTION', 'M'),
  barcodeHri: optionalEnv('BARCODE_HRI', 'below'),
  messageCommandPrefix: optionalEnv('MESSAGE_COMMAND_PREFIX', '!'),
  rawEscposUserIds: listEnv('RAW_ESCPOS_USER_IDS'),
  rawEscposAdminUserIds: listEnv('RAW_ESCPOS_ADMIN_USER_IDS'),
  rawEscposMaxBytes: intEnv('RAW_ESCPOS_MAX_BYTES', 4096),
  printedReaction: optionalEnv('PRINTED_REACTION', '✅'),
  printNearEndReaction: optionalEnv('PRINT_NEAR_END_REACTION', '🧻'),
  printErrorReaction: optionalEnv('PRINT_ERROR_REACTION', '⚠️')
};
