import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPreviewTextRuns } from '../src/discordContent.js';

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
