const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommandLock } = require('../src/commandLock');

test('serializes operations per guild', async () => {
  const lock = createCommandLock();
  const order = [];

  await Promise.all([
    lock.withGuildLock('g1', async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 30));
      order.push('a2');
    }),
    lock.withGuildLock('g1', async () => {
      order.push('b1');
      order.push('b2');
    }),
  ]);

  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2']);
});
