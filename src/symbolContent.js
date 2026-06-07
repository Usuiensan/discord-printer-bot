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
  'gs1_128',
  'gs1_databar_omni',
  'gs1_databar_truncated',
  'gs1_databar_limited',
  'gs1_databar_expanded'
]);

export function buildSymbolPrintJob({ type, data, compositeData, lineType, requestedBy }, config) {
  validateSymbolInput(type, data, compositeData);

  const printer = new EscPosBuilder({ widthDots: config.printWidthDots });
  printer.bold(true).line('[CODE PRINT]').bold(false);
  if (requestedBy) printer.line(requestedBy);
  printer.line(typeLabel(type));
  printer.line(data);
  printer.feed(1);

  if (ONE_D_TYPES.has(type)) {
    printer.barcode(type, prepareOneDimensionalData(type, data));
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

  printer.cut(config.cutMode);

  return printer.build();
}

export function parseSymbolMessageCommand(content, prefix = '!') {
  const trimmed = content.trim();
  if (!trimmed.startsWith(prefix)) return null;

  const body = trimmed.slice(prefix.length).trim();
  const match = body.match(/^(print-code|code|コード|barcode|qr)\b\s*([\s\S]*)$/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const rest = match[2].trim();
  if (command === 'qr') {
    if (!rest) throw new Error(`使い方: ${prefix}qr https://example.com`);
    return {
      type: 'qr',
      data: rest,
      compositeData: '',
      lineType: ''
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
    lineType: ''
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
    itf: 'itf',
    codabar: 'codabar',
    nw7: 'codabar',
    upca: 'upc_a',
    upc_a: 'upc_a',
    upce: 'upc_e',
    upc_e: 'upc_e',
    pdf417: 'pdf417',
    maxicode: 'maxicode',
    gs1_128: 'gs1_128'
  };

  return aliases[token] ?? token;
}

function validateSymbolInput(type, data, compositeData) {
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
}

function prepareOneDimensionalData(type, data) {
  if (type === 'code128' && !data.startsWith('{')) {
    return `{B${data}`;
  }
  return data;
}

function isAscii(value) {
  return /^[\x00-\x7f]+$/.test(value);
}

function typeLabel(type) {
  return SYMBOL_TYPES.find(([value]) => value === type)?.[1] ?? type;
}
