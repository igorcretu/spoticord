function evaluateLeaveDecision({
  hostId,
  hostInChannel,
  humanCount,
  hostMissingSince,
  now,
  hostLeaveGraceMs,
}) {
  if (hostId && !hostInChannel) {
    const missingSince = hostMissingSince || now;
    const elapsed = now - missingSince;
    if (elapsed >= hostLeaveGraceMs) {
      return { action: 'leave', reason: 'host-left-channel', hostMissingSince: missingSince };
    }
    return { action: 'wait', reason: 'host-grace', hostMissingSince: missingSince };
  }

  if (humanCount === 0) {
    return { action: 'leave', reason: 'empty-channel', hostMissingSince: null };
  }

  return { action: 'stay', reason: 'ok', hostMissingSince: null };
}

module.exports = {
  evaluateLeaveDecision,
};
