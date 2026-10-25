import test from 'node:test';
import assert from 'node:assert/strict';
import { linuxPrinterDeviceCandidates } from '../src/printer.js';

test('linux printer candidates keep the configured device first', async () => {
  const candidates = await linuxPrinterDeviceCandidates({ linuxPrinterDevice: '/dev/usb/lp7' });

  assert.equal(candidates[0], '/dev/usb/lp7');
  assert.equal(new Set(candidates).size, candidates.length);
});
