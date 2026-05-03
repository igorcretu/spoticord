function parseRoleIds(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function memberHasAnyRole(member, roleSet) {
  if (!member || !roleSet.size) return false;
  const cache = member.roles?.cache;
  if (!cache) return false;
  for (const id of roleSet) {
    if (cache.has(id)) return true;
  }
  return false;
}

function canManageGuild(member) {
  return Boolean(member?.permissions?.has?.('ManageGuild'));
}

function createCommandPolicy(env) {
  const adminRoleIds = parseRoleIds(env.ADMIN_ROLE_IDS);
  const modRoleIds = parseRoleIds(env.MOD_ROLE_IDS);

  const requirements = {
    setchannel: 'mod',
    restart: 'mod',
    stop: 'hostOrMod',
    transferhost: 'hostOrMod',
  };

  function check(commandName, ctx) {
    const level = requirements[commandName] || 'any';
    if (level === 'any') return { ok: true };

    const member = ctx.member;
    const isAdminRole = memberHasAnyRole(member, adminRoleIds);
    const isModRole = memberHasAnyRole(member, modRoleIds);
    const isManager = canManageGuild(member);
    const privileged = isAdminRole || isModRole || isManager;

    if (level === 'mod') {
      if (privileged) return { ok: true };
      return { ok: false, reason: 'You need mod permissions for this command.' };
    }

    if (level === 'hostOrMod') {
      const sessionHostId = ctx.sessionHostId ? String(ctx.sessionHostId) : null;
      if (sessionHostId && String(ctx.authorId) === sessionHostId) return { ok: true };
      if (privileged) return { ok: true };
      return { ok: false, reason: 'Only host or a mod can run this command.' };
    }

    return { ok: true };
  }

  return {
    check,
  };
}

module.exports = {
  createCommandPolicy,
};
