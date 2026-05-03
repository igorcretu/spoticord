function createSpotifyApi(fetchImpl, log, options = {}) {
  const cacheTtlMs = Number(options.cacheTtlMs || 1500);
  const failureThreshold = Number(options.failureThreshold || 5);
  const openMs = Number(options.openMs || 30000);
  const cache = new Map();
  let failureCount = 0;
  let openUntil = 0;

  async function call(token, endpoint, method = 'GET', body = null) {
    const now = Date.now();
    if (now < openUntil) {
      const err = new Error('Spotify API circuit open');
      err.status = 503;
      throw err;
    }

    const cacheKey = `${token}:${method}:${endpoint}:${body ? JSON.stringify(body) : ''}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expireAt > now) return cached.value;

    const opts = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body) {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }

    let attempt = 0;
    while (attempt < 3) {
      attempt += 1;
      const response = await fetchImpl(`https://api.spotify.com/v1${endpoint}`, opts);
      if (response.status === 204 || response.status === 202) {
        failureCount = 0;
        return {};
      }

      const text = await response.text();
      let data = {};
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text.trim() };
        }
      }

      if (response.ok) {
        failureCount = 0;
        cache.set(cacheKey, { value: data, expireAt: Date.now() + cacheTtlMs });
        return data;
      }

      const message = data?.error?.message || data?.message || response.statusText || `HTTP ${response.status}`;
      const transient = response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (transient && attempt < 3) {
        const retryAfterRaw = response.headers.get('retry-after');
        const retrySec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN;
        const waitMs = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : 300 * attempt;
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }

      if (transient) {
        failureCount += 1;
        if (failureCount >= failureThreshold) {
          openUntil = Date.now() + openMs;
          log.warn(`Spotify circuit opened for ${openMs}ms after ${failureCount} transient failures`);
        }
      } else {
        failureCount = 0;
      }

      const err = new Error(`Spotify API ${response.status}: ${message}`);
      err.status = response.status;
      err.spotifyMessage = String(message);
      if (response.status === 429) {
        const retryAfterRaw = response.headers.get('retry-after');
        const retrySec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : NaN;
        err.retryAfterMs = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : 15000;
      }
      throw err;
    }

    throw new Error('Spotify API retries exhausted');
  }

  return {
    call,
    getCircuitState: () => ({ failureCount, openUntil }),
    resetCircuit: () => {
      failureCount = 0;
      openUntil = 0;
    },
  };
}

module.exports = {
  createSpotifyApi,
};
