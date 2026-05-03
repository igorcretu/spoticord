const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

function buildSlashCommands() {
  return [
    new SlashCommandBuilder().setName('start').setDescription('Start or resume session'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop active session'),
    new SlashCommandBuilder().setName('status').setDescription('Show service status'),
    new SlashCommandBuilder().setName('session').setDescription('Show current session host'),
    new SlashCommandBuilder().setName('queue').setDescription('Show recent queued items'),
    new SlashCommandBuilder()
      .setName('dequeue')
      .setDescription('Remove an item from local queue history')
      .addIntegerOption((o) => o.setName('index').setDescription('1-based index').setRequired(true)),
    new SlashCommandBuilder().setName('diagnostics').setDescription('Show runtime diagnostics'),
    new SlashCommandBuilder().setName('dashboard').setDescription('Show public monitoring dashboard link'),
    new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
    new SlashCommandBuilder()
      .setName('transferhost')
      .setDescription('Transfer session ownership to another user in voice')
      .addUserOption((o) => o.setName('user').setDescription('New host').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('setchannel')
      .setDescription('Set default voice channel from your current channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('restart')
      .setDescription('Restart librespot bridge')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ].map((c) => c.toJSON());
}

module.exports = {
  buildSlashCommands,
};
