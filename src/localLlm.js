import { readFile } from 'node:fs/promises';

const DEFAULT_SYSTEM_PROMPT = [
  'あなたはDiscord上で会話する日本語のAIアシスタントです。',
  '質問に直接、正確かつ簡潔に答えてください。',
  'Discordで読みやすいMarkdownを使い、不要な前置きは避けてください。'
].join('\n');

export async function loadAiSystemPrompt(config) {
  if (!config.aiSystemPromptFile) return DEFAULT_SYSTEM_PROMPT;

  try {
    const prompt = (await readFile(config.aiSystemPromptFile, 'utf8')).trim();
    if (!prompt) throw new Error('file is empty');
    return prompt;
  } catch (error) {
    throw new Error(`AI_SYSTEM_PROMPT_FILEを読み込めません: ${error.message}`);
  }
}

export function extractMentionPrompt(content, botUserId) {
  const mentionPattern = new RegExp(`<@!?${escapeRegExp(botUserId)}>`, 'g');
  return String(content ?? '').replace(mentionPattern, '').trim();
}

export async function chatWithOllama({
  prompt,
  history = [],
  config,
  fetchImpl = fetch,
  think = config.ollamaThink,
  stream = false,
  signal,
  onProgress
}) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), config.aiChatTimeoutMs);

  try {
    const systemPrompt = await loadAiSystemPrompt(config);
    const url = new URL('/api/chat', ensureTrailingSlash(config.ollamaUrl));
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: prompt }
    ];
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages,
        stream,
        think,
        keep_alive: config.ollamaKeepAlive
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500);
      throw new Error(`Ollama API ${response.status}: ${detail || response.statusText}`);
    }

    const body = stream
      ? await readOllamaStream(response, onProgress)
      : await response.json();
    const answer = String(body?.message?.content ?? '').trim();
    if (!answer) throw new Error('Ollamaから回答本文が返りませんでした。');

    return {
      answer,
      thinking: String(body?.message?.thinking ?? '').trim(),
      model: String(body?.model ?? config.ollamaModel),
      totalDurationNs: Number(body?.total_duration) || null
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (signal?.aborted) {
        const aborted = new Error('AIチャットが中断されました。');
        aborted.code = 'AI_CHAT_ABORTED';
        throw aborted;
      }
      throw new Error(`ローカルLLMがタイムアウトしました（${Math.ceil(config.aiChatTimeoutMs / 1000)}秒）。`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

async function readOllamaStream(response, onProgress) {
  if (!response.body) throw new Error('Ollamaからストリーム本文が返りませんでした。');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let answer = '';
  let thinking = '';
  let finalChunk = {};

  const consumeLine = (line) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(`Ollama API: ${chunk.error}`);
    answer += String(chunk?.message?.content ?? '');
    thinking += String(chunk?.message?.thinking ?? '');
    finalChunk = chunk;
    onProgress?.({ answer, thinking });
  };

  while (true) {
    const { value, done } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  consumeLine(buffered);

  return {
    ...finalChunk,
    message: { content: answer, thinking }
  };
}

export function trimChatHistory(history, maxMessages) {
  return history.slice(-maxMessages);
}

export function splitDiscordText(text, maxLength = 1700) {
  const remaining = String(text ?? '').trim();
  if (!remaining) return ['（回答なし）'];

  const chunks = [];
  let rest = remaining;
  while (rest.length > maxLength) {
    let splitAt = rest.lastIndexOf('\n', maxLength);
    if (splitAt < Math.floor(maxLength / 2)) splitAt = rest.lastIndexOf(' ', maxLength);
    if (splitAt < Math.floor(maxLength / 2)) splitAt = maxLength;
    chunks.push(rest.slice(0, splitAt).trimEnd());
    rest = rest.slice(splitAt).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function buildThinkingText({ prompt, thinking, answer, model, elapsedMs }) {
  const thought = thinking || 'このモデル/APIは詳細な思考過程を返しませんでした。';
  return [
    `モデル: ${model}`,
    `処理時間: ${formatElapsed(elapsedMs)}`,
    '',
    '質問:',
    prompt,
    '',
    '詳細な思考過程:',
    thought,
    '',
    '最終回答:',
    answer,
    ''
  ].join('\n');
}

export function formatElapsed(elapsedMs) {
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1000).toFixed(1)}秒`;
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
