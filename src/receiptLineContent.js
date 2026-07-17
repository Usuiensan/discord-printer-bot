import { normalizePrinterTextDetailed } from './escpos.js';
import sharp from 'sharp';
import { existsSync, readFileSync } from 'node:fs';
import { wrapUnicodeText } from './textLayout.js';

const DEFAULT_COLUMNS = 32;
const PROPERTY_LINE_RE = /^\s*\{([\s\S]*)\}\s*$/;
const HORIZONTAL_LINE_RE = /^\s*-+\s*$/;
const CUT_LINE_RE = /^\s*=+\s*$/;

export function extractReceiptLineMessage(content, prefix = '!') {
  const text = String(content ?? '').trimStart();
  const escapedPrefix = escapeRegExp(prefix);
  const match = text.match(new RegExp(`^${escapedPrefix}(?:receiptline|rl)\\b(?:[ \\t]*(.*))?$`, 'i'));
  if (!match) {
    const firstLine = text.match(new RegExp(`^${escapedPrefix}(?:receiptline|rl)\\b(?:[ \\t]*(.*))?\\r?\\n([\\s\\S]*)$`, 'i'));
    if (!firstLine) return null;
    return cleanReceiptLinePayload([firstLine[1], firstLine[2]].filter(Boolean).join('\n'));
  }
  return cleanReceiptLinePayload(match[1] ?? '');
}

export async function renderReceiptLinePreview(document, config = {}) {
  const state = createReceiptLineState(config);
  const rows = [];

  for (const rawLine of parseReceiptLinePhysicalLines(document)) {
    const result = await applyReceiptLineLine(rawLine, state, {
      text: (line) => rows.push(previewRow(line)),
      styledText: (line) => rows.push(previewRow(line.text)),
      image: () => rows.push(previewRow('[ReceiptLine画像]')),
      code: (value, type) => rows.push(previewRow(`[${type.toUpperCase()}: ${value}]`)),
      cut: () => rows.push(previewRow('[CUT]'))
    });
    if (result.error) rows.push(previewRow(`[ReceiptLineエラー: ${result.error}]`));
  }

  return rows.length > 0 ? rows : [previewRow('[ReceiptLine: 空の文書]')];
}

export async function appendReceiptLine(printer, document, config = {}, warnings = [], options = {}) {
  const state = createReceiptLineState(config);
  const rasterBatch = { images: [], artifacts: options.textPrintImages ?? [] };

  for (const rawLine of parseReceiptLinePhysicalLines(document)) {
    const result = await applyReceiptLineLine(rawLine, state, {
      text: (line) => printReceiptLineText(printer, line, config, warnings, rasterBatch),
      styledText: (line) => printReceiptLineStyledText(printer, line, config, warnings, rasterBatch),
      image: async (base64) => {
        await flushReceiptLineRasterBatch(printer, rasterBatch, config);
        await printer.image(Buffer.from(base64, 'base64'), {
          maxWidth: state.printWidthDots,
          dither: config.imageDitherMode
        });
      },
      code: async (value, type, codeOptions) => {
        await flushReceiptLineRasterBatch(printer, rasterBatch, config);
        printReceiptLineCode(printer, value, type, codeOptions, config);
      },
      cut: async () => {
        await flushReceiptLineRasterBatch(printer, rasterBatch, config);
        printer.cutWithFeed(config.cutMode ?? 'partial', config.cutFeedLines ?? 3);
      }
    });

    if (result.error) {
      warnings.push(`ReceiptLineエラー: ${result.error}`);
      printer.line(`[ReceiptLineエラー: ${result.error}]`);
    }
  }
  await flushReceiptLineRasterBatch(printer, rasterBatch, config);
}

function cleanReceiptLinePayload(value) {
  return String(value ?? '')
    .trim()
    .replace(/^```(?:receiptline|rl)?\s*\r?\n?/i, '')
    .replace(/\r?\n?```\s*$/i, '')
    .replace(/\s+$/g, '');
}

function createReceiptLineState(config) {
  return {
    columns: DEFAULT_COLUMNS,
    printWidthDots: config.printWidthDots ?? 384,
    widthSpec: ['*'],
    border: 'space',
    align: 'left',
    textWrap: 'wrap',
    codeOptions: {
      type: 'code128',
      width: 2,
      height: 72,
      hri: 'none',
      qrModuleSize: config.qrModuleSize ?? 6,
      qrErrorCorrection: config.qrErrorCorrection ?? 'M'
    }
  };
}

function parseReceiptLinePhysicalLines(document) {
  const lines = [];
  let propertyBuffer = '';

  for (const rawLine of String(document ?? '').replace(/\r/g, '').split('\n')) {
    if (propertyBuffer) {
      propertyBuffer += rawLine.trim();
      if (rawLine.includes('}')) {
        lines.push(propertyBuffer);
        propertyBuffer = '';
      }
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed.startsWith('{') && !trimmed.includes('}')) {
      propertyBuffer = trimmed;
      continue;
    }

    lines.push(rawLine);
  }

  if (propertyBuffer) lines.push(propertyBuffer);
  return lines;
}

async function applyReceiptLineLine(rawLine, state, output) {
  try {
    const property = parsePropertyOnlyLine(rawLine);
    if (property) {
      await applyReceiptLineProperties(property, state, output);
      return { applied: true };
    }

    if (HORIZONTAL_LINE_RE.test(rawLine)) {
      await output.text(renderHorizontalLine(state));
      return { applied: true };
    }

    if (CUT_LINE_RE.test(rawLine)) {
      await output.cut();
      return { applied: true };
    }

    if (!rawLine.trim()) {
      await output.text('');
      return { applied: true };
    }

    const columns = splitReceiptLineColumns(rawLine);
    for (const line of layoutReceiptLineColumns(columns, state)) {
      if (line.segments) {
        await output.styledText(line);
      } else {
        await output.text(line.text);
      }
    }
    return { applied: true };
  } catch (error) {
    return { applied: false, error: error.message };
  }
}

async function applyReceiptLineProperties(properties, state, output) {
  const normalized = normalizePropertyKeys(properties);
  if (normalized.option != null) state.codeOptions = parseCodeOptions(normalized.option, state.codeOptions);

  if (normalized.image) {
    await output.image(normalized.image.replace(/\s+/g, ''));
    return;
  }
  if (normalized.code) {
    await output.code(unescapeReceiptLineText(normalized.code), state.codeOptions.type, state.codeOptions);
    return;
  }
  if (normalized.command) return;
  if (normalized.comment != null) return;

  if (normalized.align != null) state.align = parseAlign(normalized.align, 'center');
  if (normalized.width != null) state.widthSpec = parseWidthSpec(normalized.width);
  if (normalized.border != null) state.border = parseBorder(normalized.border);
  if (normalized.text != null) state.textWrap = normalizeToken(normalized.text) === 'nowrap' ? 'nowrap' : 'wrap';
}

function parsePropertyOnlyLine(line) {
  const match = String(line).match(PROPERTY_LINE_RE);
  if (!match) return null;
  const properties = {};
  for (const part of splitUnescaped(match[1], ';')) {
    const index = findUnescaped(part, ':');
    if (index < 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (key) properties[key] = value;
  }
  return properties;
}

function normalizePropertyKeys(properties) {
  const aliases = {
    i: 'image',
    c: 'code',
    o: 'option',
    x: 'command',
    _: 'comment',
    a: 'align',
    w: 'width',
    b: 'border',
    t: 'text'
  };
  const normalized = {};
  for (const [key, value] of Object.entries(properties)) {
    normalized[aliases[key] ?? key] = value;
  }
  return normalized;
}

function splitReceiptLineColumns(line) {
  return splitUnescaped(line, '|').map((raw) => {
    const leading = /^[ \t]+/.test(raw);
    const trailing = /[ \t]+$/.test(raw);
    return {
      raw,
      text: unescapeReceiptLineText(raw.trim()),
      align: columnAlign(leading, trailing)
    };
  });
}

function layoutReceiptLineColumns(columns, state) {
  const widths = resolveColumnWidths(columns.length, state);
  const borderText = borderSeparator(state.border);
  const columnLines = columns.map((column, index) => {
    const width = widths[index] ?? 0;
    if (width <= 0) return [];
    return wrapReceiptText(column.text, width, state.textWrap).map((text) => ({
      text,
      align: column.align,
      width,
      segments: parseStyledReceiptLineText(text)
    }));
  });
  const maxRows = Math.max(1, ...columnLines.map((lines) => lines.length));
  const rows = [];

  for (let rowIndex = 0; rowIndex < maxRows; rowIndex += 1) {
    const parts = columnLines.map((lines, columnIndex) => {
      const line = lines[rowIndex] ?? { text: '', align: columns[columnIndex]?.align ?? 'left', width: widths[columnIndex] ?? 0, segments: [] };
      return padReceiptLine(line.text, line.width, line.align);
    });
    const text = alignLine(parts.join(borderText), state.columns, state.align);
    rows.push({ text });
  }

  return rows;
}

function resolveColumnWidths(count, state) {
  const borderColumns = Math.max(0, count - 1) * borderWidth(state.border);
  const available = Math.max(1, state.columns - borderColumns);
  let spec = state.widthSpec;
  if (spec.length === 1 && spec[0] === 'auto') spec = Array(count).fill('*');
  if (spec.length < count) spec = [...spec, ...Array(count - spec.length).fill('*')];

  const widths = spec.slice(0, count).map((value) => (value === '*' || value === 'auto' ? '*' : Math.max(0, Number.parseInt(value, 10) || 0)));
  const fixed = widths.reduce((sum, value) => sum + (value === '*' ? 0 : value), 0);
  const stars = widths.filter((value) => value === '*').length;
  const autoWidth = stars > 0 ? Math.max(1, Math.floor(Math.max(0, available - fixed) / stars)) : 0;
  let remainder = stars > 0 ? Math.max(0, available - fixed - autoWidth * stars) : 0;

  return widths.map((value) => {
    if (value !== '*') return value;
    const width = autoWidth + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return width;
  });
}

function wrapReceiptText(text, width, mode) {
  if (mode === 'nowrap') return [truncateColumns(text, width)];
  return wrapUnicodeText(text, width, displayColumns);
}

function truncateColumns(text, width) {
  let result = '';
  let columns = 0;
  for (const char of Array.from(text)) {
    const charColumns = charWidth(char);
    if (columns + charColumns > width) break;
    result += char;
    columns += charColumns;
  }
  return result;
}

function parseStyledReceiptLineText(text) {
  const segments = [];
  let current = '';
  const style = { underline: false, bold: false, invert: false, doubleWidth: false };

  for (const char of Array.from(text)) {
    const key = styleKey(char);
    if (!key) {
      current += char;
      continue;
    }
    if (current) {
      segments.push({ text: current, ...style });
      current = '';
    }
    style[key] = !style[key];
  }

  if (current) segments.push({ text: current, ...style });
  return segments;
}

function styleKey(char) {
  if (char === '_') return 'underline';
  if (char === '"') return 'bold';
  if (char === '`') return 'invert';
  if (char === '^') return 'doubleWidth';
  return null;
}

function printStyledSegments(printer, segments) {
  for (const segment of segments) {
    if (!segment.text) continue;
    if (segment.bold) printer.bold(true);
    if (segment.underline) printer.underline(true);
    if (segment.invert) printer.invert(true);
    if (segment.doubleWidth) printer.size(2, 1);
    printer.text(stripStyleMarkers(segment.text));
    if (segment.doubleWidth) printer.size(1, 1);
    if (segment.invert) printer.invert(false);
    if (segment.underline) printer.underline(false);
    if (segment.bold) printer.bold(false);
  }
  printer.feed(1);
}

async function printReceiptLineStyledText(printer, line, config, warnings, rasterBatch = null) {
  const text = line.segments.map((segment) => stripStyleMarkers(segment.text)).join('');
  if (shouldRasterReceiptLineText(text, config)) {
    await printReceiptLineRaster(printer, text, config, warnings, rasterBatch);
  } else {
    printStyledSegments(printer, line.segments);
  }
}

async function printReceiptLineText(printer, text, config, warnings, rasterBatch = null) {
  if (shouldRasterReceiptLineText(text, config)) {
    await printReceiptLineRaster(printer, text, config, warnings, rasterBatch);
  } else {
    printer.line(text);
  }
}

function shouldRasterReceiptLineText(text, config) {
  const mode = config.textRenderMode || process.env.TEXT_RENDER_MODE || 'auto';
  if (mode === 'image') return Boolean(text);
  if (mode === 'text') return false;
  return normalizePrinterTextDetailed(text).replacements.length > 0;
}

async function printReceiptLineRaster(printer, text, config, warnings, rasterBatch = null) {
  if (!text) {
    if (rasterBatch) {
      const width = config.printWidthDots ?? printer.widthDots ?? 384;
      const height = (config.textImageLineHeightDots ?? 30) + (config.textImageLineGapDots ?? 6);
      rasterBatch.images.push(await sharp({
        create: { width, height, channels: 3, background: '#ffffff' }
      }).png().toBuffer());
    } else {
      printer.feed(1);
    }
    return;
  }
  const width = config.printWidthDots ?? printer.widthDots ?? 384;
  const fontSize = config.textImageFontSizeDots ?? 28;
  const lineHeight = (config.textImageLineHeightDots ?? 30) + (config.textImageLineGapDots ?? 6);
  const baselineY = lineHeight - Math.max(4, Math.round(lineHeight * 0.15));
  const font = resolveReceiptLineFont(config);
  let x = 0;
  const elements = Array.from(text).map((char) => {
    const advance = charWidth(char) * 12;
    const fit = char.trim() ? ` textLength="${advance}" lengthAdjust="spacingAndGlyphs"` : '';
    const element = `<text x="${x}" y="${baselineY}" font-size="${fontSize}"${fit} xml:space="preserve">${escapeXml(char)}</text>`;
    x += advance;
    return element;
  }).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${lineHeight}"><style>${font.css} text { font-family: ${font.cssFamily}; fill: #000; }</style><rect width="100%" height="100%" fill="white"/>${elements}</svg>`);
  const threshold = config.textImageThreshold ?? 170;
  const png = await sharp(svg).grayscale().threshold(threshold).png().toBuffer();
  if (rasterBatch) {
    rasterBatch.images.push(png);
  } else {
    await printer.image(png, {
    maxWidth: width,
    dither: config.textImageDitherMode ?? 'threshold',
      threshold
    });
  }
  const chars = [...new Set(normalizePrinterTextDetailed(text).replacements.map((item) => item.from))];
  if (chars.length > 0 && config.textRenderMode !== 'image') {
    const warning = `プリンタ文字コード外の文字を画像として印刷しました: ${chars.join(' ')}`;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
}

async function flushReceiptLineRasterBatch(printer, rasterBatch, config) {
  if (rasterBatch.images.length === 0) return;
  const width = config.printWidthDots ?? printer.widthDots ?? 384;
  const metadata = await Promise.all(rasterBatch.images.map((image) => sharp(image).metadata()));
  const height = metadata.reduce((sum, item) => sum + (item.height ?? 0), 0);
  let top = 0;
  const composites = rasterBatch.images.map((input, index) => {
    const item = { input, left: 0, top };
    top += metadata[index].height ?? 0;
    return item;
  });
  const image = await sharp({
    create: { width, height: Math.max(1, height), channels: 3, background: '#ffffff' }
  }).composite(composites).png().toBuffer();
  rasterBatch.images.length = 0;
  await printer.image(image, {
    maxWidth: width,
    dither: 'threshold',
    threshold: config.textImageThreshold ?? 170
  });
  rasterBatch.artifacts.push(image);
}

function resolveReceiptLineFont(config) {
  const family = config.textImageFontFamily || process.env.TEXT_IMAGE_FONT_FAMILY || 'Noto Sans Mono CJK JP';
  const requestedPath = config.textImageFontPath || process.env.TEXT_IMAGE_FONT_PATH || '';
  const selected = [
    { path: requestedPath, family },
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'Noto Sans Mono CJK JP' },
    { path: '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf', family: 'Noto Sans CJK JP' },
    { path: 'C:/Windows/Fonts/msyh.ttc', family: 'Microsoft YaHei' },
    { path: 'C:/Windows/Fonts/YuGothR.ttc', family: 'Yu Gothic' }
  ].filter((candidate) => candidate.path).find((candidate) => existsSync(candidate.path));
  if (!selected) return { css: '', cssFamily: '"Noto Sans Mono CJK JP", "Noto Sans CJK JP", "Microsoft YaHei", "Yu Gothic", monospace' };
  const format = selected.path.toLowerCase().endsWith('.otf') ? 'opentype' : 'truetype';
  const data = readFileSync(selected.path).toString('base64');
  const cssFamily = `"${selected.family.replace(/"/g, '\\"')}"`;
  return {
    css: `@font-face { font-family: ${cssFamily}; src: url("data:font/${format};base64,${data}") format("${format}"); }`,
    cssFamily: `${cssFamily}, "Noto Sans Mono CJK JP", "Noto Sans CJK JP", "Microsoft YaHei", "Yu Gothic", monospace`
  };
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function stripStyleMarkers(text) {
  return String(text).replace(/[_"`^]/g, '');
}

function printReceiptLineCode(printer, value, type, options, config) {
  const normalizedType = normalizeCodeType(type, value);
  if (normalizedType === 'qrcode') {
    printer.qrCode(value, {
      moduleSize: options.qrModuleSize ?? config.qrModuleSize,
      errorCorrection: options.qrErrorCorrection ?? config.qrErrorCorrection
    });
    return;
  }
  printer.barcode(normalizedType, value, {
    width: options.width,
    height: options.height,
    hri: options.hri
  });
}

function normalizeCodeType(type, value) {
  const token = normalizeToken(type);
  if (token === 'qrcode' || token === 'qr') return 'qrcode';
  if (token === 'ean' || token === 'jan') return String(value).replace(/\D/g, '').length <= 8 ? 'jan8' : 'jan13';
  if (token === 'upc') return 'upc_a';
  if (token === 'nw7') return 'codabar';
  return token || 'code128';
}

function parseCodeOptions(value, previous) {
  const next = { ...previous };
  for (const token of splitOptionTokens(value)) {
    const normalized = normalizeToken(token);
    if (['upc', 'ean', 'jan', 'code39', 'itf', 'codabar', 'nw7', 'code93', 'code128', 'qrcode', 'qr'].includes(normalized)) {
      next.type = normalized;
    } else if (['hri', 'nohri'].includes(normalized)) {
      next.hri = normalized === 'hri' ? 'below' : 'none';
    } else if (['l', 'm', 'q', 'h'].includes(normalized)) {
      next.qrErrorCorrection = normalized.toUpperCase();
    } else if (/^\d+$/.test(normalized)) {
      const number = Number.parseInt(normalized, 10);
      if (number >= 24) next.height = Math.min(Math.max(number, 24), 240);
      else next.width = Math.min(Math.max(number, 2), 8);
      next.qrModuleSize = Math.min(Math.max(number, 3), 8);
    }
  }
  return next;
}

function parseWidthSpec(value) {
  const tokens = splitOptionTokens(value).map((token) => normalizeToken(token));
  if (tokens.length === 0) return ['0'];
  if (tokens.includes('auto')) return ['auto'];
  return tokens.map((token) => (token === '*' ? '*' : String(Math.max(0, Number.parseInt(token, 10) || 0))));
}

function parseBorder(value) {
  const token = normalizeToken(value);
  if (token === 'line') return 'line';
  if (token === 'none' || token === '0') return 'none';
  if (token === '2') return 'wide';
  return 'space';
}

function parseAlign(value, fallback) {
  const token = normalizeToken(value);
  return ['left', 'center', 'right'].includes(token) ? token : fallback;
}

function splitOptionTokens(value) {
  return String(value ?? '').split(/[,\s]+/).map((token) => token.trim()).filter(Boolean);
}

function columnAlign(leading, trailing) {
  if (leading && trailing) return 'center';
  if (leading) return 'right';
  return 'left';
}

function borderWidth(border) {
  if (border === 'none') return 0;
  if (border === 'wide') return 2;
  return 1;
}

function borderSeparator(border) {
  if (border === 'none') return '';
  if (border === 'line') return '|';
  if (border === 'wide') return '  ';
  return ' ';
}

function renderHorizontalLine(state) {
  return state.border === 'line' ? '-'.repeat(state.columns) : '-'.repeat(state.columns);
}

function alignLine(text, width, align) {
  const columns = displayColumns(text);
  if (columns >= width) return text;
  const padding = width - columns;
  if (align === 'right') return `${' '.repeat(padding)}${text}`;
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return `${' '.repeat(left)}${text}${' '.repeat(padding - left)}`;
  }
  return text;
}

function padReceiptLine(text, width, align) {
  const printable = stripStyleMarkers(text);
  const columns = displayColumns(printable);
  if (columns >= width) return truncateColumns(text, width);
  const padding = width - columns;
  if (align === 'right') return `${' '.repeat(padding)}${text}`;
  if (align === 'center') {
    const left = Math.floor(padding / 2);
    return `${' '.repeat(left)}${text}${' '.repeat(padding - left)}`;
  }
  return `${text}${' '.repeat(padding)}`;
}

function unescapeReceiptLineText(value) {
  let result = '';
  const chars = Array.from(String(value ?? ''));
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (char !== '\\' && char !== '¥') {
      result += char === '~' ? ' ' : char;
      continue;
    }
    const next = chars[index + 1];
    if (next === 'n') {
      result += '\n';
      index += 1;
    } else if (next === 'x') {
      const hex = chars.slice(index + 2, index + 4).join('');
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        result += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 3;
      }
    } else if (next) {
      result += next;
      index += 1;
    }
  }
  return result;
}

function splitUnescaped(value, separator) {
  const parts = [];
  let current = '';
  let escaped = false;
  for (const char of Array.from(String(value ?? ''))) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' || char === '¥') {
      current += char;
      escaped = true;
      continue;
    }
    if (char === separator) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function findUnescaped(value, needle) {
  let escaped = false;
  const chars = Array.from(String(value ?? ''));
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' || char === '¥') {
      escaped = true;
      continue;
    }
    if (char === needle) return index;
  }
  return -1;
}

function previewRow(text) {
  return {
    text: stripStyleMarkers(text),
    align: 'left',
    bold: false,
    underline: false,
    sizeX: 1,
    sizeY: 1,
    small: false
  };
}

function displayColumns(text) {
  return Array.from(String(text ?? '')).reduce((columns, char) => columns + charWidth(char), 0);
}

function charWidth(char) {
  const codePoint = char.codePointAt(0);
  if (codePoint <= 0x7f) return 1;
  if (codePoint === 0x00a5) return 1;
  if (codePoint >= 0x00c0 && codePoint <= 0x024f) return 1;
  if (codePoint >= 0xff61 && codePoint <= 0xff9f) return 1;
  return 2;
}

function normalizeToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
