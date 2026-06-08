import { Client, Events, GatewayIntentBits, MessageType, Partials } from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { buildPreviewText, buildPrintJob } from './discordContent.js';
import { checkPrinterProblems, sendRawToPrinter } from './printer.js';
import { buildSymbolPrintJob, parseSymbolMessageCommand } from './symbolContent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEQUENCE_STATE_PATH = join(__dirname, '..', 'run', 'print-sequence.json');
const NEAR_END_PROBLEM = 'レシート用紙残量少';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
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

function enqueueSymbolMessagePrint(message, command) {
  return enqueuePrintJob(message, 'code', async () => {
    let retryNotified = false;
    const bytes = buildSymbolPrintJob({
      ...command,
      requestedBy: message.author.tag
    }, config);

    await sendRawToPrinter(bytes, config.printerName, {
      ...config,
      onRetry: async (retry) => {
        if (retryNotified) return;
        retryNotified = true;
        await markPrintRetry(message, retry);
      }
    });
    console.log(`Printed code requested by message ${message.id} from ${message.author.tag}`);
    await markPrintSuccess(message, hasNearEndWarning());
  });
}

function enqueuePrintJob(message, label, job) {
  queuedPrintCount += 1;
  console.log(`Queued ${label} print ${message.id} from ${message.author.tag}; pending=${queuedPrintCount}`);

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
      await markPrintFailure(message, error.message).catch((reactionError) => {
        console.error('Failed to report print failure:', reactionError);
      });
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
  console.log(`Printer: ${config.printerName}`);
  console.log(`OPOS status: ${config.oposStatusEnabled ? `enabled (${config.oposLogicalName || 'no logical name'})` : 'disabled'}`);
  startPrinterMonitor(readyClient);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== config.channelId) return;
  if (!isPrintableUserMessage(message)) {
    console.log(`Skipped non-printable message ${message.id} type=${message.type}`);
    return;
  }

  try {
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

    const command = parseSymbolMessageCommand(message.content ?? '', config.messageCommandPrefix);
    if (command) {
      enqueueSymbolMessagePrint(message, command);
      await addReaction(message, '🧾');
      return;
    }
  } catch (error) {
    await markPrintFailure(message, error.message);
    return;
  }

  enqueuePrint(message);
});

function isPreviewMessageCommand(message) {
  const content = (message.content ?? '').trimStart();
  return content.toLowerCase().startsWith(`${config.messageCommandPrefix}preview`);
}

async function replyWithPreview(message) {
  const preview = buildPreviewText(message, config);
  const body = preview.length > 1800 ? `${preview.slice(0, 1800)}\n...省略` : preview;
  await replyToMessage(message, `印刷プレビュー:\n\`\`\`text\n${escapeCodeBlock(body)}\n\`\`\``);
}

function escapeCodeBlock(value) {
  return String(value).replace(/```/g, '`\\`\\`');
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
