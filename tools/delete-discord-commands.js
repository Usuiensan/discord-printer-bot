import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const token = process.env.DISCORD_TOKEN?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();

if (!token) {
  throw new Error('DISCORD_TOKEN is missing in .env');
}

const rest = new REST({ version: '10' }).setToken(token);
const application = await rest.get(Routes.oauth2CurrentApplication());
const appId = application.id;

console.log(`Application: ${application.name} (${appId})`);

const globalCommands = await rest.put(Routes.applicationCommands(appId), {
  body: []
});
console.log(`Deleted global commands. Remaining: ${globalCommands.length}`);

if (guildId) {
  const guildCommands = await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: []
  });
  console.log(`Deleted guild commands for ${guildId}. Remaining: ${guildCommands.length}`);
} else {
  console.log('DISCORD_GUILD_ID is not set. Skipped guild command deletion.');
}
