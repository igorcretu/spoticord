const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommandPolicy } = require('../src/commandPolicy');

function memberWithRoles(roleIds = []) {
  return {
    roles: {
      cache: {
        has: (id) => roleIds.includes(id),
      },
    },
    permissions: {
      has: () => false,
    },
  };
}

test('mod command blocked without privileges', () => {
  const policy = createCommandPolicy({ MOD_ROLE_IDS: '2', ADMIN_ROLE_IDS: '1' });
  const result = policy.check('setchannel', { member: memberWithRoles([]), authorId: 'x', sessionHostId: null });
  assert.equal(result.ok, false);
});

test('hostOrMod allows host', () => {
  const policy = createCommandPolicy({ MOD_ROLE_IDS: '2', ADMIN_ROLE_IDS: '1' });
  const result = policy.check('stop', { member: memberWithRoles([]), authorId: 'abc', sessionHostId: 'abc' });
  assert.equal(result.ok, true);
});

test('mod role allows restricted command', () => {
  const policy = createCommandPolicy({ MOD_ROLE_IDS: '2', ADMIN_ROLE_IDS: '1' });
  const result = policy.check('restart', { member: memberWithRoles(['2']), authorId: 'u', sessionHostId: null });
  assert.equal(result.ok, true);
});
