require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { AudioPlayerStatus } = require('@discordjs/voice');
const MusicPlayer = require('./src/player');

const ffmpeg = require('ffmpeg-static');
if (ffmpeg) {
  process.env.FFMPEG_PATH = ffmpeg;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const player = new MusicPlayer();
const PREFIX = '!';

client.on('error', (err) => console.error('Client error:', err.message));

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: '!play', type: 2 }],
    status: 'online',
  });
});

client.on('messageCreate', async (message) => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  try {
    switch (command) {
      case 'play':
      case 'p': {
        if (!args.length) {
          return message.reply('Usage: !play <song name or URL>');
        }

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
          return message.reply('You need to be in a voice channel first.');
        }

        const perms = voiceChannel.permissionsFor(client.user);
        if (!perms.has('Connect') || !perms.has('Speak')) {
          return message.reply('I need Connect and Speak permissions in that channel.');
        }

        const guildQueue = player.getQueue(message.guild.id);
        if (
          !guildQueue.connection ||
          guildQueue.connection.state.status === 'disconnected'
        ) {
          await player.joinVoiceChannel(voiceChannel);
        } else if (guildQueue.connection && voiceChannel.id !== guildQueue.connection.joinConfig.channelId) {
          guildQueue.connection.destroy();
          await player.joinVoiceChannel(voiceChannel);
        }

        guildQueue.textChannel = message.channel;
        const status = guildQueue.player.state.status;
        const isIdle = status === AudioPlayerStatus.Idle;

        const rep = await message.reply('Searching...');

        const result = await player.play(message.guild.id, args.join(' '));

        if (result.type === 'playlist') {
          await rep.edit(`Added **${result.count}** songs from playlist: **${result.name}**`);
        } else {
          const prefix = isIdle ? 'Now playing' : 'Added to queue';
          await rep.edit(`${prefix}: **${result.title}**`);
        }
        break;
      }

      case 'skip':
      case 's': {
        const skipped = player.skip(message.guild.id);
        if (skipped) {
          await message.reply('Skipped.');
        } else {
          await message.reply('Nothing to skip.');
        }
        break;
      }

      case 'stop':
      case 'leave':
      case 'disconnect': {
        const gq = player.getQueue(message.guild.id);
        if (!gq.connection || gq.connection.state.status === 'disconnected') {
          return message.reply('Not in a voice channel.');
        }
        player.stop(message.guild.id);
        await message.reply('Disconnected.');
        break;
      }

      case 'queue':
      case 'q': {
        const s = player.getStatus(message.guild.id);
        if (!s.nowPlaying && s.queue.length === 0) {
          return message.reply('Queue is empty.');
        }

        const embed = new EmbedBuilder().setColor(0x0099ff).setTitle('Music Queue');

        if (s.nowPlaying) {
          embed.addFields({
            name: 'Now Playing',
            value: `**${s.nowPlaying.title}**`,
          });
        }

        if (s.queue.length > 0) {
          const lines = s.queue.map((song, i) => `${i + 1}. ${song.title}`).join('\n');
          embed.addFields({
            name: `Up Next (${s.queue.length})`,
            value: lines.length > 1024 ? lines.slice(0, 1020) + '...' : lines,
          });
        }

        await message.channel.send({ embeds: [embed] });
        break;
      }

      case 'pause': {
        player.pause(message.guild.id);
        await message.reply('Paused.');
        break;
      }

      case 'resume': {
        player.resume(message.guild.id);
        await message.reply('Resumed.');
        break;
      }

      case 'nowplaying':
      case 'np': {
        const s = player.getStatus(message.guild.id);
        if (!s.nowPlaying) {
          return message.reply('Nothing is playing.');
        }
        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle('Now Playing')
          .setDescription(`**${s.nowPlaying.title}**`)
          .addFields(
            { name: 'Duration', value: s.nowPlaying.duration || 'Unknown', inline: true },
            { name: 'Loop', value: s.loopMode, inline: true },
            { name: 'Volume', value: `${Math.round(s.volume * 100)}%`, inline: true },
          );
        await message.channel.send({ embeds: [embed] });
        break;
      }

      case 'loop': {
        const mode = (args[0] || '').toLowerCase();
        if (!['none', 'song', 'queue'].includes(mode)) {
          return message.reply('Usage: !loop <none|song|queue>');
        }
        player.setLoop(message.guild.id, mode);
        await message.reply(`Loop set to: **${mode}**`);
        break;
      }

      case 'volume':
      case 'vol': {
        const vol = parseInt(args[0], 10);
        if (isNaN(vol) || vol < 0 || vol > 200) {
          return message.reply('Usage: !volume <0-200>');
        }
        player.setVolume(message.guild.id, vol);
        await message.reply(`Volume set to **${vol}%**`);
        break;
      }

      case 'shuffle': {
        player.shuffle(message.guild.id);
        await message.reply('Queue shuffled.');
        break;
      }

      case 'remove': {
        const idx = parseInt(args[0], 10) - 1;
        const removed = player.remove(message.guild.id, idx);
        if (!removed) {
          return message.reply('Invalid index. Use !queue to see positions.');
        }
        await message.reply(`Removed **${removed.title}** from queue.`);
        break;
      }

      case 'clear': {
        player.clear(message.guild.id);
        await message.reply('Queue cleared.');
        break;
      }

      case 'help': {
        const embed = new EmbedBuilder()
          .setColor(0x0099ff)
          .setTitle('Music Bot Commands')
          .setDescription(
            [
              '`!play <name/url>` — Play a song or playlist',
              '`!skip` — Skip current song',
              '`!stop` — Stop and disconnect',
              '`!queue` — Show the queue',
              '`!pause` — Pause playback',
              '`!resume` — Resume playback',
              '`!nowplaying` — Show current song',
              '`!loop <none/song/queue>` — Set loop mode',
              '`!volume <0-200>` — Set volume',
              '`!shuffle` — Shuffle the queue',
              '`!remove <n>` — Remove song at position n',
              '`!clear` — Clear the queue',
              '`!help` — Show this message',
            ].join('\n'),
          );
        await message.channel.send({ embeds: [embed] });
        break;
      }

      default:
        await message.reply(`Unknown command. Use \`!help\` for available commands.`);
    }
  } catch (error) {
    console.error(error);
    const reply = message.channel
      ? message.channel.send(`Error: ${error.message}`)
      : Promise.resolve();
    await reply;
  }
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err.message);
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err.message);
});
