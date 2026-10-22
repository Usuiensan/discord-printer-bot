import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SLOT_EMOJI_LINE,
  SLOT_SYMBOLS,
  buildSlotMessage,
  drawSlot,
  isWinningSlot
} from '../src/slot.js';

test('slot draw uses the configured symbols and recognizes the エンサンチャン sequence', () => {
  const result = drawSlot(() => 0);
  assert.deepEqual(result, [SLOT_SYMBOLS[0], SLOT_SYMBOLS[0], SLOT_SYMBOLS[0]]);
  assert.equal(isWinningSlot(['ｴﾝ', 'ｻﾝ', 'ﾁｬﾝ']), true);
  assert.equal(isWinningSlot(['ｴﾝ', 'ｴﾝ', 'ﾁｬﾝ']), false);
});

test('slot message changes only the final line for a winning result', () => {
  const losing = buildSlotMessage(['ﾍｹ', 'ﾍｹ', 'ﾁｬﾝ']);
  const winning = buildSlotMessage(['ｴﾝ', 'ｻﾝ', 'ﾁｬﾝ']);

  assert.match(losing.reply, new RegExp(SLOT_EMOJI_LINE));
  assert.match(losing.reply, /ﾁﾝｯ ﾍｹ/);
  assert.match(losing.reply, /またあした$/);
  assert.match(winning.reply, /ﾁﾝｯ ｴﾝ/);
  assert.match(winning.reply, /おめでとう！$/);
  assert.match(winning.print, /^<a:enchant_ensan:1562641619960725565> <:ensan:1562641655079632916>\n!center/m);
});
