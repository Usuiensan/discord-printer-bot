import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { buildPreviewText, buildPrintJob, parsePrintTemplateOptions } from '../src/discordContent.js';

const config = {
  printWidthDots: 384,
  printHeader: true,
  printAuthorAvatar: false,
  messageCommandPrefix: '!',
  cutMode: 'none',
  cutFeedLines: 3,
  printUrlQr: false,
  textRenderMode: 'auto',
  emojiRenderMode: 'text',
  barcodeHri: 'below'
};

const message = (content) => ({
  content,
  attachments: [],
  stickers: [],
  messageSnapshots: [],
  embeds: []
});

test('template directives suppress the header, set copy count, and are not printed', async () => {
  const content = '!noheader\n!copies 3\n領収書\n番号 {{increment:0001}}';
  assert.deepEqual(parsePrintTemplateOptions(content), {
    content: '領収書\n番号 {{increment:0001}}',
    copies: 3,
    omitHeader: true
  });

  const first = await buildPrintJob(message(content), config, { copyIndex: 0 });
  const third = await buildPrintJob(message(content), config, { copyIndex: 2 });
  assert.equal(first.bytes.includes(iconv.encode('番号 0001', 'cp932')), true);
  assert.equal(third.bytes.includes(iconv.encode('番号 0003', 'cp932')), true);
  assert.equal(first.bytes.includes(iconv.encode('!copies', 'cp932')), false);
});

test('noheader suppresses the avatar fallback as well as the author header', async () => {
  const job = await buildPrintJob(
    message('!noheader\n本文'),
    { ...config, printAuthorAvatar: true },
    { printHeader: false }
  );

  assert.deepEqual(job.warnings, []);
});

test('the same increment token is substituted consistently in text, barcodes, and previews', async () => {
  const content = [
    '!noheader',
    '!copies 2',
    '!row レシート番号|26-1129-{{increment:0001}}',
    '!barcode-notext ITF 261129{{increment:0001}}'
  ].join('\n');
  const second = await buildPrintJob(message(content), config, { copyIndex: 1 });
  const preview = await buildPreviewText(message(`!preview\n${content}`), config);

  assert.equal(second.bytes.includes(iconv.encode('26-1129-0002', 'cp932')), true);
  assert.match(preview, /26-1129-0001/);
});

test('template copies and increment tokens reject unsafe ranges', () => {
  assert.throws(
    () => parsePrintTemplateOptions('!copies 101\n本文'),
    /1～100枚/
  );
  assert.throws(
    () => parsePrintTemplateOptions('!copies 2\n{{increment:9999}}'),
    /桁あふれ/
  );
});
