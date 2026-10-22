import { MessageFlags } from 'discord.js';

export const SLOT_EMOJI_LINE = '<a:enchant_ensan:1562641619960725565> <:ensan:1562641655079632916>';
export const SLOT_SYMBOLS = Object.freeze(['ｳｽｲ', 'ｴﾝ', 'ｻﾝ', 'ﾘｭｳ', 'ﾁｬﾝ', 'ﾄ', 'ﾍｹ']);
const WINNING_SLOT = Object.freeze(['ｴﾝ', 'ｻﾝ', 'ﾁｬﾝ']);

export function drawSlot(random = Math.random) {
  return Array.from({ length: 3 }, () => {
    const index = Math.min(SLOT_SYMBOLS.length - 1, Math.floor(random() * SLOT_SYMBOLS.length));
    return SLOT_SYMBOLS[Math.max(0, index)];
  });
}

export function isWinningSlot(result) {
  return WINNING_SLOT.every((symbol, index) => result[index] === symbol);
}

export function buildSlotMessage(result) {
  if (!Array.isArray(result) || result.length !== 3 || result.some((symbol) => !SLOT_SYMBOLS.includes(symbol))) {
    throw new Error('スロット結果が不正です');
  }

  const lines = [
    SLOT_EMOJI_LINE,
    'エンサンチャンスロット',
    'ｴﾝｻﾝﾁｬﾝがそろうチャンスです',
    '今日はそろうかな？',
    '',
    'スタート！',
    '',
    'ｸﾞﾙｸﾞﾙｸﾞﾙｸﾞﾙｸﾞﾙ',
    '・',
    '・',
    '・',
    '',
    `ﾁﾝｯ ${result[0]}`,
    `ﾁﾝｯ ${result[1]}`,
    `ﾁﾝｯ ${result[2]}`,
    '',
    isWinningSlot(result) ? 'おめでとう！' : 'またあした'
  ];
  const reply = lines.join('\n');
  return {
    reply,
    print: [SLOT_EMOJI_LINE, '!center', ...lines.slice(1)].join('\n')
  };
}

export async function acknowledgeSlotInteraction(interaction, result, enqueuePrint) {
  await interaction.deferReply({ flags: MessageFlags.SuppressNotifications });
  await interaction.editReply({
    content: result.reply,
    allowedMentions: { repliedUser: false }
  });
  enqueuePrint(interaction, result.print);
}
