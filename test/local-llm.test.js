import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildThinkingText,
  chatWithOllama,
  extractMentionPrompt,
  splitDiscordText,
  trimChatHistory
} from '../src/localLlm.js';

const config = {
  aiChatTimeoutMs: 1000,
  aiSystemPromptFile: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'test-model',
  ollamaThink: true,
  ollamaKeepAlive: '10m'
};

test('extractMentionPrompt removes normal and nickname bot mentions', () => {
  assert.equal(extractMentionPrompt('<@123> こんにちは <@!123>', '123'), 'こんにちは');
});

test('chatWithOllama sends history and returns answer plus thinking', async () => {
  let requestBody;
  const fetchImpl = async (url, options) => {
    assert.equal(String(url), 'http://localhost:11434/api/chat');
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      model: 'test-model:latest',
      message: { content: '回答です', thinking: '検討内容です' },
      total_duration: 123
    }));
  };

  const result = await chatWithOllama({
    prompt: '質問',
    history: [{ role: 'assistant', content: '前の回答' }],
    config,
    fetchImpl
  });

  assert.equal(requestBody.think, true);
  assert.equal(requestBody.messages.at(-2).content, '前の回答');
  assert.equal(requestBody.messages.at(-1).content, '質問');
  assert.equal(result.answer, '回答です');
  assert.equal(result.thinking, '検討内容です');
  assert.equal(result.model, 'test-model:latest');
});

test('chatWithOllama reports an Ollama HTTP error', async () => {
  await assert.rejects(
    chatWithOllama({
      prompt: '質問',
      config,
      fetchImpl: async () => new Response('model not found', { status: 404 })
    }),
    /Ollama API 404: model not found/
  );
});

test('splitDiscordText preserves all text across Discord-sized chunks', () => {
  const source = `${'あ'.repeat(20)}\n${'い'.repeat(20)}`;
  const chunks = splitDiscordText(source, 25);
  assert.deepEqual(chunks, ['あ'.repeat(20), 'い'.repeat(20)]);
});

test('history is trimmed and thinking file explains missing thinking', () => {
  assert.deepEqual(trimChatHistory([1, 2, 3, 4], 2), [3, 4]);
  const text = buildThinkingText({
    prompt: '質問',
    thinking: '',
    answer: '回答',
    model: 'model',
    elapsedMs: 1500
  });
  assert.match(text, /詳細な思考過程を返しませんでした/);
  assert.match(text, /処理時間: 1\.5秒/);
});
