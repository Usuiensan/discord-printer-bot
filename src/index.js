import { AttachmentBuilder, Client, Events, GatewayIntentBits, MessageType, Partials } from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { buildMemberJoinPrintJob, buildPreviewImage, buildPrintJob } from './discordContent.js';
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

function enqueuePrint(message) {
  enqueuePrintJob(message, 'message', async () => {
    const omitHeader = shouldOmitHeader(message);
    const printNumber = omitHeader ? null : await peekNextPrintNumber();
    let retryNotified = false;
    const { bytes, warnings } = await buildPrintJob(message, config, {
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
    if (printNumber) {
      await commitPrintNumber(printNumber);
    }
    lastPrintedMessage = {
      authorId: message.author.id,
      createdTimestamp: message.createdTimestamp
    };
    if (warnings.length > 0) {
      await markPrintWarning(message, warnings);
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
    const { bytes, warnings } = await buildPrintJob(targetMessage, config, {
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
    await commitPrintNumber(printNumber);
    lastPrintedMessage = {
      authorId: targetMessage.author.id,
      createdTimestamp: targetMessage.createdTimestamp
    };
    if (warnings.length > 0) {
      await markPrintWarning(message, warnings);
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

async function markPrintWarning(message, warnings) {
  await removeBotReaction(message, config.printedReaction).catch((error) => {
    console.error(`Failed to remove success reaction from message ${message.id}:`, error);
  });
  await removeBotReaction(message, config.printNearEndReaction).catch((error) => {
    console.error(`Failed to remove near-end reaction from message ${message.id}:`, error);
  });
  await addReaction(message, config.printErrorReaction);

  const warningText = warnings.slice(0, 5).map((warning) => `- ${warning}`).join('\n');
  const more = warnings.length > 5 ? `\n...ほか ${warnings.length - 5} 件` : '';
  const intro = warnings.every((warning) => warning.includes('を「') && warning.includes('に置換しました'))
    ? '印刷は完了しましたが、文字を置換しました。'
    : '印刷は完了しましたが、一部の内容を印刷できませんでした。';
  await replyToMessage(message, `${intro}\n${warningText}${more}`);
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

async function replyToMessage(message, content) {
  try {
    await message.reply({
      content,
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
  console.log(`Watching channel ${config.channelId}`);
  const watchedChannel = await readyClient.channels.fetch(config.channelId).catch((error) => {
    console.error(`Failed to fetch watched channel ${config.channelId}: ${error.message}`);
    return null;
  });
  if (watchedChannel) {
    console.log(`Watched channel resolved: ${watchedChannel.name ?? '(no name)'} (${watchedChannel.type})`);
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
    console.log(`Ignored message ${message.id} from channel ${message.channelId}; watching ${config.channelId}`);
    return;
  }
  if (!isPrintableUserMessage(message)) {
    console.log(`Skipped non-printable message ${message.id} type=${message.type}`);
    return;
  }

  try {
    // Message commands are checked before normal printing so command messages
    // do not consume print numbers or enter the printer queue.
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

client.on(Events.GuildMemberAdd, (member) => {
  if (!config.memberJoinPrintEnabled) return;
  if (config.guildId && member.guild.id !== config.guildId) return;

  console.log(`Guild member joined: ${member.user.tag ?? member.user.username} (${member.user.id})`);
  enqueueMemberJoinPrint(member);
});

function isWatchedChannelMessage(message) {
  if (message.channelId === config.channelId) return true;
  return message.channel?.isThread?.() && message.channel.parentId === config.channelId;
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
  const match = String(value).match(/^https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d+\/(\d+)\/(\d+)$/i)
    ?? String(value).match(/^https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(@me|\d+)\/(\d+)\/(\d+)$/i);
  if (!match) return null;
  return {
    channelId: match[1] === '@me' ? null : match[1],
    messageId: match[2] ?? match[3]
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
    const channel = await readyClient.channels.fetch(config.channelId);
    if (!channel?.isTextBased()) {
      console.error(`Printer monitor channel is not text based: ${config.channelId}`);
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
