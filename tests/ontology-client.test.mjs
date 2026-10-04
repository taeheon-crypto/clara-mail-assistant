import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { indexedDB } from 'fake-indexeddb';

test('UI indexes both sources, stores confirmed links, restores them, and isolates accounts', async () => {
  const originalTimeout = globalThis.setTimeout;
  const windows = [];
  let requests = 0, bootId = 0;
  async function boot(email) {
    const w = new Window({ url: 'https://clara.test/app.html' }); windows.push(w);
    w.document.body.innerHTML = '<div class="sb-nav"></div><textarea id="cp-input-int"></textarea><button id="cp-send-int"></button>';
    for (const key of ['window', 'document', 'navigator', 'CustomEvent', 'Event']) Object.defineProperty(globalThis, key, { value: w[key], configurable: true });
    globalThis.indexedDB = indexedDB;
    globalThis.prompt = () => 'Atlas';
    globalThis.setTimeout = (cb, ms, ...args) => originalTimeout(cb, Math.min(ms || 0, 1), ...args);
    globalThis.fetch = async url => {
      requests++;
      if (url === '/api/auth/session') return Response.json({ user: { email } });
      const source = new URL(url, 'https://clara.test').searchParams.get('source');
      const empty = email === 'other@example.com';
      if (source === 'calendars') return Response.json({ records: empty ? [] : [{ id: 'primary', name: 'Work' }], cursor: null });
      if (source === 'events') return Response.json({ records: [{ id: 'e1', calendarId: 'primary', title: '[Atlas] Meeting', start: { date: '2026-10-05' }, attendees: [{ email: 'founder@example.com' }] }], cursor: null });
      if (source === 'mail') return Response.json({ records: empty ? [] : [{ id: 'm1', subject: '[Atlas] plan', sender: 'Founder', senderEmail: 'founder@example.com', dateISO: '2026-10-04T10:00:00Z', body: 'Please review the deck.' }], cursor: null });
      throw new Error(String(url));
    };
    await import('../public/ontology-client.mjs?test=' + ++bootId);
    await w.ClaraOntology.ready;
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(await w.ClaraOntology.context('Atlas')).coverage.mail.status === 'complete') break;
      await new Promise(resolve => originalTimeout(resolve, 5));
    }
    assert.equal(JSON.parse(await w.ClaraOntology.context('Atlas')).coverage.mail.status, 'complete');
    return w;
  }
  try {
    const first = await boot('me@example.com');
    first.ClaraOntology.open();
    assert.ok(first.document.getElementById('ontology-dialog').open);
    first.document.querySelector('[data-node="mail:m1"]').click();
    assert.match(first.document.getElementById('ont-detail').textContent, /Founder/);
    first.document.getElementById('ont-project').click();
    await new Promise(resolve => originalTimeout(resolve, 20));
    let context = JSON.parse(await first.ClaraOntology.context('Atlas'));
    assert.equal(context.nodes.find(n => n.id === 'project:atlas').properties.status, 'confirmed');
    const before = requests;
    const restored = await boot('me@example.com');
    assert.equal(requests, before + 1); // Complete index loads from IndexedDB, not Google.
    context = JSON.parse(await restored.ClaraOntology.context('Atlas'));
    assert.equal(context.nodes.find(n => n.id === 'project:atlas').properties.status, 'confirmed');
    const other = await boot('other@example.com');
    const isolated = JSON.parse(await other.ClaraOntology.context('Atlas'));
    assert.equal(isolated.counts.indexedMail, 0);
    assert.equal(isolated.nodes.length, 0);
    assert.ok(!JSON.stringify(isolated).includes('Founder'));
  } finally {
    globalThis.setTimeout = originalTimeout;
    for (const w of windows) await w.happyDOM.close();
  }
});
test('every chat call uses the shared bridge and forwards current source identity', async () => {
  const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
  assert.equal((html.match(/_claraChatFetch\('\/api\/chat'/g) || []).length, 6);
  assert.equal((html.match(/(?<!_claraChat)fetch\('\/api\/chat'/g) || []).length, 0);
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (m[1].trim()) new vm.Script(m[1]);
  let sent;
  const sandbox = { window: { ClaraOntology: { context: async (q, focusId) => { assert.equal(q, 'Question'); assert.equal(focusId, 'mail:m1'); return 'shared-context'; } } }, selId: 'm1', EMAILS: [{ id: 'm1', gmailId: 'm1' }], fetch: async (_url, options) => { sent = JSON.parse(options.body); return Response.json({}); } };
  vm.runInNewContext(await readFile(new URL('../public/ontology-bridge.js', import.meta.url), 'utf8'), sandbox);
  await sandbox.window._claraChatFetch('/api/chat', { body: JSON.stringify({ messages: [{ role: 'user', content: 'Question' }] }) });
  assert.equal(sent.ontologyContext, 'shared-context');
});
test('weekly mail totals work without AI; incomplete snapshots are qualified and filtered questions go to AI', async () => {
  let calls = 0;
  const evidence = { timeZone: 'Asia/Seoul', weekStart: '2026-10-05', weekEndExclusive: '2026-10-12', counts: { indexedReceivedThisWeek: 7, indexedInboxThisWeek: 3, indexedMailThisWeek: 11 }, coverage: { mail: { status: 'syncing' } } };
  const sandbox = { Response, window: { ClaraOntology: { context: async () => JSON.stringify(evidence) } }, fetch: async () => { calls++; return Response.json({}); } };
  vm.runInNewContext(await readFile(new URL('../public/ontology-bridge.js', import.meta.url), 'utf8'), sandbox);
  async function ask(q) { return (await sandbox.window._claraChatFetch('/api/chat', { body: JSON.stringify({ messages: [{ role: 'user', content: q }] }) })).json(); }
  const received = await ask('이번주 온 메일 몇개임?');
  assert.match(received.content[0].text, /7통/);
  assert.match(received.content[0].text, /전체 동기화가 끝나지 않아/);
  assert.equal(calls, 0);
  evidence.coverage.mail.status = 'complete';
  assert.match((await ask('이번 주 받은편지함 몇 개?')).content[0].text, /3통/);
  assert.match((await ask('이번주 전체 메일 몇개야?')).content[0].text, /11통/);
  assert.equal(calls, 0);
  await ask('김 대표에게 이번주 온 메일 몇개임?');
  await ask('이번주 온 메일 몇개임? 중요한 것 요약해줘');
  assert.equal(calls, 2);
});
