import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageType,
  Partials
} from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { buildMemberJoinPrintJob, buildPreviewImage, buildPrintJob } from './discordContent.js';
import {
  buildThinkingText,
  chatWithOllama,
  extractMentionPrompt,
  formatElapsed,
  splitDiscordText,
  trimChatHistory
} from './localLlm.js';
import { checkPrinterProblems, sendRawToPrinter } from './printer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEQUENCE_STATE_PATH = join(__dirname, '..', 'run', 'print-sequence.json');
const NEAR_END_PROBLEM = 'レシート用紙残量少';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

let queue = Promise.resolve();
let queuedPrintCount = 0;
let lastPrintedMessage = null;
let printerMonitorTimer = null;
let lastPrinterProblemKey = '';
let hasSeenPrinterProblem = false;
let printerMonitorRunning = false;
let latestPrinterProblems = [];
const aiChatHistories = new Map();
const aiChatQueues = new Map();
const activeAiJobs = new Map();
const aiDeepRetryContexts = new Map();
const watchedChannelIds = new Set(config.channelIds ?? [config.channelId]);

function enqueuePrint(message) {
  enqueuePrintJob(message, 'message', async () => {
    const omitHeader = shouldOmitHeader(message);
    const printNumber = omitHeader ? null : await peekNextPrintNumber();
    let retryNotified = false;
    const { bytes, warnings, printImages, usesPrintNumber = true, updatesMergeState = true } = await buildPrintJob(message, config, {
      printHeader: !omitHeader,
      printNumber
    });
    await sendRawToPrinter(bytes, config.printerName, {
      ...config,
      onRetry: async (retry) => {
        if (retryNotified) return;
        retryNotified = true;
        await markPrintRetry(message, retry);
      }
    });
    if (printNumber && usesPrintNumber) {
      await commitPrintNumber(printNumber);
    }
    if (updatesMergeState) {
      lastPrintedMessage = {
        authorId: message.author.id,
        channelId: message.channelId,
        createdTimestamp: message.createdTimestamp
      };
    }
    if (warnings.length > 0) {
      await markPrintWarning(message, warnings, printImages);
      console.log(`Printed message ${message.id} from ${message.author.tag} with ${warnings.length} warning(s)`);
    } else {
      await markPrintSuccess(message, hasNearEndWarning());
      console.log(`Printed message ${message.id} from ${message.author.tag}`);
    }
  });
}

function enqueueMemberJoinPrint(member) {
  const eventInfo = {
    id: `member-join-${member.id}-${Date.now()}`,
    authorTag: member.user.tag ?? member.user.username
  };

  enqueuePrintJob(eventInfo, 'member-join', async () => {
    const printNumber = await peekNextPrintNumber();
    let retryNotified = false;
    const { bytes, warnings } = await buildMemberJoinPrintJob(member, config, {
      printNumber
    });
    await sendRawToPrinter(bytes, config.printerName, {
      ...config,
      onRetry: async (retry) => {
        if (retryNotified) return;
        retryNotified = true;
        console.warn(`Member join print retry for ${member.user.id}: ${retry.reason}`);
      }
    });
    await commitPrintNumber(printNumber);
    if (warnings.length > 0) {
      console.warn(`Printed member join ${member.user.id} with ${warnings.length} warning(s): ${warnings.join(' / ')}`);
    } else {
      console.log(`Printed member join ${member.user.id}`);
    }
  }, {
    onFailure: async (error) => {
      console.error(`member-join print failed for ${member.user.id}:`, error);
      await sendPrinterMonitorMessage(
        client,
        `新規参加メンバーの印刷に失敗しました: ${member.displayName ?? member.user.username} / ${error.message}`
      );
    }
  });
}

function enqueueReprint(message, targetMessage) {
  return enqueuePrintJob(message, 'reprint', async () => {
    const omitHeader = false;
    const printNumber = await peekNextPrintNumber();
    let retryNotified = false;
    const { bytes, warnings, printImages, usesPrintNumber = true, updatesMergeState = true } = await buildPrintJob(targetMessage, config, {
      printHeader: !omitHeader,
      printNumber
    });
    await sendRawToPrinter(bytes, config.printerName, {
      ...config,
      onRetry: async (retry) => {
        if (retryNotified) return;
        retryNotified = true;
        await markPrintRetry(message, retry);
      }
    });
    if (usesPrintNumber) await commitPrintNumber(printNumber);
    if (updatesMergeState) {
      lastPrintedMessage = {
        authorId: targetMessage.author.id,
        channelId: targetMessage.channelId,
        createdTimestamp: targetMessage.createdTimestamp
      };
    }
    if (warnings.length > 0) {
      await markPrintWarning(message, warnings, printImages);
      console.log(`Reprinted message ${targetMessage.id} requested by ${message.author.tag} with ${warnings.length} warning(s)`);
    } else {
      await markPrintSuccess(message, hasNearEndWarning());
      console.log(`Reprinted message ${targetMessage.id} requested by ${message.author.tag}`);
    }
  });
}

function enqueueRawEscposPrint(message, rawCommand) {
  return enqueuePrintJob(message, 'raw-escpos', async () => {
    let retryNotified = false;
    await sendRawToPrinter(rawCommand.bytes, config.printerName, {
      ...config,
      onRetry: async (retry) => {
        if (retryNotified) return;
        retryNotified = true;
        await markPrintRetry(message, retry);
      }
    });
    await markPrintSuccess(message, hasNearEndWarning());
    console.log(`Printed raw ESC/POS ${rawCommand.bytes.length} byte(s) requested by ${message.author.tag}`);
  });
}

async function peekNextPrintNumber() {
  const current = await readPrintSequenceState();
  return current + 1;
}

async function commitPrintNumber(printNumber) {
  await mkdir(dirname(SEQUENCE_STATE_PATH), { recursive: true });
  await writeFile(SEQUENCE_STATE_PATH, `${JSON.stringify({ lastPrintNumber: printNumber }, null, 2)}\n`);
}

async function readPrintSequenceState() {
  try {
    const raw = await readFile(SEQUENCE_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const value = Number.parseInt(parsed.lastPrintNumber, 10);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    console.warn(`Failed to read print sequence state: ${error.message}`);
    return 0;
  }
}

function shouldOmitHeader(message) {
  if (!lastPrintedMessage) return false;
  if (lastPrintedMessage.authorId !== message.author.id) return false;
  if (lastPrintedMessage.channelId !== message.channelId) return false;

  const delta = message.createdTimestamp - lastPrintedMessage.createdTimestamp;
  return delta >= 0 && delta <= config.mergeSameUserWindowMs;
}

function enqueuePrintJob(message, label, job, options = {}) {
  queuedPrintCount += 1;
  const authorTag = message.author?.tag ?? message.authorTag ?? 'system';
  console.log(`Queued ${label} print ${message.id} from ${authorTag}; pending=${queuedPrintCount}`);

  const previous = queue;
  const run = previous
    .catch(() => {})
    .then(async () => {
      console.log(`Starting ${label} print ${message.id}; pending=${queuedPrintCount}`);
      await job();
    });

  queue = run
    .catch(async (error) => {
      console.error(`${label} print failed:`, error);
      if (options.onFailure) {
        await options.onFailure(error);
      } else {
        await markPrintFailure(message, error.message).catch((reactionError) => {
          console.error('Failed to report print failure:', reactionError);
        });
      }
    })
    .finally(() => {
      queuedPrintCount = Math.max(0, queuedPrintCount - 1);
      console.log(`Finished ${label} print ${message.id}; pending=${queuedPrintCount}`);
    });

  return run;
}

async function markPrintSuccess(message, nearEnd = false) {
  const reaction = nearEnd ? config.printNearEndReaction : config.printedReaction;
  if (!reaction) return;

  try {
    await removeBotReaction(message, config.printErrorReaction);
    await removeBotReaction(message, config.printedReaction);
    await removeBotReaction(message, config.printNearEndReaction);
    await message.react(reaction);
  } catch (error) {
    console.error(`Printed, but failed to add reaction to message ${message.id}:`, error);
  }
}

function hasNearEndWarning() {
  return latestPrinterProblems.includes(NEAR_END_PROBLEM);
}

async function markPrintWarning(message, warnings, printImages = []) {
  const imageModeMessage = warnings.find((warning) => warning.includes('画像印字モードで印刷しました'));
  await removeBotReaction(message, config.printNearEndReaction).catch((error) => {
    console.error(`Failed to remove near-end reaction from message ${message.id}:`, error);
  });
  if (imageModeMessage) {
    await removeBotReaction(message, config.printErrorReaction).catch(() => {});
    await addReaction(message, config.printedReaction);
  } else {
    await removeBotReaction(message, config.printedReaction).catch((error) => {
      console.error(`Failed to remove success reaction from message ${message.id}:`, error);
    });
    await addReaction(message, config.printErrorReaction);
  }

  const otherWarnings = warnings.filter((warning) => warning !== imageModeMessage);
  const warningText = otherWarnings.slice(0, 5).map((warning) => `- ${warning}`).join('\n');
  const more = otherWarnings.length > 5 ? `\n...ほか ${otherWarnings.length - 5} 件` : '';
  const intro = imageModeMessage
    ?? (warnings.every((warning) => warning.startsWith('プリンタ文字コード外の文字を画像として印刷しました:'))
    ? '印刷は完了しました。プリンタ文字コード外の文字は画像として印刷しました。'
    : warnings.every((warning) => warning.includes('を「') && warning.includes('に置換しました'))
      ? '印刷は完了しましたが、文字を置換しました。'
      : '印刷は完了しましたが、一部の内容を印刷できませんでした。');
  const attachments = printImages.slice(0, 10).map((image, index) => new AttachmentBuilder(image, {
    name: index === 0 ? 'image-print.png' : `image-print-${index + 1}.png`
  }));
  const details = warningText ? `\n${warningText}${more}` : '';
  await replyToMessage(message, `${intro}${details}`, attachments);
}

async function markPrintRetry(message, retry) {
  const reason = String(retry.reason ?? 'プリンタが一時的に処理中です').replace(/\s+/g, ' ').trim();
  const waitSeconds = Math.ceil((retry.waitMs ?? 0) / 1000);
  await replyToMessage(
    message,
    `印刷をリトライ中です（理由: ${reason}）。約${waitSeconds}秒後に再試行します。`
  );
}

async function markPrintFailure(message, reason) {
  await removeBotReaction(message, config.printedReaction).catch((error) => {
    console.error(`Failed to remove success reaction from message ${message.id}:`, error);
  });
  await removeBotReaction(message, config.printNearEndReaction).catch((error) => {
    console.error(`Failed to remove near-end reaction from message ${message.id}:`, error);
  });
  await addReaction(message, config.printErrorReaction);
  await replyToMessage(message, `印刷に失敗しました: ${reason}`);
}

async function addReaction(message, emoji) {
  if (!emoji) return;
  try {
    await message.react(emoji);
  } catch (error) {
    console.error(`Failed to add reaction to message ${message.id}:`, error);
  }
}

async function replyToMessage(message, content, files = []) {
  try {
    await message.reply({
      content,
      files,
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    console.error(`Failed to reply to message ${message.id}:`, error);
  }
}

async function removeBotReaction(message, emoji) {
  if (!emoji) return;
  const me = message.client.user;
  if (!me) return;

  const reaction = message.reactions.cache.find((candidate) => candidate.emoji.toString() === emoji);
  if (!reaction) return;

  await reaction.users.remove(me.id);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Watching channels ${[...watchedChannelIds].join(', ')}`);
  for (const channelId of watchedChannelIds) {
    const watchedChannel = await readyClient.channels.fetch(channelId).catch((error) => {
      console.error(`Failed to fetch watched channel ${channelId}: ${error.message}`);
      return null;
    });
    if (watchedChannel) {
      console.log(`Watched channel resolved: ${watchedChannel.name ?? '(no name)'} (${channelId}, type=${watchedChannel.type})`);
    }
  }
  console.log(`Printer: ${config.printerName}`);
  console.log(`OPOS status: ${config.oposStatusEnabled ? `enabled (${config.oposLogicalName || 'no logical name'})` : 'disabled'}`);
  startPrinterMonitor(readyClient);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) {
    console.log(`Ignored bot message ${message.id} from ${message.author.tag}`);
    return;
  }
  if (!isWatchedChannelMessage(message)) {
    console.log(`Ignored message ${message.id} from channel ${message.channelId}; watching ${[...watchedChannelIds].join(', ')}`);
    return;
  }
  if (!isPrintableUserMessage(message)) {
    console.log(`Skipped non-printable message ${message.id} type=${message.type}`);
    return;
  }

  try {
    // Message commands are checked before normal printing so command messages
    // do not consume print numbers or enter the printer queue.
    if (isAiChatMention(message)) {
      await addReaction(message, config.aiThinkingReaction);
      enqueueAiChat(message);
      return;
    }

    if (isPreviewMessageCommand(message)) {
      await replyWithPreview(message);
      await addReaction(message, '👀');
      return;
    }

    const reprintTarget = await parseReprintMessageCommand(message);
    if (reprintTarget) {
      await addReaction(message, '🖨️');
      enqueueReprint(message, reprintTarget);
      return;
    }

    const rawEscposCommand = parseRawEscposMessageCommand(message);
    if (rawEscposCommand) {
      await addReaction(message, '🧪');
      enqueueRawEscposPrint(message, rawEscposCommand);
      return;
    }

  } catch (error) {
    await markPrintFailure(message, error.message);
    return;
  }

  enqueuePrint(message);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith('ai:')) return;
  const [, action, messageId] = interaction.customId.split(':');
  const activeJob = activeAiJobs.get(messageId);
  const retryContext = aiDeepRetryContexts.get(messageId);
  const ownerId = activeJob?.message.author.id ?? retryContext?.userId;

  if (!ownerId) {
    await interaction.reply({ content: 'このAI操作は期限切れです。', ephemeral: true });
    return;
  }
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'このボタンは質問者だけが操作できます。', ephemeral: true });
    return;
  }

  await interaction.deferUpdate();
  if (action === 'cancel' && activeJob) {
    activeJob.cancelled = true;
    activeJob.controller.abort();
    return;
  }
  if (action === 'fast' && activeJob) {
    activeJob.nextMode = 'fast';
    activeJob.controller.abort();
    return;
  }
  if (action === 'think' && retryContext) {
    aiDeepRetryContexts.delete(messageId);
    await interaction.message.edit({ components: [] }).catch(() => {});
    await addReaction(retryContext.message, config.aiThinkingReaction);
    enqueueAiChat(retryContext.message, {
      mode: 'think',
      prompt: retryContext.prompt,
      history: retryContext.history
    });
  }
});

client.on(Events.GuildMemberAdd, (member) => {
  if (!config.memberJoinPrintEnabled) return;
  if (config.guildId && member.guild.id !== config.guildId) return;

  console.log(`Guild member joined: ${member.user.tag ?? member.user.username} (${member.user.id})`);
  enqueueMemberJoinPrint(member);
});

function isWatchedChannelMessage(message) {
  if (watchedChannelIds.has(message.channelId)) return true;
  return message.channel?.isThread?.() && watchedChannelIds.has(message.channel.parentId);
}

function isAiChatMention(message) {
  return config.aiChatEnabled && Boolean(client.user) && message.mentions.has(client.user);
}

function enqueueAiChat(message, options = {}) {
  const conversationKey = `${message.guildId ?? 'dm'}:${message.channelId}`;
  const previous = aiChatQueues.get(conversationKey) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(() => handleAiChat(message, conversationKey, options))
    .catch(async (error) => {
      const activeJob = activeAiJobs.get(message.id);
      activeAiJobs.delete(message.id);
      if (error.code === 'AI_CHAT_ABORTED' && activeJob?.nextMode === 'fast') {
        enqueueAiChat(message, {
          mode: 'fast',
          prompt: activeJob.prompt,
          history: activeJob.history,
          progressMessage: activeJob.progressMessage
        });
        return;
      }
      if (error.code === 'AI_CHAT_ABORTED' && activeJob?.cancelled) {
        await activeJob.progressMessage?.edit({
          content: `<@${message.author.id}> ⏹ AIチャットを中止しました。`,
          components: [],
          allowedMentions: { users: [message.author.id], repliedUser: false }
        }).catch(() => {});
        await removeBotReaction(message, config.aiThinkingReaction).catch(() => {});
        return;
      }
      console.error(`AI chat failed for message ${message.id}:`, error);
      await removeBotReaction(message, config.aiThinkingReaction).catch(() => {});
      await addReaction(message, config.aiErrorReaction);
      if (activeJob?.progressMessage) {
        await activeJob.progressMessage.edit({
          content: `<@${message.author.id}> ローカルLLMの処理に失敗しました: ${error.message}`,
          components: [],
          allowedMentions: { users: [message.author.id], repliedUser: false }
        }).catch(() => {});
      } else {
        await replyWithUserMention(message, `ローカルLLMの処理に失敗しました: ${error.message}`);
      }
    })
    .finally(() => {
      if (aiChatQueues.get(conversationKey) === run) aiChatQueues.delete(conversationKey);
    });

  aiChatQueues.set(conversationKey, run);
}

async function handleAiChat(message, conversationKey, options) {
  const request = parseAiChatRequest(message, options);
  const { mode, prompt } = request;
  if (!prompt) {
    throw new Error('メンションの後に質問を書いてください。');
  }

  const startedAt = Date.now();
  const history = options.history ?? aiChatHistories.get(conversationKey) ?? [];
  const controller = new AbortController();
  const progressMessage = mode === 'think'
    ? await createOrResetAiProgressMessage(message, options.progressMessage, startedAt)
    : options.progressMessage;
  if (mode === 'fast' && progressMessage) {
    await progressMessage.edit({
      content: `<@${message.author.id}> ⚡ 高速回答に切り替えました…`,
      components: [],
      allowedMentions: { users: [message.author.id], repliedUser: false }
    });
  }
  const activeJob = { controller, message, mode, prompt, history, progressMessage };
  activeAiJobs.set(message.id, activeJob);

  console.log(`Starting AI chat ${message.id} mode=${mode} model=${config.ollamaModel}`);
  const progressUpdater = mode === 'think'
    ? createAiProgressUpdater(message, progressMessage, startedAt)
    : null;
  let result;
  try {
    result = await chatWithOllama({
      prompt,
      history,
      config: {
        ...config,
        aiChatTimeoutMs: mode === 'think' ? config.aiThinkTimeoutMs : config.aiFastTimeoutMs
      },
      think: mode === 'think',
      stream: mode === 'think',
      signal: controller.signal,
      onProgress: progressUpdater?.update
    });
  } finally {
    await progressUpdater?.stop();
  }
  const elapsedMs = Date.now() - startedAt;
  activeAiJobs.delete(message.id);

  aiChatHistories.set(conversationKey, trimChatHistory([
    ...history,
    { role: 'user', content: prompt },
    { role: 'assistant', content: result.answer }
  ], config.aiChatHistoryMessages));

  if (mode === 'fast') {
    aiDeepRetryContexts.set(message.id, { message, prompt, history, userId: message.author.id });
  } else {
    aiDeepRetryContexts.delete(message.id);
  }
  await sendAiChatAnswer(message, { ...result, prompt, elapsedMs, mode }, progressMessage);
  await removeBotReaction(message, config.aiThinkingReaction).catch((error) => {
    console.error(`Failed to remove AI thinking reaction from message ${message.id}:`, error);
  });
  console.log(`Finished AI chat ${message.id} mode=${mode} in ${elapsedMs}ms with model ${result.model}`);
}

function parseAiChatRequest(message, options) {
  if (options.prompt) return { mode: options.mode ?? 'fast', prompt: options.prompt };
  const rawPrompt = extractMentionPrompt(message.content, client.user.id);
  const match = rawPrompt.match(/^\/(think|fast)\b\s*/i);
  return {
    mode: options.mode ?? (match?.[1]?.toLowerCase() === 'think' ? 'think' : 'fast'),
    prompt: match ? rawPrompt.slice(match[0].length).trim() : rawPrompt
  };
}

async function createOrResetAiProgressMessage(message, existing, startedAt) {
  const payload = {
    content: buildAiProgressContent(message.author.id, '', startedAt),
    components: buildAiProgressComponents(message.id),
    allowedMentions: { users: [message.author.id], repliedUser: false }
  };
  if (existing) {
    await existing.edit(payload);
    return existing;
  }
  return message.reply(payload);
}

function createAiProgressUpdater(message, progressMessage, startedAt) {
  let lastUpdatedAt = 0;
  let stopped = false;
  let pendingEdit = Promise.resolve();
  const update = ({ thinking }) => {
    const now = Date.now();
    if (stopped || !thinking || now - lastUpdatedAt < config.aiThinkProgressIntervalMs) return;
    lastUpdatedAt = now;
    pendingEdit = pendingEdit.then(() => progressMessage.edit({
        content: buildAiProgressContent(message.author.id, thinking, startedAt),
        components: buildAiProgressComponents(message.id),
        allowedMentions: { users: [message.author.id], repliedUser: false }
      }))
      .catch((error) => console.error(`Failed to update AI progress ${message.id}:`, error));
  };
  return {
    update,
    async stop() {
      stopped = true;
      await pendingEdit;
    }
  };
}

function buildAiProgressContent(userId, thinking, startedAt) {
  const elapsed = formatElapsed(Date.now() - startedAt);
  if (!thinking) return `<@${userId}> 🧠 じっくり考えています… ${elapsed}`;
  const tail = thinking
    .slice(-config.aiThinkProgressMaxChars)
    .replace(/```/g, "'''")
    .trim();
  return `<@${userId}> 🧠 じっくり考えています… ${elapsed}\n\n現在の検討:\n\`\`\`text\n${tail}\n\`\`\``;
}

function buildAiProgressComponents(messageId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ai:cancel:${messageId}`)
      .setLabel('中止')
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`ai:fast:${messageId}`)
      .setLabel('高速回答に切替')
      .setEmoji('⚡')
      .setStyle(ButtonStyle.Secondary)
  )];
}

function buildAiFinalComponents(messageId, mode) {
  if (mode !== 'fast') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ai:think:${messageId}`)
      .setLabel('深く考え直す')
      .setEmoji('🧠')
      .setStyle(ButtonStyle.Primary)
  )];
}

async function sendAiChatAnswer(message, result, progressMessage) {
  const chunks = splitDiscordText(result.answer, 1500);
  const thinkingFilename = `thinking-${message.id}.txt`;
  const thinkingText = buildThinkingText(result);
  let sentAny = Boolean(progressMessage);

  if (progressMessage && chunks.length > 1) {
    await progressMessage.edit({
      content: `<@${message.author.id}>\n${chunks.shift()}`,
      components: [],
      allowedMentions: { users: [message.author.id], repliedUser: false }
    });
  }

  for (const chunk of chunks.slice(0, -1)) {
    const content = sentAny ? chunk : `<@${message.author.id}>\n${chunk}`;
    await sendAiMessagePart(message, content, sentAny);
    sentAny = true;
  }

  const attachmentLink = `[詳細な思考過程（テキスト）](attachment://${thinkingFilename})`;
  const footer = [
    `思考時間: ${formatElapsed(result.elapsedMs)}`,
    `LLMモデル: \`${result.model}\``,
    attachmentLink
  ].join(' / ');
  const prefix = sentAny ? '' : `<@${message.author.id}>\n`;
  const finalContent = `${prefix}${chunks.at(-1)}\n\n${footer}`;
  const attachment = new AttachmentBuilder(Buffer.from(thinkingText, 'utf8'), { name: thinkingFilename });
  const components = buildAiFinalComponents(message.id, result.mode);
  const sent = progressMessage && chunks.length === 1
    ? await progressMessage.edit({
      content: finalContent,
      files: [attachment],
      components,
      allowedMentions: { users: [message.author.id], repliedUser: false }
    })
    : await sendAiMessagePart(message, finalContent, sentAny, [attachment], components);
  const uploadedUrl = sent.attachments.first()?.url;

  if (uploadedUrl) {
    await sent.edit({
      content: finalContent.replace(`attachment://${thinkingFilename}`, uploadedUrl),
      components,
      allowedMentions: { users: [message.author.id], repliedUser: false }
    });
  }
}

function sendAiMessagePart(message, content, sentAny, files = [], components = []) {
  const payload = {
    content,
    files,
    components,
    allowedMentions: { users: [message.author.id], repliedUser: false }
  };
  return sentAny ? message.channel.send(payload) : message.reply(payload);
}

async function replyWithUserMention(message, content) {
  try {
    await message.reply({
      content: `<@${message.author.id}> ${content}`,
      allowedMentions: { users: [message.author.id], repliedUser: false }
    });
  } catch (error) {
    console.error(`Failed to reply to message ${message.id}:`, error);
  }
}

function isPreviewMessageCommand(message) {
  const content = (message.content ?? '').trimStart();
  return content.toLowerCase().startsWith(`${config.messageCommandPrefix}preview`);
}

async function replyWithPreview(message) {
  const previewPng = await buildPreviewImage(message, config);
  const attachment = new AttachmentBuilder(previewPng, { name: 'preview.png' });
  await message.reply({
    content: '印刷プレビュー:',
    files: [attachment],
    allowedMentions: { repliedUser: false }
  });
}

function parseRawEscposMessageCommand(message) {
  const content = message.content ?? '';
  const trimmed = content.trimStart();
  const prefix = config.messageCommandPrefix;
  if (!trimmed.startsWith(prefix)) return null;

  const body = trimmed.slice(prefix.length).trim();
  const match = body.match(/^(?:raw-escpos|escpos-raw|raw)\b\s*([\s\S]*)$/i);
  if (!match) return null;

  const userId = message.author.id;
  if (!config.rawEscposUserIds.includes(userId) && !config.rawEscposAdminUserIds.includes(userId)) {
    throw new Error('raw ESC/POS 印刷は許可ユーザーのみ実行できます。');
  }

  const bytes = parseRawEscposHexPayload(match[1]);
  if (bytes.length === 0) {
    throw new Error(`使い方: ${prefix}raw-escpos 1B 40 48 65 6C 6C 6F 0A`);
  }
  if (bytes.length > config.rawEscposMaxBytes) {
    throw new Error(`raw ESC/POS は最大 ${config.rawEscposMaxBytes} bytes までです。`);
  }

  const dangerous = findDangerousRawEscposPatterns(bytes);
  const isAdmin = config.rawEscposAdminUserIds.includes(userId);
  if (dangerous.length > 0 && !isAdmin) {
    throw new Error(`このraw ESC/POSには制限付きコマンドが含まれます: ${dangerous.join(', ')}`);
  }

  return { bytes };
}

function parseRawEscposHexPayload(value) {
  const withoutCodeFence = String(value ?? '')
    .trim()
    .replace(/^```[^\r\n]*\r?\n?/i, '')
    .replace(/\r?\n?```\s*$/i, '');
  const normalizedInput = withoutCodeFence.replace(/0x/gi, '');
  if (/[^0-9a-fA-F\s,;:_-]/.test(normalizedInput)) {
    throw new Error('raw ESC/POS は16進数と区切り文字だけで指定してください。コメントや通常文字は入れられません。');
  }
  const normalized = normalizedInput.replace(/[^0-9a-fA-F]/g, '');

  if (normalized.length === 0) return Buffer.alloc(0);
  if (normalized.length % 2 !== 0) {
    throw new Error('16進数の桁数が奇数です。1 byte は2桁で指定してください。');
  }
  return Buffer.from(normalized, 'hex');
}

function findDangerousRawEscposPatterns(bytes) {
  const findings = new Set();
  for (let index = 0; index < bytes.length - 1; index += 1) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const d = bytes[index + 3];
    if (a === 0x10 && (b === 0x04 || b === 0x05)) findings.add('DLE realtime/status');
    if (a === 0x1b && b === 0x3d) findings.add('ESC = peripheral select');
    if (a === 0x1b && b === 0x63 && [0x33, 0x34, 0x35].includes(c)) findings.add('ESC c device setting');
    if (a === 0x1d && b === 0x49) findings.add('GS I printer ID/status');
    if (a === 0x1d && b === 0x28 && c === 0x45) findings.add('GS ( E user setting/NV');
    if (a === 0x1c && b === 0x28 && c === 0x45) findings.add('FS ( E user setting/NV');
    if (a === 0x1d && b === 0x28 && c === 0x4c && isNvGraphicsFunction(d)) findings.add('GS ( L NV graphics');
  }
  return Array.from(findings);
}

function isNvGraphicsFunction(value) {
  return [0x30, 0x31, 0x32, 0x33, 0x40, 0x41, 0x42].includes(value);
}

function isPrintableUserMessage(message) {
  return message.type === MessageType.Default || message.type === MessageType.Reply;
}

async function parseReprintMessageCommand(message) {
  const content = (message.content ?? '').trim();
  if (!content.startsWith(config.messageCommandPrefix)) return null;

  const body = content.slice(config.messageCommandPrefix.length).trim();
  const match = body.match(/^reprint\b\s*([\s\S]*)$/i);
  if (!match) return null;

  const targetRef = match[1].trim();
  const targetMessage = await resolveReprintTarget(message, targetRef);
  if (!targetMessage) {
    throw new Error(`使い方: ${config.messageCommandPrefix}reprint <message link | message id>`);
  }
  return targetMessage;
}

async function resolveReprintTarget(message, targetRef) {
  const fallbackId = message.reference?.messageId ?? message.messageReference?.messageId;
  const ref = targetRef || fallbackId;
  if (!ref) return null;

  const parsed = parseDiscordMessageReference(ref);
  const channelId = parsed?.channelId ?? message.channelId;
  const messageId = parsed?.messageId ?? ref;

  const channel = await message.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;

  const target = await channel.messages.fetch(messageId).catch(() => null);
  if (!target || target.author?.bot) return null;
  if (!isPrintableUserMessage(target)) return null;
  return target;
}

function parseDiscordMessageReference(value) {
  const match = String(value).match(/^https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(@me|\d+)\/(\d+)\/(\d+)$/i);
  if (!match) return null;
  return {
    channelId: match[1] === '@me' ? null : match[2],
    messageId: match[3]
  };
}

function startPrinterMonitor(readyClient) {
  if (!config.printerMonitorEnabled) {
    console.log('Printer monitor: disabled');
    return;
  }

  console.log(`Printer monitor: enabled (${config.printerMonitorIntervalMs}ms)`);
  void checkAndNotifyPrinterStatus(readyClient);
  printerMonitorTimer = setInterval(() => {
    void checkAndNotifyPrinterStatus(readyClient);
  }, config.printerMonitorIntervalMs);
}

async function checkAndNotifyPrinterStatus(readyClient) {
  if (printerMonitorRunning) return;
  printerMonitorRunning = true;

  let problems = [];
  try {
    problems = await checkPrinterProblems(config.printerName, config);
    latestPrinterProblems = problems;
  } catch (error) {
    console.error('Printer monitor check failed:', error);
    return;
  } finally {
    printerMonitorRunning = false;
  }

  const problemKey = problems.slice().sort().join('|');
  const hardProblems = problems.filter((problem) => problem !== NEAR_END_PROBLEM);
  const hardProblemKey = hardProblems.slice().sort().join('|');
  if (hardProblemKey === lastPrinterProblemKey) return;

  const hadProblems = lastPrinterProblemKey !== '';
  lastPrinterProblemKey = hardProblemKey;
  if (hardProblems.length > 0) {
    hasSeenPrinterProblem = true;
    await sendPrinterMonitorMessage(readyClient, `プリンタに問題があります: ${hardProblems.join(' / ')}`);
  } else if (hadProblems || hasSeenPrinterProblem) {
    await sendPrinterMonitorMessage(readyClient, 'プリンタは正常に戻りました。');
  }
}

async function sendPrinterMonitorMessage(readyClient, content) {
  try {
    const channel = await readyClient.channels.fetch(config.printerMonitorChannelId);
    if (!channel?.isTextBased()) {
      console.error(`Printer monitor channel is not text based: ${config.printerMonitorChannelId}`);
      return;
    }
    await channel.send(content);
  } catch (error) {
    console.error('Failed to send printer monitor message:', error);
  }
}

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  if (printerMonitorTimer) clearInterval(printerMonitorTimer);
  await client.destroy();
  process.exit(0);
});

try {
  await client.login(config.discordToken);
} catch (error) {
  if (String(error?.message ?? error).includes('Used disallowed intents')) {
    console.error([
      'Discord rejected one of the requested gateway intents.',
      'Open Discord Developer Portal > your application > Bot > Privileged Gateway Intents, then enable MESSAGE CONTENT INTENT.',
      'Also confirm that .env DISCORD_TOKEN belongs to the same application you edited.'
    ].join('\n'));
  }

  throw error;
}
