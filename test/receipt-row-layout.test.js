import test from 'node:test';
import assert from 'node:assert/strict';
import { displayColumns, formatReceiptRow } from '../src/discordContent.js';

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
