const { spawn } = require('child_process');
const youtubedl = require('youtube-dl-exec');
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const YT_DLP = youtubedl.constants.YOUTUBE_DL_PATH;

class GuildQueue {
  constructor() {
    this.queue = [];
    this.connection = null;
    this.player = createAudioPlayer({ noSubscriber: NoSubscriberBehavior.Stop });
    this.loopMode = 'none';
    this.volume = 1;
    this.nowPlaying = null;
    this.textChannel = null;
    this.currentProcess = null;
    this.statusMessage = null;

    this.player.on(AudioPlayerStatus.Idle, () => {
      console.log('[AudioPlayer] status -> Idle');
      this.playNext();
    });

    this.player.on(AudioPlayerStatus.AutoPaused, () => {
      console.log('[AudioPlayer] status -> AutoPaused, stopping');
      this.player.stop();
    });

    this.player.on('error', (error) => {
      console.error('[AudioPlayer] error:', error.message);
      this.playNext();
    });

    this.player.on('stateChange', (oldState, newState) => {
      console.log('[AudioPlayer] state:', oldState.status, '->', newState.status);
    });
  }

  destroyProcess() {
    if (this.currentProcess) {
      try { this.currentProcess.kill(); } catch {}
      this.currentProcess = null;
    }
  }

  async updateStatusMessage(content) {
    if (!this.textChannel) return;
    if (this.statusMessage) {
      try {
        this.statusMessage = await this.statusMessage.edit(content);
      } catch {
        this.statusMessage = await this.textChannel.send(content);
      }
    } else {
      this.statusMessage = await this.textChannel.send(content);
    }
  }

  async playNext() {
    this.destroyProcess();
    console.log('[playNext] called, queue:', this.queue.length, 'nowPlaying:', !!this.nowPlaying, 'loop:', this.loopMode);

    if (this.queue.length === 0 && !this.nowPlaying) {
      console.log('[playNext] nothing to play');
      await this.updateStatusMessage('Queue finished.');
      return;
    }

    let song;

    if (this.loopMode === 'song' && this.nowPlaying) {
      song = this.nowPlaying;
      console.log('[playNext] looping current song');
    } else {
      if (this.queue.length === 0) {
        console.log('[playNext] queue empty, stopping');
        this.nowPlaying = null;
        await this.updateStatusMessage('Queue finished.');
        return;
      }
      song = this.queue.shift();
      if (this.loopMode === 'queue') {
        this.queue.push(song);
      }
    }

    this.nowPlaying = song;
    console.log('[playNext] playing:', song.title, 'url:', song.url);

    try {
      console.log('[playNext] spawning yt-dlp...');
      const proc = spawn(YT_DLP, [
        '-f', 'bestaudio',
        '-o', '-',
        '--no-warnings',
        '--no-playlist',
        song.url,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      this.currentProcess = proc;
      console.log('[playNext] yt-dlp spawned, pid:', proc.pid);

      let stderrBuf = '';
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString();
        console.log('[yt-dlp stderr]', chunk.toString().trim());
      });

      proc.on('error', (err) => {
        console.error('[playNext] yt-dlp process error:', err.message);
        this.playNext();
      });

      proc.on('exit', (code, signal) => {
        console.log('[playNext] yt-dlp exited code:', code, 'signal:', signal, 'killed:', proc.killed, 'stderr:', stderrBuf.slice(-200));
      });

      let audioBytes = 0;
      proc.stdout.on('data', (chunk) => {
        audioBytes += chunk.length;
      });
      proc.stdout.on('end', () => {
        console.log('[playNext] yt-dlp stdout ended, total bytes:', audioBytes);
      });
      proc.stdout.on('error', (err) => {
        console.error('[playNext] yt-dlp stdout error:', err.message);
      });

      console.log('[playNext] creating AudioResource...');
      const resource = createAudioResource(proc.stdout, {
        inlineVolume: true,
      });
      console.log('[playNext] AudioResource created, volume:', !!resource.volume, 'playStream readable:', resource.playStream.readable);
      resource.volume.setVolume(this.volume);
      console.log('[playNext] calling player.play()...');
      this.player.play(resource);
      console.log('[playNext] player state:', this.player.state.status);

      await this.updateStatusMessage(`Now playing: **${song.title}**`);
      console.log('[playNext] Now playing message sent');
    } catch (err) {
      console.error('[playNext] Stream error:', err.message, err.stack);
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
    console.log('[play] query:', trimmed);

    let url, title, duration;
    const ytMatch = trimmed.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{11})/);
    if (ytMatch) {
      const id = ytMatch[1];
      console.log('[play] direct YouTube URL, id:', id);
      const info = await youtubedl(`https://youtube.com/watch?v=${id}`, {
        dumpJson: true,
        noWarnings: true,
      });
      url = info.webpage_url || trimmed;
      title = info.title;
      duration = info.duration_string || '';
      console.log('[play] got info:', title);
    } else {
      console.log('[play] searching YouTube...');
      const result = await youtubedl(`ytsearch1:${trimmed}`, {
        flatPlaylist: true,
        dumpJson: true,
        noWarnings: true,
      });
      url = result.webpage_url;
      title = result.title;
      duration = result.duration_string || '';
      if (!url && result.id) url = `https://youtube.com/watch?v=${result.id}`;
      console.log('[play] search result:', title, url);
    }

    const song = { title, url, duration };
    console.log('[play] queued song, player idle?', guildQueue.player.state.status === AudioPlayerStatus.Idle);
    guildQueue.queue.push(song);
    if (guildQueue.player.state.status === AudioPlayerStatus.Idle) {
      console.log('[play] calling playNext()');
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
