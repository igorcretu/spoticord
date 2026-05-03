function createMetrics() {
  const counters = new Map();

  function inc(name, by = 1) {
    counters.set(name, (counters.get(name) || 0) + by);
  }

  function get(name) {
    return counters.get(name) || 0;
  }

  function snapshot() {
    const out = {};
    for (const [k, v] of counters.entries()) out[k] = v;
    return out;
  }

  function toPrometheus() {
    const lines = [];
    for (const [k, v] of counters.entries()) {
      const metric = String(k).replace(/[^a-zA-Z0-9_:]/g, '_');
      lines.push(`${metric} ${v}`);
    }
    return lines.join('\n');
  }

  return {
    inc,
    get,
    snapshot,
    toPrometheus,
  };
}

module.exports = {
  createMetrics,
};
