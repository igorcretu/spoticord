const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadStoreData, saveStoreData } = require('../src/jsonStore');

test('migrates legacy object store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoticord-store-'));
  const file = path.join(dir, 'legacy.json');
  fs.writeFileSync(file, JSON.stringify({ a: '1' }));

  const data = loadStoreData(file, 1);
  assert.equal(data.a, '1');

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.__schemaVersion, 1);
  assert.equal(parsed.data.a, '1');
});

test('saves data with schema wrapper', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spoticord-store-'));
  const file = path.join(dir, 'store.json');
  saveStoreData(file, { guild: 'abc' }, 1);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.__schemaVersion, 1);
  assert.equal(parsed.data.guild, 'abc');
});
