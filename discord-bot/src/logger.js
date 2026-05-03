const { sanitizeText, sanitizeObject } = require('./sanitize');

function createLogger(level = 'INFO', options = {}) {
  const map = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
  const current = map[String(level || 'INFO').toUpperCase()] ?? map.INFO;
  const bufferSize = Math.max(10, Number(options.bufferSize || 300));
  const recent = [];

  function pushRecent(payload) {
    recent.push(payload);
    if (recent.length > bufferSize) recent.splice(0, recent.length - bufferSize);
  }

  function should(levelName) {
    return (map[levelName] ?? map.INFO) >= current;
  }

  function emit(levelName, ...args) {
    if (!should(levelName)) return;
    const message = args.length ? sanitizeText(String(args[0])) : '';
    const rest = args.slice(1);
    const payload = {
      ts: new Date().toISOString(),
      level: levelName,
      msg: message,
    };
    if (rest.length === 1 && rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
      payload.meta = sanitizeObject(rest[0]);
    } else if (rest.length) {
      payload.meta = { args: rest.map((v) => sanitizeText(String(v))) };
    }
    if (payload.meta?.eventCode) payload.code = payload.meta.eventCode;
    pushRecent(payload);
    const line = JSON.stringify(payload);
    if (levelName === 'ERROR') console.error(line);
    else if (levelName === 'WARN') console.warn(line);
    else console.log(line);
  }

  return {
    info: (...args) => emit('INFO', ...args),
    warn: (...args) => emit('WARN', ...args),
    error: (...args) => emit('ERROR', ...args),
    debug: (...args) => emit('DEBUG', ...args),
    getRecentLogs: (limit = 100) => {
      const n = Math.max(1, Number(limit || 100));
      return recent.slice(-n);
    },
  };
}

module.exports = {
  createLogger,
};
