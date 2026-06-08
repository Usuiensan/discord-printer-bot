import emojiRegex from 'emoji-regex';
import sharp from 'sharp';
import { EscPosBuilder, normalizePrinterTextDetailed } from './escpos.js';

const CUSTOM_EMOJI_RE = /<a?:([a-zA-Z0-9_]+):(\d+)>/g;
const IMAGE_EXT_RE = /\.(apng|avif|gif|jpe?g|png|webp)(\?.*)?$/i;
const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]{}"']+/gi;

export async function buildPrintJob(message, config, options = {}) {
  const printer = new EscPosBuilder({ widthDots: config.printWidthDots });
  const warnings = [];
  const printHeader = options.printHeader ?? config.printHeader;

  if (printHeader) {
    try {
      const headerImage = await buildAuthorHeaderImage(message, config, options.printNumber);
      await printer.image(headerImage, {
        maxWidth: config.printWidthDots,
        dither: config.imageDitherMode
      });
    } catch (error) {
      console.error(`Failed to print author header for ${message.author.id}:`, error);
      warnings.push(`ヘッダー画像の印刷に失敗: ${error.message}`);
      printTextHeader(printer, message, warnings, options.printNumber);
    }
  } else if (config.printAuthorAvatar) {
    try {
      await printAuthorAvatar(printer, message, config);
    } catch (error) {
      console.error(`Failed to print author avatar for ${message.author.id}:`, error);
      warnings.push(`アイコン画像の印刷に失敗: ${error.message}`);
    }
  }

  const { text, imageItems, urls } = extractMessageContent(message);

  printTextBlock(printer, text, warnings);

  if (config.printUrlQr && urls.length > 0) {
    for (const url of urls) {
      printTextLine(printer, '[URL QR]', warnings);
      printer.qrCode(url, {
        moduleSize: config.qrModuleSize,
        errorCorrection: config.qrErrorCorrection
      });
    }
  }

  await printImageItems(printer, imageItems, config, warnings);
  await printStickers(printer, message, config, warnings);
  await printForwardedSnapshots(printer, message, config, warnings);

  if (!hasPrintableMessageContent(message)) {
    printTextLine(printer, '[印刷できる本文がありません]', warnings);
  }

  printer.cut(config.cutMode);

  return {
    bytes: printer.build(),
    warnings
  };
}

function printTextBlock(printer, text, warnings) {
  const printableText = formatDiscordMarkdownForPrint(text);
  if (!printableText.trim()) return;

  const rawLines = printableText.trim().split(/\r?\n/);
  for (const rawLine of rawLines) {
    const controlResult = applyEscPosTextCommand(printer, rawLine);
    if (controlResult.applied) continue;
    if (controlResult.error) {
      printTextLine(printer, `[ESC/POSコマンドエラー: ${controlResult.error}]`, warnings);
      warnings.push(`ESC/POSコマンドエラー: ${controlResult.error}`);
      continue;
    }

    let size = 1;
    let isSmall = false;
    let textToPrint = rawLine;

    const matchHeading = rawLine.match(/^\u0000HEADING(\d+)\u0000(.*)$/);
    const matchSmall = rawLine.match(/^\u0000SMALL\u0000(.*)$/);

    if (matchHeading) {
      const level = parseInt(matchHeading[1], 10);
      size = level === 1 ? 4 : 2;
      textToPrint = matchHeading[2];
    } else if (matchSmall) {
      isSmall = true;
      textToPrint = matchSmall[1];
    }

    const maxCols = isSmall ? 42 : Math.floor(32 / size);

    if (size > 1) {
      printer.size(size, size);
    }
    if (isSmall) {
      printer.smallText(true);
    }
    for (const line of wrapText(textToPrint, maxCols)) {
      printStyledTextLine(printer, line, warnings);
    }
    if (size > 1) {
      printer.size(1, 1);
    }
    if (isSmall) {
      printer.smallText(false);
    }
  }
  printer.feed(1);
}

function applyEscPosTextCommand(printer, line) {
  const trimmed = line.trim();
  const match = trimmed.match(/^!(?:escpos\s+)?([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/);
  if (!match) return { applied: false };

  const command = normalizeCommandName(match[1]);
  const args = splitCommandArgs(match[2] ?? '');

  try {
    switch (command) {
      case 'left':
        printer.align('left');
        return { applied: true };
      case 'center':
      case 'centre':
        printer.align('center');
        return { applied: true };
      case 'right':
        printer.align('right');
        return { applied: true };
      case 'align':
        requireArgs(command, args, 1);
        printer.align(normalizeAlignValue(args[0]));
        return { applied: true };
      case 'bold':
        printer.bold(parseOnOff(args[0], true));
        return { applied: true };
      case 'doublestrike':
      case 'double_strike':
        printer.doubleStrike(parseOnOff(args[0], true));
        return { applied: true };
      case 'underline':
        printer.underline(args[0] === '2' || normalizeCommandName(args[0]) === 'thick' ? 2 : parseOnOff(args[0], true));
        return { applied: true };
      case 'invert':
      case 'reverse':
        printer.invert(parseOnOff(args[0], true));
        return { applied: true };
      case 'upsidedown':
      case 'upside_down':
        printer.upsideDown(parseOnOff(args[0], true));
        return { applied: true };
      case 'rotate':
      case 'rotate90':
        printer.rotate90(parseOnOff(args[0], true));
        return { applied: true };
      case 'font':
        requireArgs(command, args, 1);
        printer.font(args[0]);
        return { applied: true };
      case 'smoothing':
      case 'smooth':
        printer.smoothing(parseOnOff(args[0], true));
        return { applied: true };
      case 'printmode':
      case 'print_mode':
        printer.printMode(parsePrintModeArgs(args));
        return { applied: true };
      case 'small':
        printer.smallText(parseOnOff(args[0], true));
        return { applied: true };
      case 'size':
        requireArgs(command, args, 2);
        printer.size(clampMultiplier(args[0]), clampMultiplier(args[1]));
        return { applied: true };
      case 'normal':
        printer.bold(false).underline(false).invert(false).rotate90(false).upsideDown(false).smallText(false).size(1, 1).align('left');
        return { applied: true };
      case 'reset':
        printer.initialize();
        return { applied: true };
      case 'linespacing':
      case 'line_spacing':
        requireArgs(command, args, 1);
        printer.lineSpacing(normalizeCommandName(args[0]) === 'default' ? 'default' : args[0]);
        return { applied: true };
      case 'charspacing':
      case 'char_spacing':
        requireArgs(command, args, 1);
        printer.charSpacing(args[0]);
        return { applied: true };
      case 'feed':
        printer.feed(args[0] ? nonNegativeInt(args[0], 'feed') : 1);
        return { applied: true };
      case 'cr':
        printer.carriageReturn();
        return { applied: true };
      case 'tab':
      case 'ht':
        printer.tab();
        return { applied: true };
      case 'tabs':
      case 'tabstops':
      case 'tab_stops':
        requireArgs(command, args, 1);
        printer.tabStops(args);
        return { applied: true };
      case 'feeddots':
      case 'feed_dots':
        requireArgs(command, args, 1);
        printer.feedDots(args[0]);
        return { applied: true };
      case 'position':
      case 'pos':
        requireArgs(command, args, 1);
        printer.absolutePosition(args[0]);
        return { applied: true };
      case 'relative':
      case 'rel':
        requireArgs(command, args, 1);
        printer.relativePosition(args[0]);
        return { applied: true };
      case 'margin':
      case 'leftmargin':
      case 'left_margin':
        requireArgs(command, args, 1);
        printer.leftMargin(args[0]);
        return { applied: true };
      case 'width':
      case 'areawidth':
      case 'area_width':
        requireArgs(command, args, 1);
        printer.printAreaWidth(args[0]);
        return { applied: true };
      case 'motion':
      case 'motionunits':
      case 'motion_units':
        requireArgs(command, args, 2);
        printer.motionUnits(args[0], args[1]);
        return { applied: true };
      case 'cut':
        printer.cut(normalizeCommandName(args[0] ?? 'partial'));
        return { applied: true };
      case 'drawer':
      case 'pulse':
        printer.drawerPulse(args[0] ?? 0, args[1] ?? 80, args[2] ?? 240);
        return { applied: true };
      case 'buzzer':
      case 'beep':
        printer.buzzer(args[0] ?? 1, args[1] ?? 1, args[2] ?? 3);
        return { applied: true };
      case 'page':
      case 'pagemode':
      case 'page_mode':
        applyPageCommand(printer, command, args);
        return { applied: true };
      default:
        return { applied: false };
    }
  } catch (error) {
    return { applied: false, error: error.message };
  }
}

function applyPageCommand(printer, command, args) {
  requireArgs(command, args, 1);
  const subCommand = normalizeCommandName(args[0]);
  if (subCommand === 'begin' || subCommand === 'on') {
    printer.pageMode(true);
    return;
  }
  if (subCommand === 'end' || subCommand === 'off' || subCommand === 'standard') {
    printer.pageMode(false);
    return;
  }
  if (subCommand === 'print') {
    printer.pagePrint();
    return;
  }
  if (subCommand === 'cancel') {
    printer.pageCancel();
    return;
  }
  if (subCommand === 'direction' || subCommand === 'dir') {
    requireArgs('page direction', args, 2);
    printer.pageDirection(args[1]);
    return;
  }
  if (subCommand === 'area') {
    requireArgs('page area', args, 5);
    printer.pageArea(args[1], args[2], args[3], args[4]);
    return;
  }
  if (subCommand === 'position' || subCommand === 'pos') {
    requireArgs('page position', args, 3);
    printer.pagePosition(args[1], args[2]);
    return;
  }
  if (subCommand === 'relative' || subCommand === 'rel') {
    requireArgs('page relative', args, 2);
    printer.pageRelativeVertical(args[1]);
    return;
  }

  throw new Error(`unknown page subcommand: ${args[0]}`);
}

function splitCommandArgs(value) {
  return value.trim() ? value.trim().split(/\s+/) : [];
}

function parseOnOff(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = normalizeCommandName(value);
  if (['on', 'true', 'yes', '1'].includes(normalized)) return true;
  if (['off', 'false', 'no', '0'].includes(normalized)) return false;
  throw new Error(`expected on/off, got: ${value}`);
}

function parsePrintModeArgs(args) {
  const mode = {};
  for (const arg of args) {
    const [key, rawValue = 'on'] = arg.split('=');
    const name = normalizeCommandName(key);
    if (name === 'font') mode.font = rawValue;
    if (name === 'bold') mode.bold = parseOnOff(rawValue, true);
    if (name === 'doubleheight' || name === 'double_height') mode.doubleHeight = parseOnOff(rawValue, true);
    if (name === 'doublewidth' || name === 'double_width') mode.doubleWidth = parseOnOff(rawValue, true);
    if (name === 'underline') mode.underline = parseOnOff(rawValue, true);
  }
  return mode;
}

function requireArgs(command, args, count) {
  if (args.length < count) {
    throw new Error(`${command} needs ${count} argument(s)`);
  }
}

function clampMultiplier(value) {
  const number = positiveInt(value, 'size');
  return Math.min(Math.max(number, 1), 8);
}

function positiveInt(value, label) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function nonNegativeInt(value, label) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function normalizeAlignValue(value) {
  const normalized = normalizeCommandName(value);
  return normalized === 'centre' ? 'center' : normalized;
}

function normalizeCommandName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function printTextLine(printer, line, warnings) {
  recordUnsupportedChars(line, warnings);
  printer.line(line);
}

function printStyledTextLine(printer, line, warnings) {
  const tokens = parseDiscordStyleTokens(line);
  for (const token of tokens) {
    if (token.bold) printer.bold(true);
    if (token.underline) printer.underline(true);
    printTextInline(printer, token.text, warnings);
    if (token.underline) printer.underline(false);
    if (token.bold) printer.bold(false);
  }
  printer.feed(1);
}

function printTextInline(printer, text, warnings) {
  recordUnsupportedChars(text, warnings);
  printer.text(text);
}

function parseDiscordStyleTokens(line) {
  const tokens = [];
  let index = 0;
  let plain = '';
  const state = { bold: false, underline: false };

  const flush = () => {
    if (!plain) return;
    tokens.push({ text: plain, ...state });
    plain = '';
  };

  while (index < line.length) {
    if (line.startsWith('**', index)) {
      flush();
      state.bold = !state.bold;
      index += 2;
      continue;
    }
    if (line.startsWith('__', index)) {
      flush();
      state.underline = !state.underline;
      index += 2;
      continue;
    }
    plain += line[index];
    index += 1;
  }

  flush();
  return tokens.length > 0 ? tokens : [{ text: line, bold: false, underline: false }];
}

async function printImageItems(printer, imageItems, config, warnings) {
  for (const item of imageItems) {
    try {
      if (item.label) printTextLine(printer, item.label, warnings);
      const bytes = await fetchFirstImage(item.urls ?? [item.url], config);
      await printer.image(bytes, {
        maxWidth: config.printWidthDots,
        dither: config.imageDitherMode
      });
    } catch (error) {
      printTextLine(printer, `[画像取得失敗: ${item.label || item.url}]`, warnings);
      warnings.push(`${item.label || '画像'} を印刷できませんでした: ${error.message}`);
      console.error(`Failed to print image ${item.url || item.urls?.[0]}:`, error);
    }
  }
}

async function printStickers(printer, message, config, warnings) {
  const stickers = valuesOf(message.stickers);
  if (stickers.length === 0) return;

  for (const sticker of stickers) {
    const url = sticker.url;
    if (!url) continue;
    try {
      printTextLine(printer, `[スタンプ: ${sticker.name}]`, warnings);
      const bytes = await fetchImage(url, config);
      await printer.image(bytes, {
        maxWidth: Math.min(config.printWidthDots, 256),
        dither: config.imageDitherMode
      });
    } catch (error) {
      printTextLine(printer, `[スタンプ取得失敗: ${sticker.name}]`, warnings);
      warnings.push(`スタンプ ${sticker.name} を印刷できませんでした: ${error.message}`);
      console.error(`Failed to print sticker ${sticker.id}:`, error);
    }
  }
}

async function printForwardedSnapshots(printer, message, config, warnings) {
  const snapshots = valuesOf(message.messageSnapshots);
  if (snapshots.length === 0) return;

  for (const snapshot of snapshots) {
    const { text, imageItems, urls } = extractMessageContent(snapshot);

    printTextLine(printer, '[転送メッセージ]', warnings);
    printTextBlock(printer, text, warnings);

    if (config.printUrlQr && urls.length > 0) {
      for (const url of urls) {
        printTextLine(printer, '[URL QR]', warnings);
        printer.qrCode(url, {
          moduleSize: config.qrModuleSize,
          errorCorrection: config.qrErrorCorrection
        });
      }
    }

    await printImageItems(printer, imageItems, config, warnings);
    await printStickers(printer, snapshot, config, warnings);
    printer.feed(1);
  }
}

function hasPrintableMessageContent(message) {
  const own = extractMessageContent(message);
  if (own.text.trim() || own.imageItems.length > 0 || valuesOf(message.stickers).length > 0) {
    return true;
  }

  for (const snapshot of valuesOf(message.messageSnapshots)) {
    const forwarded = extractMessageContent(snapshot);
    if (forwarded.text.trim() || forwarded.imageItems.length > 0 || valuesOf(snapshot.stickers).length > 0) {
      return true;
    }
  }

  return false;
}

function recordUnsupportedChars(text, warnings) {
  const { replacements } = normalizePrinterTextDetailed(text);
  for (const item of replacements) {
    const message = formatReplacementWarning(item.from, item.to);
    if (!warnings.includes(message)) {
      warnings.push(message);
      console.warn(`${message} count=${item.count}`);
    }
  }
}

function formatReplacementWarning(from, to) {
  return `「${from}」(${formatCodePoint(from)})を「${to}」(${formatCodePoint(to)})に置換しました`;
}

function formatCodePoint(char) {
  const codePoint = char.codePointAt(0);
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

async function printAuthorAvatar(printer, message, config) {
  const avatarUrl = message.author.displayAvatarURL({
    extension: 'png',
    size: 128
  });
  const avatarBytes = await fetchImage(avatarUrl, config);
  await printer.image(avatarBytes, {
    maxWidth: Math.min(config.authorAvatarWidthDots, config.printWidthDots),
    dither: config.imageDitherMode
  });
}

function printTextHeader(printer, message, warnings, printNumber) {
  const time = formatMessageTimeParts(message.createdAt);
  printer.bold(true);
  printTextLine(printer, displayName(message), warnings);
  printer.bold(false);
  printTextLine(printer, time.date, warnings);
  printTextLine(printer, time.time, warnings);
  const numberText = formatPrintNumber(printNumber);
  if (numberText) printTextLine(printer, numberText, warnings);
  printTextLine(printer, '-'.repeat(32), warnings);
}

async function buildAuthorHeaderImage(message, config, printNumber) {
  const avatarSize = Math.min(config.authorAvatarWidthDots, 128);
  const padding = 8;
  const gap = 10;
  const width = config.printWidthDots;
  const height = Math.max(avatarSize + padding * 2, 124);
  const textX = padding + avatarSize + gap;
  const textWidth = width - textX - padding;
  const name = escapeXml(truncateText(displayName(message), 24));
  const numberText = escapeXml(formatPrintNumber(printNumber));
  const time = formatMessageTimeParts(message.createdAt);
  const dateText = escapeXml(time.date);
  const timeText = escapeXml(time.time);
  const fontFace = systemFontFaceCss();

  let avatar = null;
  if (config.printAuthorAvatar) {
    const avatarUrl = message.author.displayAvatarURL({
      extension: 'png',
      size: 128
    });
    const avatarBytes = await fetchImage(avatarUrl, config);
    avatar = await sharp(avatarBytes)
      .rotate()
      .resize(avatarSize, avatarSize, { fit: 'cover' })
      .png()
      .toBuffer();
  }

  const svg = Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    ${fontFace}
    .name { font-family: HeaderFont, Arial, sans-serif; font-size: 32px; font-weight: 700; fill: #000; }
    .meta { font-family: HeaderFont, Arial, sans-serif; font-size: 24px; fill: #000; }
    .number { font-family: HeaderFont, Arial, sans-serif; font-size: 24px; font-weight: 700; fill: #000; }
  </style>
  <rect width="100%" height="100%" fill="white"/>
  <text class="name" x="${textX}" y="${padding + 30}">${name}</text>
  <text class="meta" x="${textX}" y="${padding + 56}">${dateText}</text>
  <text class="meta" x="${textX}" y="${padding + 80}">${timeText}</text>
  <text class="number" x="${textX}" y="${padding + 104}">${numberText}</text>
  <line x1="${textX}" y1="${height - 8}" x2="${textX + textWidth}" y2="${height - 8}" stroke="black" stroke-width="2"/>
</svg>`);

  const composites = [{ input: svg, left: 0, top: 0 }];
  if (avatar) {
    composites.push({ input: avatar, left: padding, top: padding });
  }

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: '#ffffff'
    }
  })
    .composite(composites)
    .png()
    .toBuffer();
}

function systemFontFaceCss() {
  const fontPath = 'C:/Windows/Fonts/msgothic.ttc';
  return `@font-face { font-family: HeaderFont; src: url("file:///${fontPath}"); }`;
}

function displayName(message) {
  return message.member?.displayName ?? message.author.globalName ?? message.author.username;
}

function formatPrintNumber(printNumber) {
  const value = Number.parseInt(printNumber, 10);
  return Number.isFinite(value) && value > 0 ? `No.${value}` : '';
}

function formatMessageTime(date) {
  const time = formatMessageTimeParts(date);
  return `${time.date}${time.time}`;
}

function formatMessageTimeParts(date) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Tokyo'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}年${value.month}月${value.day}日（${value.weekday}）`,
    time: `${value.hour}:${value.minute}:${value.second}`
  };
}

function truncateText(value, maxLength) {
  const chars = Array.from(value);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}...` : value;
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractMessageContent(message) {
  const imageItems = [];
  let text = message.content ?? '';
  const urls = extractUrls(text);

  text = text.replace(CUSTOM_EMOJI_RE, (_match, name, id) => {
    imageItems.push({
      label: `[絵文字: ${name}]`,
      url: `https://cdn.discordapp.com/emojis/${id}.png?size=128&quality=lossless`
    });
    return '';
  });

  const unicodeEmoji = emojiRegex();
  text = text.replace(unicodeEmoji, (emoji) => {
    imageItems.push({
      label: `[絵文字: ${emoji}]`,
      urls: twemojiUrls(emoji)
    });
    return '';
  });

  for (const attachment of valuesOf(message.attachments)) {
    if (isImageAttachment(attachment)) {
      imageItems.push({
        label: `[画像: ${attachment.name || attachment.id}]`,
        url: attachment.url
      });
    }
  }

  for (const embed of valuesOf(message.embeds)) {
    const imageUrl = embed.image?.url ?? embed.thumbnail?.url;
    if (imageUrl) {
      imageItems.push({
        label: '[埋め込み画像]',
        url: imageUrl
      });
    }
  }

  return { text: text.replace(/[ \t]+\n/g, '\n'), imageItems, urls };
}

function formatDiscordMarkdownForPrint(text) {
  const codeBlocks = [];
  let formatted = text.replace(/```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_match, language, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(formatCodeBlockLiteral(code, language));
    return `\u0000CODEBLOCK${index}\u0000`;
  });

  const inlineCodes = [];
  formatted = formatted.replace(/`([^`\n]+)`/g, (_match, code) => {
    const index = inlineCodes.length;
    inlineCodes.push(`\`${code}\``);
    return `\u0000INLINECODE${index}\u0000`;
  });

  formatted = formatted
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/\u0000INLINECODE(\d+)\u0000/g, (_match, index) => inlineCodes[Number(index)] ?? '');

  const lines = formatted.split(/\r?\n/);
  const result = [];
  let multiQuote = false;

  for (const rawLine of lines) {
    let line = rawLine;

    if (line.startsWith('>>> ')) {
      multiQuote = true;
      result.push(`> ${line.slice(4)}`);
      continue;
    }

    if (multiQuote) {
      result.push(`> ${line}`);
      continue;
    }

    const heading = line.match(/^(#{1,2})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      result.push(`\u0000HEADING${level}\u0000${title}`);
      continue;
    }

    const heading3 = line.match(/^###\s+(.+)$/);
    if (heading3) {
      const title = heading3[1].trim();
      result.push(`### ${title}`);
      result.push('-'.repeat(Math.min(displayColumns(title), 32)));
      continue;
    }

    const subtext = line.match(/^-#\s+(.+)$/);
    if (subtext) {
      result.push(`\u0000SMALL\u0000${subtext[1]}`);
      continue;
    }

    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      result.push(`> ${quote[1]}`);
      continue;
    }

    const bullet = line.match(/^(\s*)([-*])\s+(.+)$/);
    if (bullet) {
      const indent = ' '.repeat(Math.floor(bullet[1].length / 2) * 2);
      result.push(`${indent}- ${bullet[3]}`);
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (numbered) {
      result.push(`${numbered[1]}${numbered[2]}. ${numbered[3]}`);
      continue;
    }

    result.push(line);
  }

  formatted = result.join('\n');
  formatted = formatted.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_match, index) => codeBlocks[Number(index)] ?? '');
  return formatted;
}

function formatCodeBlockLiteral(code, language) {
  const prefix = language ? `\`\`\`${language}\n` : '```\n';
  return `${prefix}${code.replace(/\s+$/g, '')}\n\`\`\``;
}

function valuesOf(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return Array.from(collection.values());
  if (Array.isArray(collection)) return collection;
  return Object.values(collection);
}

function extractUrls(text) {
  const seen = new Set();
  const urls = [];

  for (const match of text.matchAll(URL_RE)) {
    const url = trimUrl(match[0]);
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

function trimUrl(url) {
  return url.replace(/[.,!?;:、。！？；：]+$/u, '');
}

function isImageAttachment(attachment) {
  if (attachment.contentType?.startsWith('image/')) return true;
  return IMAGE_EXT_RE.test(attachment.name ?? attachment.url ?? '');
}

async function fetchImage(url, config) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'discord-printer-bot/0.1'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > config.imageMaxBytes) {
    throw new Error(`Image is too large: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > config.imageMaxBytes) {
    throw new Error(`Image is too large: ${arrayBuffer.byteLength} bytes`);
  }

  return Buffer.from(arrayBuffer);
}

async function fetchFirstImage(urls, config) {
  let lastError = null;

  for (const url of urls.filter(Boolean)) {
    try {
      return await fetchImage(url, config);
    } catch (error) {
      lastError = error;
      if (!String(error.message).includes('HTTP 404')) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error('No image URL candidates');
}

function twemojiUrls(emoji) {
  const candidates = [
    emojiCodepoints(emoji, { keepVariationSelector: true }),
    emojiCodepoints(emoji, { keepVariationSelector: false })
  ]
    .filter((codepoints) => codepoints.length > 0)
    .map((codepoints) => twemojiAssetUrl(codepoints));

  return Array.from(new Set(candidates));
}

function emojiCodepoints(emoji, { keepVariationSelector }) {
  const codepoints = [];
  for (const symbol of Array.from(emoji)) {
    const codepoint = symbol.codePointAt(0);
    if (!keepVariationSelector && codepoint === 0xfe0f) continue;
    codepoints.push(codepoint.toString(16));
  }
  return codepoints;
}

function twemojiAssetUrl(codepoints) {
  return `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${codepoints.join('-')}.png`;
}

function wrapText(text, maxColumns) {
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = '';
    let columns = 0;
    for (const char of Array.from(rawLine)) {
      const width = charWidth(char);
      if (columns + width > maxColumns && line) {
        lines.push(line);
        line = '';
        columns = 0;
      }
      line += char;
      columns += width;
    }
    lines.push(line);
  }
  return lines;
}

function displayColumns(text) {
  return Array.from(text).reduce((columns, char) => columns + charWidth(char), 0);
}

function charWidth(char) {
  return char.charCodeAt(0) <= 0x7f ? 1 : 2;
}
