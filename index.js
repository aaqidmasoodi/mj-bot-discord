require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const path = require('path');

const ffmpeg = require('ffmpeg-static');
if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg;

const RADIO_FILE = path.join(__dirname, 'audio', 'radio.mp3');
const PREFIX = '!';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// guildId -> { connection, player }
const sessions = new Map();

function playRadio(player) {
  player.play(createAudioResource(RADIO_FILE));
}

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  const fs = require('fs');
  console.log(`[startup] radio file exists: ${fs.existsSync(RADIO_FILE)} | path: ${RADIO_FILE}`);
  client.user.setPresence({ activities: [{ name: '!play', type: 2 }], status: 'online' });
});

client.on('messageCreate', async (message) => {
  console.log(`[msg] author=${message.author.tag} bot=${message.author.bot} content="${message.content}"`);

  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) {
    console.log('[msg] ignored: no prefix');
    return;
  }

  const command = message.content.slice(PREFIX.length).trim().split(/ +/)[0].toLowerCase();
  console.log(`[cmd] command="${command}"`);

  try {
    switch (command) {
      case 'play': {
        const voiceChannel = message.member?.voice?.channel;
        console.log(`[play] voiceChannel=${voiceChannel?.name ?? 'none'}`);
        if (!voiceChannel) return message.reply('Join a voice channel first.');

        const perms = voiceChannel.permissionsFor(client.user);
        console.log(`[play] connect=${perms.has('Connect')} speak=${perms.has('Speak')}`);
        if (!perms.has('Connect') || !perms.has('Speak'))
          return message.reply('I need Connect and Speak permissions.');

        const existing = sessions.get(message.guild.id);
        console.log(`[play] existing session=${!!existing} status=${existing?.player.state.status ?? 'none'}`);

        if (existing) {
          if (existing.player.state.status === AudioPlayerStatus.Paused) {
            existing.player.unpause();
            return message.reply('Resumed.');
          }
          if (existing.player.state.status === AudioPlayerStatus.Playing) {
            return message.reply('Already playing.');
          }
        }

        console.log(`[play] joining channel ${voiceChannel.id}`);
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
        });

        const player = createAudioPlayer({
          behaviors: { noSubscriber: NoSubscriberBehavior.Play },
        });
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
          console.log('[player] idle — looping');
          playRadio(player);
        });
        player.on('error', (err) => console.error('[player] error:', err.message));
        player.on('stateChange', (oldState, newState) => {
          console.log(`[player] ${oldState.status} -> ${newState.status}`);
        });

        sessions.set(message.guild.id, { connection, player });

        console.log('[play] waiting for connection to be ready...');
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
        console.log('[play] connection ready, starting radio');
        playRadio(player);
        await message.reply('Now playing.');
        break;
      }

      case 'pause': {
        const session = sessions.get(message.guild.id);
        if (!session || session.player.state.status !== AudioPlayerStatus.Playing)
          return message.reply('Nothing is playing.');
        session.player.pause();
        await message.reply('Paused.');
        break;
      }

      case 'stop': {
        const session = sessions.get(message.guild.id);
        if (!session) return message.reply('Not in a voice channel.');
        session.player.removeAllListeners(AudioPlayerStatus.Idle);
        session.player.stop();
        session.connection.destroy();
        sessions.delete(message.guild.id);
        await message.reply('Stopped.');
        break;
      }
    }
  } catch (err) {
    console.error(err);
    message.channel.send(`Error: ${err.message}`).catch(() => {});
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
