const { spawn } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const YT_DLP = youtubedl.constants.YOUTUBE_DL_PATH;

class GuildQueue {
  constructor() {
    this.queue = [];
    this.connection = null;
    this.player = createAudioPlayer();
    this.loopMode = 'none';
    this.volume = 1;
    this.nowPlaying = null;
    this.textChannel = null;
    this.currentProcess = null;

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playNext();
    });

    this.player.on('error', (error) => {
      console.error('Player error:', error.message);
      this.playNext();
    });
  }

  destroyProcess() {
    if (this.currentProcess) {
      try { this.currentProcess.kill(); } catch {}
      this.currentProcess = null;
    }
  }

  async playNext() {
    this.destroyProcess();

    if (this.queue.length === 0 && !this.nowPlaying) {
      if (this.textChannel) {
        this.textChannel.send('Queue finished.');
      }
      return;
    }

    let song;

    if (this.loopMode === 'song' && this.nowPlaying) {
      song = this.nowPlaying;
    } else {
      if (this.queue.length === 0) {
        this.nowPlaying = null;
        if (this.textChannel) {
          this.textChannel.send('Queue finished.');
        }
        return;
      }
      song = this.queue.shift();
      if (this.loopMode === 'queue') {
        this.queue.push(song);
      }
    }

    this.nowPlaying = song;

    try {
      const proc = spawn(YT_DLP, [
        '-f', 'bestaudio',
        '-o', '-',
        '--no-warnings',
        '--no-playlist',
        song.url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      this.currentProcess = proc;

      proc.stderr.on('data', () => {});

      proc.on('error', (err) => {
        console.error('yt-dlp error:', err.message);
        this.playNext();
      });

      proc.on('exit', (code) => {
        if (code !== 0 && !proc.killed) {
          console.error('yt-dlp exited with code', code);
        }
      });

      const resource = createAudioResource(proc.stdout, {
        inlineVolume: true,
      });
      resource.volume.setVolume(this.volume);
      this.player.play(resource);

      if (this.textChannel) {
        this.textChannel.send(`Now playing: **${song.title}**`);
      }
    } catch (err) {
      console.error('Stream error:', err.message);
      this.playNext();
    }
  }
}

class MusicPlayer {
  constructor() {
    this.queues = new Map();
  }

  getQueue(guildId) {
    if (!this.queues.has(guildId)) {
      this.queues.set(guildId, new GuildQueue());
    }
    return this.queues.get(guildId);
  }

  async joinVoiceChannel(channel) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    const guildQueue = this.getQueue(channel.guild.id);
    guildQueue.connection = connection;
    connection.subscribe(guildQueue.player);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        guildQueue.player.stop();
        this.queues.delete(channel.guild.id);
      }
    });

    return connection;
  }

  async play(guildId, query) {
    const guildQueue = this.getQueue(guildId);
    const trimmed = query.trim();

    let url, title, duration;
    const ytMatch = trimmed.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
    if (ytMatch) {
      const id = ytMatch[1];
      const info = await youtubedl(`https://youtube.com/watch?v=${id}`, {
        dumpJson: true,
        noWarnings: true,
      });
      url = info.webpage_url || trimmed;
      title = info.title;
      duration = info.duration_string || '';
    } else {
      const result = await youtubedl(`ytsearch1:${trimmed}`, {
        flatPlaylist: true,
        dumpJson: true,
        noWarnings: true,
      });
      url = result.webpage_url;
      title = result.title;
      duration = result.duration_string || '';
      if (!url && result.id) url = `https://youtube.com/watch?v=${result.id}`;
    }

    const song = { title, url, duration };
    guildQueue.queue.push(song);
    if (guildQueue.player.state.status === AudioPlayerStatus.Idle) {
      await guildQueue.playNext();
    }
    return song;
  }

  skip(guildId) {
    const guildQueue = this.getQueue(guildId);
    if (guildQueue.player.state.status !== AudioPlayerStatus.Idle) {
      guildQueue.destroyProcess();
      guildQueue.player.stop();
      return true;
    }
    return false;
  }

  stop(guildId) {
    const guildQueue = this.getQueue(guildId);
    guildQueue.destroyProcess();
    guildQueue.queue = [];
    guildQueue.player.stop(true);
    guildQueue.nowPlaying = null;
    if (guildQueue.connection) {
      guildQueue.connection.destroy();
    }
    this.queues.delete(guildId);
  }

  pause(guildId) {
    const guildQueue = this.getQueue(guildId);
    guildQueue.player.pause();
  }

  resume(guildId) {
    const guildQueue = this.getQueue(guildId);
    guildQueue.player.unpause();
  }

  setVolume(guildId, volume) {
    const guildQueue = this.getQueue(guildId);
    guildQueue.volume = volume / 100;
    const resource = guildQueue.player.state.resource;
    if (resource?.volume) {
      resource.volume.setVolume(guildQueue.volume);
    }
  }

  setLoop(guildId, mode) {
    const guildQueue = this.getQueue(guildId);
    guildQueue.loopMode = mode;
  }

  shuffle(guildId) {
    const guildQueue = this.getQueue(guildId);
    const arr = guildQueue.queue;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  remove(guildId, index) {
    const guildQueue = this.getQueue(guildId);
    if (index >= 0 && index < guildQueue.queue.length) {
      return guildQueue.queue.splice(index, 1)[0];
    }
    return null;
  }

  clear(guildId) {
    const guildQueue = this.getQueue(guildId);
    guildQueue.queue = [];
  }

  getStatus(guildId) {
    const guildQueue = this.getQueue(guildId);
    const status = guildQueue.player.state.status;
    return {
      nowPlaying: guildQueue.nowPlaying,
      queue: guildQueue.queue,
      loopMode: guildQueue.loopMode,
      volume: guildQueue.volume,
      playing: status === AudioPlayerStatus.Playing,
      paused: status === AudioPlayerStatus.Paused,
    };
  }
}

module.exports = MusicPlayer;
