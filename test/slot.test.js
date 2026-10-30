import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import {
  SLOT_STAMPS,
  SLOT_SYMBOLS,
  acknowledgeSlotInteraction,
  buildSlotMessage,
  drawSlot,
  isWinningSlot
} from '../src/slot.js';

test('slot draw uses the configured symbols and recognizes winning patterns', () => {
  const result = drawSlot(() => 0);
  assert.deepEqual(result, [SLOT_SYMBOLS[0], SLOT_SYMBOLS[0], SLOT_SYMBOLS[0]]);
  assert.equal(isWinningSlot(['ｴﾝ', 'ｻﾝ', 'ﾁｬﾝ']), true);
  assert.equal(isWinningSlot([SLOT_STAMPS[0], SLOT_STAMPS[0], SLOT_STAMPS[0]]), true);
  assert.equal(isWinningSlot([SLOT_STAMPS[1], SLOT_STAMPS[1], SLOT_STAMPS[1]]), true);
  assert.equal(isWinningSlot([SLOT_STAMPS[0], SLOT_STAMPS[1], SLOT_STAMPS[0]]), false);
  assert.equal(isWinningSlot(['ｴﾝ', 'ｴﾝ', 'ﾁｬﾝ']), false);
  assert.equal(isWinningSlot(['ﾍｹ', 'ﾍｹ', 'ﾍｹ']), true);
});

test('slot message treats sequence, repeated text, and repeated stamp patterns as winning results', () => {
  const losing = buildSlotMessage(['ﾍｹ', 'ﾍｹ', 'ﾁｬﾝ']);
  const winning = buildSlotMessage(['ｴﾝ', 'ｻﾝ', 'ﾁｬﾝ']);
  const textWinning = buildSlotMessage(['ﾍｹ', 'ﾍｹ', 'ﾍｹ']);
  const stampWinning = buildSlotMessage([SLOT_STAMPS[0], SLOT_STAMPS[0], SLOT_STAMPS[0]]);

  assert.match(losing.reply, /ﾁﾝｯ ﾍｹ/);
  assert.match(losing.reply, /またあした$/);
  assert.match(winning.reply, /ﾁﾝｯ ｴﾝ/);
  assert.match(winning.reply, /おめでとう！$/);
  assert.equal(losing.winning, false);
  assert.equal(winning.winning, true);
  assert.doesNotMatch(winning.print, /!drawer/);
  assert.match(textWinning.reply, /おめでとう！$/);
  assert.equal(textWinning.winning, true);
  assert.match(stampWinning.reply, new RegExp(`ﾁﾝｯ ${SLOT_STAMPS[0]}\\nﾁﾝｯ ${SLOT_STAMPS[0]}\\nﾁﾝｯ ${SLOT_STAMPS[0]}\\n\\nおめでとう！$`));
  assert.equal(stampWinning.winning, true);
  assert.doesNotMatch(stampWinning.print, /!drawer/);
});

test('slot interaction replies once with a silent public result', async () => {
  const calls = [];
  const interaction = {
    async deferReply() {
      calls.push('defer');
    },
    async reply(payload) {
      calls.push(['reply', payload.content, payload.flags]);
    },
    async editReply(payload) {
      calls.push(['edit', payload.content, payload.flags]);
    }
  };
  const result = buildSlotMessage(['ﾍｹ', 'ﾍｹ', 'ﾁｬﾝ']);

  await acknowledgeSlotInteraction(interaction, result, (_interaction, _content, winning) => calls.push(['print', winning]));

  // Deferred replies ignore SuppressNotifications, so the result must be a
  // single direct reply carrying the flag (no defer, no edit).
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'reply');
  assert.equal(calls[0][1], result.reply);
  assert.equal(calls[0][2], MessageFlags.SuppressNotifications);
});

test('winning slot enqueues a print job', async () => {
  const calls = [];
  const interaction = {
    async reply() {}
  };

  await acknowledgeSlotInteraction(
    interaction,
    buildSlotMessage(['ｴﾝ', 'ｻﾝ', 'ﾁｬﾝ']),
    (_interaction, _content, winning) => calls.push(winning)
  );

  assert.deepEqual(calls, [true]);
});
