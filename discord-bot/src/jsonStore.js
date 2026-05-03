const fs = require('fs');
const path = require('path');

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, filePath);
}

function migrateObjectStore(filePath, expectedVersion = 1) {
  const current = readJson(filePath, {});
  if (current && current.__schemaVersion === expectedVersion) {
    return current;
  }

  // Backward compatibility: old files were plain object maps.
  const migrated = {
    __schemaVersion: expectedVersion,
    updatedAt: new Date().toISOString(),
    data: current && typeof current === 'object' && !Array.isArray(current) && current.data ? current.data : current,
  };

  atomicWriteJson(filePath, migrated);
  return migrated;
}

function loadStoreData(filePath, expectedVersion = 1) {
  const doc = migrateObjectStore(filePath, expectedVersion);
  return doc.data || {};
}

function saveStoreData(filePath, data, expectedVersion = 1) {
  atomicWriteJson(filePath, {
    __schemaVersion: expectedVersion,
    updatedAt: new Date().toISOString(),
    data,
  });
}

function cleanupTokenFiles(tokenDir, maxAgeDays = 60) {
  if (!fs.existsSync(tokenDir)) return { removed: 0, kept: 0 };
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let kept = 0;
  for (const name of fs.readdirSync(tokenDir)) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(tokenDir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      const expiresAt = Number(parsed.expires_at || 0) * 1000;
      if (expiresAt > 0 && now - expiresAt > maxAgeMs) {
        fs.unlinkSync(full);
        removed += 1;
      } else {
        kept += 1;
      }
    } catch {
      // Remove unreadable token artifacts so they do not break auth workflows.
      fs.unlinkSync(full);
      removed += 1;
    }
  }
  return { removed, kept };
}

module.exports = {
  readJson,
  atomicWriteJson,
  loadStoreData,
  saveStoreData,
  cleanupTokenFiles,
};
