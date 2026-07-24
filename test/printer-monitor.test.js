import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrinterMonitorTracker, shouldPausePrinterMonitor } from '../src/printerMonitor.js';

test('3回連続で失敗した時だけ問題を通知する', () => {
  const tracker = createPrinterMonitorTracker(3);

  assert.deepEqual(tracker.record(['オフライン']), {
    type: 'none',
    consecutiveFailures: 1
  });
  assert.deepEqual(tracker.record(['オフライン']), {
    type: 'none',
    consecutiveFailures: 2
  });
  assert.deepEqual(tracker.record(['オフライン']), {
    type: 'problem',
    problems: ['オフライン'],
    consecutiveFailures: 3
  });
  assert.deepEqual(tracker.record(['オフライン']), {
    type: 'none',
    consecutiveFailures: 4
  });
});

test('成功を挟むと連続失敗回数をリセットする', () => {
  const tracker = createPrinterMonitorTracker(3);

  tracker.record(['オフライン']);
  tracker.record(['オフライン']);
  assert.deepEqual(tracker.record([]), {
    type: 'none',
    consecutiveFailures: 0
  });
  assert.deepEqual(tracker.record(['オフライン']), {
    type: 'none',
    consecutiveFailures: 1
  });
});

test('問題通知後に正常へ戻った時だけ復旧を通知する', () => {
  const tracker = createPrinterMonitorTracker(3);

  tracker.record(['用紙切れ']);
  tracker.record(['用紙切れ']);
  tracker.record(['用紙切れ']);
  assert.deepEqual(tracker.record([]), {
    type: 'recovered',
    consecutiveFailures: 0
  });
  assert.deepEqual(tracker.record([]), {
    type: 'none',
    consecutiveFailures: 0
  });
});

test('印刷中と印刷完了後5秒はhealth checkを止める', () => {
  assert.equal(shouldPausePrinterMonitor({
    queuedPrintCount: 1,
    pausedUntil: 0,
    now: 10000
  }), true);
  assert.equal(shouldPausePrinterMonitor({
    queuedPrintCount: 0,
    pausedUntil: 15000,
    now: 14999
  }), true);
  assert.equal(shouldPausePrinterMonitor({
    queuedPrintCount: 0,
    pausedUntil: 15000,
    now: 15000
  }), false);
});
