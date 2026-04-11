require('dotenv').config();
const {
  Client, GatewayIntentBits, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ActivityType,
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
const FRIEND_MESSAGES = require('./messages');
const { runWeather } = require('./weather');

// ── Config ────────────────────────────────────────────────────────────────────
const DISCORD_TOKEN         = process.env.DISCORD_TOKEN;
const DISCORD_PREFIX        = process.env.DISCORD_PREFIX || '!';
const PIPE_PATH             = process.env.PIPE_PATH || '/tmp/audio/spotify.pcm';
const LIBRESPOT_API         = process.env.LIBRESPOT_API_URL || 'http://librespot:5050';
const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI;
const APP_NAME              = process.env.APP_NAME || 'Nikitify';
const SPOTIFY_SHARED_DISCORD_ID = process.env.SPOTIFY_SHARED_DISCORD_ID || '';
const SPOTIFY_CONTROLLER_MODE = (process.env.SPOTIFY_CONTROLLER_MODE || 'requester').toLowerCase();
const CONFIG_FILE           = process.env.CONFIG_FILE || '/data/guild_config.json';
const JAM_LINKS_FILE        = process.env.JAM_LINKS_FILE || '/data/jam_links.json';
const TOKEN_DIR             = process.env.TOKEN_DIR || '/data/tokens';
const IDLE_LEAVE_MS         = 5 * 60 * 1000;
const EMPTY_CHANNEL_LEAVE_MS = parseInt(process.env.EMPTY_CHANNEL_LEAVE_MS || '180000', 10);
const LIBRESPOT_EVENT_POLL_MS = 120;
const SPOTIFY_DEVICE_NAME   = process.env.SPOTIFY_DEVICE_NAME || 'SpoticordPi';
const DISCORD_ACTIVITY_TEXT = process.env.DISCORD_ACTIVITY_TEXT || 'Spotify Connect';
const DISCORD_ACTIVITY_TYPE = process.env.DISCORD_ACTIVITY_TYPE || 'LISTENING';
const APP_FOOTER_TEXT       = `${APP_NAME}  ·  ${DISCORD_ACTIVITY_TEXT}`;
const PRESENCE_UPDATE_MIN_MS = 15_000;

const presenceState = {
  text: '',
  at: 0,
};

function resolveActivityType(typeRaw) {
  const t = String(typeRaw || '').trim().toUpperCase();
  if (t === 'PLAYING') return ActivityType.Playing;
  if (t === 'STREAMING') return ActivityType.Streaming;
  if (t === 'WATCHING') return ActivityType.Watching;
  if (t === 'COMPETING') return ActivityType.Competing;
  return ActivityType.Listening;
}

function buildPresenceText(np) {
  if (!np?.title) return DISCORD_ACTIVITY_TEXT;
  const raw = np.artist ? `${np.title} - ${np.artist}` : np.title;
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function updatePresence(np = null, force = false) {
  if (!client?.user) return;
  const now = Date.now();
  const text = buildPresenceText(np);
  if (!force && text === presenceState.text && now - presenceState.at < PRESENCE_UPDATE_MIN_MS) return;
  try {
    client.user.setActivity(text, { type: resolveActivityType(DISCORD_ACTIVITY_TYPE) });
    presenceState.text = text;
    presenceState.at = now;
  } catch (e) {
    log.debug(`presence update failed: ${e.message}`);
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log( `[${new Date().toISOString()}] [INFO]`, ...a),
  warn:  (...a) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...a),
  debug: (...a) => console.log( `[${new Date().toISOString()}] [DEBUG]`, ...a),
};

process.on('unhandledRejection', e => log.error('Unhandled rejection:', e));
process.on('uncaughtException',  e => { log.error('Uncaught exception:', e); process.exit(1); });

// ── Bazinga ───────────────────────────────────────────────────────────────────
let bazingaQueue = [];

function getNextBazinga() {
  if (bazingaQueue.length === 0) {
    bazingaQueue = [...FRIEND_MESSAGES].sort(() => Math.random() - 0.5);
  }
  return bazingaQueue.pop();
}


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

function loadJamLinks() {
  try { return JSON.parse(fs.readFileSync(JAM_LINKS_FILE, 'utf8')); } catch { return {}; }
}

function saveJamLinks(data) {
  fs.mkdirSync(path.dirname(JAM_LINKS_FILE), { recursive: true });
  fs.writeFileSync(JAM_LINKS_FILE, JSON.stringify(data, null, 2));
}

function getJamLink(guildId) {
  const d = loadJamLinks();
  const link = d[String(guildId)];
  return typeof link === 'string' && link.trim() ? link.trim() : null;
}

function setJamLink(guildId, link) {
  const d = loadJamLinks();
  d[String(guildId)] = String(link).trim();
  saveJamLinks(d);
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
    .setTitle(`Link your Spotify account to ${APP_NAME}`)
    .setDescription(
      `[Click here to connect your Spotify ->](${link})\n\nAfter logging in, return to Discord and run ${prefix}start again.`
    )
    .setFooter({ text: APP_FOOTER_TEXT });

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

  const raw = await r.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw.trim() };
    }
  }

  if (!r.ok) {
    const message = data?.error?.message || data?.message || r.statusText || `HTTP ${r.status}`;
    const err = new Error(`Spotify API ${r.status}: ${message}`);
    err.status = r.status;
    err.spotifyMessage = String(message);
    throw err;
  }

  return data;
}

async function waitForLibrespotReady(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await fetch(`${LIBRESPOT_API}/health`).then(r => r.json());
      if (health?.status === 'ok') return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function waitForSpotifyDevice(token, deviceName, timeoutMs = 20000) {
  const started = Date.now();
  let lastDevices = [];
  while (Date.now() - started < timeoutMs) {
    const data = await spotifyApi(token, '/me/player/devices');
    const list = Array.isArray(data?.devices) ? data.devices : [];
    lastDevices = list;
    const found = list.find(d => d.name === deviceName);
    if (found) return { device: found, devices: list };
    await new Promise(r => setTimeout(r, 1000));
  }
  return { device: null, devices: lastDevices };
}

async function releaseSpotifyController(guildId) {
  const session = sessions[guildId];
  if (!session) return;
  const controllerId = session.controllerId || session.hostId;
  if (!controllerId) return;

  const token = await refreshToken(controllerId);
  if (!token?.access_token) return;

  try { await spotifyApi(token.access_token, '/me/player/pause', 'PUT'); } catch {}

  try {
    const devices = await spotifyApi(token.access_token, '/me/player/devices');
    const targetName = SPOTIFY_DEVICE_NAME;
    const list = Array.isArray(devices?.devices) ? devices.devices : [];
    const fallback =
      list.find(d => d.name !== targetName && (d.type === 'Smartphone' || d.type === 'Computer')) ||
      list.find(d => d.name !== targetName);
    if (fallback?.id) {
      await spotifyApi(token.access_token, '/me/player', 'PUT', { device_ids: [fallback.id], play: false });
    }
  } catch (e) {
    log.debug(`[${guildId}] releaseSpotifyController: ${e.message}`);
  }
}

function resolveControllerId(requesterId) {
  if (SPOTIFY_CONTROLLER_MODE === 'shared' && SPOTIFY_SHARED_DISCORD_ID) {
    return String(SPOTIFY_SHARED_DISCORD_ID);
  }
  return String(requesterId);
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
    .setAuthor({ name: `Now Playing on ${APP_NAME}`, iconURL: 'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png' })
    .setTitle(np.title).setURL(np.trackUrl)
    .setDescription(`by **${np.artist}**  ·  *${np.album}*`)
    .addFields({ name: `${msToTime(np.progress)}  ${bar}  ${msToTime(np.duration)}`, value: `${np.isPlaying ? '**Playing**' : '**Paused**'}  ·  Host: **${hostName}**` })
    .setFooter({ text: APP_FOOTER_TEXT }).setTimestamp();
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
  await releaseSpotifyController(guildId);
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
    '-re',
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
  const volPct = Number(s.volumePercent ?? 80);
  resource.volume?.setVolume(Math.max(0, Math.min(volPct, 200)) / 100);
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
    volumePercent: 80,
    idleSince: Date.now(),
    emptySince: null,
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

    const guild = client.guilds.cache.get(guildId);
    const channelId = s.connection.joinConfig?.channelId;
    const channel = guild && channelId ? guild.channels.cache.get(String(channelId)) : null;
    const humanCount = channel?.members ? channel.members.filter(m => !m.user?.bot).size : 0;
    if (humanCount === 0) {
      if (!s.emptySince) s.emptySince = now;
      if (now - s.emptySince >= EMPTY_CHANNEL_LEAVE_MS) {
        await terminateGuildPlayback(guildId, 'Session ended due to 3 minutes with no users in voice channel.');
        continue;
      }
    } else {
      s.emptySince = null;
    }

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
    let presenceTrack = null;
    for (const [guildId, session] of Object.entries(sessions)) {
      if (!session?.hostId) continue;
      const controllerId = session.controllerId || session.hostId;

      log.debug(`[${guildId}] poller: fetching Spotify state`);
      const np = await getNowPlaying(controllerId);
      log.debug(`[${guildId}] poller: np=${np?.title ?? 'null'} playing=${np?.isPlaying} trackId=${np?.trackId?.slice(-6)}`);
      if (!presenceTrack && np?.isPlaying) presenceTrack = np;

      const trackChanged = np && np.trackId   !== session.lastTrackId;
      const pauseChanged = np && np.isPlaying !== session.lastIsPlaying;
      const justPaused   = pauseChanged && !np.isPlaying;
      const justResumed  = pauseChanged && np.isPlaying;
      const prevRemainingMs = (typeof session.lastDuration === 'number' && typeof session.lastProgress === 'number')
        ? session.lastDuration - session.lastProgress
        : null;
      const naturalBoundaryChange = trackChanged && typeof prevRemainingMs === 'number' && prevRemainingMs >= 0 && prevRemainingMs <= 2500;
      const realtimeHandledRecently = Date.now() - (session.lastRealtimeEventAt || 0) < 600;

      if (trackChanged || pauseChanged) {
        if (realtimeHandledRecently) {
          log.debug(`[${guildId}] Spotify state change ignored (recent librespot realtime event)`);
        } else {
        log.info(`[${guildId}] State change — track=${trackChanged} paused=${justPaused} resumed=${justResumed}`);

        cancelRestart(guildId);

        if (trackChanged) {
          if (naturalBoundaryChange) {
            // Keep the stream continuous at natural boundaries to avoid audible gaps.
            log.debug(`[${guildId}] Natural track boundary detected (${prevRemainingMs}ms left), keeping stream running`);
          } else {
            // Non-natural jumps (e.g. manual skip/seek) still get a hard reset.
            stopPlayer(guildId);
            killFfmpeg(guildId);
            log.debug(`[${guildId}] Calling /flush on librespot`);
            const t0 = Date.now();
            await fetch(`${LIBRESPOT_API}/flush`, { method: 'POST' }).catch(e => log.warn('flush API error:', e.message));
            log.debug(`[${guildId}] /flush done in ${Date.now()-t0}ms`);
            flushPipe();
            if (np.isPlaying) scheduleRestart(guildId, 10, 'spotify-track-changed');
          }
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
        session.lastProgress  = np.progress;
        session.lastDuration  = np.duration;
      }

      // Update embed
      if (np && session.npMessage && (trackChanged || pauseChanged || Date.now() - (session.lastEmbedUpdate || 0) >= 2_000)) {
        session.lastEmbedUpdate = Date.now();
        try {
          await session.npMessage.edit({ embeds: [buildEmbed(np, session.hostName)], components: [buildControls(np.isPlaying)] });
        } catch (e) { if (e.code === 10008) session.npMessage = null; }
      }
    }
    updatePresence(presenceTrack);
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

      if (pauseLike) {
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
          const status = guildState[guildId]?.player?.state?.status;
          const streaming = status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering;
          if (streaming) {
            log.debug(`[${guildId}] Realtime track change while streaming; keeping pipeline to reduce transition gap`);
          } else {
            stopPlayer(guildId);
            killFfmpeg(guildId);
            scheduleRestart(guildId, 10, `librespot-event-${event}${trackIdChanged ? '-trackid' : ''}`);
          }
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
  const controllerId = session.controllerId || session.hostId;
  const token = await refreshToken(controllerId);
  if (!token) return interaction.reply({ content: '❌ Token expired.', ephemeral: true });
  await interaction.deferUpdate();
  switch (interaction.customId) {
    case 'sp_prev': await spotifyApi(token.access_token, '/me/player/previous', 'POST'); break;
    case 'sp_playpause': {
      const np = await getNowPlaying(controllerId);
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
    const previousSession = sessions[msg.guild.id];
    const hostChanged = Boolean(previousSession && previousSession.hostId !== msg.author.id);
    const controllerId = resolveControllerId(msg.author.id);
    const token = await refreshToken(controllerId);
    if (!token) {
      if (SPOTIFY_SHARED_DISCORD_ID && String(SPOTIFY_SHARED_DISCORD_ID) !== String(msg.author.id)) {
        return msg.reply({ content: '❌ Shared Spotify account is not linked yet. The owner must run !start once to link it.' });
      }
      const sentDm = await sendSpotifyLoginPrompt(msg.author);
      if (sentDm) {
        return msg.reply({ content: 'I sent you a DM with the Spotify login link.' });
      }
      return msg.reply({ content: `I could not DM you. Please enable DMs and use this link: ${authUrl(msg.author.id)}` });
    }

    try {
      const sw = await fetch(`${LIBRESPOT_API}/set-controller`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discord_id: controllerId }),
      }).then(r => r.json());

      if (sw?.restarting) {
        log.info(`[${msg.guild.id}] Switching librespot controller to ${controllerId}`);
        const ok = await waitForLibrespotReady(35_000);
        if (!ok) {
          return msg.reply({ content: '❌ Spotify backend is restarting for this user. Please retry !start in a few seconds.' });
        }
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) {
      log.warn(`[${msg.guild.id}] set-controller error: ${e.message}`);
      return msg.reply({ content: '❌ Could not switch Spotify controller account right now. Please retry !start.' });
    }

    let devices;
    try {
      const waited = await waitForSpotifyDevice(token.access_token, SPOTIFY_DEVICE_NAME, 25000);
      devices = { devices: waited.devices };
    } catch (e) {
      log.warn(`[${msg.guild.id}] !start devices error: ${e.message}`);
      const m = String(e.spotifyMessage || e.message || 'Unknown error');
      if (/premium|required/i.test(m)) {
        return msg.reply({ content: '❌ Spotify Premium is required for playback control.' });
      }
      if (/token|expired|invalid/i.test(m)) {
        return msg.reply({ content: '❌ Spotify login expired or invalid. Please run !unlink, then !start to relink.' });
      }
      return msg.reply({ content: `❌ Spotify login succeeded, but playback is unavailable: ${m.slice(0, 180)}` });
    }

    const deviceName = SPOTIFY_DEVICE_NAME;
    const device = devices.devices?.find(d => d.name === deviceName);
    if (!device) return msg.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Device Not Found').setDescription(`**${deviceName}** is not visible in Spotify.`).setFooter({ text: APP_NAME })] });

    try {
      await spotifyApi(token.access_token, '/me/player', 'PUT', { device_ids: [device.id], play: true });
    } catch (e) {
      log.warn(`[${msg.guild.id}] !start transfer/play error: ${e.message}`);
      const m = String(e.spotifyMessage || e.message || 'Unknown error');
      return msg.reply({ content: `❌ Could not start playback on ${deviceName}: ${m.slice(0, 180)}` });
    }

    // Some Spotify clients accept transfer but remain paused; force resume.
    try {
      await spotifyApi(token.access_token, `/me/player/play?device_id=${encodeURIComponent(device.id)}`, 'PUT');
    } catch (e) {
      log.debug(`[${msg.guild.id}] !start play retry (1) skipped: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
    const npAfterTransfer = await getNowPlaying(controllerId);
    if (npAfterTransfer && !npAfterTransfer.isPlaying) {
      try {
        await spotifyApi(token.access_token, `/me/player/play?device_id=${encodeURIComponent(device.id)}`, 'PUT');
      } catch (e) {
        log.debug(`[${msg.guild.id}] !start play retry (2) skipped: ${e.message}`);
      }
    }

    const hostName = msg.member?.displayName || msg.author.username;
  sessions[msg.guild.id] = { hostId: msg.author.id, controllerId, hostName, npMessage: null, lastTrackId: null, lastIsPlaying: null, lastEmbedUpdate: 0 };
    await new Promise(r => setTimeout(r, 1200));
  const np = await getNowPlaying(controllerId);
    const embed = np ? buildEmbed(np, hostName) : new EmbedBuilder().setColor(0x1DB954).setAuthor({ name: 'Session Started', iconURL: 'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png' }).setDescription(`Host: **${hostName}**\nOpen Spotify and play something on **${deviceName}**!`).setFooter({ text: APP_FOOTER_TEXT });
    const npMsg = await msg.reply({ embeds: [embed], components: np ? [buildControls(np.isPlaying)] : [], fetchReply: true });
    sessions[msg.guild.id].npMessage = npMsg;
    if (np) { sessions[msg.guild.id].lastTrackId = np.trackId; sessions[msg.guild.id].lastIsPlaying = np.isPlaying; }

    if (hostChanged) {
      const savedJam = getJamLink(msg.guild.id);
      if (savedJam) {
        await msg.reply({ content: `New host detected. Current saved Jam link: ${savedJam}\nUse !jam <link> to replace it, or !jam to show it again.` });
      } else {
        await msg.reply({ content: 'New host detected. If you want to share queue, send !jam <link>. Use !jam anytime to show the saved link.' });
      }
    }

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

    const s = guildState[msg.guild.id];
    if (s) s.volumePercent = vol;
    if (s?.player?.state?.resource?.volume) s.player.state.resource.volume.setVolume(vol / 100);

    // Apply Discord-side volume immediately, then sync bridge in the background.
    fetch(`${LIBRESPOT_API}/volume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: Math.max(0, Math.min(vol, 100)) }),
    }).catch(e => log.debug(`[${msg.guild.id}] volume sync warning: ${e.message}`));

    await msg.reply({ content: `Volume: **${vol}%**` });
  },
  async status(msg) {
    const health = await fetch(`${LIBRESPOT_API}/health`).then(r => r.json()).catch(() => ({ status: 'unreachable' }));
    const session = sessions[msg.guild.id]; const s = guildState[msg.guild.id];
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle(`${APP_NAME} Status`).addFields(
      { name: DISCORD_ACTIVITY_TEXT, value: health.status === 'ok' ? 'Online' : 'Offline', inline: true },
      { name: 'Streaming', value: s?.player?.state?.status === AudioPlayerStatus.Playing ? 'Active' : 'Idle', inline: true },
      { name: 'Pipe', value: fs.existsSync(PIPE_PATH) ? 'Ready' : 'Missing', inline: true },
      { name: 'Session', value: session ? session.hostName : 'None', inline: true },
    ).setFooter({ text: APP_NAME })] });
  },
  async debug(msg) {
    const session = sessions[msg.guild.id];
    const s = guildState[msg.guild.id];
    const config = loadConfig();
    const configuredChannelId = config[msg.guild.id] || 'not set';
    const joinedChannelId = msg.guild.members.me?.voice?.channelId || 'not in voice';
    const controllerId = session?.controllerId || session?.hostId || resolveControllerId(msg.author.id);

    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle('Debug Snapshot').addFields(
      { name: 'Guild', value: `${msg.guild.name} (${msg.guild.id})`, inline: false },
      { name: 'Requester', value: `${msg.author.tag} (${msg.author.id})`, inline: false },
      { name: 'Session Host', value: session ? `${session.hostName} (${session.hostId})` : 'none', inline: false },
      { name: 'Controller', value: controllerId || 'none', inline: false },
      { name: 'Auto-Join Disabled', value: autoJoinDisabled.has(String(msg.guild.id)) ? 'yes' : 'no', inline: true },
      { name: 'Player Status', value: s?.player?.state?.status || 'none', inline: true },
      { name: 'FFmpeg PID', value: s?.ffmpeg?.pid ? String(s.ffmpeg.pid) : 'none', inline: true },
      { name: 'Configured Channel', value: String(configuredChannelId), inline: true },
      { name: 'Joined Channel', value: String(joinedChannelId), inline: true },
      { name: 'Pipe Exists', value: fs.existsSync(PIPE_PATH) ? 'yes' : 'no', inline: true },
    ).setFooter({ text: `${APP_NAME} Debug` })] });
  },
  async controller(msg) {
    const session = sessions[msg.guild.id];
    const controllerId = session?.controllerId || session?.hostId || resolveControllerId(msg.author.id);
    const mode = SPOTIFY_CONTROLLER_MODE === 'shared' ? `shared (${SPOTIFY_SHARED_DISCORD_ID || 'unset'})` : 'requester';
    await msg.reply({ content: `Controller mode: **${mode}**\nActive controller: **${controllerId || 'none'}**` });
  },
  async tokeninfo(msg) {
    const session = sessions[msg.guild.id];
    const controllerId = session?.controllerId || session?.hostId || resolveControllerId(msg.author.id);
    const token = loadToken(controllerId);
    if (!token) return msg.reply({ content: `❌ No token file for controller **${controllerId}**.` });

    const expiresAt = Number(token.expires_at || 0);
    const remainingSec = expiresAt ? Math.floor(expiresAt - Date.now() / 1000) : null;
    await msg.reply({ content: `Token for **${controllerId}**\nExpires at: **${expiresAt ? new Date(expiresAt * 1000).toISOString() : 'unknown'}**\nTime left: **${remainingSec !== null ? `${remainingSec}s` : 'unknown'}**\nHas refresh token: **${token.refresh_token ? 'yes' : 'no'}**` });
  },
  async devices(msg) {
    const session = sessions[msg.guild.id];
    const controllerId = session?.controllerId || session?.hostId || resolveControllerId(msg.author.id);
    const token = await refreshToken(controllerId);
    if (!token) return msg.reply({ content: `❌ No valid token for controller **${controllerId}**.` });

    let data;
    try {
      data = await spotifyApi(token.access_token, '/me/player/devices');
    } catch (e) {
      return msg.reply({ content: `❌ Spotify devices error: ${String(e.spotifyMessage || e.message).slice(0, 180)}` });
    }

    const devices = Array.isArray(data?.devices) ? data.devices : [];
    if (!devices.length) return msg.reply({ content: 'No Spotify devices returned for this controller.' });

    const lines = devices.slice(0, 10).map(d => {
      const active = d.is_active ? 'active' : 'idle';
      return `- ${d.name} | ${d.type} | ${active} | vol=${d.volume_percent ?? 'n/a'}`;
    });
    await msg.reply({ content: `Spotify devices for **${controllerId}**:\n${lines.join('\n')}` });
  },
  async voice(msg) {
    const s = guildState[msg.guild.id];
    const me = msg.guild.members.me;
    const connected = me?.voice?.channel ? `${me.voice.channel.name} (${me.voice.channel.id})` : 'not connected';
    const connStatus = s?.connection?.state?.status || 'none';
    const playerStatus = s?.player?.state?.status || 'none';
    await msg.reply({ content: `Voice connection: **${connected}**\nConnection state: **${connStatus}**\nPlayer state: **${playerStatus}**` });
  },
  async flush(msg) {
    await fetch(`${LIBRESPOT_API}/flush`, { method: 'POST' }).catch(() => null);
    flushPipe();
    await msg.reply({ content: 'Flushed librespot and local pipe.' });
  },
  async restream(msg) {
    const guildId = msg.guild.id;
    cancelRestart(guildId);
    stopPlayer(guildId);
    killFfmpeg(guildId);
    scheduleRestart(guildId, 20, 'manual-restream');
    await msg.reply({ content: 'Restream scheduled.' });
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
    await releaseSpotifyController(msg.guild.id);
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
  async link(msg) {
    const requesterLink = authUrl(msg.author.id);
    if (SPOTIFY_SHARED_DISCORD_ID) {
      const sharedLink = authUrl(SPOTIFY_SHARED_DISCORD_ID);
      return msg.reply({ content: `Spotify login links:\n- Your link: ${requesterLink}\n- Shared controller link (${SPOTIFY_SHARED_DISCORD_ID}): ${sharedLink}` });
    }
    await msg.reply({ content: `Spotify login link: ${requesterLink}` });
  },
  async jam(msg, args) {
    if (!args[0]) {
      const saved = getJamLink(msg.guild.id);
      if (!saved) {
        return msg.reply({ content: '❌ No Jam link saved yet. Use !jam <link> to save one.' });
      }
      return msg.reply({ embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle('Saved Jam Link').setDescription(`[Click to join Spotify Jam](${saved})`).setFooter({ text: APP_NAME })] });
    }

    const link = String(args[0]).trim();
    if (!/^https?:\/\//i.test(link)) {
      return msg.reply({ content: '❌ Please provide a valid URL (http/https).' });
    }

    setJamLink(msg.guild.id, link);
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle('Jam Link Saved').setDescription(`[Click to join Spotify Jam](${link})`).setFooter({ text: APP_NAME })] });
  },
  async weathertest(msg) {
    await msg.reply({ content: 'Running weather test...' });
    try {
      await runWeather();
      await msg.reply({ content: 'Weather test finished. Check your weather webhook channel.' });
    } catch (e) {
      await msg.reply({ content: `❌ Weather test failed: ${String(e.message || e).slice(0, 180)}` });
    }
  },
  async bazinga(msg) {
    const line = String(getNextBazinga() || 'Bazinga!').trim() || 'Bazinga!';
    log.info(`[cmd:bazinga] reply attempt in ${msg.guild ? `guild ${msg.guild.id}` : 'DM'}`);
    try {
      await msg.reply({ content: line });
      log.info('[cmd:bazinga] reply sent');
    } catch (e) {
      log.warn(`[cmd:bazinga] primary reply failed: ${e.message}`);
      // If custom content is blocked (e.g. AutoMod), send a guaranteed-safe fallback.
      await msg.reply({ content: 'Bazinga!' }).catch(err => {
        log.error(`[cmd:bazinga] fallback reply failed: ${err.message}`);
      });
    }
  },
  async ping(msg) { await msg.reply({ content: `${Math.round(client.ws.ping)}ms` }); },
  async help(msg) {
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle(`${APP_NAME} Commands`).addFields(
      { name: 'Playback', value: '`!start`  `!stop`  `!np`  `!session`' },
      { name: 'Audio',    value: '`!volume [0-200]`  `!restart`' },
      { name: 'Voice',    value: '`!join`  `!leave`  `!setchannel [#ch]`' },
      { name: 'Account',  value: '`!link`  `!unlink`  `!jam [link]`  `!ping`  `!bazinga`  `!weathertest`' },
      { name: 'Debug',    value: '`!debug`  `!controller`  `!tokeninfo`  `!devices`  `!voice`  `!flush`  `!restream`' },
    ).setFooter({ text: APP_FOOTER_TEXT })] });
  },
};
commands.nowplaying = commands.np;
commands.login = commands.link;

client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot) return;
  if (!msg.content) {
    log.warn(`Empty message content from ${msg.author.tag}. If prefix commands do not work, enable Message Content Intent in Discord Developer Portal.`);
    return;
  }
  if (!msg.content.startsWith(DISCORD_PREFIX)) return;
  const [rawCmd, ...args] = msg.content.slice(DISCORD_PREFIX.length).trim().split(/\s+/);
  if (!rawCmd) return;
  const cmd = rawCmd.toLowerCase();
  log.info(`[cmd] received !${cmd} in ${msg.guild ? `guild ${msg.guild.id}` : 'DM'} by ${msg.author.tag}`);
  const command = commands[cmd];
  if (!command) {
    log.debug(`[cmd] unknown command: !${cmd}`);
    return;
  }

  const dmAllowed = new Set(['bazinga', 'ping', 'help', 'link']);
  if (!msg.guild && !dmAllowed.has(cmd)) {
    await msg.reply({ content: '❌ This command only works in a server channel.' }).catch(() => {});
    return;
  }

  try { await command(msg, args); }
  catch (e) { log.error(`!${cmd}:`, e); msg.reply({ content: '❌ Error.' }).catch(() => {}); }
});

client.once(Events.ClientReady, () => {
  log.info(`Logged in as ${client.user.tag}`);
  updatePresence(null, true);
  setInterval(streamLoop,    10_000);
  setInterval(spotifyPoller,  1_000);
  setInterval(librespotEventPoller, LIBRESPOT_EVENT_POLL_MS);
  setInterval(() => { idleVoiceMonitor().catch(e => log.warn('idleVoiceMonitor:', e.message)); }, 10_000);
  setTimeout(streamLoop,      3_000);

});

client.login(DISCORD_TOKEN);