import 'dotenv/config';
import { PermissionFlagsBits, REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (!token) {
  throw new Error('DISCORD_TOKEN is missing in .env');
}

const rest = new REST({ version: '10' }).setToken(token);
const application = await rest.get(Routes.oauth2CurrentApplication());
const appId = application.id;
const permissions = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions
].reduce((sum, permission) => sum | permission, 0n);

const inviteUrl = new URL('https://discord.com/oauth2/authorize');
inviteUrl.searchParams.set('client_id', appId);
inviteUrl.searchParams.set('scope', 'bot applications.commands');
inviteUrl.searchParams.set('permissions', permissions.toString());

console.log(`Application: ${application.name}`);
console.log(`Application ID: ${appId}`);
console.log(`Guild ID from .env: ${guildId || '(not set)'}`);
console.log(`Permission integer: ${permissions}`);
console.log('');
console.log('Use this invite URL to reinstall the bot:');
console.log(inviteUrl.toString());
console.log('');

const globalCommands = await rest.get(Routes.applicationCommands(appId));
console.log(`Global commands: ${globalCommands.length}`);
for (const command of globalCommands) {
  console.log(`- /${command.name} (${command.id})`);
}

if (guildId) {
  const guildCommands = await rest.get(Routes.applicationGuildCommands(appId, guildId));
  console.log('');
  console.log(`Guild commands for ${guildId}: ${guildCommands.length}`);
  for (const command of guildCommands) {
    console.log(`- /${command.name} (${command.id})`);
  }
}
