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
const http = require('http');
const { URL } = require('url');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const FRIEND_MESSAGES = require('./messages');
const { runWeather } = require('./weather');
const { createLogger } = require('./src/logger');
const { startupSecurityCheck } = require('./src/security');
const { loadStoreData, saveStoreData, cleanupTokenFiles } = require('./src/jsonStore');
const { createSpotifyApi } = require('./src/spotifyApi');
const { evaluateLeaveDecision } = require('./src/leavePolicy');
const { buildSlashCommands } = require('./src/slashCommands');
const { createCommandPolicy } = require('./src/commandPolicy');
const { createCommandLock } = require('./src/commandLock');
const { createMetrics } = require('./src/metrics');
const { validateConfig } = require('./src/configValidate');

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
const RESTART_STATE_FILE    = process.env.RESTART_STATE_FILE || '/data/restart_state.json';
const LIBRESPOT_EVENT_POLL_MS = 120;
const SPOTIFY_DEVICE_NAME   = process.env.SPOTIFY_DEVICE_NAME || 'SpoticordPi';
const DISCORD_ACTIVITY_TEXT = process.env.DISCORD_ACTIVITY_TEXT || 'Spotify Connect';
const DISCORD_ACTIVITY_TYPE = process.env.DISCORD_ACTIVITY_TYPE || 'LISTENING';
const DISCORD_ACTIVITY_URL  = process.env.DISCORD_ACTIVITY_URL || '';
const PUBLIC_DASHBOARD_URL  = process.env.PUBLIC_DASHBOARD_URL || '';
const APP_FOOTER_TEXT       = `${APP_NAME}  ·  ${DISCORD_ACTIVITY_TEXT}`;
const PRESENCE_UPDATE_MIN_MS = 15_000;
const PLAYLIST_QUEUE_LIMIT = parseInt(process.env.PLAYLIST_QUEUE_LIMIT || '50', 10);
const SPOTIFY_POLL_MS = parseInt(process.env.SPOTIFY_POLL_MS || '2000', 10);
const AUTO_JOIN_WITHOUT_SESSION = String(process.env.AUTO_JOIN_WITHOUT_SESSION || 'false').toLowerCase() === 'true';
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'INFO').trim().toUpperCase();
const HOST_LEAVE_GRACE_MS = parseInt(process.env.HOST_LEAVE_GRACE_MS || '15000', 10);
const MAX_RESTARTS_PER_MIN = parseInt(process.env.MAX_RESTARTS_PER_MIN || '10', 10);
const BOT_HEALTH_PORT = parseInt(process.env.BOT_HEALTH_PORT || '7070', 10);
const ADMIN_ROLE_IDS = String(process.env.ADMIN_ROLE_IDS || '');
const MOD_ROLE_IDS = String(process.env.MOD_ROLE_IDS || '');
const DASHBOARD_DIR = path.join(__dirname, 'public', 'dashboard');

const presenceState = {
  text: '',
  at: 0,
};
const spotifyRateLimitState = new Map();
const restartHistoryByGuild = new Map(
  Object.entries(loadStoreData(RESTART_STATE_FILE, 1) || {}).map(([k, arr]) => [k, Array.isArray(arr) ? arr : []])
);

function persistRestartHistory() {
  const obj = Object.fromEntries(restartHistoryByGuild.entries());
  saveStoreData(RESTART_STATE_FILE, obj, 1);
}

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
    const type = resolveActivityType(DISCORD_ACTIVITY_TYPE);
    const opts = { type };
    const presenceUrl = String(DISCORD_ACTIVITY_URL || PUBLIC_DASHBOARD_URL || '').trim();
    if (type === ActivityType.Streaming && /^https?:\/\//i.test(presenceUrl)) {
      opts.url = presenceUrl;
    }
    client.user.setActivity(text, opts);
    presenceState.text = text;
    presenceState.at = now;
  } catch (e) {
    log.debug(`presence update failed: ${e.message}`);
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────
const log = createLogger(LOG_LEVEL, { bufferSize: 700 });
startupSecurityCheck(process.env, log);
validateConfig(process.env);
const tokenCleanup = cleanupTokenFiles(TOKEN_DIR, 90);
log.info('Token cleanup complete', tokenCleanup);
const spotifyClient = createSpotifyApi(fetch, log, { cacheTtlMs: 2000, failureThreshold: 5, openMs: 30000 });
const commandPolicy = createCommandPolicy({ ADMIN_ROLE_IDS, MOD_ROLE_IDS });
const commandLock = createCommandLock();
const metrics = createMetrics();
const runtimeDiag = {
  startedAt: Date.now(),
  requests: {
    health: 0,
    metrics: 0,
    dashboardApi: 0,
    dashboardPage: 0,
    static: 0,
    notFound: 0,
  },
  errors: [],
};

function trackError(scope, errorLike) {
  const errText = errorLike && errorLike.message ? errorLike.message : String(errorLike || 'unknown error');
  const entry = {
    ts: new Date().toISOString(),
    scope,
    message: errText.slice(0, 400),
  };
  runtimeDiag.errors.push(entry);
  if (runtimeDiag.errors.length > 120) runtimeDiag.errors.splice(0, runtimeDiag.errors.length - 120);
}

function logEvent(level, eventCode, msg, meta = {}) {
  log[level](msg, { eventCode, ...meta });
}

process.on('unhandledRejection', e => {
  trackError('process.unhandledRejection', e);
  log.error('Unhandled rejection:', e);
});
process.on('uncaughtException',  e => {
  trackError('process.uncaughtException', e);
  log.error('Uncaught exception:', e);
  process.exit(1);
});

// ── Bazinga ───────────────────────────────────────────────────────────────────
let bazingaQueue = [];
const sizeUsage = new Map();

function getNextBazinga() {
  if (bazingaQueue.length === 0) {
    bazingaQueue = [...FRIEND_MESSAGES].sort(() => Math.random() - 0.5);
  }
  return bazingaQueue.pop();
}


// ── Config helpers ────────────────────────────────────────────────────────────
function loadConfig() {
  return loadStoreData(CONFIG_FILE, 1);
}
function saveConfig(d) {
  saveStoreData(CONFIG_FILE, d, 1);
}
function setChannel(guildId, channelId) {
  const d = loadConfig(); d[String(guildId)] = String(channelId); saveConfig(d);
}

function loadJamLinks() {
  return loadStoreData(JAM_LINKS_FILE, 1);
}

function saveJamLinks(data) {
  saveStoreData(JAM_LINKS_FILE, data, 1);
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
  return spotifyClient.call(token, endpoint, method, body);
}

function parseSpotifyInput(inputRaw) {
  const input = String(inputRaw || '').trim();
  if (!input) return null;

  // spotify:track:<id> or spotify:playlist:<id>
  const uriMatch = input.match(/^spotify:(track|playlist):([A-Za-z0-9]+)$/i);
  if (uriMatch) {
    return {
      type: uriMatch[1].toLowerCase(),
      id: uriMatch[2],
      uri: `spotify:${uriMatch[1].toLowerCase()}:${uriMatch[2]}`,
    };
  }

  // https://open.spotify.com/track/<id> or /playlist/<id>
  const urlMatch = input.match(/^https?:\/\/(?:open\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?(track|playlist)\/([A-Za-z0-9]+)/i);
  if (urlMatch) {
    return {
      type: urlMatch[1].toLowerCase(),
      id: urlMatch[2],
      uri: `spotify:${urlMatch[1].toLowerCase()}:${urlMatch[2]}`,
    };
  }

  return null;
}

async function queueSpotifyUri(token, uri) {
  await spotifyApi(token, `/me/player/queue?uri=${encodeURIComponent(uri)}`, 'POST');
}

async function getPlaylistTrackUris(token, playlistId, limit = PLAYLIST_QUEUE_LIMIT) {
  const uris = [];
  let offset = 0;
  const pageSize = Math.min(100, Math.max(1, limit));

  while (uris.length < limit) {
    const endpoint = `/playlists/${playlistId}/tracks?limit=${pageSize}&offset=${offset}&fields=items(track(uri,is_local,type)),next`;
    const data = await spotifyApi(token, endpoint);
    const items = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) break;

    for (const item of items) {
      const track = item?.track;
      const uri = typeof track?.uri === 'string' ? track.uri : null;
      if (!uri) continue;
      if (track?.is_local) continue;
      if (track?.type && track.type !== 'track') continue;
      uris.push(uri);
      if (uris.length >= limit) break;
    }

    if (!data?.next) break;
    offset += items.length;
  }

  return uris;
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

async function ensureLibrespotRunning(timeoutMs = 30000) {
  try {
    const health = await fetch(`${LIBRESPOT_API}/health`).then(r => r.json());
    if (health?.status === 'ok') return true;
  } catch {}

  await fetch(`${LIBRESPOT_API}/restart`, { method: 'POST' }).catch(() => null);
  return waitForLibrespotReady(timeoutMs);
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
  const key = String(discordId);
  const rl = spotifyRateLimitState.get(key);
  if (rl?.until && Date.now() < rl.until) return null;

  const token = await refreshToken(discordId);
  if (!token) return null;
  try {
    const data = await spotifyApi(token.access_token, '/me/player/currently-playing');
    if (rl) spotifyRateLimitState.delete(key);
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
  } catch (e) {
    if (e?.status === 429) {
      const retryMs = Math.max(1000, Number(e.retryAfterMs || 15000));
      const until = Date.now() + retryMs;
      const prev = spotifyRateLimitState.get(key);
      spotifyRateLimitState.set(key, { until, loggedAt: prev?.loggedAt || 0 });
      const state = spotifyRateLimitState.get(key);
      if (!state.loggedAt || Date.now() - state.loggedAt >= 30000) {
        log.warn(`getNowPlaying rate-limited for controller ${key}; backing off ${Math.ceil(retryMs / 1000)}s`);
        state.loggedAt = Date.now();
      }
      return null;
    }
    log.warn('getNowPlaying error:', e.message);
    return null;
  }
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

function dashboardLinkMarkdown() {
  const link = String(PUBLIC_DASHBOARD_URL || '').trim();
  if (!/^https?:\/\//i.test(link)) return '';
  return `[Bot Health Dashboard](${link})`;
}

function buildEmbed(np, hostName) {
  const bar = progressBar(np.progress, np.duration);
  const dashboardLink = dashboardLinkMarkdown();
  const statusLine = `${np.isPlaying ? '**Playing**' : '**Paused**'}  ·  Host: **${hostName}**`;
  const statusWithLink = dashboardLink ? `${statusLine}\n${dashboardLink}` : statusLine;
  const embed = new EmbedBuilder()
    .setColor(0x1DB954)
    .setAuthor({ name: `Now Playing on ${APP_NAME}`, iconURL: 'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png' })
    .setTitle(np.title).setURL(np.trackUrl)
    .setDescription(`by **${np.artist}**  ·  *${np.album}*`)
    .addFields({ name: `${msToTime(np.progress)}  ${bar}  ${msToTime(np.duration)}`, value: statusWithLink })
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
const queueHistory = new Map();

function addQueueHistory(guildId, item) {
  const key = String(guildId);
  const cur = queueHistory.get(key) || [];
  cur.unshift({ ...item, at: Date.now() });
  queueHistory.set(key, cur.slice(0, 50));
}

async function withGuildCommandLock(guildId, fn) {
  return commandLock.withGuildLock(guildId || 'global', fn);
}

function setSessionState(guildId, state) {
  if (!sessions[guildId]) return;
  sessions[guildId].state = state;
  sessions[guildId].stateUpdatedAt = Date.now();
}

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
  const now = Date.now();
  const history = restartHistoryByGuild.get(guildId) || [];
  const recent = history.filter((ts) => now - ts < 60_000);
  if (recent.length >= MAX_RESTARTS_PER_MIN) {
    log.warn(`[${guildId}] restart watchdog tripped; disabling auto-join`);
    disableAutoJoin(guildId, 'restart-watchdog');
    persistRestartHistory();
    return;
  }
  recent.push(now);
  restartHistoryByGuild.set(guildId, recent);
  persistRestartHistory();

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

async function terminateGuildPlayback(guildId, reason = 'Session ended.', autoJoinReason = 'stop command') {
  const hadSession = Boolean(sessions[guildId]);
  setSessionState(guildId, 'draining');
  cancelRestart(guildId);
  disableAutoJoin(guildId, autoJoinReason);
  await releaseSpotifyController(guildId);
  await fetch(`${LIBRESPOT_API}/stop`, { method: 'POST' }).catch(() => null);
  stopPlayer(guildId);
  killFfmpeg(guildId);
  const s = guildState[guildId];
  if (s?.connection) {
    try { s.connection.destroy(); } catch {}
  }
  delete guildState[guildId];
  await endSession(guildId, reason);
  metrics.inc('playback_terminated_total');
  if (hadSession) metrics.inc('sessions_ended_total');
  logEvent('info', 'SESSION_TERMINATED', `[${guildId}] Playback terminated and voice disconnected`, { guildId, reason, autoJoinReason });
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
  ff.on('error', e => {
    trackError(`ffmpeg.spawn.${guildId}`, e);
    log.error(`[${guildId}] ffmpeg spawn error:`, e.message);
    if (s) s.ffmpeg = null;
  });
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
    hostMissingSince: null,
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
    scheduleRestart(guild.id, 1500, 'player-idle');
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
  for (const [guildId, s] of Object.entries(guildState)) {
    if (!s?.connection || !s?.player) continue;

    const guild = client.guilds.cache.get(guildId);
    const channelId = s.connection.joinConfig?.channelId;
    const channel = guild && channelId ? guild.channels.cache.get(String(channelId)) : null;
    if (!channel) continue;

    const humanCount = channel?.members ? channel.members.filter(m => !m.user?.bot).size : 0;
    const session = sessions[guildId];
    const hostId = session?.hostId ? String(session.hostId) : null;
    const hostInChannel = hostId ? channel.members.has(hostId) : true;
    const decision = evaluateLeaveDecision({
      hostId,
      hostInChannel,
      humanCount,
      hostMissingSince: s.hostMissingSince,
      now: Date.now(),
      hostLeaveGraceMs: HOST_LEAVE_GRACE_MS,
    });
    s.hostMissingSince = decision.hostMissingSince;
    if (decision.action === 'wait' && decision.reason === 'host-grace' && hostId) {
      const hostVoiceChannelId = guild.members.cache.get(hostId)?.voice?.channelId;
      if (hostVoiceChannelId && String(hostVoiceChannelId) !== String(channel.id)) {
        logEvent('info', 'HOST_CHANNEL_SWITCH', `[${guildId}] Host moved channels, following`, {
          guildId,
          fromChannelId: String(channel.id),
          toChannelId: String(hostVoiceChannelId),
        });
        setChannel(guildId, hostVoiceChannelId);
        await connectAndStream(guild, hostVoiceChannelId);
        continue;
      }
    }
    if (decision.action === 'leave' && decision.reason === 'host-left-channel') {
      await terminateGuildPlayback(guildId, 'Session ended because host left the voice channel.', 'host-left-channel');
      continue;
    }
    if (decision.action === 'leave' && decision.reason === 'empty-channel') {
      await terminateGuildPlayback(guildId, 'Session ended because no users are in the voice channel.', 'empty-channel');
      continue;
    }
  }
}

// ── Stream loop ───────────────────────────────────────────────────────────────
function streamLoop() {
  const config = loadConfig();
  for (const [guildId, channelId] of Object.entries(config)) {
    if (autoJoinDisabled.has(String(guildId))) continue;
    if (!AUTO_JOIN_WITHOUT_SESSION && !sessions[guildId]) continue;
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
  if (interaction.isChatInputCommand()) {
    const cmd = interaction.commandName;
    const command = commands[cmd];
    if (!command) return;

    const fauxMsg = {
      guild: interaction.guild,
      author: interaction.user,
      member: interaction.member,
      mentions: { users: { first: () => interaction.options.getUser('user') || null }, channels: { first: () => null } },
      content: '',
      reply: async (payload) => {
        if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
        return interaction.reply({ ...payload, ephemeral: true });
      },
    };

    const policy = commandPolicy.check(cmd, {
      member: interaction.member,
      authorId: interaction.user.id,
      sessionHostId: sessions[interaction.guild?.id]?.hostId,
    });
    if (!policy.ok) {
      await interaction.reply({ content: `❌ ${policy.reason}`, ephemeral: true }).catch(() => {});
      return;
    }

    const args = [];
    if (cmd === 'transferhost') {
      const u = interaction.options.getUser('user');
      if (u) args.push(`<@${u.id}>`);
    } else if (cmd === 'dequeue') {
      const index = interaction.options.getInteger('index');
      if (Number.isInteger(index)) args.push(String(index));
    }

    try {
      await withGuildCommandLock(interaction.guild?.id, async () => {
        await command(fauxMsg, args);
      });
    } catch (e) {
      metrics.inc('command_errors_total');
      trackError(`slash.${cmd}`, e);
      log.error(`/${cmd}:`, e.message);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ Command failed.', ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

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
    metrics.inc('command_start_total');
    enableAutoJoin(msg.guild.id, 'start command');
    const bridgeReady = await ensureLibrespotRunning(35_000);
    if (!bridgeReady) {
      return msg.reply({ content: '❌ Spotify backend is offline right now. Please retry !start in a few seconds.' });
    }

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
  sessions[msg.guild.id] = { hostId: msg.author.id, controllerId, hostName, npMessage: null, lastTrackId: null, lastIsPlaying: null, lastEmbedUpdate: 0, sessionId: randomUUID(), startedAt: Date.now(), state: 'starting', stateUpdatedAt: Date.now() };
    await new Promise(r => setTimeout(r, 1200));
  const np = await getNowPlaying(controllerId);
    const embed = np ? buildEmbed(np, hostName) : new EmbedBuilder().setColor(0x1DB954).setAuthor({ name: 'Session Started', iconURL: 'https://storage.googleapis.com/pr-newsroom-wp/1/2018/11/Spotify_Logo_RGB_Green.png' }).setDescription(`Host: **${hostName}**\nOpen Spotify and play something on **${deviceName}**!`).setFooter({ text: APP_FOOTER_TEXT });
    const npMsg = await msg.reply({ embeds: [embed], components: np ? [buildControls(np.isPlaying)] : [], fetchReply: true });
    sessions[msg.guild.id].npMessage = npMsg;
    if (np) { sessions[msg.guild.id].lastTrackId = np.trackId; sessions[msg.guild.id].lastIsPlaying = np.isPlaying; }
    setSessionState(msg.guild.id, 'active');
    metrics.inc('sessions_started_total');

    if (hostChanged) {
      const savedJam = getJamLink(msg.guild.id);
      if (savedJam) {
        await msg.reply({ content: `New host detected. Current saved Jam link: ${savedJam}\nUse !jam <link> to replace it, or !jam to show it again.` });
      } else {
        await msg.reply({ content: 'New host detected. If you want to share queue, send !jam <link>. Use !jam anytime to show the saved link.' });
      }
    }

    log.info(`Session started by ${msg.author.tag}`, { guildId: msg.guild.id, sessionId: sessions[msg.guild.id]?.sessionId });
  },
  async stop(msg) {
    metrics.inc('command_stop_total');
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
  async play(msg, args) {
    metrics.inc('command_play_total');
    const input = args.join(' ').trim();
    if (!input) {
      return msg.reply({ content: '❌ Usage: `!play <spotify track or playlist link>`' });
    }

    enableAutoJoin(msg.guild.id, 'play command');

    const bridgeReady = await ensureLibrespotRunning(35_000);
    if (!bridgeReady) {
      return msg.reply({ content: '❌ Spotify backend is offline right now. Please retry !play in a few seconds.' });
    }

    const config = loadConfig();
    let targetChannelId = config[msg.guild.id];
    if (!targetChannelId && msg.member?.voice?.channelId) {
      targetChannelId = msg.member.voice.channelId;
      setChannel(msg.guild.id, targetChannelId);
    }
    if (targetChannelId && !guildState[msg.guild.id]?.connection) {
      await connectAndStream(msg.guild, targetChannelId);
    }

    const parsed = parseSpotifyInput(input);
    if (!parsed || (parsed.type !== 'track' && parsed.type !== 'playlist')) {
      return msg.reply({ content: '❌ Please provide a valid Spotify **track** or **playlist** link.' });
    }

    const session = sessions[msg.guild.id];
    const controllerId = session?.controllerId || session?.hostId || resolveControllerId(msg.author.id);
    const token = await refreshToken(controllerId);
    if (!token?.access_token) {
      return msg.reply({ content: '❌ Spotify login missing/expired. Run `!link` then try again.' });
    }

    try {
      if (parsed.type === 'track') {
        await queueSpotifyUri(token.access_token, parsed.uri);
        addQueueHistory(msg.guild.id, { type: 'track', uri: parsed.uri, by: msg.author.id });
        return msg.reply({ content: '✅ Added track to queue.' });
      }

      const uris = await getPlaylistTrackUris(token.access_token, parsed.id, PLAYLIST_QUEUE_LIMIT);
      if (!uris.length) {
        return msg.reply({ content: '❌ Playlist has no queueable tracks.' });
      }

      let added = 0;
      for (const uri of uris) {
        await queueSpotifyUri(token.access_token, uri);
        addQueueHistory(msg.guild.id, { type: 'playlist-track', uri, by: msg.author.id });
        added += 1;
      }
      return msg.reply({ content: `✅ Added **${added}** track(s) from playlist to queue.` });
    } catch (e) {
      const m = String(e.spotifyMessage || e.message || 'Unknown error');
      if (/premium|required/i.test(m)) {
        return msg.reply({ content: '❌ Spotify Premium is required for queue control.' });
      }
      if (/no active device|device not found/i.test(m)) {
        return msg.reply({ content: '❌ No active Spotify device found. Start playback first with `!start`.' });
      }
      return msg.reply({ content: `❌ Could not queue this item: ${m.slice(0, 180)}` });
    }
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
      { name: 'Session State', value: session?.state || 'none', inline: true },
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
      { name: 'Spotify Circuit Open', value: spotifyClient.getCircuitState().openUntil > Date.now() ? 'yes' : 'no', inline: true },
    ).setFooter({ text: `${APP_NAME} Debug` })] });
  },
  async diagnostics(msg) {
    const health = await fetch(`${LIBRESPOT_API}/health`).then(r => r.json()).catch(() => ({ status: 'unreachable' }));
    const session = sessions[msg.guild.id];
    const gs = guildState[msg.guild.id];
    const circuit = spotifyClient.getCircuitState();
    const openInMs = Math.max(0, circuit.openUntil - Date.now());
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle(`${APP_NAME} Diagnostics`).addFields(
      { name: 'Health', value: String(health.status || 'unknown'), inline: true },
      { name: 'Session ID', value: session?.sessionId || 'none', inline: true },
      { name: 'Host', value: session?.hostName || 'none', inline: true },
      { name: 'Voice State', value: gs?.connection?.state?.status || 'none', inline: true },
      { name: 'Circuit Open', value: openInMs > 0 ? `yes (${openInMs}ms)` : 'no', inline: true },
      { name: 'Circuit Failures', value: String(circuit.failureCount), inline: true },
    )] });
  },
  async transferhost(msg, args) {
    metrics.inc('command_transferhost_total');
    const s = sessions[msg.guild.id];
    if (!s) return msg.reply({ content: '❌ No active session.' });
    if (String(s.hostId) !== String(msg.author.id)) return msg.reply({ content: '❌ Only current host can transfer ownership.' });
    const target = msg.mentions.users.first();
    if (!target) return msg.reply({ content: '❌ Usage: `!transferhost @user`' });
    const voiceChannelId = guildState[msg.guild.id]?.connection?.joinConfig?.channelId;
    const voiceChannel = voiceChannelId ? msg.guild.channels.cache.get(String(voiceChannelId)) : null;
    if (!voiceChannel?.members?.has(target.id)) return msg.reply({ content: '❌ Target user must be in current voice channel.' });

    s.hostId = target.id;
    s.hostName = msg.guild.members.cache.get(target.id)?.displayName || target.username;
    s.controllerId = resolveControllerId(target.id);
    setSessionState(msg.guild.id, 'active');
    await msg.reply({ content: `✅ Host transferred to **${s.hostName}**.` });
  },
  async queue(msg) {
    const items = queueHistory.get(String(msg.guild.id)) || [];
    if (!items.length) return msg.reply({ content: 'Queue history is empty.' });
    const lines = items.slice(0, 10).map((it, i) => `${i + 1}. ${it.type} ${it.uri}`);
    await msg.reply({ content: `Recent queued items:\n${lines.join('\n')}` });
  },
  async dequeue(msg, args) {
    const idx = Number(args[0] || 0);
    if (!Number.isInteger(idx) || idx < 1) return msg.reply({ content: '❌ Usage: `!dequeue <index>`' });
    const key = String(msg.guild.id);
    const items = queueHistory.get(key) || [];
    if (idx > items.length) return msg.reply({ content: '❌ Queue index out of range.' });
    const [removed] = items.splice(idx - 1, 1);
    queueHistory.set(key, items);
    await msg.reply({ content: `Removed local queue history item: ${removed.uri}` });
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
    await terminateGuildPlayback(msg.guild.id, 'Session ended.');
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
  async size(msg) {
    const name = msg.member?.displayName || msg.author.username;
    const now = Date.now();
    const recentUses = (sizeUsage.get(msg.author.id) || []).filter(ts => now - ts < 60_000);
    recentUses.push(now);
    sizeUsage.set(msg.author.id, recentUses);

    if (recentUses.length > 2) {
      await msg.reply({ content: `${name}, ia-o in gura.` });
      return;
    }

    const nr = Math.floor(Math.random() * 25) + 1;
    await msg.reply({ content: `${name} are ciocanul de ${nr} cm.` });
  },
  async ping(msg) { await msg.reply({ content: `${Math.round(client.ws.ping)}ms` }); },
  async dashboard(msg) {
    if (!PUBLIC_DASHBOARD_URL || !/^https?:\/\//i.test(PUBLIC_DASHBOARD_URL)) {
      return msg.reply({ content: '❌ Dashboard URL is not configured. Set `PUBLIC_DASHBOARD_URL` in `.env`.' });
    }
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x42aaff).setTitle(`${APP_NAME} Live Dashboard`).setDescription(`[Open dashboard](${PUBLIC_DASHBOARD_URL})`).setFooter({ text: APP_FOOTER_TEXT })] });
  },
  async help(msg) {
    await msg.reply({ embeds: [new EmbedBuilder().setColor(0x1DB954).setTitle(`${APP_NAME} Commands`).addFields(
      { name: 'Playback', value: '`!start`  `!stop`  `!play <spotify-link>`  `!np`  `!session`' },
      { name: 'Queue',    value: '`!queue`  `!dequeue <index>`' },
      { name: 'Audio',    value: '`!volume [0-200]`  `!restart`' },
      { name: 'Voice',    value: '`!join`  `!leave`  `!setchannel [#ch]`' },
      { name: 'Account',  value: '`!link`  `!unlink`  `!jam [link]`  `!dashboard`  `!ping`  `!bazinga`  `!size`  `!weathertest`' },
      { name: 'Debug',    value: '`!debug`  `!diagnostics`  `!controller`  `!tokeninfo`  `!devices`  `!voice`  `!flush`  `!restream`' },
      { name: 'Host',     value: '`!transferhost @user`' },
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

  const dmAllowed = new Set(['bazinga', 'ping', 'help', 'link', 'dashboard']);
  if (!msg.guild && !dmAllowed.has(cmd)) {
    await msg.reply({ content: '❌ This command only works in a server channel.' }).catch(() => {});
    return;
  }

  const policy = commandPolicy.check(cmd, {
    member: msg.member,
    authorId: msg.author.id,
    sessionHostId: sessions[msg.guild?.id]?.hostId,
  });
  if (!policy.ok) {
    await msg.reply({ content: `❌ ${policy.reason}` }).catch(() => {});
    return;
  }

  try {
    await withGuildCommandLock(msg.guild?.id, async () => {
      await command(msg, args);
    });
  }
  catch (e) {
    metrics.inc('command_errors_total');
    trackError(`prefix.${cmd}`, e);
    log.error(`!${cmd}:`, e);
    msg.reply({ content: '❌ Error.' }).catch(() => {});
  }
});

client.once(Events.ClientReady, () => {
  logEvent('info', 'BOT_READY', `Logged in as ${client.user.tag}`);
  client.application?.commands.set(buildSlashCommands()).catch((e) => {
    log.warn(`Slash command registration failed: ${e.message}`);
  });
  updatePresence(null, true);
  setInterval(streamLoop,    10_000);
  setInterval(spotifyPoller,  SPOTIFY_POLL_MS);
  setInterval(librespotEventPoller, LIBRESPOT_EVENT_POLL_MS);
  setInterval(() => { idleVoiceMonitor().catch(e => log.warn('idleVoiceMonitor:', e.message)); }, 10_000);
  setTimeout(streamLoop,      3_000);

});

http.createServer((req, res) => {
  const reqUrl = new URL(req.url || '/', 'http://localhost');
  const route = reqUrl.pathname;

  if (route === '/metrics') {
    runtimeDiag.requests.metrics += 1;
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.end(metrics.toPrometheus());
    return;
  }

  if (route === '/health') {
    runtimeDiag.requests.health += 1;
    const payload = {
      status: 'ok',
      guildStates: Object.keys(guildState).length,
      sessions: Object.keys(sessions).length,
      spotifyCircuitOpen: spotifyClient.getCircuitState().openUntil > Date.now(),
      counters: metrics.snapshot(),
    };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
    return;
  }

  if (route === '/api/dashboard') {
    runtimeDiag.requests.dashboardApi += 1;
    const mem = process.memoryUsage();
    const circuit = spotifyClient.getCircuitState();
    const recentLogs = typeof log.getRecentLogs === 'function' ? log.getRecentLogs(90) : [];
    const restartSnapshot = Object.fromEntries(
      Array.from(restartHistoryByGuild.entries()).map(([guildId, arr]) => [
        guildId,
        Array.isArray(arr) ? arr.filter((ts) => Date.now() - ts < 60_000).length : 0,
      ])
    );
    const health = {
      status: 'ok',
      guildStates: Object.keys(guildState).length,
      sessions: Object.keys(sessions).length,
      spotifyCircuitOpen: circuit.openUntil > Date.now(),
      counters: metrics.snapshot(),
    };
    const sessionHosts = Object.values(sessions)
      .map((s) => ({ guildId: s.guildId, hostId: s.hostId, voiceChannelId: s.voiceChannelId }))
      .slice(0, 25);

    const guildRuntime = Object.entries(guildState).map(([gid, gs]) => ({
      guildId: gid,
      playerStatus: gs?.player?.state?.status || 'none',
      hasConnection: Boolean(gs?.connection),
      voiceChannelId: gs?.connection?.joinConfig?.channelId || null,
      ffmpegPid: gs?.ffmpeg?.pid || null,
      restartTimerActive: Boolean(gs?.restartTimer),
      volumePercent: gs?.volumePercent ?? null,
    }));

    const topCounters = Object.entries(metrics.snapshot())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, value]) => ({ name, value }));

    const payload = {
      status: 'ok',
      now: new Date().toISOString(),
      uptimeSec: Math.floor(process.uptime()),
      health,
      metrics: metrics.snapshot(),
      sessions: sessionHosts,
      guildIds: Object.keys(guildState),
      diagnostics: {
        pid: process.pid,
        nodeVersion: process.version,
        startedAt: new Date(runtimeDiag.startedAt).toISOString(),
        memoryMb: {
          rss: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
          heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
          heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        },
        requests: runtimeDiag.requests,
        spotifyCircuit: {
          failureCount: circuit.failureCount,
          openUntil: circuit.openUntil,
          openRemainingMs: Math.max(0, circuit.openUntil - Date.now()),
        },
        commandLock: commandLock.stats(),
        autoJoinDisabledGuilds: Array.from(autoJoinDisabled.values()),
        queueHistoryCounts: Object.fromEntries(Array.from(queueHistory.entries()).map(([k, arr]) => [k, arr.length])),
        restartWatchdogPerGuild: restartSnapshot,
        runtimeErrors: runtimeDiag.errors.slice(-40),
        guildRuntime,
        topCounters,
        recentLogs,
      },
    };

    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
    return;
  }

  if (route === '/' || route === '/dashboard') {
    runtimeDiag.requests.dashboardPage += 1;
    const htmlPath = path.join(DASHBOARD_DIR, 'index.html');
    fs.readFile(htmlPath, 'utf8', (err, html) => {
      if (err) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('dashboard unavailable');
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
    });
    return;
  }

  if (route === '/dashboard/styles.css' || route === '/dashboard/app.js' || route === '/dashboard/icon.png' || route === '/favicon.ico') {
    runtimeDiag.requests.static += 1;
    const relPath = route === '/favicon.ico' ? 'icon.png' : route.replace('/dashboard/', '');
    const filePath = path.join(DASHBOARD_DIR, relPath);
    const contentType = relPath.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : relPath.endsWith('.js')
        ? 'application/javascript; charset=utf-8'
        : 'image/png';
    const encoding = relPath.endsWith('.png') ? undefined : 'utf8';
    fs.readFile(filePath, encoding, (err, content) => {
      if (err) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('content-type', contentType);
      res.end(content);
    });
    return;
  }

  if (route !== '/health') {
    runtimeDiag.requests.notFound += 1;
    res.statusCode = 404;
    res.end('not found');
    return;
  }
}).listen(BOT_HEALTH_PORT, () => {
  log.info(`Bot health endpoint listening on :${BOT_HEALTH_PORT}`);
});

client.login(DISCORD_TOKEN);