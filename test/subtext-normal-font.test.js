import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { buildPrintJob } from '../src/discordContent.js';

const FONT_B_SELECT = Buffer.from([0x1b, 0x4d, 0x01]); // ESC M 1

function baseConfig() {
  return {
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
}

function baseMessage(content) {
  return {
    content,
    attachments: [],
    stickers: [],
    messageSnapshots: [],
    embeds: []
  };
}

test('subtext (-#) lines print at normal size, not Font B', async () => {
  const message = baseMessage('速報タイトル\n-# 詳細の行です');
  const { bytes } = await buildPrintJob(message, baseConfig(), { printHeader: false });
  assert.equal(bytes.includes(FONT_B_SELECT), false);
  assert.ok(bytes.includes(iconv.encode('詳細の行です', 'cp932')));
});

test('explicit !font b command still selects Font B', async () => {
  const message = baseMessage('!font b\n小さい文字で出す行');
  const { bytes } = await buildPrintJob(message, baseConfig(), { printHeader: false });
  assert.equal(bytes.includes(FONT_B_SELECT), true);
});
