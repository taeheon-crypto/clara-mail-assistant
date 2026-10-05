import { buildOntology, ontologyContext, exportOntology } from './ontology-core.mjs';
import { queryOntology, planQuery, rangeKey, resolvePlan, queryRange } from './ontology-query.mjs';
import { validatePlan } from './ontology-plan.mjs';
import { runAssistant, assistantPlan, evidenceBatches, redactSourceText } from './ontology-assistant.mjs';
import { retrieveEvidence } from './ontology-retrieval.mjs';

const emptyState = () => ({ version: 1, emails: {}, events: {}, calendars: [], manual: { nodes: [], edges: [] }, sync: { mail: { status: 'idle', cursor: null }, calendar: { status: 'idle', index: 0, cursor: null, listCursor: null, listed: false } } });
let state = emptyState(), graph = buildOntology(), account = '', db, running = false, paused = false, persistence = true, queued = false;
const plannedQueries = new Map();
let refreshRequested = false;
let resolveReady;
const ready = new Promise(resolve => { resolveReady = resolve; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const coverage = () => ({
  accountEmail: account,
  mail: { ...state.sync.mail, indexed: Object.keys(state.emails).length, scope: 'All Gmail messages, including sent, archived, spam and trash' },
  calendar: { ...state.sync.calendar, indexed: Object.keys(state.events).length, calendars: state.calendars.length, scope: 'All stored events and recurring series; series are not expanded into future occurrences' },
  persistence: persistence ? 'Account-scoped IndexedDB on this browser; no cross-device sync' : 'Memory only: browser storage unavailable'
});
function rebuild() {
  graph = buildOntology(Object.values(state.emails), Object.values(state.events), coverage(), state.manual);
 
  window.dispatchEvent(new CustomEvent('clara-ontology-updated', { detail: { nodes: graph.nodes.length, edges: graph.edges.length } }));
}
async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('clara-ontology-v1', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('accounts');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function restore() {
  db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('accounts').objectStore('accounts').get(account);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function save() {
  if (!db || !persistence) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('accounts', 'readwrite');
      tx.objectStore('accounts').put(state, account);
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } catch { persistence = false;  }
}
async function page(params, signal) {
  const res = await fetch('/api/ontology/sync?' + new URLSearchParams(params), { credentials: 'same-origin', signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const error = new Error(data.error || '동기화 오류'); error.status = res.status; error.retryAfter = Number(data.retryAfter || 60); throw error; }
  return data;
}
let occurrenceWork = Promise.resolve();
async function loadOccurrences(plan) {
  if (!plan?.types?.includes('Event') || !plan.start || plan.error || plan.kind === 'clarify') return;
  const work = async () => {
    const queryState = state;
    state.sync.calendar.ranges ||= {};
    const key = rangeKey(plan), previous = state.sync.calendar.ranges[key];
    if (previous?.status === 'complete' && Date.now() - Date.parse(previous.finishedAt) < 300000) return;
    const range = previous?.status === 'complete' ? { status: 'syncing', index: 0, cursor: null, ids: [] } : previous || { status: 'syncing', index: 0, cursor: null, ids: [] };
    state.sync.calendar.ranges[key] = range;
    const deadline = Date.now() + 20000;
    try {
      while (!state.sync.calendar.listed && Date.now() < deadline) {
        const data = await page({ source: 'calendars', ...(state.sync.calendar.listCursor ? { cursor: state.sync.calendar.listCursor } : {}) }, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
        if (state !== queryState) return;
        for (const c of data.records) if (!state.calendars.some(x => x.id === c.id)) state.calendars.push(c);
        state.sync.calendar.listCursor = data.cursor; state.sync.calendar.listed = !data.cursor;
      }
      if (!state.sync.calendar.listed) throw new Error('캘린더 목록 수집이 미완료입니다. 같은 질문을 다시 하면 이어서 조회합니다.');
      while (range.index < state.calendars.length && Date.now() < deadline) {
        const calendarId = state.calendars[range.index].id;
        const data = await page({ source: 'occurrences', calendarId, start: plan.start, end: plan.end, timeZone: plan.timeZone, ...(range.cursor ? { cursor: range.cursor } : {}) }, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
        if (state !== queryState) return;
        for (const event of data.records) { const id = event.calendarId + ':' + event.id; state.events[id] = event; if (!range.ids.includes(id)) range.ids.push(id); }
        range.cursor = data.cursor; if (!range.cursor) range.index++;
      }
      if (range.index < state.calendars.length) throw new Error('기간 조회가 미완료입니다. 같은 질문을 다시 하면 다음 페이지부터 이어서 조회합니다.');
      range.status = 'complete'; range.finishedAt = new Date().toISOString(); delete range.error;
    } catch (error) {
      range.status = 'error'; range.error = error.status === 429 ? 'Google 요청 한도로 반복 일정 조회가 중단되었습니다. 잠시 후 같은 질문으로 재개해 주세요.' : error.status === 400 ? '반복 일정은 한 번에 370일 이내의 날짜 범위로 조회해 주세요.' : '반복 일정 조회가 미완료입니다. 같은 질문을 다시 하면 이어서 조회합니다.';
    }
    await save(); rebuild();
  };
  occurrenceWork = occurrenceWork.then(work, work); await occurrenceWork;
}
async function run() {
  if (running || !account) return;
  running = true; paused = false;
  for (const source of [state.sync.mail, state.sync.calendar]) if (source.status === 'error') source.status = 'syncing';
  try {
    const work = async lock => {
      if (lock === null) {  return; }
      // Re-read the shared account snapshot after acquiring the tab lock. A
      // waiting tab must not restart the scan already completed by its peer.
      if (navigator.locks && persistence) { const saved = await restore(); if (saved?.version === 1) state = saved; }
      if (refreshRequested) {
        refreshRequested = false;
        const previous = state.sync.mail;
        state.sync = emptyState().sync;
        if (previous.status !== 'complete' && previous.cursor) {
          state.sync.mail = previous;
          state.sync.mail.status = 'syncing';
        } else if (previous.historyId && (previous.status === 'complete' || previous.incremental)) {
          state.sync.mail.historyId = previous.historyId;
          state.sync.mail.incremental = true;
        } else { state.sync.mail.refreshing = true; state.sync.mail.seenIds = []; }
        state.sync.calendar.refreshing = true; state.sync.calendar.seenIds = [];
        state.calendars = [];
        await save(); rebuild();
      }
      let preferMail = true;
      while (!paused && (!['complete', 'error'].includes(state.sync.mail.status) || !['complete', 'error'].includes(state.sync.calendar.status))) {
        const mailPending = !['complete', 'error'].includes(state.sync.mail.status), calendarPending = !['complete', 'error'].includes(state.sync.calendar.status);
        const active = calendarPending && (!mailPending || !preferMail) ? state.sync.calendar : state.sync.mail;
        try {
          // Alternate pages so a large calendar cannot starve mail indexing.
          const cal = state.sync.calendar;
          if (active === cal) {
            cal.status = 'syncing';
            if (!cal.listed) {
              const data = await page({ source: 'calendars', ...(cal.listCursor ? { cursor: cal.listCursor } : {}) });
              for (const c of data.records) if (!state.calendars.some(x => x.id === c.id)) state.calendars.push(c);
              cal.listCursor = data.cursor; cal.listed = !data.cursor;
            } else if (cal.index < state.calendars.length) {
              const calendarId = state.calendars[cal.index].id;
              const data = await page({ source: 'events', calendarId, ...(cal.cursor ? { cursor: cal.cursor } : {}) });
              for (const e of data.records) state.events[e.calendarId + ':' + e.id] = e;
              if (cal.refreshing) cal.seenIds.push(...data.records.map(e => e.calendarId + ':' + e.id));
              cal.cursor = data.cursor;
              if (!cal.cursor) cal.index++;
            } else {
              if (cal.refreshing) for (const id of Object.keys(state.events)) if (!cal.seenIds.includes(id)) delete state.events[id];
              delete cal.refreshing; delete cal.seenIds;
              cal.status = 'complete'; cal.finishedAt = new Date().toISOString();
            }
          } else {
            const mail = state.sync.mail; mail.status = 'syncing';
            if (!mail.cursor && !mail.historyId && !mail.checkpointAttempted) {
              const checkpoint = await page({ source: 'mail_checkpoint' });
              mail.historyId = checkpoint.historyId;
              mail.checkpointAttempted = true;
              await save();
            }
            const data = await page({ source: mail.incremental ? 'mail_changes' : 'mail', ...(mail.incremental ? { historyId: mail.historyId } : {}), ...(mail.cursor ? { cursor: mail.cursor } : {}) });
            if (data.reset) {
              delete mail.historyId; delete mail.incremental; delete mail.checkpointAttempted;
              mail.cursor = null; mail.refreshing = true; mail.seenIds = [];
              await save(); continue;
            }
            for (const id of data.deletedIds || []) delete state.emails[id];
            if (!data.cursor && mail.incremental && data.historyId) mail.historyId = data.historyId;
            for (const m of data.records) state.emails[m.id] = m;
            if (mail.refreshing) mail.seenIds.push(...data.records.map(m => m.id));
            if (data.estimatedTotal !== undefined) mail.estimatedTotal = data.estimatedTotal;
            mail.cursor = data.cursor;
            if (!mail.cursor) {
              if (mail.refreshing) for (const id of Object.keys(state.emails)) if (!mail.seenIds.includes(id)) delete state.emails[id];
              delete mail.refreshing; delete mail.seenIds;
              if (!mail.incremental && mail.historyId) {
                // Catch arrivals and label edits that occurred during the full scan.
                mail.incremental = true; mail.status = 'syncing';
              } else {
                delete mail.incremental;
                mail.status = 'complete'; mail.finishedAt = new Date().toISOString();
              }
            }
          }
          preferMail = active === cal;
          delete active.error;  await save(); rebuild();
          // Ten messages per page and a pause, instead of an unbounded request burst.
          await wait(1800);
        } catch (err) {
          if (err.status === 429) {
            
           
            for (let i = 0; i < Math.max(60, err.retryAfter || 60) && !paused; i++) await wait(1000);
          } else {
            active.status = 'error'; active.error = err.status === 401 ? '로그인이 만료되었습니다. 다시 로그인해 주세요.' : '자동 동기화 중단: ' + err.message;
            if (err.status === 401) paused = true;
            await save(); rebuild();
          }
        }
      }
    };
    if (navigator.locks) await navigator.locks.request('clara-ontology:' + account, { ifAvailable: true }, work);
    else await work(undefined);
  } finally {
    running = false; rebuild();
    if (queued) { queued = false; await refresh(); }
  }
}
async function refresh() {
  if (running) { queued = true; return; }
  refreshRequested = true;
  await run();
}
function sourceChanged() {
  if (account) void refresh();
}
function resumeBackground() {
  if (!account || running || document.visibilityState === 'hidden') return;
  const syncs = [state.sync.mail, state.sync.calendar];
  const expired = syncs.some(s => s.status === 'complete' && Date.now() - (Date.parse(s.finishedAt) || 0) > 15 * 60 * 1000);
  if (expired || syncs.some(s => ['stale', 'error'].includes(s.status))) void refresh();
  else if (syncs.some(s => s.status !== 'complete')) void run();
}
window.ClaraOntology = {
  ready, refresh, sourceChanged,
  async agent(question, { messages = [], focusId } = {}) {
    await ready;
    if (!account) return { kind: 'clarify', text: 'Google 로그인 후 Clara AI를 사용할 수 있습니다.' };
    const agentAccount = account, agentState = state, now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
    const current = () => { if (account !== agentAccount || state !== agentState) throw new Error('계정이나 자료가 변경되었습니다. 같은 질문을 다시 보내 주세요.'); };
    const context = { accountEmail: account, timeZone, focusId, coverage: { mail: { status: state.sync.mail.status, indexed: Object.keys(state.emails).length }, calendar: { status: state.sync.calendar.status, indexed: Object.keys(state.events).length } } };
    const history = messages.slice(-10).filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: redactSourceText(m.content.slice(0, 12000)) }));
    if (history.at(-1)?.role !== 'user' || history.at(-1)?.content !== question) history.push({ role: 'user', content: redactSourceText(question) });
    const allowed = new Set();
    if (focusId && graph.byId.has(focusId)) allowed.add(focusId);
    for (const message of history) for (const match of message.content.matchAll(/\[((?:mail|event):[^\]\n]+)\]/g)) if (graph.byId.has(match[1])) allowed.add(match[1]);
    const source = n => {
      allowed.add(n.id);
      return { id: n.id, type: n.type, label: redactSourceText(n.label, n.label), properties: { ...n.properties, text: redactSourceText(n.properties.text, n.label), textIsExcerpt: Boolean(n.properties.textTruncated || String(n.properties.text || '').length >= 24000) }, provenance: n.provenance };
    };
    const request = async (mode, evidence, transcript = [], remainingTools = 10) => {
      current();
      // Preserve native call/result pairing. Compact only older bodies after
      // they have already been read; the latest results stay intact.
      const wire = transcript.map(m => ({ ...m }));
      for (let i = 0; JSON.stringify(wire).length > 90000 && i < wire.length - 2; i++) if (wire[i].role === 'tool') {
        const prior = JSON.parse(wire[i].content);
        if (prior.nodes) prior.nodes = prior.nodes.map(n => ({ ...n, properties: { ...n.properties, text: '', textPreviouslyRead: true } }));
        if (prior.analysis) prior.analysis = prior.analysis.slice(0, 3000);
        wire[i].content = JSON.stringify(prior);
      }
      const res = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, agentContext: context, evidence, transcript: wire, remainingTools, messages: history }) });
      const data = await res.json(); current();
      if (!res.ok) { console.warn('clara_assistant_error ' + JSON.stringify({ code: data.error?.code, providerStatus: data.error?.providerStatus })); throw new Error(data.error?.message || 'Clara AI 연결에 실패했습니다.'); }
      return data.message;
    };
    let preparing = true;
    const pack = async (records, meta = {}) => {
      let nodes = records.filter(n => ['Email', 'Event'].includes(n.type)).map(source);
      const sourceCount = new Set(nodes.map(n => n.id)).size;
      if (preparing && nodes.some(n => n.properties.textIsExcerpt)) return { ...meta, nodes: nodes.slice(0, 40).map(n => ({ ...n, properties: { ...n.properties, text: '' } })), bodiesRead: 0, bodiesNotLoaded: true, nextStep: 'Call get_mail or read_sources to load original bodies, including the rest of long messages.' };
      if (!preparing) {
        const expanded = [];
        for (const n of nodes) {
          if (n.type !== 'Email' || !n.properties.textIsExcerpt) { expanded.push(n); continue; }
          let offset = 0;
          do {
            const res = await fetch('/api/ontology/sync?' + new URLSearchParams({ source: 'mail_body', id: n.id.slice(5), offset: String(offset) }), { credentials: 'same-origin', signal: AbortSignal.timeout(30000) });
            const body = await res.json(); current();
            if (!res.ok || body.id !== n.id || typeof body.text !== 'string') throw new Error('긴 메일의 원문 읽기를 완료하지 못했습니다.');
            expanded.push({ ...n, properties: { ...n.properties, text: redactSourceText(body.text, n.label), textIsExcerpt: false, originalBodyPartOffset: offset, originalTotalChars: body.totalChars } });
            if (body.nextOffset !== null && (!Number.isSafeInteger(body.nextOffset) || body.nextOffset <= offset)) throw new Error('원문 읽기 위치를 확인하지 못했습니다.');
            offset = body.nextOffset;
          } while (offset !== null);
        }
        nodes = expanded;
      }
      const batches = evidenceBatches(nodes);
      if (batches.length <= 1) return { ...meta, nodes, bodiesRead: sourceCount, evidenceIsSample: meta.exhaustive === false };
      if (preparing) return { ...meta, nodes: nodes.slice(0, 40).map(n => ({ ...n, properties: { ...n.properties, text: '' } })), bodiesRead: 0, bodiesNotLoaded: true, totalSourceCount: nodes.length, nextStep: 'For summaries, priorities, drafts or source-content analysis, call get_mail/get_calendar for this period to read ALL matching bodies in batches. For counts/ranks call rank_correspondents.' };
      // Every matching original body enters a model batch. The final model
      // receives per-source notes instead of silently taking a top-k sample.
      const notes = [];
      for (let i = 0; i < batches.length; i++) {
        const message = await request('ontology_digest', { ...meta, batch: i + 1, batches: batches.length, nodes: batches[i] });
        if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('메일 본문 분석을 완료하지 못했습니다.');
        notes.push(message.content);
      }
      const manifest = nodes.slice(0, 40).map(n => ({ ...n, properties: { ...n.properties, text: '', bodyAnalyzedInBatch: true } }));
      return { ...meta, nodes: manifest, sourceIds: [...new Set(nodes.map(n => n.id))].slice(0, 1000), nodeManifestTruncated: nodes.length > 40, analysis: notes.join('\n\n').slice(0, 40000), analysisIsTruncated: notes.join('\n\n').length > 40000, bodiesRead: sourceCount, bodyPartsRead: nodes.length, evidenceIsSample: meta.exhaustive === false };
    };

    const execute = async (name, args) => {
      current();
      const plan = assistantPlan(name, args, { now, timeZone });
      if (plan) {
        await loadOccurrences(resolvePlan('', { now, timeZone, plan })); current();
        const selected = queryOntology(graph, '', { now, timeZone, accountEmail: account, plan, allowReason: true });
        if (selected?.kind === 'clarify') return { error: selected.text, nodes: [] };

        const meta = { kind: selected.kind, total: selected.total, matchedTotal: selected.matchedTotal, complete: selected.complete, scope: plan.scope, period: args.period || 'all', summary: redactSourceText(selected.text?.slice(0, 8000)) };
        if (name === 'rank_correspondents') return { ...meta, groups: selected.groups?.map(g => ({ ...g, sourceIds: g.sourceIds.slice(0, 3) })), nodes: [] };
        return pack(selected.records || [], meta);
      }
      if (name === 'read_sources') {
        if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 12 || args.ids.some(id => !allowed.has(id))) throw new Error('Read only IDs returned by search, cited earlier, or explicitly focused.');
        return pack(args.ids.map(id => graph.byId.get(id)).filter(Boolean), { originalSources: true });
      }
      if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 2000) throw new Error('Search query must be a nonempty short string.');
      const found = retrieveEvidence(graph, args.query, { focusId, limit: 24 });
      return pack(found.nodes, { exhaustive: false, method: found.method, passages: found.passages.map(p => ({ ...p, text: redactSourceText(p.text, graph.byId.get(p.sourceId)?.label || '') })) });
    };
    // Evidence enters the very first model call. This is a context preparation
    // step, not an intent whitelist or a requirement to match query grammar.
    const range = queryRange(question, now, timeZone);
    let initial;
    if (range.start && !range.error) {
      const scope = /보낸|발신/.test(question) && !/받은|온|수신/.test(question) ? 'sent' : /주고받|모든|전체/.test(question) ? 'all' : 'received';
      initial = await execute(/일정|캘린더|회의|미팅/.test(question) && !/메일|이메일/.test(question) ? 'get_calendar' : 'get_mail', { period: range.start + ' to ' + new Date(new Date(range.end + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10), ...(/일정|캘린더|회의|미팅/.test(question) && !/메일|이메일/.test(question) ? {} : { scope }) });
    } else {
      const found = retrieveEvidence(graph, question, { focusId, limit: 16 });
      const prior = [...allowed].slice(0, 12).map(id => graph.byId.get(id)).filter(n => n && !found.nodes.some(other => other.id === n.id));
      initial = await pack([...found.nodes, ...prior], { exhaustive: false, matchedBy: 'whole-index retrieval and prior conversation sources', indexedMail: Object.keys(state.emails).length });
    }
    preparing = false;
    const result = await runAssistant({ context, evidence: initial, history, complete: data => request('ontology_assistant', data.evidence, data.transcript, data.remainingTools), execute });
    current();
    if (state.sync.mail.status !== 'complete' && !/동기화|수집된|인덱스|indexed|partial/i.test(result.text)) result.text += '\n\n현재 동기화된 자료 기준이며, 전체 메일 동기화는 아직 완료되지 않았습니다.';
    return result;
  },
  async query(question, { messages = [] } = {}) {
    await ready;
    if (!account) return { kind: 'clarify', text: 'Google 로그인 후 연동 자료를 사용할 수 있습니다.' };
    const now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
    plannedQueries.delete(question);
    const publish = result => result;
    const queryAccount = account, queryState = state;
    const heuristic = planQuery(question, { now, timeZone });
    let plan;
    if (!heuristic || heuristic.kind === 'clarify' || heuristic.kind === 'reason' && heuristic.unsupported) {
      try {
        const history = messages.slice(-10).filter(m => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content.slice(0, 12000) }));
        if (history.at(-1)?.role !== 'user' || history.at(-1)?.content !== question) history.push({ role: 'user', content: question });
        const res = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'ontology_plan', plannerContext: { timeZone }, messages: history, max_tokens: 2048 }) });
        const data = await res.json();
        if (!res.ok) return publish({ kind: 'clarify', text: (data.error?.message || '질문 해석에 실패했습니다.') + '\n조회 계획을 만들지 못해 메일 집계를 실행하지 않았습니다.' });
        const validated = validatePlan(data.plan);
        if (validated.error) return publish({ kind: 'clarify', text: validated.error });
        plan = validated.plan;
      } catch { return publish({ kind: 'clarify', text: 'AI 질문 해석 연결에 실패했습니다. 잠시 후 다시 질문해 주세요. 메일 목록·개수·날짜의 직접 조회는 계속 사용할 수 있습니다.' }); }
      // Do not execute a plan against a different account/snapshot after awaiting AI.
      if (account !== queryAccount || state !== queryState) return { kind: 'clarify', text: '계정이나 자료가 변경되었습니다. 같은 질문을 다시 해 주세요.' };
      plannedQueries.set(question, plan);
      if (plannedQueries.size > 20) plannedQueries.delete(plannedQueries.keys().next().value);
    }
    const effective = resolvePlan(question, { now, timeZone, plan });
    await loadOccurrences(effective);
    if (account !== queryAccount || state !== queryState) return { kind: 'clarify', text: '계정이나 자료가 변경되었습니다. 같은 질문을 다시 해 주세요.' };
    // Resolve ambiguous identities before allowing reason plans to reach the model.
    if (effective?.kind === 'reason' && plan) {
      const check = queryOntology(graph, question, { now, timeZone, accountEmail: account, plan, allowReason: true });
      if (check?.kind === 'clarify') return publish(check);
    }
    const result = queryOntology(graph, question, { now, timeZone, accountEmail: account, plan });
    return publish(result);
  },
  async fallback(question, failure) {
    await ready; if (!account) return null;
    const now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
    const result = queryOntology(graph, question, { now, timeZone, accountEmail: account, plan: plannedQueries.get(question), allowReason: true });
    if (!result || result.kind === 'clarify' || !result.records?.length) return null;
    result.fallbackMessage = failure + '\nAI 분석을 생성하지 못해 조회 가능한 원본 근거 목록을 대신 표시합니다. 내용 요약이나 중요도 판단은 포함하지 않았습니다.';
    result.text = result.fallbackMessage + '\n\n' + result.text;
    return result;
  },
  async context(question, focusId) { await ready; return account ? ontologyContext(graph, question, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul', focusId, plan: plannedQueries.get(question) }) : undefined; },
  async export(scope) { await ready; if (!account) throw new Error('로그인이 필요합니다.'); return exportOntology(graph, scope); },
  async quality() { await ready; return { version: graph.version, ...graph.validation }; }
};
window.addEventListener('clara-source-changed', sourceChanged);
window.addEventListener('focus', resumeBackground);
document.addEventListener('visibilitychange', resumeBackground);
window.setInterval(resumeBackground, 60000);
try {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
  const session = await res.json(); account = session?.user?.email?.toLowerCase() || '';
  if (account) {
    try { const saved = await restore(); if (saved?.version === 1) state = saved; } catch { persistence = false; }
    rebuild(); resolveReady();
    resumeBackground();
  } else {  resolveReady(); }
} catch {  resolveReady(); }
