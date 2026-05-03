function assertNumberInRange(name, value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number in range [${min}, ${max}]`);
  }
}

function validateConfig(env) {
  assertNumberInRange('SPOTIFY_POLL_MS', env.SPOTIFY_POLL_MS || 2000, 500, 60000);
  assertNumberInRange('HOST_LEAVE_GRACE_MS', env.HOST_LEAVE_GRACE_MS || 15000, 0, 300000);
  assertNumberInRange('MAX_RESTARTS_PER_MIN', env.MAX_RESTARTS_PER_MIN || 10, 1, 120);
  assertNumberInRange('BOT_HEALTH_PORT', env.BOT_HEALTH_PORT || 7070, 1, 65535);
  assertNumberInRange('PLAYLIST_QUEUE_LIMIT', env.PLAYLIST_QUEUE_LIMIT || 50, 1, 500);
  if (!/^https:\/\//i.test(String(env.SPOTIFY_REDIRECT_URI || ''))) {
    throw new Error('SPOTIFY_REDIRECT_URI must use https://');
  }
}

module.exports = {
  validateConfig,
};
