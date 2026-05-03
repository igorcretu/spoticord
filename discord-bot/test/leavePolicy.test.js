const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateLeaveDecision } = require('../src/leavePolicy');

test('leave when host absent beyond grace', () => {
  const now = Date.now();
  const out = evaluateLeaveDecision({
    hostId: '1',
    hostInChannel: false,
    humanCount: 2,
    hostMissingSince: now - 20000,
    now,
    hostLeaveGraceMs: 15000,
  });
  assert.equal(out.action, 'leave');
  assert.equal(out.reason, 'host-left-channel');
});

test('wait while host grace active', () => {
  const now = Date.now();
  const out = evaluateLeaveDecision({
    hostId: '1',
    hostInChannel: false,
    humanCount: 2,
    hostMissingSince: now - 5000,
    now,
    hostLeaveGraceMs: 15000,
  });
  assert.equal(out.action, 'wait');
  assert.equal(out.reason, 'host-grace');
});

test('leave when channel is empty', () => {
  const now = Date.now();
  const out = evaluateLeaveDecision({
    hostId: null,
    hostInChannel: true,
    humanCount: 0,
    hostMissingSince: null,
    now,
    hostLeaveGraceMs: 15000,
  });
  assert.equal(out.action, 'leave');
  assert.equal(out.reason, 'empty-channel');
});
