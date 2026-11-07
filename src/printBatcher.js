export function createPrintBatcher({
  quietMs,
  maxMs,
  maxMessages,
  onFlush,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout
}) {
  const batches = new Map();

  function keyFor(message) {
    return `${message.channelId}\u0000${message.author?.id ?? message.authorId}`;
  }

  function flush(key) {
    const batch = batches.get(key);
    if (!batch) return;
    batches.delete(key);
    cancel(batch.quietTimer);
    cancel(batch.maxTimer);
    onFlush(batch.messages);
  }

  return {
    add(message) {
      if (quietMs === 0) {
        onFlush([message]);
        return;
      }

      const key = keyFor(message);
      let batch = batches.get(key);
      if (!batch) {
        batch = { messages: [], quietTimer: null, maxTimer: null };
        batches.set(key, batch);
        batch.maxTimer = schedule(() => flush(key), maxMs);
      } else {
        cancel(batch.quietTimer);
      }
      batch.messages.push(message);
      batch.quietTimer = schedule(() => flush(key), quietMs);
      if (batch.messages.length >= maxMessages) flush(key);
    },

    flush(message) {
      flush(keyFor(message));
    },

    flushAll() {
      for (const key of batches.keys()) flush(key);
    },

    size() {
      return batches.size;
    },

  };
}
