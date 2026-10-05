(function () {
  // Cross-tab budget survives server-worker changes. No mail bodies or tokens
  // are written to localStorage. Indexed mail stays in account-scoped IDB.
  let account;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function key() {
    account ||= fetch('/api/auth/session', { credentials: 'same-origin' }).then(r => r.json()).then(s => 'clara-gmail-budget:' + (s.user?.email || 'anonymous').toLowerCase());
    return account;
  }
  const read = k => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  const write = (k, value) => { try { localStorage.setItem(k, JSON.stringify(value)); } catch { /* Storage denied: server pacing still applies. */ } };
  async function locked(k, work) {
    if (navigator.locks) return navigator.locks.request(k, work);
    return work();
  }
  window.ClaraGmailRead = async function (url, options = {}, cost = 650, background = false) {
    const k = await key();
    while (true) {
      options.signal?.throwIfAborted();
      const delay = await locked(k, () => {
        const now = Date.now(), state = read(k);
        state.requests = (state.requests || []).filter(r => now - r.at < 60000);
        const used = state.requests.reduce((sum, r) => sum + r.cost, 0);
        if (!background) state.interactive = now;
        let delay = Math.max(0, (state.until || 0) - now);
        if (background) delay = Math.max(delay, (state.interactive || 0) + 10000 - now);
        if (used + cost > 4000) delay = Math.max(delay, state.requests[0].at + 60000 - now);
        if (!delay) state.requests.push({ at: now, cost });
        write(k, state); return delay;
      });
      if (!delay) break;
      await wait(Math.min(delay, 1000));
    }
    options.signal?.throwIfAborted();
    const res = await fetch(url, options);
    const data = await res.clone().json().catch(() => ({}));
    if (data.error === 'quota_exceeded' || data.quotaExceeded) {
      await locked(k, () => {
        const state = read(k);
        state.until = Math.max(state.until || 0, Date.now() + Math.max(60000, data.retryAfterMs || (data.retryAfter || 60) * 1000));
        write(k, state);
      });
    }
    return res;
  };
})();
