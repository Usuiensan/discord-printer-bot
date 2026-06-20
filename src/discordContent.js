import emojiRegex from 'emoji-regex';
import sharp from 'sharp';
import { EscPosBuilder, normalizePrinterTextDetailed } from './escpos.js';
import { appendSymbolItems, extractSymbolMessageCommands, formatSymbolPreviewLines } from './symbolContent.js';

const CUSTOM_EMOJI_RE = /<a?:([a-zA-Z0-9_]+):(\d+)>/g;
const IMAGE_EXT_RE = /\.(apng|avif|gif|jpe?g|png|webp)(\?.*)?$/i;
const TEXT_EXT_RE = /\.(txt|text|md|markdown|csv|tsv|json|jsonl|log|ini|conf|cfg|yaml|yml|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|ps1|bat|cmd|sh|py|rb|php|java|c|h|cpp|hpp|cs|rs|go|sql)(\?.*)?$/i;
const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]{}"']+/gi;
const TEXT_FALLBACK_EMOJI = new Set([0x203c, 0x2049]);
const INLINE_IMAGE_MARKER_RE = /^\u0000INLINEIMAGE:([^:\u0000]+):([^\u0000]*)\u0000$/;

export async function buildPrintJob(message, config, options = {}) {
  const printer = new EscPosBuilder({ widthDots: config.printWidthDots });
  const warnings = [];

  await appendDiscordHeader(printer, message, config, {
    printHeader: options.printHeader,
    printNumber: options.printNumber,
    warnings
  });

  const symbolExtraction = extractSymbolMessageCommands(message.content ?? '', config.messageCommandPrefix);
  const contentMessage = symbolExtraction.commands.length > 0
    ? { ...message, content: symbolExtraction.text }
    : message;
  const { text, imageItems, urls } = await extractMessageContent(contentMessage, config);
  const imageState = createInlineImageState();

  await printTextBlock(printer, text, warnings, {
    config,
    prefix: config.messageCommandPrefix,
    imageItems,
    imageState
  });

  if (config.printUrlQr && urls.length > 0) {
    for (const url of urls) {
      printer.qrCode(url, {
        moduleSize: config.qrModuleSize,
        errorCorrection: config.qrErrorCorrection,
      });
    }
  }

  await printImageItems(printer, remainingImageItems(imageItems, imageState), config, warnings);
  await printStickers(printer, message, config, warnings);
  await printForwardedSnapshots(printer, message, config, warnings);

  if (symbolExtraction.commands.length > 0) {
    await appendSymbolItems(printer, symbolExtraction.commands, config);
  }

  if (!(await hasPrintableMessageContent(contentMessage, config)) && symbolExtraction.commands.length === 0) {
    printTextLine(printer, '[印刷できる本文がありません]', warnings);
  }

  printer.cut(config.cutMode);

  return {
    bytes: printer.build(),
    warnings,
  };
}

export async function buildMemberJoinPrintJob(member, config, options = {}) {
  const printer = new EscPosBuilder({ widthDots: config.printWidthDots });
  const warnings = [];
  const joinedAt = new Date();
  const headerMessage = {
    author: member.user,
    member,
    createdAt: joinedAt,
    createdTimestamp: joinedAt.getTime()
  };

  await appendDiscordHeader(printer, headerMessage, config, {
    printHeader: config.printHeader,
    printNumber: options.printNumber,
    warnings
  });

  printer.align('center');
  printer.bold(true);
  printer.size(2, 1);
  printTextLine(printer, 'WELCOME', warnings);
  printer.size(1, 1);
  printTextLine(printer, '新しいメンバーが参加しました', warnings);
  printer.bold(false);
  printer.align('left');
  printTextLine(printer, '-'.repeat(32), warnings);
  printTextLine(printer, `名前: ${member.displayName ?? member.user.globalName ?? member.user.username}`, warnings);
  printTextLine(printer, `ユーザーID: ${member.user.id}`, warnings);
  if (member.user.tag) printTextLine(printer, `タグ: ${member.user.tag}`, warnings);
  printTextLine(printer, '-'.repeat(32), warnings);
  printer.cut(config.cutMode);

  return {
    bytes: printer.build(),
    warnings
  };
}

export async function appendDiscordHeader(printer, message, config, options = {}) {
  const warnings = options.warnings ?? [];
  const printHeader = options.printHeader ?? config.printHeader;

  if (printHeader) {
    try {
      const headerImage = await buildAuthorHeaderImage(message, config, options.printNumber);
      await printer.image(headerImage, {
        maxWidth: config.printWidthDots,
        dither: config.imageDitherMode,
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

  return warnings;
}

export async function buildPreviewText(message, config) {
  const rows = await buildPreviewRows(message, config);
  return rows.map((line) => line.text).join('\n') || '[印刷できる本文がありません]';
}

async function buildPreviewRows(message, config) {
  const content = stripPreviewCommand(message.content ?? '', config.messageCommandPrefix);
  const symbolExtraction = extractSymbolMessageCommands(content, config.messageCommandPrefix);
  const contentMessage = symbolExtraction.commands.length > 0
    ? { ...message, content: symbolExtraction.text }
    : { ...message, content };
  const { text, imageItems, urls } = await extractMessageContent(contentMessage, config);
  const imageState = createInlineImageState();
  const lines = renderTextPreview(text, {
    prefix: config.messageCommandPrefix,
    imageItems,
    imageState
  });

  if (config.printUrlQr && urls.length > 0) {
    for (const url of urls) lines.push(previewLine(`[QR: ${url}]`));
  }

  for (const item of remainingImageItems(imageItems, imageState)) {
    if (item.label?.startsWith('[絵文字:')) {
      lines.push(previewLine(item.label));
    } else {
      lines.push(previewLine(item.label ?? '[画像]'));
    }
  }

  for (const sticker of valuesOf(message.stickers)) {
    lines.push(previewLine(`[スタンプ: ${sticker.name ?? sticker.id}]`));
  }

  lines.push(...formatSymbolPreviewLines(symbolExtraction.commands).map((line) => previewLine(line)));

  return lines.length > 0 ? lines : [previewLine('[印刷できる本文がありません]')];
}

export async function buildPreviewImage(message, config) {
  const lines = await buildPreviewRows(message, config);
  const padding = 16;
  const baseFontSize = 18;
  const baseLineHeight = 24;
  const width = config.printWidthDots ?? 384;
  const measuredLines = lines.map((line) => {
    const fontSize = previewFontSize(line, baseFontSize);
    return {
      ...line,
      fontSize,
      lineHeight: Math.ceil(baseLineHeight * Math.max(1, line.sizeY ?? 1) * (line.small ? 0.75 : 1))
    };
  });
  const height = Math.max(80, padding * 2 + measuredLines.reduce((sum, line) => sum + line.lineHeight, 0));
  const fontFace = systemFontFaceCss();
  let y = padding;
  const tspans = measuredLines.map((line) => {
    y += line.lineHeight;
    const anchor = line.align === 'center' ? 'middle' : line.align === 'right' ? 'end' : 'start';
    const x = line.align === 'center' ? Math.round(width / 2) : line.align === 'right' ? width - padding : padding;
    const weight = line.bold ? '700' : '400';
    const decoration = line.underline ? ' text-decoration=\"underline\"' : '';
    const baselineY = y - Math.max(4, Math.round(line.lineHeight * 0.25));
    const scaleX = Math.max(1, line.sizeX ?? 1);
    return `<text x="0" y="0" transform="translate(${x} ${baselineY}) scale(${scaleX} 1)" text-anchor="${anchor}" font-size="${line.fontSize}" font-weight="${weight}"${decoration} xml:space="preserve">${escapeXml(line.text)}</text>`;
  }).join('\n');

  const svg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    ${fontFace}
    text { font-family: HeaderFont, "MS Gothic", monospace; fill: #000; }
  </style>
  <rect width="100%" height="100%" fill="white"/>
  ${tspans}
</svg>`);

  return sharp(svg).png().toBuffer();
}

async function printTextBlock(printer, text, warnings, options = {}) {
  const printableText = formatDiscordMarkdownForPrint(text);
  if (!printableText.trim()) return;

  const layoutState = createLayoutState();
  const rawLines = printableText.trim().split(/\r?\n/);
  for (const rawLine of rawLines) {
    const inlineImageResult = await applyInlineImageMarker(printer, rawLine, warnings, {
      ...options,
      layoutState
    });
    if (inlineImageResult.applied) continue;

    const imageResult = await applyInlineImageCommand(printer, rawLine, warnings, options);
    if (imageResult.applied) continue;
    if (imageResult.error) {
      printTextLine(printer, `[画像コマンドエラー: ${imageResult.error}]`, warnings);
      warnings.push(`画像コマンドエラー: ${imageResult.error}`);
      continue;
    }

    const receiptResult = applyReceiptLayoutCommand(printer, rawLine, warnings, layoutState);
    if (receiptResult.applied) continue;
    if (receiptResult.error) {
      printTextLine(printer, `[レシートコマンドエラー: ${receiptResult.error}]`, warnings);
      warnings.push(`レシートコマンドエラー: ${receiptResult.error}`);
      continue;
    }

    const controlResult = applyEscPosTextCommand(printer, rawLine, layoutState);
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

function renderTextPreview(text, options = {}) {
  const printableText = formatDiscordMarkdownForPrint(text);
  if (!printableText.trim()) return [];

  const layoutState = createLayoutState();
  const lines = [];

  for (const rawLine of printableText.trim().split(/\r?\n/)) {
    const previewOptions = { ...options, layoutState };
    const inlineImageResult = applyPreviewInlineImageMarker(lines, rawLine, previewOptions);
    if (inlineImageResult.applied) continue;

    const imageResult = applyPreviewInlineImageCommand(lines, rawLine, previewOptions);
    if (imageResult.applied) continue;
    if (imageResult.error) {
      lines.push(previewLine(`[画像コマンドエラー: ${imageResult.error}]`, layoutState));
      continue;
    }

    const receiptResult = applyPreviewReceiptCommand(lines, rawLine, layoutState);
    if (receiptResult.applied) continue;
    if (receiptResult.error) {
      lines.push(previewLine(`[レシートコマンドエラー: ${receiptResult.error}]`, layoutState));
      continue;
    }

    const controlResult = applyPreviewControlCommand(rawLine, layoutState);
    if (controlResult.applied) continue;
    if (controlResult.error) {
      lines.push(previewLine(`[ESC/POSコマンドエラー: ${controlResult.error}]`, layoutState));
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
    for (const line of wrapText(previewPrintableText(textToPrint), maxCols)) {
      lines.push(previewLine(line, layoutState, {
        sizeX: Math.max(1, (layoutState.sizeX ?? 1) * size),
        sizeY: Math.max(1, (layoutState.sizeY ?? 1) * size),
        small: layoutState.small || isSmall
      }));
    }
  }

  return lines;
}

function applyEscPosTextCommand(printer, line, layoutState = createLayoutState()) {
  const trimmed = line.trim();
  const match = trimmed.match(/^!(?:escpos\s+)?([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/);
  if (!match) return { applied: false };

  const command = normalizeCommandName(match[1]);
  const args = splitCommandArgs(match[2] ?? '');

  try {
    switch (command) {
      case 'left':
        layoutState.align = 'left';
        printer.align('left');
        return { applied: true };
      case 'center':
      case 'centre':
        layoutState.align = 'center';
        printer.align('center');
        return { applied: true };
      case 'right':
        layoutState.align = 'right';
        printer.align('right');
        return { applied: true };
      case 'align':
        requireArgs(command, args, 1);
        layoutState.align = normalizeAlignValue(args[0]);
        printer.align(layoutState.align);
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
        {
          const mode = parsePrintModeArgs(args);
          if (Object.hasOwn(mode, 'doubleWidth')) layoutState.sizeX = mode.doubleWidth ? 2 : 1;
          printer.printMode(mode);
        }
        return { applied: true };
      case 'small':
        layoutState.small = parseOnOff(args[0], true);
        printer.smallText(layoutState.small);
        return { applied: true };
      case 'size':
        requireArgs(command, args, 2);
        layoutState.sizeX = clampMultiplier(args[0]);
        printer.size(layoutState.sizeX, clampMultiplier(args[1]));
        return { applied: true };
      case 'normal':
        layoutState.align = 'left';
        layoutState.small = false;
        layoutState.sizeX = 1;
        printer.bold(false).underline(false).invert(false).rotate90(false).upsideDown(false).smallText(false).size(1, 1).align('left');
        return { applied: true };
      case 'reset':
        layoutState.align = 'left';
        layoutState.small = false;
        layoutState.sizeX = 1;
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
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

function createLayoutState() {
  return {
    align: 'left',
    bold: false,
    underline: false,
    small: false,
    sizeX: 1,
    sizeY: 1,
  };
}

function previewLine(text, layoutState = createLayoutState(), overrides = {}) {
  return {
    text: String(text ?? ''),
    align: overrides.align ?? layoutState.align ?? 'left',
    bold: overrides.bold ?? layoutState.bold ?? false,
    underline: overrides.underline ?? layoutState.underline ?? false,
    small: overrides.small ?? layoutState.small ?? false,
    sizeX: overrides.sizeX ?? layoutState.sizeX ?? 1,
    sizeY: overrides.sizeY ?? layoutState.sizeY ?? 1,
  };
}

function previewFontSize(line, baseFontSize) {
  const smallScale = line.small ? 0.75 : 1;
  return Math.max(8, Math.round(baseFontSize * Math.max(1, line.sizeY ?? 1) * smallScale));
}

function applyReceiptLayoutCommand(printer, line, warnings, layoutState) {
  try {
    const command = parseReceiptLayoutCommand(line);
    if (!command) return { applied: false };

    if (command.name === 'row') {
      printReceiptRowCommand(printer, command.body, warnings, layoutState);
      return { applied: true };
    }

    for (const outputLine of renderReceiptLayoutCommand(command, layoutState)) {
      printStyledTextLine(printer, outputLine, warnings);
    }
    return { applied: true };
  } catch (error) {
    return { applied: false, error: error.message };
  }
}

function printReceiptRowCommand(printer, body, warnings, layoutState) {
  const separator = body.indexOf('|');
  if (separator < 0) throw new Error('row needs "|" separator');

  const left = body.slice(0, separator).trim();
  const right = body.slice(separator + 1).trim();
  const rightColumns = displayColumns(stripDiscordStyleMarkers(right));
  const columns = currentLayoutColumns(layoutState);

  if (!right || rightColumns >= columns - 1) {
    for (const outputLine of formatReceiptRow(left, right, columns)) {
      printStyledTextLine(printer, outputLine, warnings);
    }
    return;
  }

  const leftColumns = Math.max(1, columns - rightColumns - 1);
  const leftLines = wrapText(left, leftColumns);
  for (let index = 0; index < leftLines.length - 1; index += 1) {
    printStyledTextLine(printer, leftLines[index], warnings);
  }

  const lastLeft = leftLines.at(-1) ?? '';
  printStyledTextInline(printer, lastLeft, warnings);
  printer.absolutePosition(rowRightStartDots(right, layoutState, printer.widthDots));
  printStyledTextInline(printer, right, warnings);
  printer.feed(1);
}

function applyPreviewReceiptCommand(lines, line, layoutState) {
  try {
    const command = parseReceiptLayoutCommand(line);
    if (!command) return { applied: false };

    for (const outputLine of renderReceiptLayoutCommand(command, layoutState)) {
      lines.push(previewLine(previewPrintableText(outputLine), layoutState));
    }
    return { applied: true };
  } catch (error) {
    return { applied: false, error: error.message };
  }
}

function parseReceiptLayoutCommand(line) {
  const match = line.trim().match(/^!(row|rule|blank|box)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return {
    name: normalizeCommandName(match[1]),
    body: match[2] ?? '',
  };
}

function renderReceiptLayoutCommand(command, layoutState) {
  const columns = currentLayoutColumns(layoutState);

  if (command.name === 'row') {
    const separator = command.body.indexOf('|');
    if (separator < 0) throw new Error('row needs "|" separator');
    const left = command.body.slice(0, separator).trim();
    const right = command.body.slice(separator + 1).trim();
    return formatReceiptRow(left, right, columns);
  }

  if (command.name === 'rule') {
    const mark = Array.from(command.body.trim())[0] ?? '-';
    return [mark.repeat(columns)];
  }

  if (command.name === 'blank') {
    const count = command.body.trim() ? nonNegativeInt(command.body.trim(), 'blank') : 1;
    return Array.from({ length: count }, () => '');
  }

  if (command.name === 'box') {
    const text = command.body.trim();
    if (!text) return ['*'.repeat(columns)];
    const innerColumns = Math.max(1, columns - 4);
    return wrapText(text, innerColumns).map((line) => {
      const padding = Math.max(0, innerColumns - displayColumns(line));
      return `* ${line}${' '.repeat(padding)} *`;
    });
  }

  return [];
}

function formatReceiptRow(left, right, columns) {
  const rightWidth = displayColumns(stripDiscordStyleMarkers(right));
  if (!right) return wrapText(left, columns);
  if (rightWidth >= columns - 1) {
    return [...wrapText(left, columns), right];
  }

  const leftColumns = Math.max(1, columns - rightWidth - 1);
  const leftLines = wrapText(left, leftColumns);
  const lastLeft = leftLines.pop() ?? '';
  const spaces = Math.max(1, columns - displayColumns(lastLeft) - rightWidth);
  return [...leftLines, `${lastLeft}${' '.repeat(spaces)}${right}`];
}

function currentLayoutColumns(layoutState) {
  const baseColumns = layoutState.small ? 42 : 32;
  return Math.max(1, Math.floor(baseColumns / Math.max(1, layoutState.sizeX)));
}

function rowRightStartDots(right, layoutState, widthDots) {
  const columns = currentLayoutColumns(layoutState);
  const columnWidthDots = widthDots / columns;
  const printableRight = normalizePrinterTextDetailed(stripDiscordStyleMarkers(right)).text;
  const rightColumns = displayColumns(printableRight);
  return Math.max(0, Math.round((columns - rightColumns) * columnWidthDots));
}

function applyPreviewControlCommand(line, layoutState) {
  const trimmed = line.trim();
  const match = trimmed.match(/^!(?:escpos\s+)?([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/);
  if (!match) return { applied: false };

  const command = normalizeCommandName(match[1]);
  const args = splitCommandArgs(match[2] ?? '');

  try {
    switch (command) {
      case 'left':
        layoutState.align = 'left';
        return { applied: true };
      case 'center':
      case 'centre':
        layoutState.align = 'center';
        return { applied: true };
      case 'right':
        layoutState.align = 'right';
        return { applied: true };
      case 'align':
        requireArgs(command, args, 1);
        layoutState.align = normalizeAlignValue(args[0]);
        return { applied: true };
      case 'bold':
        layoutState.bold = parseOnOff(args[0], true);
        return { applied: true };
      case 'underline':
        layoutState.underline = args[0] === '2' || normalizeCommandName(args[0]) === 'thick' ? true : parseOnOff(args[0], true);
        return { applied: true };
      case 'small':
        layoutState.small = parseOnOff(args[0], true);
        return { applied: true };
      case 'size':
        requireArgs(command, args, 2);
        layoutState.sizeX = clampMultiplier(args[0]);
        layoutState.sizeY = clampMultiplier(args[1]);
        return { applied: true };
      case 'printmode':
      case 'print_mode':
        {
          const mode = parsePrintModeArgs(args);
          if (Object.hasOwn(mode, 'doubleWidth')) layoutState.sizeX = mode.doubleWidth ? 2 : 1;
          if (Object.hasOwn(mode, 'doubleHeight')) layoutState.sizeY = mode.doubleHeight ? 2 : 1;
          if (Object.hasOwn(mode, 'bold')) layoutState.bold = mode.bold;
          if (Object.hasOwn(mode, 'underline')) layoutState.underline = Boolean(mode.underline);
        }
        return { applied: true };
      case 'normal':
      case 'reset':
        layoutState.small = false;
        layoutState.sizeX = 1;
        layoutState.sizeY = 1;
        layoutState.bold = false;
        layoutState.underline = false;
        layoutState.align = 'left';
        return { applied: true };
      case 'doublestrike':
      case 'double_strike':
      case 'invert':
      case 'reverse':
      case 'upsidedown':
      case 'upside_down':
      case 'rotate':
      case 'rotate90':
      case 'font':
      case 'smoothing':
      case 'smooth':
      case 'linespacing':
      case 'line_spacing':
      case 'charspacing':
      case 'char_spacing':
      case 'position':
      case 'pos':
      case 'relative':
      case 'rel':
      case 'margin':
      case 'leftmargin':
      case 'left_margin':
      case 'width':
      case 'areawidth':
      case 'area_width':
      case 'motion':
      case 'motionunits':
      case 'motion_units':
      case 'page':
      case 'pagemode':
      case 'page_mode':
        return { applied: true };
      case 'feed':
        return { applied: true };
      case 'blank':
      case 'rule':
      case 'row':
      case 'box':
        return { applied: false };
      default:
        return { applied: false };
    }
  } catch (error) {
    return { applied: false, error: error.message };
  }
}

function stripDiscordStyleMarkers(text) {
  return String(text)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1');
}

function previewPrintableText(text) {
  return normalizePrinterTextDetailed(stripDiscordStyleMarkers(text)).text;
}

function stripPreviewCommand(content, prefix) {
  const trimmed = String(content ?? '').trimStart();
  const command = `${prefix}preview`;
  if (!trimmed.toLowerCase().startsWith(command.toLowerCase())) return content;
  return trimmed.slice(command.length).replace(/^\s*\r?\n?/, '');
}

function printTextLine(printer, line, warnings) {
  recordUnsupportedChars(line, warnings);
  printer.line(line);
}

function printStyledTextLine(printer, line, warnings) {
  printStyledTextInline(printer, line, warnings);
  printer.feed(1);
}

function printStyledTextInline(printer, line, warnings) {
  const tokens = parseDiscordStyleTokens(line);
  for (const token of tokens) {
    if (token.bold) printer.bold(true);
    if (token.underline) printer.underline(true);
    printTextInline(printer, token.text, warnings);
    if (token.underline) printer.underline(false);
    if (token.bold) printer.bold(false);
  }
}

function printTextInline(printer, text, warnings) {
  recordUnsupportedChars(text, warnings);
  printer.text(text);
}

function createInlineImageState() {
  return {
    printedAttachmentIndexes: new Set(),
    printedInlineImageKeys: new Set()
  };
}

async function applyInlineImageMarker(printer, line, warnings, options) {
  const match = String(line).match(INLINE_IMAGE_MARKER_RE);
  if (!match) return { applied: false };

  const [, key] = match;
  const item = findInlineImageItem(options.imageItems, key);
  if (!item) {
    printTextLine(printer, '[画像取得失敗: 絵文字画像]', warnings);
    warnings.push('絵文字画像マーカーに対応する画像がありません');
    return { applied: true };
  }

  await printImageItems(printer, [item], options.config, warnings, {
    maxWidthDots: options.config.emojiImageWidthDots,
    printLabel: false
  });
  // Raster image output centers the image and then returns the printer to left
  // alignment. Restore the active text alignment so !center/!right persists.
  printer.align(options.layoutState?.align ?? 'left');
  options.imageState?.printedInlineImageKeys.add(key);
  return { applied: true };
}

async function applyInlineImageCommand(printer, line, warnings, options) {
  const command = parseInlineImageCommandSafe(line, options.prefix);
  if (command?.error) return { applied: false, error: command.error };
  if (!command) return { applied: false };

  const item = findAttachmentImageItem(options.imageItems, command.index);
  if (!item) {
    return { applied: false, error: `添付画像${command.index}がありません` };
  }

  await printImageItems(printer, [item], options.config, warnings, {
    maxWidthDots: command.widthPercent
      ? Math.max(1, Math.round(options.config.printWidthDots * command.widthPercent / 100))
      : undefined,
    printLabel: !command.noText
  });
  options.imageState?.printedAttachmentIndexes.add(command.index);
  return { applied: true };
}

function applyPreviewInlineImageMarker(lines, line, options) {
  const match = String(line).match(INLINE_IMAGE_MARKER_RE);
  if (!match) return { applied: false };

  const [, key, label] = match;
  const item = findInlineImageItem(options.imageItems, key);
  lines.push(previewLine(item?.previewLabel ?? `[絵文字画像: ${label || 'emoji'}]`, options.layoutState));
  options.imageState?.printedInlineImageKeys.add(key);
  return { applied: true };
}

function applyPreviewInlineImageCommand(lines, line, options) {
  const command = parseInlineImageCommandSafe(line, options.prefix);
  if (command?.error) return { applied: false, error: command.error };
  if (!command) return { applied: false };

  const item = findAttachmentImageItem(options.imageItems, command.index);
  if (!item) {
    return { applied: false, error: `添付画像${command.index}がありません` };
  }

  const sizeText = command.widthPercent ? ` ${command.widthPercent}%` : '';
  const label = command.noText ? `[画像${command.index}: ラベルなし]` : (item.label ?? `[画像${command.index}]`);
  lines.push(previewLine(`${label}${sizeText}`, options.layoutState));
  options.imageState?.printedAttachmentIndexes.add(command.index);
  return { applied: true };
}

function parseInlineImageCommand(line, prefix = '!') {
  const escapedPrefix = escapeRegex(String(prefix || '!'));
  const match = String(line).trim().match(new RegExp(`^${escapedPrefix}(img-notext|image-notext|img|image)\\s+(\\d+)(?:\\s+(\\d{1,3})%?)?$`, 'i'));
  if (!match) return null;

  const commandName = match[1].toLowerCase();
  const index = Number.parseInt(match[2], 10);
  if (!Number.isFinite(index) || index < 1) return null;
  const widthPercent = match[3] === undefined ? null : Number.parseInt(match[3], 10);
  if (widthPercent !== null && (!Number.isFinite(widthPercent) || widthPercent < 1 || widthPercent > 100)) {
    throw new Error('画像サイズは1%から100%で指定してください');
  }
  return { index, widthPercent, noText: commandName.endsWith('-notext') };
}

function parseInlineImageCommandSafe(line, prefix = '!') {
  try {
    return parseInlineImageCommand(line, prefix);
  } catch (error) {
    return { error: error.message };
  }
}

function findAttachmentImageItem(imageItems = [], index) {
  return imageItems.find((item) => item.source === 'attachment' && item.attachmentIndex === index) ?? null;
}

function findInlineImageItem(imageItems = [], key) {
  return imageItems.find((item) => item.inlineKey === key) ?? null;
}

function remainingImageItems(imageItems = [], imageState = createInlineImageState()) {
  return imageItems.filter((item) => {
    if (item.source === 'emoji_inline') return !imageState.printedInlineImageKeys.has(item.inlineKey);
    if (item.source !== 'attachment') return true;
    return !imageState.printedAttachmentIndexes.has(item.attachmentIndex);
  });
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDiscordStyleTokens(line) {
  if (/^\*+$/.test(line)) {
    return [{ text: line, bold: false, underline: false }];
  }

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

async function printImageItems(printer, imageItems, config, warnings, options = {}) {
  const maxWidth = Math.min(config.printWidthDots, options.maxWidthDots ?? config.printWidthDots);
  const printLabel = options.printLabel ?? true;
  for (const item of imageItems) {
    try {
      if (printLabel && item.label) printTextLine(printer, item.label, warnings);
      const bytes = await fetchFirstImage(item.urls ?? [item.url], config);
      await printer.image(bytes, {
        maxWidth,
        dither: config.imageDitherMode,
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
        dither: config.imageDitherMode,
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
    const { text, imageItems, urls } = await extractMessageContent(snapshot, config);
    const imageState = createInlineImageState();

    printTextLine(printer, '[転送メッセージ]', warnings);
    await printTextBlock(printer, text, warnings, {
      config,
      prefix: config.messageCommandPrefix,
      imageItems,
      imageState
    });

    if (config.printUrlQr && urls.length > 0) {
      for (const url of urls) {
        printer.qrCode(url, {
          moduleSize: config.qrModuleSize,
          errorCorrection: config.qrErrorCorrection,
        });
      }
    }

    await printImageItems(printer, remainingImageItems(imageItems, imageState), config, warnings);
    await printStickers(printer, snapshot, config, warnings);
    printer.feed(1);
  }
}

async function hasPrintableMessageContent(message, config) {
  const own = await extractMessageContent(message, config);
  if (own.text.trim() || own.imageItems.length > 0 || valuesOf(message.stickers).length > 0) {
    return true;
  }

  for (const snapshot of valuesOf(message.messageSnapshots)) {
    const forwarded = await extractMessageContent(snapshot, config);
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
  if (to === '') {
    return `「${from}」(${formatCodePointDetails(from)})を削除しました`;
  }
  return `「${from}」(${formatCodePointDetails(from)})を「${to}」(${formatCodePointDetailsList(to)})に置換しました`;
}

function formatCodePoint(char) {
  const codePoint = char.codePointAt(0);
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function formatCodePointDetails(char) {
  const codePoint = formatCodePoint(char);
  const name = UNICODE_NAME_LABELS.get(codePoint) ?? algorithmicUnicodeNameLabel(char);
  if (!name) return `${codePoint} 名称未登録`;
  return `${codePoint} ${name.en} / ${name.ja}`;
}

function algorithmicUnicodeNameLabel(char) {
  const codePoint = char.codePointAt(0);
  if (isCjkUnifiedIdeograph(codePoint)) {
    return {
      en: `CJK UNIFIED IDEOGRAPH-${codePoint.toString(16).toUpperCase()}`,
      ja: `CJK統合漢字-${codePoint.toString(16).toUpperCase()}`
    };
  }
  return null;
}

function isCjkUnifiedIdeograph(codePoint) {
  return (
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0x2ceb0 && codePoint <= 0x2ebef) ||
    (codePoint >= 0x30000 && codePoint <= 0x3134f) ||
    (codePoint >= 0x31350 && codePoint <= 0x323af)
  );
}

function formatCodePointDetailsList(text) {
  return Array.from(text)
    .map((char) => formatCodePointDetails(char))
    .join(' ');
}

const UNICODE_NAME_LABELS = new Map([
  ['U+0021', { en: 'EXCLAMATION MARK', ja: '感嘆符' }],
  ['U+002B', { en: 'PLUS SIGN', ja: 'プラス記号' }],
  ['U+002D', { en: 'HYPHEN-MINUS', ja: 'ハイフンマイナス' }],
  ['U+003F', { en: 'QUESTION MARK', ja: '疑問符' }],
  ['U+005C', { en: 'REVERSE SOLIDUS', ja: '逆斜線 日本ロケールでは円記号' }],
  ['U+007C', { en: 'VERTICAL LINE', ja: '縦線' }],
  ['U+007E', { en: 'TILDE', ja: 'チルダ' }],
  ['U+00A5', { en: 'YEN SIGN', ja: '円記号' }],
  ['U+2010', { en: 'HYPHEN', ja: 'ハイフン' }],
  ['U+2011', { en: 'NON-BREAKING HYPHEN', ja: '改行禁止ハイフン' }],
  ['U+2012', { en: 'FIGURE DASH', ja: '数字幅ダッシュ' }],
  ['U+2013', { en: 'EN DASH', ja: 'エンダッシュ' }],
  ['U+2014', { en: 'EM DASH', ja: 'エムダッシュ' }],
  ['U+2015', { en: 'HORIZONTAL BAR', ja: 'ホリゾンタルバー' }],
  ['U+203C', { en: 'DOUBLE EXCLAMATION MARK', ja: '二重感嘆符' }],
  ['U+2049', { en: 'EXCLAMATION QUESTION MARK', ja: '感嘆疑問符' }],
  ['U+2212', { en: 'MINUS SIGN', ja: 'マイナス記号' }],
  ['U+2500', { en: 'BOX DRAWINGS LIGHT HORIZONTAL', ja: '罫線 細い横線' }],
  ['U+2501', { en: 'BOX DRAWINGS HEAVY HORIZONTAL', ja: '罫線 太い横線' }],
  ['U+2502', { en: 'BOX DRAWINGS LIGHT VERTICAL', ja: '罫線 細い縦線' }],
  ['U+2503', { en: 'BOX DRAWINGS HEAVY VERTICAL', ja: '罫線 太い縦線' }],
  ['U+2514', { en: 'BOX DRAWINGS LIGHT UP AND RIGHT', ja: '罫線 左下角' }],
  ['U+2518', { en: 'BOX DRAWINGS LIGHT UP AND LEFT', ja: '罫線 右下角' }],
  ['U+251C', { en: 'BOX DRAWINGS LIGHT VERTICAL AND RIGHT', ja: '罫線 縦線と右分岐' }],
  ['U+2524', { en: 'BOX DRAWINGS LIGHT VERTICAL AND LEFT', ja: '罫線 縦線と左分岐' }],
  ['U+252C', { en: 'BOX DRAWINGS LIGHT DOWN AND HORIZONTAL', ja: '罫線 上T字' }],
  ['U+2534', { en: 'BOX DRAWINGS LIGHT UP AND HORIZONTAL', ja: '罫線 下T字' }],
  ['U+253C', { en: 'BOX DRAWINGS LIGHT VERTICAL AND HORIZONTAL', ja: '罫線 交差' }],
  ['U+301C', { en: 'WAVE DASH', ja: '波ダッシュ' }],
  ['U+FE0E', { en: 'VARIATION SELECTOR-15', ja: '異体字セレクタ15 テキスト表示指定' }],
  ['U+FE0F', { en: 'VARIATION SELECTOR-16', ja: '異体字セレクタ16 絵文字表示指定' }],
  ['U+FE58', { en: 'SMALL EM DASH', ja: '小さいエムダッシュ' }],
  ['U+FE63', { en: 'SMALL HYPHEN-MINUS', ja: '小さいハイフンマイナス' }],
  ['U+FF0D', { en: 'FULLWIDTH HYPHEN-MINUS', ja: '全角ハイフンマイナス' }],
  ['U+FF5E', { en: 'FULLWIDTH TILDE', ja: '全角チルダ' }]
]);

async function printAuthorAvatar(printer, message, config) {
  const avatarUrl = message.author.displayAvatarURL({
    extension: 'png',
    size: 128,
  });
  const avatarBytes = await fetchImage(avatarUrl, config);
  await printer.image(avatarBytes, {
    maxWidth: Math.min(config.authorAvatarWidthDots, config.printWidthDots),
    dither: config.imageDitherMode,
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
  const avatarSize = Math.min(config.authorAvatarWidthDots ?? 96, 128);
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
      size: 128,
    });
    const avatarBytes = await fetchImage(avatarUrl, config);
    avatar = await sharp(avatarBytes).rotate().resize(avatarSize, avatarSize, { fit: 'cover' }).png().toBuffer();
  }

  const svg = Buffer.from(`
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    ${fontFace}
    .name { font-family: HeaderFont, Arial, sans-serif; font-size: 32px; font-weight: 700; fill: #000; }
    .meta { font-family: HeaderFont, Arial, sans-serif; font-size: 24px; fill: #000; }
    .number { font-family: HeaderFont, Arial, sans-serif; font-size: 36px; font-weight: 700; fill: #000; }
  </style>
  <rect width="100%" height="100%" fill="white"/>
  <text class="name" x="${textX}" y="${padding + 30}">${name}</text>
  <text class="meta" x="${textX}" y="${padding + 56}">${dateText}</text>
  <text class="meta" x="${textX}" y="${padding + 80}">${timeText}</text>
  <text class="number" x="${textX}" y="${padding + 110}">${numberText}</text>
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
      background: '#ffffff',
    },
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
    timeZone: 'Asia/Tokyo',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${value.year}年${value.month}月${value.day}日（${value.weekday}）`,
    time: `${value.hour}:${value.minute}:${value.second}`,
  };
}

function truncateText(value, maxLength) {
  const chars = Array.from(value);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}...` : value;
}

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function extractMessageContent(message, config = {}) {
  const imageItems = [];
  const seenEmojiImages = new Set();
  let inlineEmojiIndex = 0;
  let text = stripCodeMarkers(message.content ?? '');
  const emojiRenderMode = normalizeEmojiRenderMode(config.emojiRenderMode);
  const textAttachmentBlocks = [];

  for (const attachment of valuesOf(message.attachments)) {
    if (isTextAttachment(attachment) && !isImageAttachment(attachment)) {
      textAttachmentBlocks.push(await fetchTextAttachmentBlock(attachment, config));
    }
  }

  if (textAttachmentBlocks.length > 0) {
    text = [text, ...textAttachmentBlocks].filter((part) => part.trim()).join('\n');
  }

  const urls = extractUrls(text);

  text = text.replace(CUSTOM_EMOJI_RE, (_match, name, id) => {
    const item = {
      key: `custom:${id}`,
      label: `[絵文字: :${name}:]`,
      previewLabel: `[絵文字画像: :${name}:]`,
      url: `https://cdn.discordapp.com/emojis/${id}.png?size=128&quality=lossless`,
    };
    if (emojiRenderMode === 'inline_image') {
      inlineEmojiIndex += 1;
      return pushInlineEmojiImage(imageItems, item, inlineEmojiIndex, `:${name}:`);
    }
    if (emojiRenderMode === 'alias_append') {
      pushUniqueEmojiImage(imageItems, seenEmojiImages, item);
    }
    return `:${name}:`;
  });

  const unicodeEmoji = emojiRegex();
  text = text.replace(unicodeEmoji, (emoji) => {
    if (shouldKeepEmojiAsText(emoji)) {
      return emoji;
    }

    const codepointName = emojiCodepointName(emoji);
    const item = {
      key: `unicode:${codepointName}`,
      label: `[絵文字: :emoji_${codepointName}:]`,
      previewLabel: `[絵文字画像: :emoji_${codepointName}:]`,
      urls: twemojiUrls(emoji),
    };
    if (emojiRenderMode === 'inline_image') {
      inlineEmojiIndex += 1;
      return pushInlineEmojiImage(imageItems, item, inlineEmojiIndex, `:emoji_${codepointName}:`);
    }
    if (emojiRenderMode === 'alias_append') {
      pushUniqueEmojiImage(imageItems, seenEmojiImages, item);
    }
    return `:emoji_${codepointName}:`;
  });

  let attachmentImageIndex = 0;
  for (const attachment of valuesOf(message.attachments)) {
    if (isImageAttachment(attachment)) {
      attachmentImageIndex += 1;
      imageItems.push({
        source: 'attachment',
        attachmentIndex: attachmentImageIndex,
        label: `[画像${attachmentImageIndex}: ${attachment.name || attachment.id}]`,
        url: attachment.url,
      });
    }
  }

  for (const embed of valuesOf(message.embeds)) {
    const imageUrl = embed.image?.url ?? embed.thumbnail?.url;
    if (imageUrl) {
      imageItems.push({
        label: '[埋め込み画像]',
        url: imageUrl,
      });
    }
  }

  return { text: text.replace(/[ \t]+\n/g, '\n'), imageItems, urls };
}

function normalizeEmojiRenderMode(value) {
  return ['inline_image', 'alias_append', 'text'].includes(value) ? value : 'inline_image';
}

function shouldKeepEmojiAsText(emoji) {
  return Array.from(emoji).some((char) => TEXT_FALLBACK_EMOJI.has(char.codePointAt(0)));
}

function pushUniqueEmojiImage(imageItems, seenEmojiImages, item) {
  if (seenEmojiImages.has(item.key)) return;
  seenEmojiImages.add(item.key);
  imageItems.push(item);
}

function pushInlineEmojiImage(imageItems, item, index, label) {
  const inlineKey = `emoji${index}`;
  imageItems.push({
    ...item,
    source: 'emoji_inline',
    inlineKey,
  });
  return `\n${inlineImageMarker(inlineKey, label)}\n`;
}

function inlineImageMarker(key, label) {
  return `\u0000INLINEIMAGE:${key}:${label}\u0000`;
}

function formatDiscordMarkdownForPrint(text) {
  const codeBlocks = [];
  let formatted = text.replace(/```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g, (_match, language, code) => {
    const index = codeBlocks.length;
    codeBlocks.push(formatCodeBlockLiteral(code));
    return `\u0000CODEBLOCK${index}\u0000`;
  });

  const inlineCodes = [];
  formatted = formatted.replace(/`([^`\n]+)`/g, (_match, code) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
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

    if (line.trim().startsWith('```')) {
      continue;
    }

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

function formatCodeBlockLiteral(code) {
  return code.replace(/\s+$/g, '');
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

function stripCodeMarkers(text) {
  return String(text ?? '')
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_match, code) => code.replace(/\s+$/g, ''))
    .replace(/`([^`\n]+)`/g, '$1');
}

function trimUrl(url) {
  return url.replace(/[.,!?;:、。！？；：]+$/u, '');
}

function isImageAttachment(attachment) {
  if (attachment.contentType?.startsWith('image/')) return true;
  return IMAGE_EXT_RE.test(attachment.name ?? attachment.url ?? '');
}

function isTextAttachment(attachment) {
  if (attachment.contentType?.startsWith('text/')) return true;
  if (['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(attachment.contentType)) return true;
  return TEXT_EXT_RE.test(attachment.name ?? attachment.url ?? '');
}

async function fetchTextAttachmentBlock(attachment, config) {
  const label = attachment.name || attachment.id || 'text';
  try {
    const bytes = await fetchAttachmentBytes(attachment.url, config.textAttachmentMaxBytes, 'Text attachment');
    return decodeTextAttachment(bytes).replace(/\s+$/g, '');
  } catch (error) {
    console.error(`Failed to print text attachment ${attachment.url}:`, error);
    return `[テキスト取得失敗: ${label} ${error.message}]`;
  }
}

async function fetchImage(url, config) {
  return fetchAttachmentBytes(url, config.imageMaxBytes, 'Image');
}

async function fetchAttachmentBytes(url, maxBytes, label) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'discord-printer-bot/0.1',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`${label} is too large: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(`${label} is too large: ${arrayBuffer.byteLength} bytes`);
  }

  return Buffer.from(arrayBuffer);
}

function decodeTextAttachment(bytes) {
  const withoutBom = stripUtf8Bom(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(withoutBom);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

function stripUtf8Bom(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3);
  }
  return bytes;
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
  const candidates = [emojiCodepoints(emoji, { keepVariationSelector: true }), emojiCodepoints(emoji, { keepVariationSelector: false })]
    .filter((codepoints) => codepoints.length > 0)
    .map((codepoints) => twemojiAssetUrl(codepoints));

  return Array.from(new Set(candidates));
}

function emojiCodepointName(emoji) {
  return emojiCodepoints(emoji, { keepVariationSelector: false }).join('_');
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
    for (const unit of textWrapUnits(rawLine)) {
      const width = displayColumns(unit);
      if (columns + width > maxColumns && line) {
        lines.push(line);
        line = '';
        columns = 0;
      }
      if (width > maxColumns) {
        for (const char of Array.from(unit)) {
          const charColumns = charWidth(char);
          if (columns + charColumns > maxColumns && line) {
            lines.push(line);
            line = '';
            columns = 0;
          }
          line += char;
          columns += charColumns;
        }
      } else {
        line += unit;
        columns += width;
      }
    }
    lines.push(line);
  }
  return lines;
}

function textWrapUnits(line) {
  const units = [];
  const pattern = /:emoji_[0-9a-f_]+:|:[A-Za-z0-9_+-]+:/gi;
  let index = 0;

  for (const match of line.matchAll(pattern)) {
    if (match.index > index) {
      units.push(...Array.from(line.slice(index, match.index)));
    }
    units.push(match[0]);
    index = match.index + match[0].length;
  }

  if (index < line.length) {
    units.push(...Array.from(line.slice(index)));
  }

  return units;
}

function displayColumns(text) {
  return Array.from(text).reduce((columns, char) => columns + charWidth(char), 0);
}

function charWidth(char) {
  return char.charCodeAt(0) <= 0x7f ? 1 : 2;
}
