import iconv from 'iconv-lite';
import sharp from 'sharp';

const ESC = 0x1b;
const GS = 0x1d;
const FS = 0x1c;
const LF = 0x0a;
const BAYER_8X8 = [
  [0, 48, 12, 60, 3, 51, 15, 63],
  [32, 16, 44, 28, 35, 19, 47, 31],
  [8, 56, 4, 52, 11, 59, 7, 55],
  [40, 24, 36, 20, 43, 27, 39, 23],
  [2, 50, 14, 62, 1, 49, 13, 61],
  [34, 18, 46, 30, 33, 17, 45, 29],
  [10, 58, 6, 54, 9, 57, 5, 53],
  [42, 26, 38, 22, 41, 25, 37, 21]
];

export class EscPosBuilder {
  constructor({ widthDots = 384 } = {}) {
    this.widthDots = widthDots;
    this.parts = [];
    this.raw(Buffer.from([ESC, 0x40]));
    this.raw(Buffer.from([ESC, 0x33, 24]));
    this.enableJapaneseMode();
  }

  raw(buffer) {
    this.parts.push(Buffer.from(buffer));
    return this;
  }

  enableJapaneseMode() {
    this.raw(Buffer.from([ESC, 0x52, 8]));
    this.raw(Buffer.from([FS, 0x43, 1]));
    this.raw(Buffer.from([FS, 0x26]));
    return this;
  }

  align(value) {
    const map = { left: 0, center: 1, right: 2 };
    this.raw(Buffer.from([ESC, 0x61, map[value] ?? 0]));
    return this;
  }

  initialize() {
    this.raw(Buffer.from([ESC, 0x40]));
    this.raw(Buffer.from([ESC, 0x33, 24]));
    this.enableJapaneseMode();
    return this;
  }

  bold(enabled) {
    this.raw(Buffer.from([ESC, 0x45, enabled ? 1 : 0]));
    return this;
  }

  doubleStrike(enabled) {
    this.raw(Buffer.from([ESC, 0x47, enabled ? 1 : 0]));
    return this;
  }

  underline(value) {
    const n = value === 2 || value === '2' || value === 'thick' ? 2 : value ? 1 : 0;
    this.raw(Buffer.from([ESC, 0x2d, n]));
    this.raw(Buffer.from([FS, 0x2d, n]));
    return this;
  }

  invert(enabled) {
    this.raw(Buffer.from([GS, 0x42, enabled ? 1 : 0]));
    return this;
  }

  upsideDown(enabled) {
    this.raw(Buffer.from([ESC, 0x7b, enabled ? 1 : 0]));
    return this;
  }

  rotate90(enabled) {
    this.raw(Buffer.from([ESC, 0x56, enabled ? 1 : 0]));
    return this;
  }

  font(value) {
    const font = String(value).toLowerCase() === 'b' ? 1 : 0;
    this.raw(Buffer.from([ESC, 0x4d, font]));
    return this;
  }

  smoothing(enabled) {
    this.raw(Buffer.from([GS, 0x62, enabled ? 1 : 0]));
    return this;
  }

  printMode({
    font = 'a',
    bold = false,
    doubleHeight = false,
    doubleWidth = false,
    underline = false
  } = {}) {
    const n = (String(font).toLowerCase() === 'b' ? 1 : 0)
      | (bold ? 0x08 : 0)
      | (doubleHeight ? 0x10 : 0)
      | (doubleWidth ? 0x20 : 0)
      | (underline ? 0x80 : 0);
    this.raw(Buffer.from([ESC, 0x21, n]));
    return this;
  }

  text(value = '') {
    if (!value) return this;
    this.raw(iconv.encode(normalizePrinterText(value), 'cp932'));
    return this;
  }

  line(value = '') {
    this.text(value);
    this.feed(1);
    return this;
  }

  carriageReturn() {
    this.raw(Buffer.from([0x0d]));
    return this;
  }

  tab() {
    this.raw(Buffer.from([0x09]));
    return this;
  }

  tabStops(columns = []) {
    const stops = columns
      .map((value) => clampByte(value))
      .filter((value) => value > 0)
      .sort((a, b) => a - b)
      .slice(0, 32);
    this.raw(Buffer.from([ESC, 0x44, ...stops, 0]));
    return this;
  }

  size(widthMult, heightMult) {
    const n = ((widthMult - 1) << 4) | (heightMult - 1);
    this.raw(Buffer.from([GS, 0x21, n]));
    return this;
  }

  smallText(enabled) {
    this.raw(Buffer.from([ESC, 0x4D, enabled ? 1 : 0]));
    return this;
  }

  lineSpacing(dots) {
    if (dots === 'default') {
      this.raw(Buffer.from([ESC, 0x32]));
      return this;
    }
    this.raw(Buffer.from([ESC, 0x33, clampByte(dots)]));
    return this;
  }

  charSpacing(dots) {
    this.raw(Buffer.from([ESC, 0x20, clampByte(dots)]));
    return this;
  }

  feed(lines = 1) {
    this.raw(Buffer.alloc(Math.max(0, lines), LF));
    return this;
  }

  feedDots(dots = 0) {
    this.raw(Buffer.from([ESC, 0x4a, clampByte(dots)]));
    return this;
  }

  absolutePosition(dots = 0) {
    const n = clampWord(dots);
    this.raw(Buffer.from([ESC, 0x24, n & 0xff, (n >> 8) & 0xff]));
    return this;
  }

  relativePosition(dots = 0) {
    const n = clampRelativeWord(dots);
    this.raw(Buffer.from([ESC, 0x5c, n & 0xff, (n >> 8) & 0xff]));
    return this;
  }

  pageMode(enabled) {
    this.raw(Buffer.from([ESC, enabled ? 0x4c : 0x53]));
    return this;
  }

  pagePrint() {
    this.raw(Buffer.from([0x0c]));
    return this;
  }

  pageCancel() {
    this.raw(Buffer.from([CAN]));
    return this;
  }

  pageDirection(value) {
    const map = {
      left_to_right: 0,
      bottom_to_top: 1,
      right_to_left: 2,
      top_to_bottom: 3
    };
    this.raw(Buffer.from([ESC, 0x54, map[normalizeCommandName(value)] ?? 0]));
    return this;
  }

  pageArea(x, y, width, height) {
    const values = [x, y, width, height].map(clampWord);
    this.raw(Buffer.from([
      ESC,
      0x57,
      values[0] & 0xff,
      (values[0] >> 8) & 0xff,
      values[1] & 0xff,
      (values[1] >> 8) & 0xff,
      values[2] & 0xff,
      (values[2] >> 8) & 0xff,
      values[3] & 0xff,
      (values[3] >> 8) & 0xff
    ]));
    return this;
  }

  pagePosition(x, y) {
    const horizontal = clampWord(x);
    const vertical = clampWord(y);
    this.raw(Buffer.from([ESC, 0x24, horizontal & 0xff, (horizontal >> 8) & 0xff]));
    this.raw(Buffer.from([GS, 0x24, vertical & 0xff, (vertical >> 8) & 0xff]));
    return this;
  }

  pageRelativeVertical(dots = 0) {
    const n = clampRelativeWord(dots);
    this.raw(Buffer.from([GS, 0x5c, n & 0xff, (n >> 8) & 0xff]));
    return this;
  }

  leftMargin(dots = 0) {
    const n = clampWord(dots);
    this.raw(Buffer.from([GS, 0x4c, n & 0xff, (n >> 8) & 0xff]));
    return this;
  }

  printAreaWidth(dots = this.widthDots) {
    const n = clampWord(dots);
    this.raw(Buffer.from([GS, 0x57, n & 0xff, (n >> 8) & 0xff]));
    return this;
  }

  motionUnits(x = 203, y = 203) {
    this.raw(Buffer.from([GS, 0x50, clampByte(x), clampByte(y)]));
    return this;
  }

  drawerPulse(pin = 0, onTime = 80, offTime = 240) {
    const m = Number(pin) === 1 ? 1 : 0;
    this.raw(Buffer.from([ESC, 0x70, m, clampByte(Math.round(onTime / 2)), clampByte(Math.round(offTime / 2))]));
    return this;
  }

  buzzer(pattern = 1, repeat = 1, cycle = 3) {
    this.raw(Buffer.from([ESC, 0x28, 0x41, 0x04, 0x00, 48, clampByte(pattern), clampByte(repeat), clampByte(cycle)]));
    return this;
  }

  cut(mode = 'partial') {
    if (mode === 'none') {
      this.feed(2);
      return this;
    }

    this.feed(3);
    if (mode === 'full') {
      this.raw(Buffer.from([GS, 0x56, 0x41, 0]));
    } else if (mode === 'partial3') {
      this.raw(Buffer.from([ESC, 0x6d]));
    } else {
      this.raw(Buffer.from([ESC, 0x69]));
    }
    return this;
  }

  barcode(type, value, { width = 3, height = 96, hri = 'below' } = {}) {
    const data = Buffer.from(value, 'ascii');
    if (data.length === 0 || data.length > 255) return this;

    const typeMap = {
      upc_a: 65,
      upc_e: 66,
      ean13: 67,
      jan13: 67,
      ean8: 68,
      jan8: 68,
      code39: 69,
      itf: 70,
      codabar: 71,
      nw7: 71,
      code93: 72,
      code128: 73,
      code128c: 73,
      gs1_128: 74,
      gs1_databar_omni: 75,
      gs1_databar_truncated: 76,
      gs1_databar_limited: 77,
      gs1_databar_expanded: 78
    };
    const hriMap = { none: 0, above: 1, below: 2, both: 3 };
    const symbolType = typeMap[type];
    if (symbolType === undefined) {
      throw new Error(`Unsupported 1D barcode type: ${type}`);
    }

    this.align('center');
    this.raw(Buffer.from([GS, 0x48, hriMap[hri] ?? hriMap.below]));
    this.raw(Buffer.from([GS, 0x77, Math.min(Math.max(width, 2), 6)]));
    this.raw(Buffer.from([GS, 0x68, Math.min(Math.max(height, 1), 255)]));
    this.raw(Buffer.from([GS, 0x6b, symbolType, data.length]));
    this.raw(data);
    this.feed(1);
    this.align('left');
    return this;
  }

  qrCode(value, { moduleSize = 6, errorCorrection = 'M' } = {}) {
    const data = Buffer.from(value, 'utf8');
    if (data.length === 0 || data.length > 7089) return this;

    const safeModuleSize = Math.min(Math.max(moduleSize, 1), 16);
    const errorMap = {
      L: 48,
      M: 49,
      Q: 50,
      H: 51
    };
    const errorValue = errorMap[String(errorCorrection).toUpperCase()] ?? errorMap.M;
    const storeLength = data.length + 3;
    const pL = storeLength & 0xff;
    const pH = (storeLength >> 8) & 0xff;

    this.align('center');
    this.raw(Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]));
    this.raw(Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, safeModuleSize]));
    this.raw(Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, errorValue]));
    this.raw(Buffer.from([GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30]));
    this.raw(data);
    this.raw(Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]));
    this.feed(1);
    this.align('left');
    return this;
  }

  pdf417(value, { moduleWidth = 3, rowHeight = 8, errorCorrection = 3 } = {}) {
    const data = Buffer.from(value, 'utf8');
    if (data.length === 0 || data.length > 928) return this;

    this.align('center');
    this.gsK(48, 67, Buffer.from([Math.min(Math.max(moduleWidth, 2), 8)]));
    this.gsK(48, 68, Buffer.from([Math.min(Math.max(rowHeight, 2), 8)]));
    this.gsK(48, 69, Buffer.from([48, Math.min(Math.max(errorCorrection, 0), 8)]));
    this.gsK(48, 80, Buffer.concat([Buffer.from([48]), data]));
    this.gsK(48, 81, Buffer.from([48]));
    this.feed(1);
    this.align('left');
    return this;
  }

  maxicode(value, { mode = 4 } = {}) {
    const data = Buffer.from(value, 'utf8');
    if (data.length === 0 || data.length > 138) return this;

    this.align('center');
    this.gsK(50, 65, Buffer.from([Math.min(Math.max(mode, 2), 6)]));
    this.gsK(50, 80, Buffer.concat([Buffer.from([48]), data]));
    this.gsK(50, 81, Buffer.from([48]));
    this.feed(1);
    this.align('left');
    return this;
  }

  gs1DataBar2d(type, value, { moduleWidth = 3, expandedStackedMaxWidth = 176 } = {}) {
    const typeMap = {
      gs1_databar_stacked: 72,
      gs1_databar_stacked_omni: 73,
      gs1_databar_expanded_stacked: 76
    };
    const data = Buffer.from(value, 'ascii');
    const symbolType = typeMap[type];
    if (symbolType === undefined) {
      throw new Error(`Unsupported 2D GS1 DataBar type: ${type}`);
    }

    const maxWidth = Math.min(Math.max(expandedStackedMaxWidth, 2), 384);
    this.align('center');
    this.gsK(51, 67, Buffer.from([Math.min(Math.max(moduleWidth, 2), 8)]));
    this.gsK(51, 71, Buffer.from([maxWidth & 0xff, (maxWidth >> 8) & 0xff]));
    this.gsK(51, 80, Buffer.concat([Buffer.from([48, symbolType]), data]));
    this.gsK(51, 81, Buffer.from([48]));
    this.feed(1);
    this.align('left');
    return this;
  }

  compositeSymbology(lineType, lineData, compositeData, { moduleWidth = 3, expandedStackedMaxWidth = 176 } = {}) {
    const lineTypeMap = {
      ean8: 65,
      jan8: 65,
      ean13: 66,
      jan13: 66,
      upc_a: 67,
      upc_e: 68,
      gs1_databar_omni: 70,
      gs1_databar_truncated: 71,
      gs1_databar_stacked: 72,
      gs1_databar_stacked_omni: 73,
      gs1_databar_limited: 74,
      gs1_databar_expanded: 75,
      gs1_databar_expanded_stacked: 76,
      gs1_128: 77
    };
    const lineTypeValue = lineTypeMap[lineType];
    if (lineTypeValue === undefined) {
      throw new Error(`Unsupported Composite line type: ${lineType}`);
    }

    const lineBytes = Buffer.from(lineData, 'ascii');
    const compositeBytes = Buffer.from(compositeData, 'utf8');
    const maxWidth = Math.min(Math.max(expandedStackedMaxWidth, 2), 384);

    this.align('center');
    this.gsK(52, 67, Buffer.from([Math.min(Math.max(moduleWidth, 2), 8)]));
    this.gsK(52, 71, Buffer.from([maxWidth & 0xff, (maxWidth >> 8) & 0xff]));
    this.gsK(52, 80, Buffer.concat([Buffer.from([48, 48, lineTypeValue]), lineBytes]));
    this.gsK(52, 80, Buffer.concat([Buffer.from([48, 49, 65]), compositeBytes]));
    this.gsK(52, 81, Buffer.from([48]));
    this.feed(1);
    this.align('left');
    return this;
  }

  gsK(cn, fn, payload) {
    const length = payload.length + 2;
    this.raw(Buffer.from([GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, cn, fn]));
    this.raw(payload);
    return this;
  }

  async image(inputBuffer, { maxWidth = this.widthDots, dither = 'ordered' } = {}) {
    const png = await sharp(inputBuffer, { animated: false })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize({
        width: maxWidth,
        withoutEnlargement: true,
        fit: 'inside'
      })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = png;
    const widthBytes = Math.ceil(info.width / 8);
    const raster = Buffer.alloc(widthBytes * info.height, 0x00);

    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const pixel = data[y * info.width + x];
        if (shouldPrintBlack(pixel, x, y, dither)) {
          const byteIndex = y * widthBytes + Math.floor(x / 8);
          raster[byteIndex] |= 0x80 >> (x % 8);
        }
      }
    }

    const xL = widthBytes & 0xff;
    const xH = (widthBytes >> 8) & 0xff;
    const yL = info.height & 0xff;
    const yH = (info.height >> 8) & 0xff;

    this.align('center');
    this.raw(Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]));
    this.raw(raster);
    this.feed(1);
    this.align('left');
    return this;
  }

  build() {
    return Buffer.concat(this.parts);
  }
}

const CAN = 0x18;

function clampByte(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, 0), 255);
}

function clampWord(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, 0), 65535);
}

function clampRelativeWord(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, -32768), 32767);
}

function normalizeCommandName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
}

export function normalizePrinterText(value) {
  return normalizePrinterTextDetailed(value).text;
}

export function findUnsupportedPrinterChars(value) {
  return normalizePrinterTextDetailed(value).replacements.map((item) => ({
    char: item.from,
    codePoint: `U+${item.from.codePointAt(0).toString(16).toUpperCase()}`,
    count: item.count,
    replacement: item.to
  }));
}

export function normalizePrinterTextDetailed(value) {
  const counts = new Map();
  const text = Array.from(String(value))
    .map((char) => {
      const replacement = normalizePrinterChar(char);
      if (replacement !== char) {
        const key = `${char}\u0000${replacement}`;
        counts.set(key, {
          from: char,
          to: replacement,
          count: (counts.get(key)?.count ?? 0) + 1
        });
      }
      return replacement;
    })
    .join('');

  return {
    text,
    replacements: Array.from(counts.values())
  };
}

function normalizePrinterTextDetailedLegacy(value) {
  return normalizePrinterTextDetailed(value);
}

function findUnsupportedPrinterCharsLegacy(value) {
  const unsupported = new Map();
  const normalized = String(value);

  for (const char of Array.from(normalized)) {
    if (char === '\r' || char === '\n' || char === '\t') continue;

    if (normalizePrinterChar(char) !== char) {
      unsupported.set(char, (unsupported.get(char) ?? 0) + 1);
    }
  }

  return Array.from(unsupported, ([char, count]) => ({
    char,
    codePoint: `U+${char.codePointAt(0).toString(16).toUpperCase()}`,
    count
  }));
}

function normalizePrinterChar(char) {
  if (char === '\r' || char === '\n' || char === '\t') return char;
  if (char === '\u00A0' || /[\u2000-\u200B\u202F\u205F]/.test(char)) return ' ';

  if (isSupportedPrinterChar(char)) return char;

  const fallback = PRINTER_CHAR_FALLBACKS.get(char);
  if (fallback !== undefined) return fallback;

  return '?';
}

function isSupportedPrinterChar(char) {
  const encoded = iconv.encode(char, 'cp932');
  const decoded = iconv.decode(encoded, 'cp932');
  if (decoded !== char) return false;

  if (encoded.length === 1) {
    const code = encoded[0];
    return (code >= 0x20 && code <= 0x7E) || (code >= 0xA1 && code <= 0xDF);
  }

  if (encoded.length === 2) {
    const code = (encoded[0] << 8) | encoded[1];
    return (
      (code >= 0x8140 && code <= 0xEAAD) ||
      (code >= 0xED40 && code <= 0xEEFC) ||
      (code >= 0xFA40 && code <= 0xFC4E)
    );
  }

  return false;
}

const PRINTER_CHAR_FALLBACKS = new Map([
  // Add printer-specific substitutions here when a character cannot round-trip
  // through CP932 or the TM-T70II built-in font. The bot reports these mappings
  // to Discord as "from codepoint -> to codepoint" replacement warnings.
  ['\u00A5', '\\'],
  ['\u203C', '!!'],
  ['\u2049', '!?'],
  ['\uFE0E', ''],
  ['\uFE0F', ''],
  ['\u301C', '~'],
  ['\uFF5E', '~'],
  ['\u2212', '-'],
  ['\u2010', '-'],
  ['\u2011', '-'],
  ['\u2012', '-'],
  ['\u2013', '-'],
  ['\u2014', '-'],
  ['\u2015', '-'],
  ['\uFE58', '-'],
  ['\uFE63', '-'],
  ['\uFF0D', '-'],
  ['\u2500', '-'],
  ['\u2501', '-'],
  ['\u2502', '|'],
  ['\u2503', '|'],
  ['\u2514', '+'],
  ['\u2518', '+'],
  ['\u251C', '+'],
  ['\u2524', '+'],
  ['\u2534', '+'],
  ['\u252C', '+'],
  ['\u253C', '+']
]);

function shouldPrintBlack(pixel, x, y, dither) {
  if (dither === 'threshold') {
    return pixel < 170;
  }

  const threshold = ((BAYER_8X8[y % 8][x % 8] + 0.5) / 64) * 255;
  return pixel < threshold;
}
