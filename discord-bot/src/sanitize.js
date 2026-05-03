const TOKEN_REPLACERS = [
  {
    pattern: /\b[A-Za-z\d_-]{20,30}\.[A-Za-z\d_-]{6,}\.[A-Za-z\d_-]{20,}\b/g,
    replace: '[REDACTED]',
  },
  {
    pattern: /https?:\/\/discord(?:app)?\.com\/api\/webhooks\/[\w-]+\/[\w-]+/gi,
    replace: '[REDACTED_WEBHOOK]',
  },
  {
    pattern: /(SPOTIFY_CLIENT_SECRET=)([^\s]+)/g,
    replace: '$1[REDACTED]',
  },
];

function sanitizeText(input) {
  let out = String(input == null ? '' : input);
  for (const { pattern, replace } of TOKEN_REPLACERS) {
    out = out.replace(pattern, replace);
  }
  return out;
}

function sanitizeObject(value) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/token|secret|password|webhook/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeObject(v);
      }
    }
    return out;
  }
  return value;
}

module.exports = {
  sanitizeText,
  sanitizeObject,
};
