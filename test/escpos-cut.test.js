import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { EscPosBuilder } from '../src/escpos.js';

test('cutWithFeed adds exactly three lines before and after an inline cut', () => {
  const printer = new EscPosBuilder();
  printer.text('A').cutWithFeed('partial', 3).text('B');
  const bytes = printer.build();
  const cutIndex = bytes.indexOf(Buffer.from([0x1b, 0x69]));

  assert.notEqual(cutIndex, -1);
  assert.deepEqual([...bytes.subarray(cutIndex - 3, cutIndex)], [0x0a, 0x0a, 0x0a]);
  assert.deepEqual([...bytes.subarray(cutIndex + 2, cutIndex + 5)], [0x0a, 0x0a, 0x0a]);
});

test('text threshold conversion does not leak into the following grayscale image', async () => {
  const grayPixel = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 150, g: 150, b: 150 } }
  }).png().toBuffer();
  const printer = new EscPosBuilder({ widthDots: 1 });

  await printer.image(grayPixel, { maxWidth: 1, dither: 'threshold', threshold: 170 });
  await printer.image(grayPixel, { maxWidth: 1, dither: 'ordered' });

  const bytes = printer.build();
  const command = Buffer.from([0x1d, 0x76, 0x30, 0x00]);
  const first = bytes.indexOf(command);
  const second = bytes.indexOf(command, first + command.length);
  assert.equal(bytes[first + 8], 0x80);
  assert.equal(bytes[second + 8], 0x00);
});
