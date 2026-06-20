import { EscPosBuilder } from './escpos.js';
import bwipjs from 'bwip-js';

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
const ROTATED_BARCODE_MAX_LENGTH_DOTS = 2048;

export async function buildSymbolPrintJob(commands, config, options = {}) {
  const items = Array.isArray(commands) ? commands : [commands];
  const printer = new EscPosBuilder({ widthDots: config.printWidthDots });
  const warnings = [];

  if (options.requestedBy) printer.line(options.requestedBy);
  await appendSymbolItems(printer, items, config);

  printer.cut(config.cutMode);

  return {
    bytes: printer.build(),
    warnings
  };
}

export async function appendSymbolItems(printer, commands, config) {
  const items = Array.isArray(commands) ? commands : [commands];
  if (items.length === 0) return;

  for (const [index, item] of items.entries()) {
    try {
      await printSymbolItem(printer, item, config, index, items.length);
    } catch (error) {
      throw new Error(`#${index + 1} ${item.type} ${item.data}: ${error.message}`);
    }
  }
}

async function printSymbolItem(printer, { type, data, compositeData, lineType, rotation = 0, printText = true }, config, index, total) {
  const rotated = Number(rotation) === 90;
  validateSymbolInput(type, data, compositeData, config, { rotated });

  if (index > 0) printer.feed(1);

  if (ONE_D_TYPES.has(type)) {
    const preparedData = prepareOneDimensionalData(type, data);
    const barcodeConfig = rotated
      ? { ...config, printWidthDots: ROTATED_BARCODE_MAX_LENGTH_DOTS }
      : config;
    const barcodeOptions = barcodeOptionsFor(type, data, barcodeConfig);
    if (!printText) barcodeOptions.hri = 'none';
    if (rotated) {
      await printRotatedBarcodeImage(printer, type, data, printText, config);
    } else {
      printer.barcode(type, preparedData, barcodeOptions);
    }
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

async function printRotatedBarcodeImage(printer, type, data, printText, config) {
  const bcid = bwipBarcodeType(type);
  const text = bwipBarcodeText(type, data);
  const svg = bwipjs.toSVG({
    bcid,
    text,
    scale: 2,
    height: 14,
    includetext: printText,
    textxalign: 'center',
    rotate: 'R',
    backgroundcolor: 'FFFFFF'
  });
  await printer.image(Buffer.from(svg), {
    maxWidth: config.printWidthDots ?? printer.widthDots,
    dither: 'threshold'
  });
}

function bwipBarcodeType(type) {
  const map = {
    upc_a: 'upca',
    upc_e: 'upce',
    jan13: 'ean13',
    jan8: 'ean8',
    code39: 'code39',
    itf: 'interleaved2of5',
    codabar: 'rationalizedCodabar',
    nw7: 'rationalizedCodabar',
    code93: 'code93',
    code128: 'code128',
    code128c: 'code128',
    gs1_128: 'gs1-128',
    gs1_databar_omni: 'databaromni',
    gs1_databar_truncated: 'databartruncated',
    gs1_databar_limited: 'databarlimited',
    gs1_databar_expanded: 'databarexpanded'
  };
  const bcid = map[type];
  if (!bcid) throw new Error(`${typeLabel(type)} の90度画像生成には対応していません。`);
  return bcid;
}

function bwipBarcodeText(type, data) {
  if (type === 'code128c') return String(data);
  if (type === 'code128' && String(data).startsWith('{')) {
    throw new Error('90度CODE128では明示的な {A/{B/{C/FNC 制御は未対応です。通常向きで使用してください。');
  }
  return String(data);
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

function symbolPlaceholder({ type, rotation = 0 }) {
  if (type === 'qr') return '[QRコード]';
  if (type === 'pdf417') return '[PDF417]';
  if (type === 'maxicode') return '[MaxiCode]';
  if (type === 'composite') return '[Composite Symbology]';
  return Number(rotation) === 90 ? '[バーコード 90度回転]' : '[バーコード]';
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
  const match = body.match(/^(print-code-90-notext|print-code-notext-90|barcode-90-notext|barcode-notext-90|print-code-90|print-code90|barcode-90|barcode90|code-90|code90|print-code-notext|code-notext|barcode-notext|qr-notext|print-code|code|コード|barcode|qr)\b\s*([\s\S]*)$/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  const printText = !command.includes('notext');
  const rotation = /(?:^|-)90(?:-|$)|90$/.test(command) ? 90 : 0;
  const rest = match[2].trim();
  if (command === 'qr' || command === 'qr-notext') {
    if (!rest) throw new Error(`使い方: ${prefix}qr https://example.com`);
    return {
      type: 'qr',
      data: rest,
      compositeData: '',
      lineType: '',
      printText,
      rotation
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
    printText,
    rotation
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

function validateSymbolInput(type, data, compositeData, config = {}, options = {}) {
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
  if (options.rotated && !ONE_D_TYPES.has(type)) {
    throw new Error('90度回転印刷は一次元バーコードだけに対応しています。');
  }
  validateOneDimensionalWidth(
    type,
    data,
    options.rotated ? ROTATED_BARCODE_MAX_LENGTH_DOTS : (config.printWidthDots ?? 384)
  );
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
  const encoded = Buffer.isBuffer(preparedData) ? preparedData : Buffer.from(preparedData, 'ascii');
  const dataCodeCount = countCode128DataWords(encoded);
  const startCheckStopModules = 11 + 11 + 13;
  return (dataCodeCount * 11 + startCheckStopModules) * moduleWidth;
}

function countCode128DataWords(encoded) {
  let count = 0;
  for (let index = 2; index < encoded.length; index += 1) {
    if (encoded[index] === 0x7b && index + 1 < encoded.length) index += 1;
    count += 1;
  }
  return count;
}

function prepareOneDimensionalData(type, data) {
  if (type === 'gs1_128') {
    return prepareGs1Data(data);
  }
  if (type === 'code128c') {
    return encodeCode128C(data);
  }
  if (type === 'code128') {
    if (data.startsWith('{')) return encodeCode128ControlData(data);
    if (/^\d+$/.test(data) && data.length % 2 === 0) {
      return encodeCode128C(data);
    }
    return encodeCode128ControlData(`{B${escapeCode128Braces(data)}`);
  }
  return data;
}

// Epson's GS k CODE128 command expects Code Set C data as binary codewords:
// "123456" must be sent as {C, 0x0c, 0x22, 0x38 (12, 34, 56), not ASCII digits.
function encodeCode128C(data) {
  return encodeCode128ControlData(`{C${data}`);
}

// Converts Epson CODE128 control notation to the byte stream required by GS k.
// In Code Set C each pair of decimal digits is one binary value from 0 to 99.
function encodeCode128ControlData(value) {
  const input = String(value);
  if (!/^\{[ABC]/.test(input)) {
    throw new Error('CODE128制御形式は {A、{B、{C のいずれかで開始してください。');
  }

  const output = [];
  let codeSet = null;
  let index = 0;
  while (index < input.length) {
    if (input[index] === '{') {
      const token = input[index + 1];
      if (!token || !'ABCS1234{'.includes(token)) {
        throw new Error(`未対応のCODE128制御トークンです: ${input.slice(index, index + 2)}`);
      }
      output.push(0x7b, token.charCodeAt(0));
      if ('ABC'.includes(token)) codeSet = token;
      index += 2;
      continue;
    }

    if (codeSet === 'C') {
      const pair = input.slice(index, index + 2);
      if (!/^\d{2}$/.test(pair)) {
        throw new Error(`Code Set C のデータは2桁の数字単位で指定してください（位置${index + 1}: ${JSON.stringify(pair)}）。`);
      }
      output.push(Number.parseInt(pair, 10));
      index += 2;
      continue;
    }

    const code = input.charCodeAt(index);
    if (code > 0x7f) throw new Error('CODE128のデータはASCII文字で指定してください。');
    output.push(code);
    index += 1;
  }
  return Buffer.from(output);
}

function escapeCode128Braces(value) {
  return String(value).replace(/\{/g, '{{');
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
  if (data.startsWith('{')) return encodeCode128ControlData(data);
  const elements = parseGs1ApplicationIdentifiers(data);
  let controlData = '';

  for (const [index, element] of elements.entries()) {
    const chunk = `${element.ai}${element.value}`;
    const targetSet = /^\d+$/.test(chunk) && chunk.length % 2 === 0 ? 'C' : 'B';
    controlData += `{${targetSet}${escapeCode128Braces(chunk)}`;
    if (!element.fixedLength && index < elements.length - 1) controlData += '{1';
  }
  return encodeCode128ControlData(controlData);
}

function parseGs1ApplicationIdentifiers(value) {
  const input = String(value).trim();
  const matches = [...input.matchAll(/\((\d{2,4})\)/g)];
  if (matches.length === 0 || matches[0].index !== 0) {
    throw new Error('GS1-128は (01)04901234567890(10)LOT123 のようにAIを括弧で指定してください。');
  }

  return matches.map((match, index) => {
    const ai = match[1];
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? input.length;
    const fieldValue = input.slice(start, end);
    const rule = gs1AiRule(ai);
    if (!fieldValue) throw new Error(`GS1 AI (${ai}) のデータがありません。`);
    if (rule.fixedLength && fieldValue.length !== rule.length) {
      throw new Error(`GS1 AI (${ai}) は${rule.length}文字で指定してください（現在${fieldValue.length}文字）。`);
    }
    if (!rule.fixedLength && fieldValue.length > rule.length) {
      throw new Error(`GS1 AI (${ai}) は最大${rule.length}文字です（現在${fieldValue.length}文字）。`);
    }
    return { ai, value: fieldValue, fixedLength: rule.fixedLength };
  });
}

// Length rules cover the common GS1 identification, date, measurement,
// logistics and internal-company AIs. Unknown AIs are rejected because a wrong
// fixed/variable decision would place FNC1 incorrectly and change the payload.
function gs1AiRule(ai) {
  const fixed = new Map([
    ['00', 18], ['01', 14], ['02', 14], ['11', 6], ['12', 6], ['13', 6],
    ['15', 6], ['16', 6], ['17', 6], ['20', 2], ['402', 17],
    ['410', 13], ['411', 13], ['412', 13], ['413', 13], ['414', 13],
    ['415', 13], ['416', 13], ['417', 13], ['422', 3], ['424', 3],
    ['425', 3], ['426', 3], ['7001', 13], ['7003', 10], ['7006', 6],
    ['8001', 14], ['8005', 6], ['8006', 18], ['8017', 18], ['8018', 18],
    ['8100', 6], ['8101', 10], ['8102', 2], ['8111', 4]
  ]);
  if (fixed.has(ai)) return { fixedLength: true, length: fixed.get(ai) };
  if (/^(3[1-6]\d\d)$/.test(ai)) return { fixedLength: true, length: 6 };
  if (/^39[45]\d$/.test(ai)) return { fixedLength: true, length: ai.startsWith('394') ? 4 : 6 };

  const variable = new Map([
    ['10', 20], ['21', 20], ['22', 29], ['30', 8], ['37', 8],
    ['240', 30], ['241', 30], ['242', 6], ['243', 20], ['250', 30],
    ['251', 30], ['253', 30], ['254', 20], ['255', 25], ['400', 30],
    ['401', 30], ['403', 30], ['420', 20], ['421', 15], ['423', 15],
    ['427', 3], ['7002', 30], ['7004', 4], ['7005', 12], ['7007', 12],
    ['7008', 3], ['7009', 10], ['7010', 2], ['8002', 20], ['8003', 30],
    ['8004', 30], ['8007', 34], ['8008', 12], ['8010', 30], ['8011', 12],
    ['8012', 20], ['8013', 30], ['8019', 10], ['8020', 25],
    ['8110', 70], ['8112', 70], ['8200', 70]
  ]);
  if (variable.has(ai)) return { fixedLength: false, length: variable.get(ai) };
  if (/^39[0-3]\d$/.test(ai)) return { fixedLength: false, length: ai.startsWith('391') || ai.startsWith('393') ? 18 : 15 };
  if (/^7[0-9]{3}$/.test(ai) || /^90$|^9[1-9]$/.test(ai)) return { fixedLength: false, length: 30 };
  throw new Error(`GS1 AI (${ai}) の長さ規則が未登録です。明示制御形式を使用してください。`);
}

function isAscii(value) {
  return /^[\x00-\x7f]+$/.test(value);
}

function typeLabel(type) {
  return SYMBOL_TYPES.find(([value]) => value === type)?.[1] ?? type;
}
