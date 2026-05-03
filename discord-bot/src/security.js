const REQUIRED_ENV_VARS = [
  'DISCORD_TOKEN',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REDIRECT_URI',
];

function redactSecret(value = '') {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function validateRequiredEnv(env) {
  const missing = REQUIRED_ENV_VARS.filter((k) => !String(env[k] || '').trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

function validateSuspiciousValues(env) {
  const bad = [];
  if (String(env.DISCORD_TOKEN || '').includes('your_discord_bot_token')) bad.push('DISCORD_TOKEN');
  if (String(env.SPOTIFY_CLIENT_ID || '').includes('your_spotify_client_id')) bad.push('SPOTIFY_CLIENT_ID');
  if (String(env.SPOTIFY_CLIENT_SECRET || '').includes('your_spotify_client_secret')) bad.push('SPOTIFY_CLIENT_SECRET');
  if (String(env.SPOTIFY_REDIRECT_URI || '').includes('yourdomain.com')) bad.push('SPOTIFY_REDIRECT_URI');
  if (bad.length) {
    throw new Error(`Refusing to start with placeholder values in: ${bad.join(', ')}`);
  }
}

function startupSecurityCheck(env, log) {
  validateRequiredEnv(env);
  validateSuspiciousValues(env);
  if (String(env.LOG_LEVEL || '').toUpperCase() === 'DEBUG') {
    log.warn('LOG_LEVEL=DEBUG is enabled. Consider INFO in production to reduce sensitive metadata exposure.');
  }
  log.info(
    `Security check passed (discord=${redactSecret(env.DISCORD_TOKEN)}, spotifyClient=${redactSecret(env.SPOTIFY_CLIENT_ID)})`
  );
}

module.exports = {
  startupSecurityCheck,
  redactSecret,
};
