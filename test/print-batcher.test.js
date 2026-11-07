import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrintBatcher } from '../src/printBatcher.js';

function message(id, channelId = 'channel', authorId = 'author') {
  return { id, channelId, author: { id: authorId } };
}

function scheduler() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    }
  };
}

test('print batcher flushes after the quiet period', () => {
  const clock = scheduler();
  const flushed = [];
  createPrintBatcher({
    quietMs: 5,
    maxMs: 30,
    maxMessages: 10,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onFlush: (messages) => flushed.push(messages.map(({ id }) => id))
  }).add(message('1'));

  clock.advance(4);
  assert.deepEqual(flushed, []);
  clock.advance(1);
  assert.deepEqual(flushed, [['1']]);
});

test('print batcher flushes from the oldest message at the maximum period', () => {
  const clock = scheduler();
  const flushed = [];
  const batcher = createPrintBatcher({
    quietMs: 5,
    maxMs: 10,
    maxMessages: 10,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onFlush: (messages) => flushed.push(messages.map(({ id }) => id))
  });

  batcher.add(message('1'));
  clock.advance(4);
  batcher.add(message('2'));
  clock.advance(6);
  assert.deepEqual(flushed, [['1', '2']]);
});

test('print batcher flushes when the message limit is reached', () => {
  const clock = scheduler();
  const flushed = [];
  const batcher = createPrintBatcher({
    quietMs: 50,
    maxMs: 100,
    maxMessages: 2,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onFlush: (messages) => flushed.push(messages.map(({ id }) => id))
  });

  batcher.add(message('1'));
  batcher.add(message('2'));
  assert.deepEqual(flushed, [['1', '2']]);
});

test('print batcher keeps different authors and channels separate', () => {
  const clock = scheduler();
  const flushed = [];
  const batcher = createPrintBatcher({
    quietMs: 5,
    maxMs: 30,
    maxMessages: 10,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onFlush: (messages) => flushed.push(messages.map(({ id }) => id))
  });

  batcher.add(message('1'));
  batcher.add(message('2', 'channel', 'other-author'));
  batcher.add(message('3', 'other-channel'));
  clock.advance(5);
  assert.deepEqual(flushed, [['1'], ['2'], ['3']]);
});

test('zero quiet period passes messages through immediately', () => {
  const flushed = [];
  createPrintBatcher({
    quietMs: 0,
    maxMs: 30,
    maxMessages: 10,
    onFlush: (messages) => flushed.push(messages.map(({ id }) => id))
  }).add(message('1'));

  assert.deepEqual(flushed, [['1']]);
});
