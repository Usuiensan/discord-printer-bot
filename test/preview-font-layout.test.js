import test from 'node:test';
import assert from 'node:assert/strict';
import { displayColumns, layoutPreviewTextRuns } from '../src/discordContent.js';

test('preview layout advances half-width, full-width, and symbols by printer columns', () => {
  const runs = layoutPreviewTextRuns({
    text: 'Aあ1！?',
    align: 'left',
    small: false,
    sizeX: 1,
    sizeY: 1
  }, {
    width: 384,
    padding: 0,
    y: 24
  });

  assert.deepEqual(runs.map((run) => run.text), ['A', 'あ', '1', '！', '?']);
  assert.deepEqual(runs.map((run) => run.x), [0, 12, 36, 48, 72]);
  assert.deepEqual(runs.map((run) => run.width), [12, 24, 12, 24, 12]);
  assert.equal(runs.at(-1).x + runs.at(-1).width, 84);
});

test('preview layout centers mixed Japanese text using calculated pixel width', () => {
  const runs = layoutPreviewTextRuns({
    text: '合計 A-1',
    align: 'center',
    small: false,
    sizeX: 1,
    sizeY: 1
  }, {
    width: 384,
    padding: 0,
    y: 24
  });

  const totalWidth = runs.reduce((sum, run) => sum + run.width, 0);
  assert.equal(totalWidth, 96);
  assert.equal(runs[0].x, 144);
});

test('preview layout uses Font B 42-column half-width advances for small text', () => {
  const runs = layoutPreviewTextRuns({
    text: 'ABCあ',
    align: 'left',
    small: true,
    sizeX: 1,
    sizeY: 1
  }, {
    width: 384,
    padding: 0,
    y: 24
  });

  const half = 384 / 42;
  assert.deepEqual(runs.map((run) => run.x), [0, half, half * 2, half * 3]);
  assert.deepEqual(runs.map((run) => run.width), [half, half, half, half * 2]);
});

test('preview layout can place receipt row left and right segments without space padding overflow', () => {
  const runs = layoutPreviewTextRuns({
    text: '',
    align: 'left',
    small: false,
    sizeX: 1,
    sizeY: 1,
    segments: [
      { text: '合計', align: 'left' },
      { text: '¥2,150', align: 'right', bold: true }
    ]
  }, {
    width: 384,
    padding: 0,
    y: 24
  });

  const rightRuns = runs.slice(2);
  assert.equal(rightRuns[0].x, 312);
  assert.equal(rightRuns.at(-1).x + rightRuns.at(-1).width, 384);
  assert.ok(rightRuns.every((run) => run.bold));
});

test('half-width katakana and half-width voiced marks occupy one half-width column each', () => {
  assert.equal(displayColumns('ABC'), 3);
  assert.equal(displayColumns('ｳｽｲｴﾝｻﾝ'), 7);
  assert.equal(displayColumns('ｶﾞﾊﾟ'), 4);
  assert.equal(displayColumns('ガパ'), 4);

  const runs = layoutPreviewTextRuns({
    text: 'ｶﾞﾊﾟA',
    align: 'left',
    small: false,
    sizeX: 1,
    sizeY: 1
  }, {
    width: 384,
    padding: 0,
    y: 24
  });

  assert.deepEqual(runs.map((run) => run.text), ['ｶ', 'ﾞ', 'ﾊ', 'ﾟ', 'A']);
  assert.deepEqual(runs.map((run) => run.x), [0, 12, 24, 36, 48]);
  assert.deepEqual(runs.map((run) => run.width), [12, 12, 12, 12, 12]);
});
