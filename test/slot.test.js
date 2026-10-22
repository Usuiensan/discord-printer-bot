import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_STAMPS,
  SLOT_SYMBOLS,
  acknowledgeSlotInteraction,
  buildSlotMessage,
  drawSlot,
  isWinningSlot
} from '../src/slot.js';

test('slot draw uses the configured symbols and recognizes the エンサンチャン sequence', () => {
  const result = drawSlot(() => 0);
  assert.deepEqual(result, [SLOT_SYMBOLS[0], SLOT_SYMBOLS[0], SLOT_SYMBOLS[0]]);
  assert.equal(isWinningSlot(['ｴﾝ', 'ｻﾝ', 'ﾁｬﾝ']), true);
  assert.equal(isWinningSlot([SLOT_STAMPS[0], SLOT_STAMPS[0], SLOT_STAMPS[0]]), true);
  assert.equal(isWinningSlot([SLOT_STAMPS[1], SLOT_STAMPS[1], SLOT_STAMPS[1]]), true);
  assert.equal(isWinningSlot([SLOT_STAMPS[0], SLOT_STAMPS[1], SLOT_STAMPS[0]]), false);
  assert.equal(isWinningSlot(['ｴﾝ', 'ｴﾝ', 'ﾁｬﾝ']), false);
  assert.equal(isWinningSlot(['ﾍｹ', 'ﾍｹ', 'ﾍｹ']), false);
});

test('slot message treats text and repeated stamp patterns as winning results', () => {
  const losing = buildSlotMessage(['ﾍｹ', 'ﾍｹ', 'ﾁｬﾝ']);
  const winning = buildSlotMessage(['ｴﾝ', 'ｻﾝ', 'ﾁｬﾝ']);
  const stampWinning = buildSlotMessage([SLOT_STAMPS[0], SLOT_STAMPS[0], SLOT_STAMPS[0]]);

  assert.match(losing.reply, /ﾁﾝｯ ﾍｹ/);
  assert.match(losing.reply, /またあした$/);
  assert.match(winning.reply, /ﾁﾝｯ ｴﾝ/);
  assert.match(winning.reply, /おめでとう！$/);
  assert.equal(losing.winning, false);
  assert.equal(winning.winning, true);
  assert.doesNotMatch(winning.print, /!drawer/);
  assert.match(stampWinning.reply, new RegExp(`ﾁﾝｯ ${SLOT_STAMPS[0]}\\nﾁﾝｯ ${SLOT_STAMPS[0]}\\nﾁﾝｯ ${SLOT_STAMPS[0]}\\n\\nおめでとう！$`));
  assert.equal(stampWinning.winning, true);
  assert.doesNotMatch(stampWinning.print, /!drawer/);
});

test('slot interaction acknowledges before editing the public result', async () => {
  const calls = [];
  const interaction = {
    async deferReply() {
      calls.push('defer');
    },
    async editReply(payload) {
      calls.push(['edit', payload.content]);
    }
  };
  const result = buildSlotMessage(['ﾍｹ', 'ﾍｹ', 'ﾁｬﾝ']);

  await acknowledgeSlotInteraction(interaction, result, (_interaction, _content, winning) => calls.push(['print', winning]));

  assert.equal(calls[0], 'defer');
  assert.equal(calls[1][0], 'edit');
  assert.deepEqual(calls[2], ['print', false]);
});
