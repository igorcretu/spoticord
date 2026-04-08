require('dotenv').config();
const {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
} = require('discord.js');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState,
  StreamType, NoSubscriberBehavior,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN         = process.env.DISCORD_TOKEN;
const DISCORD_PREFIX        = process.env.DISCORD_PREFIX || '!';
const PIPE_PATH             = process.env.PIPE_PATH || '/tmp/audio/spotify.pcm';
const LIBRESPOT_API         = process.env.LIBRESPOT_API_URL || 'http://librespot:5050';
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI;
const CONFIG_FILE           = process.env.CONFIG_FILE || '/data/guild_config.json';
const TOKEN_DIR             = process.env.TOKEN_DIR || '/data/tokens';
const IDLE_LEAVE_MS         = 5 * 60 * 1000;
const LIBRESPOT_EVENT_POLL_MS = 250;

// ── Logging ───────────────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log( `[${new Date().toISOString()}] [INFO]`, ...a),
  warn:  (...a) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...a),
  debug: (...a) => console.log( `[${new Date().toISOString()}] [DEBUG]`, ...a),
};

process.on('unhandledRejection', e => log.error('Unhandled rejection:', e));
process.on('uncaughtException',  e => { log.error('Uncaught exception:', e); process.exit(1); });

// ── Config helpers ────────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveConfig(d) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(d, null, 2));
}
function setChannel(guildId, channelId) {
  const d = loadConfig(); d[String(guildId)] = String(channelId); saveConfig(d);
}

// ── Spotify auth ──────────────────────────────────────────────────────────────
function loadToken(discordId) {
  try { return JSON.parse(fs.readFileSync(path.join(TOKEN_DIR, `${discordId}.json`), 'utf8')); }
  catch { return null; }
}
async function refreshToken(discordId) {
  const t = loadToken(discordId);
  if (!t) return null;
  if (t.expires_at && Date.now() / 1000 < t.expires_at - 60) return t;
  try {
    const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token }),
    });
    const data = await r.json();
    if (data.access_token) {
      Object.assign(t, { access_token: data.access_token, expires_at: Date.now() / 1000 + (data.expires_in || 3600) });
      if (data.refresh_token) t.refresh_token = data.refresh_token;
      fs.writeFileSync(path.join(TOKEN_DIR, `${discordId}.json`), JSON.stringify(t, null, 2));
    }
    return t;
  } catch (e) { log.warn('Token refresh:', e.message); return t; }
}
function authUrl(discordId) {
  return 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID, response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: 'user-read-playback-state user-modify-playback-state user-read-currently-playing streaming user-read-private',
    state: String(discordId), show_dialog: 'false',
  });
}

async function sendSpotifyLoginPrompt(user, prefix = DISCORD_PREFIX) {
  const link = authUrl(user.id);
  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setTitle('Link your Spotify account to Nikitify')
    .setDescription(
      `[Click here to connect your Spotify ->](${link})\n\nAfter logging in, return to Discord and run ${prefix}start again.`
    )
    .setFooter({ text: 'Nikitify  ·  Spotify Connect' });

  try {
    await user.send({ embeds: [embed] });
    return true;
  } catch (e) {
    log.warn(`Failed to DM Spotify link to ${user.tag}: ${e.message}`);
    return false;
  }
}

async function spotifyApi(token, endpoint, method = 'GET', body = null) {
  const opts = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(`https://api.spotify.com/v1${endpoint}`, opts);
  if (r.status === 204 || r.status === 202) return {};
  return r.json();
}

// ── Now playing ───────────────────────────────────────────────────────────────
async function getNowPlaying(discordId) {
  const token = await refreshToken(discordId);
  if (!token) return null;
  try {
    const data = await spotifyApi(token.access_token, '/me/player/currently-playing');
    if (!data?.item) return null;
    const track = data.item;
    return {
      trackId:   track.id,
      title:     track.name,
      artist:    track.artists.map(a => a.name).join(', '),
      album:     track.album.name,
      albumArt:  track.album.images[0]?.url || null,
      duration:  track.duration_ms,
      progress:  data.progress_ms,
      isPlaying: data.is_playing,
      trackUrl:  track.external_urls.spotify,
    };
  } catch (e) { log.warn('getNowPlaying error:', e.message); return null; }
}

function msToTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function progressBar(progress, duration, width = 17) {
  const pct = Math.min(progress / duration, 1);
  const pos = Math.round(pct * width);
  return '─'.repeat(pos) + '◉' + '─'.repeat(width - pos);
}
function buildEmbed(np, hostName) {
  const bar = progressBar(np.progress, np.duration);
  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setAuthor({ name: 'Now Playing on Nikitify', iconURL: 'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png' })
    .setTitle(np.title).setURL(np.trackUrl)
    .setDescription(`by **${np.artist}**  ·  *${np.album}*`)
    .addFields({ name: `${msToTime(np.progress)}  ${bar}  ${msToTime(np.duration)}`, value: `${np.isPlaying ? '**Playing**' : '**Paused**'}  ·  Host: **${hostName}**` })
    .setFooter({ text: 'Nikitify  ·  Spotify Connect' }).setTimestamp();
  if (np.albumArt) embed.setThumbnail(np.albumArt);
  return embed;
}
function buildControls(isPlaying) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sp_prev').setLabel('|<<').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sp_playpause').setLabel(isPlaying ? '||' : '>').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('sp_next').setLabel('>>|').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('sp_stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
  );
}

// ── Audio state ───────────────────────────────────────────────────────────────
const sessions   = {};
const guildState = {};
const autoJoinDisabled = new Set();

function disableAutoJoin(guildId, reason = 'manual') {
  autoJoinDisabled.add(String(guildId));
  log.info(`[${guildId}] Auto-join disabled (${reason})`);
}

function enableAutoJoin(guildId, reason = 'manual') {
  autoJoinDisabled.delete(String(guildId));
  log.info(`[${guildId}] Auto-join enabled (${reason})`);
}

function killFfmpeg(guildId) {
  const s = guildState[guildId];
  if (s?.ffmpeg) {
    log.debug(`[${guildId}] killFfmpeg: killing pid ${s.ffmpeg.pid}`);
    try { s.ffmpeg.kill('SIGKILL'); } catch (e) { log.debug(`[${guildId}] killFfmpeg error: ${e.message}`); }
    s.ffmpeg = null;
  } else {
    log.debug(`[${guildId}] killFfmpeg: no ffmpeg running`);
  }
}

function cancelRestart(guildId) {
  const s = guildState[guildId];
  if (s?.restartTimer) {
    clearTimeout(s.restartTimer);
    s.restartTimer = null;
    log.debug(`[${guildId}] cancelRestart`);
  }
}

function shouldAutoRestart(guildId) {
  const session = sessions[guildId];
  return Boolean(session && session.lastIsPlaying === true);
}

function scheduleRestart(guildId, delayMs, reason = 'unspecified') {
  const s = guildState[guildId];
  if (!s) return;
  cancelRestart(guildId);
  s.restartTimer = setTimeout(() => {
    const gs = guildState[guildId];
    if (!gs) return;
    gs.restartTimer = null;
    if (!shouldAutoRestart(guildId)) {
      log.debug(`[${guildId}] scheduleRestart skipped (${reason}) - not playing`);
      return;
    }
    startStreaming(guildId);
  }, delayMs);
  log.debug(`[${guildId}] scheduleRestart in ${delayMs}ms (${reason})`);
}

function stopPlayer(guildId) {
  const s = guildState[guildId];
  if (!s?.player) return;
  try {
    // Force stop drops currently buffered packets from the active resource.
    s.player.stop(true);
    log.debug(`[${guildId}] stopPlayer: forced stop`);
  } catch (e) {
    log.debug(`[${guildId}] stopPlayer error: ${e.message}`);
  }
}

function pausePlayer(guildId) {
  const s = guildState[guildId];
  if (!s?.player) return false;
  try {
    const ok = s.player.pause(true);
    log.debug(`[${guildId}] pausePlayer: ${ok}`);
    return ok;
  } catch (e) {
    log.debug(`[${guildId}] pausePlayer error: ${e.message}`);
    return false;
  }
}

function resumePlayer(guildId) {
  const s = guildState[guildId];
  if (!s?.player) return false;
  try {
    const ok = s.player.unpause();
    log.debug(`[${guildId}] resumePlayer: ${ok}`);
    return ok;
  } catch (e) {
    log.debug(`[${guildId}] resumePlayer error: ${e.message}`);
    return false;
  }
}

async function endSession(guildId, reason = 'Session ended.') {
  const session = sessions[guildId];
  if (!session) return;
  if (session.npMessage) {
    try {
      await session.npMessage.edit({
        embeds: [new EmbedBuilder().setColor(0x555555).setDescription(reason)],
        components: [],
      });
    } catch {}
  }
  delete sessions[guildId];
}

async function leaveVoiceDueToIdle(guildId) {
  const s = guildState[guildId];
  if (!s || s.leavingForIdle) return;
  s.leavingForIdle = true;
  cancelRestart(guildId);
  disableAutoJoin(guildId, 'idle-timeout');
  stopPlayer(guildId);
  killFfmpeg(guildId);
  try { s.connection?.destroy(); } catch {}
  delete guildState[guildId];
  await endSession(guildId, 'Session ended due to 2 minutes of inactivity.');
  log.info(`[${guildId}] Left voice due to inactivity timeout`);
}

async function terminateGuildPlayback(guildId, reason = 'Session ended.') {
  cancelRestart(guildId);
  disableAutoJoin(guildId, 'stop command');
  stopPlayer(guildId);
  killFfmpeg(guildId);
  const s = guildState[guildId];
  if (s?.connection) {
    try { s.connection.destroy(); } catch {}
  }
  delete guildState[guildId];
  await endSession(guildId, reason);
  log.info(`[${guildId}] Playback terminated and voice disconnected`);
}

function flushPipe() {
  if (!fs.existsSync(PIPE_PATH)) { log.debug('flushPipe: pipe does not exist'); return; }
  try {
    const fd  = fs.openSync(PIPE_PATH, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const buf = Buffer.alloc(65536);
    let total = 0;
    try { let n; while ((n = fs.readSync(fd, buf, 0, 65536, null)) > 0) total += n; } catch {}
    fs.closeSync(fd);
    log.debug(`flushPipe: drained ${total} bytes (${(total/176400).toFixed(3)}s)`);
  } catch (e) { log.debug(`flushPipe error: ${e.message}`); }
}

function waitForAudio(guildId, cb) {
  log.debug(`[${guildId}] waitForAudio: polling...`);
  const check = () => {
    if (!fs.existsSync(PIPE_PATH)) {
      log.debug(`[${guildId}] waitForAudio: pipe missing, retrying...`);
      setTimeout(check, 80); return;
    }
    let fd;
    try {
      fd = fs.openSync(PIPE_PATH, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const buf = Buffer.alloc(4096);
      const n   = fs.readSync(fd, buf, 0, 4096, null);
      fs.closeSync(fd);
      if (n > 0) {
        log.debug(`[${guildId}] waitForAudio: got ${n} bytes, proceeding`);
        cb(); return;
      }
      log.debug(`[${guildId}] waitForAudio: pipe empty, retrying...`);
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      log.debug(`[${guildId}] waitForAudio: read error: ${e.message}`);
    }
    setTimeout(check, 80);
  };
  check();
}

function startStreaming(guildId) {
  const s = guildState[guildId];
  if (autoJoinDisabled.has(String(guildId))) {
    log.debug(`[${guildId}] startStreaming: auto-join disabled`);
    return;
  }
  if (!s?.player || !s?.connection) { log.debug(`[${guildId}] startStreaming: no player/connection`); return; }
  const status = s.player.state.status;
  if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering) {
    log.debug(`[${guildId}] startStreaming: already ${status}, skipping`);
    return;
  }

  killFfmpeg(guildId);
  log.debug(`[${guildId}] Spawning FFmpeg`);
  const ff = spawn('ffmpeg', [
    '-loglevel', 'warning',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-flush_packets', '1',
    '-f', 's16le', '-ar', '44100', '-ac', '2',
    '-i', PIPE_PATH,
    '-c:a', 'libopus', '-b:a', '128k',
    '-ar', '48000', '-ac', '2',
    '-frame_duration', '20',
    '-f', 'ogg', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  s.ffmpeg = ff;
  log.debug(`[${guildId}] FFmpeg spawned pid=${ff.pid}`);

  ff.stderr.on('data', d => log.debug(`[${guildId}] ffmpeg: ${d.toString().trim()}`));
  ff.on('error', e => { log.error(`[${guildId}] ffmpeg spawn error:`, e.message); if (s) s.ffmpeg = null; });
  ff.on('close', code => {
    log.debug(`[${guildId}] ffmpeg exited code=${code}`);
    if (s) s.ffmpeg = null;
  });

  const resource = createAudioResource(ff.stdout, { inputType: StreamType.OggOpus, inlineVolume: true });
  resource.volume?.setVolume(0.8);
  s.player.play(resource);
  log.info(`[${guildId}] Streaming started`);
}

async function connectAndStream(guild, channelId) {
  if (autoJoinDisabled.has(String(guild.id))) {
    log.debug(`[${guild.id}] connectAndStream: auto-join disabled, skipping`);
    return;
  }
  const channel = guild.channels.cache.get(String(channelId));
  if (!channel) { log.warn(`Channel ${channelId} not found`); return; }

  const existing = guildState[guild.id];
  if (existing?.connection && existing?.player) {
    const st = existing.connection.state.status;
    log.debug(`[${guild.id}] connectAndStream: existing conn status=${st}`);
    if (st === VoiceConnectionStatus.Ready || st === VoiceConnectionStatus.Signalling) {
      startStreaming(guild.id); return;
    }
  }

  if (existing?.connection) { try { existing.connection.destroy(); } catch {} }
  killFfmpeg(guild.id);

  const connection = joinVoiceChannel({
    channelId: String(channelId), guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator, selfDeaf: false,
  });
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  guildState[guild.id] = {
    connection,
    player,
    ffmpeg: null,
    idleSince: Date.now(),
    leavingForIdle: false,
    restartTimer: null,
  };
  connection.subscribe(player);

  log.info(`[${guild.id}] Connecting to: ${channel.name}`);
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    log.info(`[${guild.id}] Voice ready`);
  } catch (e) {
    log.error(`[${guild.id}] Voice failed:`, e.message);
    connection.destroy(); delete guildState[guild.id]; return;
  }

  player.on(AudioPlayerStatus.Idle, () => {
    log.debug(`[${guild.id}] Player went Idle`);
    const gs = guildState[guild.id];
    if (gs && !gs.idleSince) gs.idleSince = Date.now();
    scheduleRestart(guild.id, 1500, 'player-idle');
  });
  player.on(AudioPlayerStatus.Playing, () => {
    const gs = guildState[guild.id];
    if (gs) gs.idleSince = null;
  });
  player.on('error', e => {
    log.error(`[${guild.id}] Player error:`, e.message);
    killFfmpeg(guild.id);
    scheduleRestart(guild.id, 3000, 'player-error');
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    log.warn(`[${guild.id}] Voice disconnected`);
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      log.info(`[${guild.id}] Reconnecting...`);
    } catch {
      const stillInVoice = Boolean(guild.members.me?.voice?.channelId);
      if (!stillInVoice) {
        // If we were kicked/disconnected from the channel, do not force rejoin.
        disableAutoJoin(guild.id, 'disconnected/kicked');
        cancelRestart(guild.id);
        connection.destroy(); delete guildState[guild.id]; killFfmpeg(guild.id);
        return;
      }

      if (autoJoinDisabled.has(String(guild.id))) {
        cancelRestart(guild.id);
        connection.destroy(); delete guildState[guild.id]; killFfmpeg(guild.id);
        return;
      }

      log.warn(`[${guild.id}] Reconnect failed, retrying in 10s`);
      cancelRestart(guild.id);
      connection.destroy(); delete guildState[guild.id]; killFfmpeg(guild.id);
      setTimeout(() => connectAndStream(guild, channelId), 10_000);
    }
  });

  startStreaming(guild.id);
}

async function idleVoiceMonitor() {
  const now = Date.now();
  for (const [guildId, s] of Object.entries(guildState)) {
    if (!s?.connection || !s?.player) continue;

    const status = s.player.state.status;
    if (status === AudioPlayerStatus.Playing) {
      s.idleSince = null;
      continue;
    }

    if (!s.idleSince) s.idleSince = now;
    if (now - s.idleSince >= IDLE_LEAVE_MS) {
      await leaveVoiceDueToIdle(guildId);
    }
  }
}

// ── Stream loop ───────────────────────────────────────────────────────────────
function streamLoop() {
  const config = loadConfig();
  for (const [guildId, channelId] of Object.entries(config)) {
    if (autoJoinDisabled.has(String(guildId))) {
      log.debug(`[${guildId}] streamLoop: auto-join disabled, skipping`);
      continue;
    }
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const s = guildState[guildId];
    if (s?.connection && s?.player) continue;
    log.debug(`[${guildId}] streamLoop: no state, connecting`);
    connectAndStream(guild, channelId);
  }
}

// ── Spotify poller ────────────────────────────────────────────────────────────
let pollerRunning = false;
async function spotifyPoller() {
  if (pollerRunning) { log.debug('poller: skipping, previous still running'); return; }
  pollerRunning = true;
  try {
    for (const [guildId, session] of Object.entries(sessions)) {
      if (!session?.hostId) continue;

      log.debug(`[${guildId}] poller: fetching Spotify state`);
      const np = await getNowPlaying(session.hostId);
      log.debug(`[${guildId}] poller: np=${np?.title ?? 'null'} playing=${np?.isPlaying} trackId=${np?.trackId?.slice(-6)}`);

      const trackChanged = np && np.trackId   !== session.lastTrackId;
      const pauseChanged = np && np.isPlaying !== session.lastIsPlaying;
      const justPaused   = pauseChanged && !np.isPlaying;
      const justResumed  = pauseChanged && np.isPlaying;
      const realtimeHandledRecently = Date.now() - (session.lastRealtimeEventAt || 0) < 1800;

      if (trackChanged || pauseChanged) {
        if (realtimeHandledRecently && !trackChanged) {
          log.debug(`[${guildId}] Spotify state change ignored (recent librespot realtime event)`);
        } else {
        log.info(`[${guildId}] State change — track=${trackChanged} paused=${justPaused} resumed=${justResumed}`);

        cancelRestart(guildId);

        if (trackChanged) {
          // Full reset on song switch to guarantee old frames are discarded.
          stopPlayer(guildId);
          killFfmpeg(guildId);
          log.debug(`[${guildId}] Calling /flush on librespot`);
          const t0 = Date.now();
          await fetch(`${LIBRESPOT_API}/flush`, { method: 'POST' }).catch(e => log.warn('flush API error:', e.message));
          log.debug(`[${guildId}] /flush done in ${Date.now()-t0}ms`);
          flushPipe();
          if (np.isPlaying) scheduleRestart(guildId, 40, 'spotify-track-changed');
        } else if (justPaused) {
          // Soft pause keeps encoder alive and avoids resume startup delay.
          pausePlayer(guildId);
          log.debug(`[${guildId}] Calling /flush on librespot`);
          await fetch(`${LIBRESPOT_API}/flush`, { method: 'POST' }).catch(e => log.warn('flush API error:', e.message));
          flushPipe();
        } else if (justResumed) {
          if (!resumePlayer(guildId)) {
            scheduleRestart(guildId, 20, 'spotify-resumed-fallback');
          }
        }
        }
      }

      // Update state
      if (np) {
        session.lastTrackId   = np.trackId;
        session.lastIsPlaying = np.isPlaying;
      }

      // Update embed
      if (np && session.npMessage && (trackChanged || pauseChanged || Date.now() - (session.lastEmbedUpdate || 0) >= 2_000)) {
        session.lastEmbedUpdate = Date.now();
        try {
          await session.npMessage.edit({ embeds: [buildEmbed(np, session.hostName)], components: [buildControls(np.isPlaying)] });
        } catch (e) { if (e.code === 10008) session.npMessage = null; }
      }
    }
  } finally {
    pollerRunning = false;
  }
}

let librespotEventRunning = false;
async function librespotEventPoller() {
  if (librespotEventRunning) return;
  librespotEventRunning = true;
  try {
    let events = await fetch(`${LIBRESPOT_API}/track-events`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => (Array.isArray(data?.events) ? data.events : null))
      .catch(() => null);

    if (!events) {
      const ev = await fetch(`${LIBRESPOT_API}/track-changed`).then(r => r.json()).catch(() => null);
      events = ev?.changed ? [ev] : [];
    }

    if (!events.length) return;

    for (const ev of events) {
      const event = String(ev.event || '');
      const evTrackId = typeof ev.track_id === 'string' && ev.track_id ? ev.track_id : null;
      const pauseLike = event === 'paused' || event === 'stopped';
      const isTrackChanged = event === 'track_changed' || event === 'start_of_track';
      const playLike = event === 'playing';
      if (!pauseLike && !playLike && !isTrackChanged) continue;

      log.debug(`[realtime] librespot event=${event}`);

      if (pauseLike || isTrackChanged) {
        await fetch(`${LIBRESPOT_API}/flush`, { method: 'POST' }).catch(() => null);
        flushPipe();
      }

      const now = Date.now();
      for (const [guildId, session] of Object.entries(sessions)) {
        if (!session) continue;
        session.lastRealtimeEventAt = now;

        const trackIdChanged = Boolean(evTrackId && session.lastTrackId !== evTrackId);
        if (trackIdChanged) session.lastTrackId = evTrackId;

        if (pauseLike) {
          session.lastIsPlaying = false;
          cancelRestart(guildId);
          pausePlayer(guildId);
        }

        if (isTrackChanged || trackIdChanged) {
          session.lastIsPlaying = true;
          cancelRestart(guildId);
          stopPlayer(guildId);
          killFfmpeg(guildId);
          scheduleRestart(guildId, 20, `librespot-event-${event}${trackIdChanged ? '-trackid' : ''}`);
        } else if (playLike) {
          session.lastIsPlaying = true;
          if (!resumePlayer(guildId)) {
            scheduleRestart(guildId, 20, `librespot-event-${event}`);
          }
        }
      }
    }
  } finally {
    librespotEventRunning = false;
  }
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates],
});

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  const session = sessions[interaction.guild.id];
  if (!session) return interaction.reply({ content: '❌ No active session.', ephemeral: true });
  const token = await refreshToken(session.hostId);
  if (!token) return interaction.reply({ content: '❌ Token expired.', ephemeral: true });
  await interaction.deferUpdate();
  switch (interaction.customId) {
    case 'sp_prev': await spotifyApi(token.access_token, '/me/player/previous', 'POST'); break;
    case 'sp_playpause': {
      const np = await getNowPlaying(session.hostId);
      if (np?.isPlaying) await spotifyApi(token.access_token, '/me/player/pause', 'PUT');
      else               await spotifyApi(token.access_token, '/me/player/play', 'PUT');
      break;
    }
    case 'sp_next': await spotifyApi(token.access_token, '/me/player/next', 'POST'); break;
    case 'sp_stop':
      await terminateGuildPlayback(interaction.guild.id, 'Session ended.');
      await interaction.message.edit({ embeds: [new EmbedBuilder().setColor(0x555555).setDescription('Session ended and left voice channel.')], components: [] });
      return;
  }
});

const commands = {
  async start(msg) {
    enableAutoJoin(msg.guild.id, 'start command');
    const token = await refreshToken(msg.author.id);
    if (!token) {
      const sentDm = await sendSpotifyLoginPrompt(msg.author);
      if (sentDm) {
        return msg.reply({ content: 'I sent you a DM with the Spotify login link.' });
      }
      return msg.reply({ content: `I could not DM you. Please enable DMs and use this link: ${authUrl(msg.author.id)}` });
    }
    const devices = await spotifyApi(token.access_token, '/me/player/devices');
    const deviceName = process.env.SPOTIFY_DEVICE_NAME || 'NikitifyPi';
    const device = devices.devices?.find(d => d.name === deviceName);
    if (!device) return msg.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Device Not Found').setDescription(`**${deviceName}** is not visible in Spotify.`).setFooter({ text: 'Nikitify' })] });
    await spotifyApi(token.access_token, '/me/player', 'PUT', { device_ids: [device.id], play: true });
    const hostName = msg.member?.displayName || msg.author.username;
    sessions[msg.guild.id] = { hostId: msg.author.id, hostName, npMessage: null, lastTrackId: null, lastIsPlaying: null, lastEmbedUpdate: 0 };
    await new Promise(r => setTimeout(r, 1200));
    const np = await getNowPlaying(msg.author.id);
    const embed = np ? buildEmbed(np, hostName) : new EmbedBuilder().setColor(0x1DB954).setAuthor({ name: 'Session Started', iconURL: 'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png' }).setDescription(`Host: **${hostName}**\nOpen Spotify and play something on **${deviceName}**!`).setFooter({ text: 'Nikitify  ·  Spotify Connect' });
    const npMsg = await msg.reply({ embeds: [embed], components: np ? [buildControls(np.isPlaying)] : [], fetchReply: true });
    sessions[msg.guild.id].npMessage = npMsg;
    if (np) { sessions[msg.guild.id].lastTrackId = np.trackId; sessions[msg.guild.id].lastIsPlaying = np.isPlaying; }
    log.info(`Session started by ${msg.author.tag}`);
  },
  async stop(msg) {
    const s = sessions[msg.guild.id];
    if (!s && !guildState[msg.guild.id]) return msg.reply({ content: '❌ No active session.' });
    if (s && s.hostId !== msg.author.id) return msg.reply({ content: '❌ Only the host can stop.' });
    await terminateGuildPlayback(msg.guild.id, 'Session ended.');
    await msg.reply({ content: 'Session ended and left voice channel.' });
  },
  async np(msg) {
    const s = sessions[msg.guild.id];
    if (!s) return msg.reply({ content: '❌ No active session.' });
    const np = await getNowPlaying(s.hostId);
    if (!np) return msg.reply({ content: '❌ Nothing playing right now.' });
    const npMsg = await msg.reply({ embeds: [buildEmbed(np, s.hostName)], components: [buildControls(np.isPlaying)], fetchReply: true });
    s.npMessage = npMsg; s.lastEmbedUpdate = Date.now();
  },
  async session(msg) {
    const s = sessions[msg.guild.id];
    if (!s) return msg.reply({ content: '❌ No active session.' });
    await msg.reply({ content: `Host: **${s.hostName}**` });
  },
  async volume(msg, args) {
    if (!args[0]) { const r = await fetch(`${LIBRESPOT_API}/volume`).then(r => r.json()).catch(() => null); return msg.reply({ content: `Volume: **${r?.volume ?? '?'}%**` }); }
    const vol = parseInt(args[0]);
    if (isNaN(vol) || vol < 0 || vol > 200) return msg.reply({ content: '❌ 0-200 only.' });
    await fetch(`${LIBRESPOT_API}/volume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: vol }) });
    const s = guildState[msg.guild.id];
    if (s?.player?.state?.resource?.volume) s.player.state.resource.volume.setVolume(vol / 100);
    await msg.reply({ content: `Volume: **${vol}%**` });
  },
  async status(msg) {
    const health = await fetch(`${LIBRESPOT_API}/health`).then(r => r.json()).catch(() => ({ status: 'unreachable' }));
    const session = sessions[msg.guild.id]; const s = guildState[msg.guild.id];
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle('Nikitify Status').addFields(
      { name: 'Spotify Connect', value: health.status === 'ok' ? 'Online' : 'Offline', inline: true },
      { name: 'Streaming', value: s?.player?.state?.status === AudioPlayerStatus.Playing ? 'Active' : 'Idle', inline: true },
      { name: 'Pipe', value: fs.existsSync(PIPE_PATH) ? 'Ready' : 'Missing', inline: true },
      { name: 'Session', value: session ? session.hostName : 'None', inline: true },
    ).setFooter({ text: 'Nikitify' })] });
  },
  async restart(msg) { await fetch(`${LIBRESPOT_API}/restart`, { method: 'POST' }).catch(() => null); await msg.reply({ content: 'Librespot restarted.' }); },
  async join(msg) {
    const ch = msg.member?.voice?.channel;
    if (!ch) return msg.reply({ content: '❌ Join a voice channel first.' });
    enableAutoJoin(msg.guild.id, 'join command');
    setChannel(msg.guild.id, ch.id);
    const s = guildState[msg.guild.id];
    if (s?.connection) { try { s.connection.destroy(); } catch {} }
    killFfmpeg(msg.guild.id); delete guildState[msg.guild.id];
    await connectAndStream(msg.guild, ch.id);
    await msg.reply({ content: `Joined **${ch.name}**` });
  },
  async leave(msg) {
    disableAutoJoin(msg.guild.id, 'leave command');
    cancelRestart(msg.guild.id);
    stopPlayer(msg.guild.id);
    const s = guildState[msg.guild.id];
    if (s?.connection) { try { s.connection.destroy(); } catch {} }
    killFfmpeg(msg.guild.id); delete guildState[msg.guild.id];
    await msg.reply({ content: 'Left voice channel.' });
  },
  async setchannel(msg) {
    const ch = msg.mentions.channels.first() || msg.member?.voice?.channel;
    if (!ch) return msg.reply({ content: '❌ Mention a channel or join one.' });
    setChannel(msg.guild.id, ch.id); await msg.reply({ content: `Default channel set to **${ch.name}**` });
  },
  async unlink(msg) {
    const p = path.join(TOKEN_DIR, `${msg.author.id}.json`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); await msg.reply({ content: 'Spotify account unlinked.' }); }
    else await msg.reply({ content: '❌ No linked account found.' });
  },
  async jam(msg, args) {
    if (!args[0]) return msg.reply({ content: 'Usage: `!jam <link>`' });
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle('Join the Jam').setDescription(`[Click to join Spotify Jam](${args[0]})`).setFooter({ text: 'Nikitify' })] });
  },
  async ping(msg) { await msg.reply({ content: `${Math.round(client.ws.ping)}ms` }); },
  async help(msg) {
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle('Nikitify Commands').addFields(
      { name: 'Playback', value: '`!start`  `!stop`  `!np`  `!session`' },
      { name: 'Audio',    value: '`!volume [0-200]`  `!restart`' },
      { name: 'Voice',    value: '`!join`  `!leave`  `!setchannel [#ch]`' },
      { name: 'Account',  value: '`!unlink`  `!jam <link>`  `!ping`' },
    ).setFooter({ text: 'Nikitify  ·  Spotify Connect' })] });
  },
};
commands.nowplaying = commands.np;

client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot || !msg.guild) return;
  if (!msg.content.startsWith(DISCORD_PREFIX)) return;
  const [rawCmd, ...args] = msg.content.slice(DISCORD_PREFIX.length).trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  if (commands[cmd]) {
    try { await commands[cmd](msg, args); }
    catch (e) { log.error(`!${cmd}:`, e); msg.reply({ content: '❌ Error.' }).catch(() => {}); }
  }
});

client.once(Events.ClientReady, () => {
  log.info(`Logged in as ${client.user.tag}`);
  client.user.setActivity('Spotify Connect', { type: 2 });
  setInterval(streamLoop,    10_000);
  setInterval(spotifyPoller,  1_000);
  setInterval(librespotEventPoller, LIBRESPOT_EVENT_POLL_MS);
  setInterval(() => { idleVoiceMonitor().catch(e => log.warn('idleVoiceMonitor:', e.message)); }, 10_000);
  setTimeout(streamLoop,      3_000);
});

client.login(DISCORD_TOKEN);