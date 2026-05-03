const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpotifyApi } = require('../src/spotifyApi');

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    headers: {
      get: (k) => headers[k.toLowerCase()] || null,
    },
    statusText: 'status',
  };
}

test('opens circuit after repeated transient failures', async () => {
  const logs = [];
  const log = { warn: (m) => logs.push(m) };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(503, { message: 'down' });
  };

  const api = createSpotifyApi(fetchImpl, log, { failureThreshold: 2, openMs: 1000, cacheTtlMs: 1 });

  await assert.rejects(() => api.call('tok', '/me/player', 'GET'));
  await assert.rejects(() => api.call('tok', '/me/player', 'GET'));
  await assert.rejects(() => api.call('tok', '/me/player', 'GET'));

  const state = api.getCircuitState();
  assert.ok(state.openUntil > Date.now());
  assert.ok(calls >= 2);
  assert.ok(logs.length >= 1);
});
