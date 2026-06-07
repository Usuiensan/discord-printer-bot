import { Client, Events, GatewayIntentBits, MessageType, Partials } from 'discord.js';
import { config } from './config.js';
import { buildPrintJob } from './discordContent.js';
import { sendRawToPrinter } from './printer.js';
import { buildSymbolPrintJob, parseSymbolMessageCommand } from './symbolContent.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

let queue = Promise.resolve();
let lastPrintedMessage = null;

function enqueuePrint(message) {
  queue = queue
    .then(async () => {
      const omitHeader = shouldOmitHeader(message);
      const { bytes, warnings } = await buildPrintJob(message, config, {
        printHeader: !omitHeader
      });
      await sendRawToPrinter(bytes, config.printerName, config);
      lastPrintedMessage = {
        authorId: message.author.id,
        createdTimestamp: message.createdTimestamp
      };
      if (warnings.length > 0) {
        await markPrintWarning(message, warnings);
        console.log(`Printed message ${message.id} from ${message.author.tag} with ${warnings.length} warning(s)`);
      } else {
        await markPrintSuccess(message);
        console.log(`Printed message ${message.id} from ${message.author.tag}`);
      }
    })
    .catch(async (error) => {
      console.error('Print failed:', error);
      await markPrintFailure(message, error.message).catch((reactionError) => {
        console.error('Failed to report print failure:', reactionError);
      });
    });
}

function shouldOmitHeader(message) {
  if (!lastPrintedMessage) return false;
  if (lastPrintedMessage.authorId !== message.author.id) return false;

  const delta = message.createdTimestamp - lastPrintedMessage.createdTimestamp;
  return delta >= 0 && delta <= config.mergeSameUserWindowMs;
}

function enqueueSymbolMessagePrint(message, command) {
  const job = queue.then(async () => {
    const bytes = buildSymbolPrintJob({
      ...command,
      requestedBy: message.author.tag
    }, config);

    await sendRawToPrinter(bytes, config.printerName, config);
    console.log(`Printed code requested by message ${message.id} from ${message.author.tag}`);
  });

  queue = job.catch((error) => {
    console.error('Message code print failed:', error);
  });

  return job;
}

async function markPrintSuccess(message) {
  if (!config.printedReaction) return;

  try {
    await removeBotReaction(message, config.printErrorReaction);
    await message.react(config.printedReaction);
  } catch (error) {
    console.error(`Printed, but failed to add reaction to message ${message.id}:`, error);
  }
}

async function markPrintWarning(message, warnings) {
  await removeBotReaction(message, config.printedReaction).catch((error) => {
    console.error(`Failed to remove success reaction from message ${message.id}:`, error);
  });
  await addReaction(message, config.printErrorReaction);

  const warningText = warnings.slice(0, 5).map((warning) => `- ${warning}`).join('\n');
  const more = warnings.length > 5 ? `\n...ほか ${warnings.length - 5} 件` : '';
  await replyToMessage(message, `印刷は完了しましたが、一部の内容を印刷できませんでした。\n${warningText}${more}`);
}

async function markPrintFailure(message, reason) {
  await removeBotReaction(message, config.printedReaction).catch((error) => {
    console.error(`Failed to remove success reaction from message ${message.id}:`, error);
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
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== config.channelId) return;
  if (!isPrintableUserMessage(message)) {
    console.log(`Skipped non-printable message ${message.id} type=${message.type}`);
    return;
  }

  try {
    const command = parseSymbolMessageCommand(message.content ?? '', config.messageCommandPrefix);
    if (command) {
      await addReaction(message, '🧾');
      enqueueSymbolMessagePrint(message, command)
        .then(() => markPrintSuccess(message))
        .catch((error) => markPrintFailure(message, error.message));
      return;
    }
  } catch (error) {
    await markPrintFailure(message, error.message);
    return;
  }

  enqueuePrint(message);
});

function isPrintableUserMessage(message) {
  return message.type === MessageType.Default || message.type === MessageType.Reply;
}

process.on('SIGINT', async () => {
  console.log('Shutting down...');
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
