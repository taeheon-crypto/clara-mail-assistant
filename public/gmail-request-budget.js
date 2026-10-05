(function () {
  // Cross-tab budget survives server-worker changes. No mail bodies or tokens
  // are written to localStorage. Indexed mail stays in account-scoped IDB.
  let account;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function key() {
    account ||= fetch('/api/auth/session', { credentials: 'same-origin' }).then(r => r.json()).then(s => 'clara-gmail-budget:' + (s.user?.email || 'anonymous').toLowerCase());
    return account;
  }
  const read = k => {
    try {
      const state = JSON.parse(localStorage.getItem(k)) || {};
      // Migrate cooldowns produced by the old parallel-backoff bug. The next
      // provider response can still extend the wait with its real Retry-After.
      if (state.version !== 2) { state.until = Math.min(state.until || 0, Date.now() + 120000); state.version = 2; }
      return state;
    } catch { return {}; }
  };
  const write = (k, value) => { try { localStorage.setItem(k, JSON.stringify(value)); } catch { /* Storage denied: server pacing still applies. */ } };
  let mailboxDB;
  function openMailboxDB() {
    mailboxDB ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('clara-mailbox-cache-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('folders');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return mailboxDB;
  }
  async function indexedFolder(folder, accountKey) {
    const labels = { inbox:'INBOX', primary:'CATEGORY_PERSONAL', sent:'SENT', drafts:'DRAFT', starred:'STARRED', important:'IMPORTANT', social:'CATEGORY_SOCIAL', updates:'CATEGORY_UPDATES', promotions:'CATEGORY_PROMOTIONS', forums:'CATEGORY_FORUMS', spam:'SPAM', deleted:'TRASH' };
    if (folder !== 'all' && !labels[folder]) return null;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('clara-ontology-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('accounts');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const saved = await new Promise((resolve, reject) => {
        const request = db.transaction('accounts').objectStore('accounts').get(accountKey.replace('clara-gmail-budget:', ''));
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const records = Object.values(saved?.emails || {}).filter(m => {
        const ids = m.labelIds || [];
        if (!['spam','deleted'].includes(folder) && (ids.includes('SPAM') || ids.includes('TRASH'))) return false;
        return (folder === 'all' || ids.includes(labels[folder])) && (folder !== 'primary' || ids.includes('INBOX'));
      }).sort((a,b) => Date.parse(b.dateISO) - Date.parse(a.dateISO)).slice(0, 30);
      if (!records.length) return null;
      return { sourceEmails: records.map(m => ({ ...m, date:m.dateISO, preview:m.body?.slice(0,140) || '', bodyLoaded:false, unread:m.labelIds?.includes('UNREAD'), starred:m.labelIds?.includes('STARRED'), mailbox:folder })), time:0, cursor:null, hasMore:false, retry:false };
    } finally { db.close(); }
  }
  window.ClaraMailboxStore = {
    async load(folder) {
      try {
        const k = await key(), db = await openMailboxDB();
        const saved = await new Promise((resolve, reject) => {
          const request = db.transaction('folders').objectStore('folders').get(k + ':' + folder);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        return saved || await indexedFolder(folder, k);
      } catch { return null; }
    },
    async save(folder, snapshot) {
      try {
        const k = await key(), db = await openMailboxDB();
        const tx = db.transaction('folders', 'readwrite');
        tx.objectStore('folders').put(snapshot, k + ':' + folder);
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
      } catch { /* A denied/full cache must not prevent reading Gmail. */ }
    },
    async clear() {
      try {
        const k = await key(), db = await openMailboxDB();
        const tx = db.transaction('folders', 'readwrite'), store = tx.objectStore('folders');
        const request = store.openCursor();
        request.onsuccess = () => { const cursor = request.result; if (cursor) { if (String(cursor.key).startsWith(k + ':')) cursor.delete(); cursor.continue(); } };
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
      } catch { /* Cache invalidation remains best effort when storage is denied. */ }
    }
  };
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
        const backgroundUsed = state.requests.filter(r => r.background).reduce((sum, r) => sum + r.cost, 0);
        if (!background) state.interactive = now;
        let delay = Math.max(0, (state.until || 0) - now);
        if (background) delay = Math.max(delay, (state.interactive || 0) + 10000 - now);
        if (used + cost > 4000) delay = Math.max(delay, state.requests[0].at + 60000 - now);
        // Leave half the rolling allowance for opening folders and messages.
        if (background && backgroundUsed + cost > 2000) delay = Math.max(delay, state.requests.find(r => r.background).at + 60000 - now);
        if (!delay) state.requests.push({ at: now, cost, background });
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
