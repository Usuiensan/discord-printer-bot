import { normalizePrinterTextDetailed } from './escpos.js';

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

export async function appendReceiptLine(printer, document, config = {}, warnings = []) {
  const state = createReceiptLineState(config);

  for (const rawLine of parseReceiptLinePhysicalLines(document)) {
    const result = await applyReceiptLineLine(rawLine, state, {
      text: (line) => printer.line(line),
      styledText: (line) => printStyledSegments(printer, line.segments),
      image: async (base64) => {
        await printer.image(Buffer.from(base64, 'base64'), {
          maxWidth: state.printWidthDots,
          dither: config.imageDitherMode
        });
      },
      code: (value, type, options) => printReceiptLineCode(printer, value, type, options, config),
      cut: () => printer.cut(config.cutMode ?? 'partial')
    });

    if (result.error) {
      warnings.push(`ReceiptLineエラー: ${result.error}`);
      printer.line(`[ReceiptLineエラー: ${result.error}]`);
    }
  }
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
      output.text(renderHorizontalLine(state));
      return { applied: true };
    }

    if (CUT_LINE_RE.test(rawLine)) {
      output.cut();
      return { applied: true };
    }

    if (!rawLine.trim()) {
      output.text('');
      return { applied: true };
    }

    const columns = splitReceiptLineColumns(rawLine);
    for (const line of layoutReceiptLineColumns(columns, state)) {
      if (line.segments) {
        output.styledText(line);
      } else {
        output.text(line.text);
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
    output.code(unescapeReceiptLineText(normalized.code), state.codeOptions.type, state.codeOptions);
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
  const lines = [];
  let current = '';
  let columns = 0;
  for (const char of Array.from(text)) {
    const charColumns = charWidth(char);
    if (columns + charColumns > width && current) {
      lines.push(current);
      current = '';
      columns = 0;
    }
    current += char;
    columns += charColumns;
  }
  lines.push(current);
  return lines;
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
    text: normalizePrinterTextDetailed(stripStyleMarkers(text)).text,
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
  return char.charCodeAt(0) <= 0x7f ? 1 : 2;
}

function normalizeToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
