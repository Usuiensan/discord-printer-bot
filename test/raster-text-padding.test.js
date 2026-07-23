import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { buildPrintJob } from '../src/discordContent.js';

const config = {
  printWidthDots: 384,
  printHeader: false,
  printUrlQr: false,
  cutMode: 'none',
  messageCommandPrefix: '!',
  textRenderMode: 'image',
  textImageFontFamily: 'sans-serif',
  textImageFontSizeDots: 28,
  textImageLineHeightDots: 30,
  textImageLineGapDots: 6,
  textImageThreshold: 170,
  textImageDitherMode: 'threshold',
  emojiRenderMode: 'text'
};

test('Discord raster text has balanced top and bottom whitespace', async () => {
  const { printImages } = await buildPrintJob(message('日本語Ag'), config, { printHeader: false });
  assert.equal(printImages.length, 1);
  await assertBalancedVerticalPadding(printImages[0], 1);
});

test('ReceiptLine raster text has balanced top and bottom whitespace', async () => {
  const { printImages } = await buildPrintJob(
    message('!receiptline\n日本語Ag'),
    config,
    { printHeader: false }
  );
  assert.equal(printImages.length, 1);
  await assertBalancedVerticalPadding(printImages[0], 1);
});

function message(content) {
  return {
    content,
    attachments: new Map(),
    embeds: [],
    stickers: new Map(),
    author: {
      id: '1',
      username: 'tester',
      displayName: 'tester',
      displayAvatarURL: () => ''
    },
    createdAt: new Date('2026-07-23T00:00:00Z')
  };
}

async function assertBalancedVerticalPadding(image, tolerance) {
  const { data, info } = await sharp(image).grayscale().raw().toBuffer({ resolveWithObject: true });
  let firstInkRow = -1;
  let lastInkRow = -1;
  for (let y = 0; y < info.height; y += 1) {
    const start = y * info.width;
    const hasInk = data.subarray(start, start + info.width).some((value) => value < 255);
    if (!hasInk) continue;
    if (firstInkRow < 0) firstInkRow = y;
    lastInkRow = y;
  }

  assert.notEqual(firstInkRow, -1);
  const topPadding = firstInkRow;
  const bottomPadding = info.height - lastInkRow - 1;
  assert.ok(
    Math.abs(topPadding - bottomPadding) <= tolerance,
    `expected balanced padding, got top=${topPadding}, bottom=${bottomPadding}`
  );
}
