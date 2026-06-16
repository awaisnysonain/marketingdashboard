// Local dev skips ERP auth; production requires a real session.
// Set ERP_AUTH_BYPASS=true|false to override NODE_ENV behaviour.

const DEV_BYPASS_USER = {
  id: 0,
  email: 'dev@local',
  name: 'Dev User',
  role: 'admin',
  nav_group: 'dev',
  portals: ['*'],
  content_permissions: {},
  theme: 'dark',
  source: 'bypass',
};

function isAuthBypassEnabled() {
  if (process.env.ERP_AUTH_BYPASS === 'true') return true;
  if (process.env.ERP_AUTH_BYPASS === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

function getDevBypassUser() {
  return {
    ...DEV_BYPASS_USER,
    expires_at: Math.floor(Date.now() / 1000) + 7200,
  };
}

function effectiveUserId(req) {
  if (isAuthBypassEnabled()) return DEV_BYPASS_USER.id;
  if (req.session?.userId) return req.session.userId;
  if (req.session?.erp?.id != null) return req.session.erp.id;
  return null;
}

function effectiveUserName(req) {
  if (isAuthBypassEnabled()) return DEV_BYPASS_USER.name;
  if (req.session?.erp?.name) return req.session.erp.name;
  return null;
}

function isAdminSession(req) {
  if (isAuthBypassEnabled()) return true;
  if (req.session?.erp?.role === 'admin') return true;
  return false;
}

module.exports = {
  isAuthBypassEnabled,
  getDevBypassUser,
  effectiveUserId,
  effectiveUserName,
  isAdminSession,
};
