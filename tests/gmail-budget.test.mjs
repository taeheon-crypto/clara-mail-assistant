import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function tabs(fetchBody) {
  const code = await readFile(new URL('../public/gmail-request-budget.js', import.meta.url), 'utf8');
  const store = new Map(), clock = { now: 1000000 }, calls = [];
  let tail = Promise.resolve();
  class Clock extends Date { static now() { return clock.now; } }
  const lock = { request(_key, fn) { const result = tail.then(fn); tail = result.catch(() => {}); return result; } };
  const open = email => {
    const window = {};
    vm.runInNewContext(code, { window, Date: Clock, navigator: { locks: lock }, localStorage: { getItem: k => store.get(k), setItem: (k, v) => store.set(k, v) },
      setTimeout(fn, ms) { clock.now += ms; fn(); }, fetch: async url => {
        if (url === '/api/auth/session') return Response.json({ user: { email } });
        calls.push({ url, at: clock.now }); return Response.json(fetchBody?.(url) || {});
      } });
    return window.ClaraGmailRead;
  };
  return { open, clock, calls };
}
test('two tabs share a rolling Gmail budget across server workers and isolate accounts', async () => {
  const t = await tabs(), a = t.open('a@example.com'), b = t.open('a@example.com');
  await a('/one', {}, 3900); await b('/two', {}, 220);
  assert.ok(t.calls[1].at - t.calls[0].at >= 60000);
  const other = t.open('other@example.com'); await other('/other', {}, 3900);
  assert.equal(t.calls[2].at, t.calls[1].at);
});
test('quota cooldown is shared with other tabs and background indexing yields to interactive reads', async () => {
  const t = await tabs(url => url === '/quota' ? { error: 'quota_exceeded', retryAfterMs: 120000 } : {});
  const a = t.open('a@example.com'), b = t.open('a@example.com');
  await a('/quota'); await b('/background', {}, 220, true);
  assert.ok(t.calls[1].at - t.calls[0].at >= 120000);
  await a('/interactive'); const before = t.clock.now;
  await b('/index', {}, 220, true); assert.ok(t.clock.now - before >= 10000);
});
