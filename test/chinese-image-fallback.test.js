import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { EscPosBuilder } from '../src/escpos.js';
import { buildPrintJob } from '../src/discordContent.js';
import { appendReceiptLine } from '../src/receiptLineContent.js';

const RASTER_COMMAND = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
const QR_COMMAND = Buffer.from([0x1d, 0x28, 0x6b]);

test('ReceiptLine rasterizes unsupported Chinese and pinyin while retaining native QR output', async () => {
  const printer = new EscPosBuilder({ widthDots: 384 });
  const warnings = [];

  await appendReceiptLine(printer, '简体中文：这个 yǒu\n{code:https://example.com; option:qrcode,4,m}', {
    printWidthDots: 384,
    textRenderMode: 'auto',
    textImageFontPath: '',
    textImageFontFamily: 'sans-serif',
    imageDitherMode: 'threshold',
    qrModuleSize: 4,
    qrErrorCorrection: 'M',
    cutMode: 'none'
  }, warnings);

  const bytes = printer.build();
  assert.notEqual(bytes.indexOf(RASTER_COMMAND), -1);
  assert.notEqual(bytes.indexOf(QR_COMMAND), -1);
  assert.ok(warnings.some((warning) => warning.includes('画像として印刷しました')));
  assert.ok(warnings.every((warning) => !warning.includes('に置換しました')));
});

test('one unsupported character switches all message text to one attached binary image', async () => {
  const message = {
    content: 'ASCII only\n有香料：yǒu xiāng',
    author: { id: '1', username: 'test', globalName: 'test' },
    member: null,
    createdAt: new Date('2026-07-17T00:00:00Z'),
    attachments: new Map(),
    stickers: new Map(),
    messageSnapshots: new Map()
  };
  const config = {
    printWidthDots: 384,
    printHeader: false,
    printAuthorAvatar: false,
    messageCommandPrefix: '!',
    textRenderMode: 'auto',
    textImageFontPath: '',
    textImageFontFamily: 'monospace',
    textImageFontSizeDots: 28,
    textImageLineHeightDots: 30,
    textImageDitherMode: 'threshold',
    textImageThreshold: 170,
    imageDitherMode: 'ordered',
    cutMode: 'none',
    printUrlQr: false,
    emojiRenderMode: 'text',
    imageMaxBytes: 1024,
    textAttachmentMaxBytes: 1024
  };

  const job = await buildPrintJob(message, config, { printHeader: false });
  const rasterCommand = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
  assert.equal(countBufferOccurrences(job.bytes, rasterCommand), 1);
  assert.equal(job.bytes.includes(Buffer.from('ASCII only', 'ascii')), false);
  assert.deepEqual(job.warnings, ['"ǒ"この文字ほか1文字は出せないため画像印字モードで印刷しました']);
  assert.equal(job.printImages.length, 1);

  const pixels = await sharp(job.printImages[0]).grayscale().raw().toBuffer();
  assert.ok([...new Set(pixels)].every((value) => value === 0 || value === 255));
});

function countBufferOccurrences(buffer, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = buffer.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}
