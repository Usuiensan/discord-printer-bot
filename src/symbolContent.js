import { EscPosBuilder } from './escpos.js';

export const SYMBOL_TYPES = [
  ['upc_a', 'UPC-A'],
  ['upc_e', 'UPC-E'],
  ['jan8', 'JAN 8 / EAN 8'],
  ['jan13', 'JAN 13 / EAN 13'],
  ['code39', 'CODE 39'],
  ['itf', 'ITF'],
  ['codabar', 'CODABAR / NW-7'],
  ['code93', 'CODE 93'],
  ['code128', 'CODE 128'],
  ['code128c', 'CODE 128 Code Set C'],
  ['gs1_128', 'GS1-128'],
  ['gs1_databar_omni', 'GS1 DataBar Omnidirectional'],
  ['gs1_databar_truncated', 'GS1 DataBar Truncated'],
  ['gs1_databar_stacked', 'GS1 DataBar Stacked'],
  ['gs1_databar_stacked_omni', 'GS1 DataBar Stacked Omnidirectional'],
  ['gs1_databar_limited', 'GS1 DataBar Limited'],
  ['gs1_databar_expanded', 'GS1 DataBar Expanded'],
  ['gs1_databar_expanded_stacked', 'GS1 DataBar Expanded Stacked'],
  ['pdf417', 'PDF417'],
  ['qr', 'QR Code'],
  ['maxicode', 'MaxiCode'],
  ['composite', 'Composite Symbology']
];

const TWO_D_GS1_TYPES = new Set([
  'gs1_databar_stacked',
  'gs1_databar_stacked_omni',
  'gs1_databar_expanded_stacked'
]);

const ONE_D_TYPES = new Set([
  'upc_a',
  'upc_e',
  'jan8',
  'jan13',
  'code39',
  'itf',
  'codabar',
  'code93',
  'code128',
  'code128c',
  'gs1_128',
  'gs1_databar_omni',
  'gs1_databar_truncated',
  'gs1_databar_limited',
  'gs1_databar_expanded'
]);

export async function buildSymbolPrintJob(commands, config, options = {}) {
  const items = Array.isArray(commands) ? commands : [commands];
  const printer = new EscPosBuilder({ widthDots: config.printWidthDots });
  const warnings = [];

  if (options.requestedBy) printer.line(options.requestedBy);
  appendSymbolItems(printer, items, config);

  printer.cut(config.cutMode);

  return {
    bytes: printer.build(),
    warnings
  };
}

export function appendSymbolItems(printer, commands, config) {
  const items = Array.isArray(commands) ? commands : [commands];
  if (items.length === 0) return;

  for (const [index, item] of items.entries()) {
    try {
      printSymbolItem(printer, item, config, index, items.length);
    } catch (error) {
      throw new Error(`#${index + 1} ${item.type} ${item.data}: ${error.message}`);
    }
  }
}

function printSymbolItem(printer, { type, data, compositeData, lineType }, config, index, total) {
  validateSymbolInput(type, data, compositeData, config);

  if (index > 0) printer.feed(1);

  if (ONE_D_TYPES.has(type)) {
    printer.barcode(type, prepareOneDimensionalData(type, data), barcodeOptionsFor(type, data, config));
  } else if (TWO_D_GS1_TYPES.has(type)) {
    printer.gs1DataBar2d(type, data);
  } else if (type === 'qr') {
    printer.qrCode(data, {
      moduleSize: config.qrModuleSize,
      errorCorrection: config.qrErrorCorrection
    });
  } else if (type === 'pdf417') {
    printer.pdf417(data);
  } else if (type === 'maxicode') {
    printer.maxicode(data);
  } else if (type === 'composite') {
    printer.compositeSymbology(lineType || 'gs1_databar_omni', data, compositeData);
  } else {
    throw new Error(`Unsupported symbol type: ${type}`);
  }
}

export function formatSymbolPreviewLines(commands) {
  const items = Array.isArray(commands) ? commands : [commands];
  if (items.length === 0) return [];

  const lines = [];
  for (const [index, item] of items.entries()) {
    lines.push(symbolPlaceholder(item));
  }
  return lines;
}

function symbolPlaceholder({ type }) {
  if (type === 'qr') return '[QRコード]';
  if (type === 'pdf417') return '[PDF417]';
  if (type === 'maxicode') return '[MaxiCode]';
  if (type === 'composite') return '[Composite Symbology]';
  return '[バーコード]';
}

export function parseSymbolMessageCommands(content, prefix = '!') {
  const trimmed = stripInlineCodeMarkers(content).trim();
  if (!trimmed.startsWith(prefix)) return null;

  const commands = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (isCodeBlockFence(line)) {
      continue;
    }

    const command = parseSymbolCommandLine(line, prefix);
    if (command) commands.push(command);
  }

  return commands.length > 0 ? commands : null;
}

export function extractSymbolMessageCommands(content, prefix = '!') {
  const commands = [];
  const textLines = [];

  for (const line of String(content ?? '').split(/\r?\n/)) {
    if (isCodeBlockFence(line)) {
      continue;
    }

    const commandLine = stripInlineCodeMarkers(line);
    const command = parseSymbolCommandLine(commandLine, prefix);
    if (command) {
      commands.push(command);
    } else {
      textLines.push(line);
    }
  }

  return {
    commands,
    text: textLines.join('\n')
  };
}

function isCodeBlockFence(line) {
  return /^```/.test(String(line).trim());
}

function stripInlineCodeMarkers(value) {
  return String(value ?? '').replace(/`([^`\n]+)`/g, '$1');
}

export function parseSymbolMessageCommand(content, prefix = '!') {
  const commands = parseSymbolMessageCommands(content, prefix);
  if (!commands) return null;
  if (commands.length === 1) return commands[0];
  return commands;
}

function parseSymbolCommandLine(line, prefix = '!') {
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const body = trimmed.slice(prefix.length).trim();
  const match = body.match(/^(print-code-notext|code-notext|barcode-notext|qr-notext|print-code|code|コード|barcode|qr)\b\s*([\s\S]*)$/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const printText = !command.endsWith('-notext');
  const rest = match[2].trim();
  if (command === 'qr' || command === 'qr-notext') {
    if (!rest) throw new Error(`使い方: ${prefix}qr https://example.com`);
    return {
      type: 'qr',
      data: rest,
      compositeData: '',
      lineType: '',
      printText
    };
  }

  const [typeToken, ...dataParts] = splitCommandArgs(rest);
  if (!typeToken || dataParts.length === 0) {
    throw new Error(`使い方: ${prefix}print-code qr https://example.com`);
  }

  return {
    type: normalizeTypeToken(typeToken),
    data: dataParts.join(' '),
    compositeData: '',
    lineType: '',
    printText
  };
}

function splitCommandArgs(value) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of value.matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

function normalizeTypeToken(value) {
  const token = value.toLowerCase().replace(/[-\s]/g, '_');
  const aliases = {
    qr: 'qr',
    qrcode: 'qr',
    qr_code: 'qr',
    jan13: 'jan13',
    ean13: 'jan13',
    jan8: 'jan8',
    ean8: 'jan8',
    code39: 'code39',
    code_39: 'code39',
    code93: 'code93',
    code_93: 'code93',
    code128: 'code128',
    code_128: 'code128',
    code128c: 'code128c',
    code_128c: 'code128c',
    code128_c: 'code128c',
    code_128_c: 'code128c',
    code128num: 'code128c',
    code128_numeric: 'code128c',
    itf: 'itf',
    codabar: 'codabar',
    nw7: 'codabar',
    upca: 'upc_a',
    upc_a: 'upc_a',
    upce: 'upc_e',
    upc_e: 'upc_e',
    pdf417: 'pdf417',
    maxicode: 'maxicode',
    gs1128: 'gs1_128',
    gs1_128: 'gs1_128',
    gs1: 'gs1_128',
    databar: 'gs1_databar_omni',
    gs1_databar: 'gs1_databar_omni',
    gs1databar: 'gs1_databar_omni',
    databar_omni: 'gs1_databar_omni',
    omni: 'gs1_databar_omni',
    databar_truncated: 'gs1_databar_truncated',
    databar_limited: 'gs1_databar_limited',
    databar_expanded: 'gs1_databar_expanded',
    databar_stacked: 'gs1_databar_stacked',
    databar_stacked_omni: 'gs1_databar_stacked_omni',
    databar_expanded_stacked: 'gs1_databar_expanded_stacked',
    composite: 'composite'
  };

  return aliases[token] ?? token;
}

function validateSymbolInput(type, data, compositeData, config = {}) {
  if (!SYMBOL_TYPES.some(([value]) => value === type)) {
    throw new Error('未対応のコード種別です。');
  }
  if (!data?.trim()) {
    throw new Error('data は必須です。');
  }
  if (type === 'composite' && !compositeData?.trim()) {
    throw new Error('Composite Symbology では composite_data も指定してください。');
  }
  if (type !== 'qr' && type !== 'pdf417' && type !== 'maxicode' && !isAscii(data)) {
    throw new Error('このコード種別の data は ASCII 文字で指定してください。');
  }
  if (type === 'code39') {
    validateCode39Input(data, config.printWidthDots ?? 384);
  }
  validateOneDimensionalWidth(type, data, config.printWidthDots ?? 384);
  if (type === 'code128c') {
    validateCode128CInput(data);
  }
}

function validateCode39Input(data, printWidthDots) {
  if (!/^[0-9A-Z ./$%+-]+$/.test(data)) {
    throw new Error('CODE 39 で使える文字は 0-9、A-Z、スペース、-、.、/、$、%、+ です。');
  }

  const minModuleWidth = 2;
  const estimatedDots = estimateCode39WidthDots(data, minModuleWidth);
  if (estimatedDots > printWidthDots) {
    throw new Error(`CODE 39 が長すぎます（推定 ${estimatedDots} dots / 印字幅 ${printWidthDots} dots）。長いIDは code128 を使ってください。`);
  }
}

function estimateCode39WidthDots(data, moduleWidth) {
  const startStopChars = 2;
  const modulesPerCharWithGap = 13;
  return (data.length + startStopChars) * modulesPerCharWithGap * moduleWidth;
}

function validateOneDimensionalWidth(type, data, printWidthDots) {
  if (!ONE_D_TYPES.has(type)) return;
  const preparedData = prepareOneDimensionalData(type, data);
  const estimatedDots = estimateOneDimensionalWidthDots(type, preparedData, 2);
  if (estimatedDots > printWidthDots) {
    throw new Error(`${typeLabel(type)} が長すぎます（推定 ${estimatedDots} dots / 印字幅 ${printWidthDots} dots）。短いデータにするか、QRコードを使ってください。`);
  }
}

function barcodeOptionsFor(type, data, config) {
  const options = {
    hri: normalizeBarcodeHri(config.barcodeHri)
  };
  if (type === 'code39' || shouldUseNarrowBarcode(type, data, config.printWidthDots ?? 384)) {
    options.width = 2;
  }
  return options;
}

function normalizeBarcodeHri(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ['none', 'above', 'below', 'both'].includes(normalized) ? normalized : 'below';
}

function shouldUseNarrowBarcode(type, data, printWidthDots) {
  const preparedData = prepareOneDimensionalData(type, data);
  return estimateOneDimensionalWidthDots(type, preparedData, 3) > printWidthDots;
}

function estimateOneDimensionalWidthDots(type, preparedData, moduleWidth) {
  if (type === 'code39') return estimateCode39WidthDots(preparedData, moduleWidth);
  if (type === 'code128' || type === 'code128c' || type === 'gs1_128') {
    return estimateCode128WidthDots(preparedData, moduleWidth);
  }
  if (type === 'jan13' || type === 'ean13' || type === 'upc_a') return 95 * moduleWidth;
  if (type === 'jan8' || type === 'ean8') return 67 * moduleWidth;
  if (type === 'itf') return (Math.ceil(preparedData.length / 2) * 18 + 20) * moduleWidth;
  return preparedData.length * 12 * moduleWidth;
}

function estimateCode128WidthDots(preparedData, moduleWidth) {
  const codeSet = Buffer.isBuffer(preparedData)
    ? preparedData.subarray(0, 2).toString('ascii')
    : preparedData.slice(0, 2);
  const bodyLength = Math.max(0, preparedData.length - 2);
  // Binary Code Set C data is already one codeword per digit pair. Keep the
  // string calculation for legacy/GS1 values that are still represented as text.
  const dataCodeCount = codeSet === '{C' && !Buffer.isBuffer(preparedData)
    ? Math.ceil(bodyLength / 2)
    : bodyLength;
  const startCheckStopModules = 11 + 11 + 13;
  return (dataCodeCount * 11 + startCheckStopModules) * moduleWidth;
}

function prepareOneDimensionalData(type, data) {
  if (type === 'gs1_128') {
    return prepareGs1Data(data);
  }
  if (type === 'code128c') {
    return encodeCode128C(data);
  }
  if (type === 'code128' && !data.startsWith('{')) {
    if (/^\d+$/.test(data) && data.length % 2 === 0) {
      return encodeCode128C(data);
    }
    return `{B${data}`;
  }
  return data;
}

// Epson's GS k CODE128 command expects Code Set C data as binary codewords:
// "123456" must be sent as {C, 0x0c, 0x22, 0x38 (12, 34, 56), not ASCII digits.
function encodeCode128C(data) {
  const pairs = String(data).match(/\d{2}/g) ?? [];
  return Buffer.concat([
    Buffer.from('{C', 'ascii'),
    Buffer.from(pairs.map((pair) => Number.parseInt(pair, 10)))
  ]);
}

function validateCode128CInput(data) {
  if (!/^\d+$/.test(data)) {
    throw new Error('CODE128 Code Set C は数字のみ指定できます。');
  }
  if (data.length % 2 !== 0) {
    throw new Error('CODE128 Code Set C は数字を2桁単位で符号化するため、桁数は偶数にしてください。');
  }
}

function prepareGs1Data(data) {
  if (data.startsWith('{')) return data;
  const compact = data.replace(/[()\s]/g, '');
  return `{C${compact}`;
}

function isAscii(value) {
  return /^[\x00-\x7f]+$/.test(value);
}

function typeLabel(type) {
  return SYMBOL_TYPES.find(([value]) => value === type)?.[1] ?? type;
}
