const https = require('https');
const {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MJBot/1.0)' },
      timeout: 15000,
    }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () {
      this.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function searchArchive(query, limit = 5) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:audio&fl[]=identifier,title,creator&sort[]=downloads+desc&rows=${limit}&page=1&output=json`;
  const data = await fetchJSON(url);
  return data?.response?.docs || [];
}

async function getArchiveItem(identifier) {
  return await fetchJSON(`https://archive.org/metadata/${identifier}`);
}

function findBestAudioFile(metadata) {
  if (!metadata?.files) return null;
  const formats = ['MP3', '128Kbps MP3', 'VBR MP3', '192Kbps MP3', '256Kbps MP3', '320Kbps MP3', 'OGG', '96Kbps MP3', '64Kbps MP3'];
  for (const fmt of formats) {
    const file = metadata.files.find(f => f.format === fmt);
    if (file) return file;
  }
  return metadata.files.find(f =>
    f.source === 'original' && f.format && (f.format.includes('MP3') || f.format.includes('OGG') || f.format.includes('FLAC') || f.format.includes('PCM'))
  ) || null;
}

class GuildQueue {
  constructor() {
    this.queue = [];
    this.connection = null;
    this.player = createAudioPlayer();
    this.loopMode = 'none';
    this.volume = 1;
    this.nowPlaying = null;
    this.textChannel = null;

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playNext();
    });

    this.player.on('error', (error) => {
      console.error('Player error:', error.message);
      this.playNext();
    });
  }

  async playNext() {
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
      const resource = createAudioResource(song.url, {
        inputType: StreamType.Arbitrary,
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

    const match = query.match(/archive\.org\/(?:details|download)\/([^/\s?]+)/);
    let identifier;
    if (match) {
      identifier = match[1];
    } else {
      const results = await searchArchive(query);
      if (results.length === 0) throw new Error('No results found on Internet Archive');

      for (const result of results) {
        try {
          const metadata = await getArchiveItem(result.identifier);
          const audioFile = findBestAudioFile(metadata);
          if (!audioFile) continue;

          const parts = audioFile.name.split('/').map(encodeURIComponent).join('/');
          const song = {
            title: result.title,
            url: `https://archive.org/download/${result.identifier}/${parts}`,
            identifier: result.identifier,
            duration: audioFile.length || 'Unknown',
          };
          guildQueue.queue.push(song);
          if (guildQueue.player.state.status === AudioPlayerStatus.Idle) {
            await guildQueue.playNext();
          }
          return song;
        } catch (e) {
          console.error(`Failed to load ${result.identifier}:`, e.message);
        }
      }
      throw new Error('No playable audio found in search results');
    }

    const metadata = await getArchiveItem(identifier);
    const audioFile = findBestAudioFile(metadata);
    if (!audioFile) throw new Error('No audio files in that item');

    const parts = audioFile.name.split('/').map(encodeURIComponent).join('/');
    const song = {
      title: metadata?.metadata?.title || identifier,
      url: `https://archive.org/download/${identifier}/${parts}`,
      identifier,
      duration: audioFile.length || 'Unknown',
    };
    guildQueue.queue.push(song);
    if (guildQueue.player.state.status === AudioPlayerStatus.Idle) {
      await guildQueue.playNext();
    }
    return song;
  }

  skip(guildId) {
    const guildQueue = this.getQueue(guildId);
    if (guildQueue.player.state.status !== AudioPlayerStatus.Idle) {
      guildQueue.player.stop();
      return true;
    }
    return false;
  }

  stop(guildId) {
    const guildQueue = this.getQueue(guildId);
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
