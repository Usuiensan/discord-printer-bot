import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { EscPosBuilder } from '../src/escpos.js';

const rasterCommand = Buffer.from([0x1d, 0x76, 0x30, 0x00]);

function rasterPayload(bytes) {
  const commandIndex = bytes.indexOf(rasterCommand);
  assert.notEqual(commandIndex, -1);
  const widthBytes = bytes[commandIndex + 4] | (bytes[commandIndex + 5] << 8);
  const height = bytes[commandIndex + 6] | (bytes[commandIndex + 7] << 8);
  return {
    widthBytes,
    height,
    data: bytes.subarray(commandIndex + 8, commandIndex + 8 + widthBytes * height)
  };
}

test('rotate180 reverses line segments and keeps the cut at the end', () => {
  const printer = new EscPosBuilder({ rotate180: true });
  printer.line('A').line('B').cut();
  const bytes = printer.build();

  assert.deepEqual([...bytes.subarray(0, 2)], [0x1b, 0x40]);
  assert.notEqual(bytes.indexOf(Buffer.from([0x1b, 0x7b, 0x01])), -1);
  assert.ok(bytes.indexOf(Buffer.from('B')) < bytes.indexOf(Buffer.from('A')));
  assert.deepEqual([...bytes.subarray(-2)], [0x1b, 0x69]);
});

test('rotate180 puts the standard cut feed immediately before the cut', () => {
  const printer = new EscPosBuilder({ rotate180: true });
  printer.line('A').cut();
  const bytes = printer.build();
  const cut = Buffer.from([0x1b, 0x69]);
  const cutIndex = bytes.indexOf(cut);
  const rotateIndex = bytes.indexOf(Buffer.from([0x1b, 0x7b, 0x01]));

  assert.deepEqual([...bytes.subarray(cutIndex - 4, cutIndex)], [0x0a, 0x0a, 0x0a, 0x0a]);
  assert.equal(bytes[rotateIndex + 3], 'A'.charCodeAt(0));
});

test('rotate180 puts standard cut feeds before every inline cut', () => {
  const printer = new EscPosBuilder({ rotate180: true });
  printer.line('A').cut().line('B').cut();
  const bytes = printer.build();
  const cut = Buffer.from([0x1b, 0x69]);
  const firstCut = bytes.indexOf(cut);
  const secondCut = bytes.indexOf(cut, firstCut + cut.length);

  assert.deepEqual([...bytes.subarray(firstCut - 4, firstCut)], [0x0a, 0x0a, 0x0a, 0x0a]);
  assert.deepEqual([...bytes.subarray(secondCut - 4, secondCut)], [0x0a, 0x0a, 0x0a, 0x0a]);
});

test('rotate180 keeps state changes with their content segment', () => {
  const printer = new EscPosBuilder({ rotate180: true });
  printer.bold(true).line('X').bold(false).line('Y');
  const bytes = printer.build();
  const x = bytes.indexOf(Buffer.from('X'));
  const y = bytes.indexOf(Buffer.from('Y'));

  assert.ok(y < x);
  assert.deepEqual([...bytes.subarray(x - 3, x)], [0x1b, 0x45, 0x01]);
});

test('rotate180 keeps inline cuts between their small pages', () => {
  const printer = new EscPosBuilder({ rotate180: true });
  printer.line('A').cut().line('B').cut();
  const bytes = printer.build();
  const cut = Buffer.from([0x1b, 0x69]);
  const firstCut = bytes.indexOf(cut);
  const secondCut = bytes.indexOf(cut, firstCut + cut.length);

  assert.ok(bytes.indexOf(Buffer.from('A')) < firstCut);
  assert.ok(firstCut < bytes.indexOf(Buffer.from('B')));
  assert.ok(bytes.indexOf(Buffer.from('B')) < secondCut);
  assert.notEqual(bytes.indexOf(Buffer.from([0x1b, 0x7b, 0x01])), -1);
});

test('rotate180 keeps cutWithFeed boundaries between their small pages', () => {
  const printer = new EscPosBuilder({ rotate180: true });
  printer.line('A').cutWithFeed('partial', 2).line('B').cutWithFeed('partial', 2);
  const bytes = printer.build();
  const cut = Buffer.from([0x1b, 0x69]);
  const firstCut = bytes.indexOf(cut);
  const secondCut = bytes.indexOf(cut, firstCut + cut.length);

  assert.ok(bytes.indexOf(Buffer.from('A')) < firstCut);
  assert.ok(firstCut < bytes.indexOf(Buffer.from('B')));
  assert.ok(bytes.indexOf(Buffer.from('B')) < secondCut);
});

test('rotate180 keeps cutWithFeed feed after the cut at the next group head', () => {
  const printer = new EscPosBuilder({ rotate180: true });
  printer.line('A').cutWithFeed('partial', 2).line('B');
  const bytes = printer.build();
  const cut = Buffer.from([0x1b, 0x69]);
  const cutIndex = bytes.indexOf(cut);
  const bIndex = bytes.indexOf(Buffer.from('B'));

  assert.deepEqual([...bytes.subarray(cutIndex - 2, cutIndex)], [0x0a, 0x0a]);
  assert.deepEqual([...bytes.subarray(cutIndex + cut.length, bIndex)], [0x0a, 0x0a]);
});

test('rotate180 keeps page mode blocks in their original byte order', () => {
  const normal = new EscPosBuilder();
  normal.line('Y').pageMode(true).text('X').feed(1).pagePrint().pageMode(false);
  const rotated = new EscPosBuilder({ rotate180: true });
  rotated.line('Y').pageMode(true).text('X').feed(1).pagePrint().pageMode(false);

  const normalBytes = normal.build();
  const rotatedBytes = rotated.build();
  const pageBlockStart = normalBytes.indexOf(Buffer.from([0x1b, 0x4c]));
  const pageBlock = normalBytes.subarray(pageBlockStart);

  const rotatedPageBlock = rotatedBytes.indexOf(pageBlock);
  assert.notEqual(rotatedPageBlock, -1);
  assert.ok(rotatedPageBlock < rotatedBytes.indexOf(Buffer.from('Y')));
});

test('rotate180 rotates raster pixels before packing them', async () => {
  const image = await sharp({
    create: {
      width: 3,
      height: 2,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  }).composite([
    { input: Buffer.from([0, 0, 0, 255, 255, 255, 255, 255, 255]), raw: { width: 3, height: 1, channels: 3 }, top: 0, left: 0 },
    { input: Buffer.from([255, 255, 255, 0, 0, 0, 255, 255, 255]), raw: { width: 3, height: 1, channels: 3 }, top: 1, left: 0 }
  ]).png().toBuffer();
  const normal = new EscPosBuilder({ widthDots: 3 });
  const rotated = new EscPosBuilder({ widthDots: 3, rotate180: true });

  await normal.image(image, { maxWidth: 3, dither: 'threshold', threshold: 170 });
  await rotated.image(image, { maxWidth: 3, dither: 'threshold', threshold: 170 });

  assert.deepEqual([...rasterPayload(rotated.build()).data], [0x40, 0x20]);
  assert.deepEqual([...rasterPayload(normal.build()).data], [0x80, 0x40]);
});

test('rotate180 disabled keeps the existing output', () => {
  const defaultPrinter = new EscPosBuilder();
  const disabledPrinter = new EscPosBuilder({ rotate180: false });
  defaultPrinter.line('A').line('B').cut();
  disabledPrinter.line('A').line('B').cut();

  assert.deepEqual(disabledPrinter.build(), defaultPrinter.build());
});
