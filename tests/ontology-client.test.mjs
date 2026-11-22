import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { indexedDB } from 'fake-indexeddb';

test('headless ontology indexes both sources, restores links, isolates accounts and refreshes automatically', async () => {
  const originalTimeout = globalThis.setTimeout;
  const windows = [];
  let requests = 0, bootId = 0, revised = false, releaseRefresh;
  async function boot(email) {
    const w = new Window({ url: 'https://clara.test/app.html' }); windows.push(w);
    let occurrenceAttempts = 0;
    w.document.body.innerHTML = '<div class="sb-nav"></div><textarea id="cp-input-int"></textarea><button id="cp-send-int"></button>';
    for (const key of ['window', 'document', 'navigator', 'CustomEvent', 'Event']) Object.defineProperty(globalThis, key, { value: w[key], configurable: true });
    globalThis.indexedDB = indexedDB;
    globalThis.prompt = () => 'Atlas';
    globalThis.setTimeout = (cb, ms, ...args) => originalTimeout(cb, Math.min(ms || 0, 1), ...args);
    globalThis.fetch = async (url, opts) => {
      requests++;
      if (url === '/api/auth/session') return Response.json({ user: { email } });
      if (url === '/api/chat') {
        const body = JSON.parse(opts.body);
        if (body.mode === 'ontology_digest') return Response.json({ message: { content: body.evidence.nodes.map(n => n.id + ' ' + n.label).join('\n') } });
        if (body.mode === 'ontology_assistant') {
          if (!body.transcript.length) return Response.json({ message: { content: null, tool_calls: [{ id: 'call1', type: 'function', function: { name: 'get_mail', arguments: JSON.stringify({ period: 'all', scope: 'received' }) } }] } });
          return Response.json({ message: { content: '요청하신 자료를 확인했습니다. [mail:page124]' } });
        }
        assert.equal(body.mode, 'ontology_plan');
        assert.ok(!body.ontologyContext);
        const question = body.messages.at(-1).content;
        if (question === '모델 한도 테스트') return Response.json({ error: { message: '무료 AI 한도' } }, { status: 429 });
        return Response.json({ plan: { operation: 'aggregate', types: ['Email'], scope: 'all', groupBy: 'person', direction: 'exchanged', order: 'desc', limit: 1 } });
      }
      const source = new URL(url, 'https://clara.test').searchParams.get('source');
      const empty = email === 'other@example.com';
      const paged = email === 'pages@example.com';
      if (source === 'calendars') return Response.json({ records: empty ? [] : [{ id: 'primary', name: 'Work' }], cursor: null });
      if (source === 'occurrences') {
        if (++occurrenceAttempts === 1) return Response.json({error:'quota_exceeded'},{status:429});
        const cursor = new URL(url,'https://clara.test').searchParams.get('cursor');
        return Response.json({records:[{id:cursor ? 'occ2' : 'occ1',calendarId:'primary',title:'Repeated',recurringEventId:'e1',start:{date:'2026-10-06'}}],cursor:cursor ? null : 'more'});
      }
      if (source === 'events') return Response.json({ records: [{ id: 'e1', calendarId: 'primary', title: '[Atlas] Meeting', start: { date: '2026-10-05' }, attendees: [{ email: 'founder@example.com' }] }], cursor: null });
      if (source === 'mail_checkpoint') return Response.json(paged ? {historyId:'100'} : {});
      if (source === 'mail_changes' && paged && revised) { await new Promise(resolve => { releaseRefresh = resolve; }); return Response.json({ records: [{ id: 'new-page', subject: 'Updated mail', senderEmail: 'founder@example.com', dateISO: '2026-10-05T00:00:00Z', body: 'New source' }], cursor: null, historyId:'200', deletedIds:Array.from({length:125},(_,i)=>'page'+i) }); }
      if (source === 'mail_changes') return Response.json({records:[],cursor:null,historyId:'100'});
      if (source === 'mail') return Response.json({ records: paged ? Array.from({length:125}, (_,i) => ({id:'page'+i,subject:'Paged '+i,senderEmail:'founder@example.com',dateISO:'2026-09-30T00:00:00Z'})) : empty ? [] : [{ id: 'm1', subject: '[Atlas] plan', sender: 'Founder', senderEmail: 'founder@example.com', dateISO: '2026-10-04T10:00:00Z', body: 'Please review the deck.' }], cursor: null });
      throw new Error(String(url));
    };
    await import('../public/ontology-client.mjs?test=' + ++bootId);
    await w.ClaraOntology.ready;
    for (let i = 0; i < 100; i++) {
      const coverage = JSON.parse(await w.ClaraOntology.context('Atlas')).coverage;
      if (coverage.mail.status === 'complete' && coverage.calendar.status === 'complete') break;
      await new Promise(resolve => originalTimeout(resolve, 5));
    }
    assert.equal(JSON.parse(await w.ClaraOntology.context('Atlas')).coverage.mail.status, 'complete');
    return w;
  }
  try {
    const first = await boot('me@example.com');
    assert.equal(first.document.getElementById('ontology-dialog'), null);
    assert.equal(first.document.getElementById('nl-ontology'), null);
    assert.equal(first.ClaraOntology.open, undefined);
    let context = JSON.parse(await first.ClaraOntology.context('Atlas'));
    const fixtureDb = await new Promise((resolve, reject) => { const req = indexedDB.open('clara-ontology-v1', 1); req.onsuccess = () => resolve(req.result); req.onerror = reject; });
    await new Promise((resolve, reject) => { const tx = fixtureDb.transaction('accounts', 'readwrite'); const store = tx.objectStore('accounts'); const req = store.get('me@example.com'); req.onsuccess = () => { const saved = req.result; saved.manual.nodes.push({ id: 'project:atlas', type: 'Project', label: 'Atlas' }); saved.manual.edges.push({ from: 'mail:m1', to: 'project:atlas' }); store.put(saved, 'me@example.com'); }; tx.oncomplete = resolve; tx.onerror = reject; });
    fixtureDb.close();
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
    const paged = await boot('pages@example.com');
    const result = await paged.ClaraOntology.query('메일 모두 알려줘');
    assert.equal(result.total,125);
    const evidence = await paged.ClaraOntology.fallback('메일 요약해줘','AI 빈 응답');
    assert.match(evidence.text,/원본 근거 목록/);
    const partialCalendar = await paged.ClaraOntology.query('2026-10-06 일정 목록');
    assert.equal(partialCalendar.complete,false);
    const resumedCalendar = await paged.ClaraOntology.query('2026-10-06 일정 목록');
    assert.equal(resumedCalendar.complete,true); assert.equal(resumedCalendar.total,2);
    assert.match(resumedCalendar.text,/Google에서 이 기간의 반복 일정/);

    const rank = await paged.ClaraOntology.query('나랑 최근에 가장 많이 메일 주고받은 사람 누구임?');
    assert.equal(rank.kind, 'aggregate'); assert.equal(rank.groups[0].count, 125);
    assert.equal(rank.groups[0].email, 'founder@example.com');
    const limited = await paged.ClaraOntology.query('모델 한도 테스트');
    assert.match(limited.text, /무료 AI 한도/);
    assert.match(limited.text, /집계를 실행하지 않았습니다/);
    assert.equal((await paged.ClaraOntology.query('전체 메일 몇개야?')).total, 125);
    const agent = await paged.ClaraOntology.agent('이번엔 내가 신경써야 하는 게 뭔지 맥락을 보고 판단해봐', { messages: [{ role: 'assistant', content: '지원사업 자료를 확인하겠습니다.' }] });
    assert.equal(agent.kind, 'answer');
    assert.deepEqual(agent.trace.filter(t => t.role === 'tool').map(t => t.name), ['get_mail']);
    assert.equal(JSON.parse(agent.trace[1].content).total, 125);
    assert.equal(JSON.parse(agent.trace[1].content).evidenceIsSample, false);
    assert.equal(JSON.parse(agent.trace[1].content).bodiesRead, 125);

    revised = true;
    paged.dispatchEvent(new paged.CustomEvent('clara-source-changed'));
    for (let i = 0; i < 100 && !releaseRefresh; i++) await new Promise(resolve => originalTimeout(resolve, 5));
    assert.ok(releaseRefresh);
    assert.equal(JSON.parse(await paged.ClaraOntology.context('mail')).counts.indexedMail, 125);
    releaseRefresh();
    for (let i = 0; i < 100; i++) {
      const updated = JSON.parse(await paged.ClaraOntology.context('mail'));
      if (updated.coverage.mail.status === 'complete' && updated.coverage.calendar.status === 'complete') break;
      await new Promise(resolve => originalTimeout(resolve, 5));
    }
    const updated = JSON.parse(await paged.ClaraOntology.context('Updated mail'));
    assert.equal(updated.counts.indexedMail, 1);
    assert.ok(updated.nodes.some(n => n.id === 'mail:new-page'));
    assert.equal((await paged.ClaraOntology.query('전체 일정 목록')).total, 1);
    assert.equal(paged.document.getElementById('ontology-dialog'), null);

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
test('every chat question enters the AI agent, including formerly hard-coded direct queries', async () => {
  let calls = 0;
  const sandbox = { Response, window: { ClaraOntology: {
    query: async () => { throw new Error('Chat must not bypass AI'); },
    agent: async q => { calls++; return { kind: 'answer', text: q === '지난주 온 메일 모두 알려줘' ? 'AI가 조회한 123건 원본 목록' : 'AI 답변' }; },
    context: async () => 'shared-context',
    fallback: async q => q === '메일 요약해줘' ? {text:'AI 생성 실패 · 원본 근거'} : null
  } }, fetch: async () => { calls++; return Response.json({error:{message:'무료 AI 한도'}},{status:429}); } };
  vm.runInNewContext(await readFile(new URL('../public/ontology-bridge.js', import.meta.url), 'utf8'), sandbox);
  const ask = q => sandbox.window._claraChatFetch('/api/chat', {body:JSON.stringify({messages:[{role:'user',content:q}]})});
  assert.match((await (await ask('지난주 온 메일 모두 알려줘')).json()).content[0].text,/123건/);
  assert.equal(calls,1);
  assert.equal((await (await ask('메일 요약해줘')).json()).answerMode,'answer');
  assert.match((await (await ask('기타 질문')).json()).content[0].text, /AI 답변/);
  assert.equal(calls,3);
});
