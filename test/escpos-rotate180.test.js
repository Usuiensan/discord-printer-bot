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

test('rotate180 keeps state changes with their content segment', () => {
  const printer = new EscPosBuilder({ rotate180: true });
  printer.bold(true).line('X').bold(false).line('Y');
  const bytes = printer.build();
  const x = bytes.indexOf(Buffer.from('X'));
  const y = bytes.indexOf(Buffer.from('Y'));

  assert.ok(y < x);
  assert.deepEqual([...bytes.subarray(x - 3, x)], [0x1b, 0x45, 0x01]);
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
