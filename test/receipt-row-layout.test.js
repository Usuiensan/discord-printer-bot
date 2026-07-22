import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { buildPreviewText, buildPrintJob, displayColumns, formatReceiptRow } from '../src/discordContent.js';

test('receipt row layout does not wrap half-width katakana as full-width text', () => {
  const rows = formatReceiptRow('ｴﾝﾁｬﾝｱﾘｶﾞﾄｳ水', '¥926※', 32);

  assert.equal(rows.length, 1);
  assert.equal(displayColumns('ｴﾝﾁｬﾝｱﾘｶﾞﾄｳ水'), 13);
  assert.equal(displayColumns(rows[0]), 32);
  assert.match(rows[0], /^ｴﾝﾁｬﾝｱﾘｶﾞﾄｳ水\s+¥926※$/);
});

test('receipt row layout counts half-width voiced marks as their own half-width columns', () => {
  const rows = formatReceiptRow('ｶﾞﾊﾟ'.repeat(6), '¥100', 32);

  assert.equal(displayColumns('ｶﾞﾊﾟ'.repeat(6)), 24);
  assert.equal(rows.length, 1);
  assert.equal(displayColumns(rows[0]), 32);
});

test('yen receipt rows stay printer-native and remain visible in text preview', async () => {
  const content = [
    '!row ｲﾁｴﾝﾁｬﾝ|¥1',
    '!row ﾆｴﾝﾁｬﾝ|¥2',
    '!row ｻﾝｴﾝﾁｬﾝ|¥3',
    '!row ﾋｬｸｴﾝﾁｬﾝ|¥100',
    '!row ｾﾝｴﾝﾁｬﾝ|¥1000',
    '!rule -',
    '!bold on',
    '!row 合計|1106ｴﾝﾁｬﾝ'
  ].join('\n');
  const message = {
    content,
    attachments: [],
    stickers: [],
    messageSnapshots: [],
    embeds: []
  };
  const config = {
    printWidthDots: 384,
    printHeader: false,
    printAuthorAvatar: false,
    messageCommandPrefix: '!',
    cutMode: 'none',
    cutFeedLines: 3,
    printUrlQr: false,
    textRenderMode: 'auto',
    emojiRenderMode: 'text'
  };

  const preview = await buildPreviewText(message, config);
  assert.match(preview, /ｲﾁｴﾝﾁｬﾝ\s+¥1/);
  assert.match(preview, /合計\s+1106ｴﾝﾁｬﾝ/);

  const { bytes, warnings } = await buildPrintJob(message, config, { printHeader: false });
  assert.deepEqual(warnings, []);
  assert.equal(bytes.includes(iconv.encode('ｲﾁｴﾝﾁｬﾝ', 'cp932')), true);
  assert.equal(bytes.includes(iconv.encode('1106ｴﾝﾁｬﾝ', 'cp932')), true);
  assert.ok(bytes.length < 1000, `expected native text, got ${bytes.length} bytes`);
});
