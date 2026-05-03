function createCommandLock() {
  const inFlight = new Map();

  async function withGuildLock(guildId, fn) {
    const key = String(guildId || 'global');
    const prev = inFlight.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    inFlight.set(key, prev.then(() => current));

    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (inFlight.get(key) === current) {
        inFlight.delete(key);
      }
    }
  }

  return {
    withGuildLock,
    stats: () => ({
      inFlightKeys: inFlight.size,
      guildIds: Array.from(inFlight.keys()),
    }),
  };
}

module.exports = {
  createCommandLock,
};
