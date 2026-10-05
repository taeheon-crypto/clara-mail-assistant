import { buildOntology, searchOntology, ontologyContext, exportOntology, TYPES } from './ontology-core.mjs';
import { queryOntology, planQuery, rangeKey, resolvePlan } from './ontology-query.mjs';
import { validatePlan } from './ontology-plan.mjs';

const emptyState = () => ({ version: 1, emails: {}, events: {}, calendars: [], manual: { nodes: [], edges: [] }, sync: { mail: { status: 'idle', cursor: null }, calendar: { status: 'idle', index: 0, cursor: null, listCursor: null, listed: false } } });
let state = emptyState(), graph = buildOntology(), account = '', db, running = false, paused = false, selectedId = '', query = '', filter = '', statusText = '', persistence = true, queued = false;
let queryResult = null, queryQuestion = '', queryAt, listPage = 0, resultView = false;
const plannedQueries = new Map();
let resolveReady;
const ready = new Promise(resolve => { resolveReady = resolve; });
const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const coverage = () => ({
  accountEmail: account,
  mail: { ...state.sync.mail, indexed: Object.keys(state.emails).length, scope: 'All Gmail messages, including sent, archived, spam and trash' },
  calendar: { ...state.sync.calendar, indexed: Object.keys(state.events).length, calendars: state.calendars.length, scope: 'All stored events and recurring series; series are not expanded into future occurrences' },
  persistence: persistence ? 'Account-scoped IndexedDB on this browser; no cross-device sync' : 'Memory only: browser storage unavailable'
});
function rebuild() {
  graph = buildOntology(Object.values(state.emails), Object.values(state.events), coverage(), state.manual);
  render();
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
  } catch { persistence = false; statusText = '브라우저 저장 공간이 부족합니다. 현재 세션에서만 인덱스를 유지합니다.'; }
}
async function page(params, signal) {
  const res = await fetch('/api/ontology/sync?' + new URLSearchParams(params), { credentials: 'same-origin', signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const error = new Error(data.error || '동기화 오류'); error.status = res.status; throw error; }
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
      if (lock === null) { statusText = '다른 탭에서 동기화 중입니다. 완료 후 이 페이지를 새로고침하세요.'; return; }
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
              cal.cursor = data.cursor;
              if (!cal.cursor) cal.index++;
            } else { cal.status = 'complete'; cal.finishedAt = new Date().toISOString(); }
          } else {
            const mail = state.sync.mail; mail.status = 'syncing';
            const data = await page({ source: 'mail', ...(mail.cursor ? { cursor: mail.cursor } : {}) });
            for (const m of data.records) state.emails[m.id] = m;
            mail.estimatedTotal = data.estimatedTotal;
            mail.cursor = data.cursor;
            if (!mail.cursor) { mail.status = 'complete'; mail.finishedAt = new Date().toISOString(); }
          }
          preferMail = active === cal;
          delete active.error; statusText = ''; await save(); rebuild();
          // Ten messages per page and a pause, instead of an unbounded request burst.
          await wait(1800);
        } catch (err) {
          if (err.status === 429) {
            statusText = 'Google 요청 한도에 도달했습니다. 60초 후 같은 페이지부터 재개합니다.';
            render();
            for (let i = 0; i < 60 && !paused; i++) await wait(1000);
          } else {
            statusText = err.status === 401 ? '로그인이 만료되었습니다. 다시 로그인해 주세요.' : '동기화 중단: ' + err.message + ' · 재개 버튼으로 다시 시도하세요.';
            active.status = 'error'; active.error = statusText;
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
  const manual = state.manual;
  state = emptyState(); state.manual = manual;
  await save(); rebuild(); await run();
}
function sourceChanged() {
  // Preserve the usable graph until the user requests a full refresh.
  state.sync.mail.status = 'stale'; state.sync.calendar.status = 'stale';
  statusText = '메일 또는 일정이 변경되었습니다. 새로 동기화하면 관계에도 반영됩니다.';
  save(); rebuild();
}
function mount() {
  const style = document.createElement('style');
  style.textContent = `
    #ontology-dialog{position:fixed;inset:0;width:min(1100px,94vw);height:min(760px,90vh);border:1px solid #e7e2f1;border-radius:18px;padding:0;color:#292438;background:#fff;box-shadow:0 24px 90px #25123c30;z-index:20000}
    #ontology-dialog::backdrop{background:#21133366}#ontology-dialog *{box-sizing:border-box}
    .ont-head{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid #eee8f5}.ont-head h2{margin:0;font-size:20px}.ont-head p{margin:5px 0 0;color:#80738f;font-size:12px}
    #ontology-dialog button{cursor:pointer;font:inherit;border:1px solid #e5def0;border-radius:8px;background:#fff;padding:7px 12px;color:#593491}#ontology-dialog button:hover{background:#f5f0ff}
    .ont-toolbar{padding:14px 24px;display:flex;gap:8px;flex-wrap:wrap}.ont-toolbar input{flex:1;min-width:180px;border:1px solid #ded5eb;border-radius:8px;padding:9px 12px;font:inherit}.ont-toolbar select{border:1px solid #ded5eb;border-radius:8px;background:#fff;padding:8px}
    #ont-status{margin:0 24px 12px;padding:10px 12px;border-radius:9px;background:#f7f4fc;color:#705a8e;font-size:12px;line-height:1.7}
    .ont-body{display:grid;grid-template-columns:38% 62%;height:calc(100% - 225px);min-height:240px;border-top:1px solid #eee8f5}.ont-list{overflow:auto;border-right:1px solid #eee8f5;padding:10px}.ont-detail{overflow:auto;padding:20px}
    #ontology-dialog .ont-row{display:block;text-align:left;width:100%;margin:0 0 6px;padding:12px;border:1px solid transparent;color:#352740}.ont-row small{display:block;color:#887996;font-size:11px;margin-bottom:5px}.ont-row span{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ont-row[aria-current=true]{background:#f1e9ff;border-color:#d9c5ff!important}
    .ont-detail h3{margin:0 0 10px;font-size:19px;overflow-wrap:anywhere}.ont-detail p{font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}.ont-detail a{color:#7544b4}.ont-relation{border-bottom:1px solid #eee8f5;padding:9px 0;font-size:12px}.ont-relation button{max-width:100%;text-align:left;overflow-wrap:anywhere}.ont-candidate{color:#ac7734;font-size:11px}.ont-empty{padding:24px;font-size:13px;line-height:1.8;color:#8b7b99}.ont-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
    @media(max-width:650px){.ont-body{grid-template-columns:42% 58%}.ont-head,.ont-toolbar{padding:12px}.ont-detail{padding:12px}#ont-status{margin:0 12px 8px}.ont-head p{max-width:230px}.ont-head h2{font-size:17px}}
  `;
  document.head.append(style);
  const nav = document.querySelector('.sb-nav');
  const trigger = document.createElement('button'); trigger.className = 'sb-icon'; trigger.id = 'nl-ontology'; trigger.dataset.tip = 'Knowledge · 지식 연결'; trigger.title = '메일·캘린더 지식 연결'; trigger.setAttribute('aria-label', trigger.title);
  trigger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="5" cy="5" r="3"/><circle cx="19" cy="7" r="3"/><circle cx="10" cy="19" r="3"/><path d="m8 5 8 2M6 8l3 8m8-6-5 7"/></svg>';
  trigger.addEventListener('click', () => open()); (nav || document.body).append(trigger);
  const dialog = document.createElement('dialog'); dialog.id = 'ontology-dialog'; dialog.setAttribute('aria-labelledby', 'ont-title');
  dialog.innerHTML = `<div class="ont-head"><div><h2 id="ont-title">Knowledge · 지식 연결</h2><p>메일과 일정에서 연결된 사람, 프로젝트, 업무와 근거</p></div><button id="ont-close" aria-label="닫기">✕</button></div>
    <div class="ont-toolbar"><input id="ont-search" aria-label="지식 검색" placeholder="사람, 이메일 주소, 프로젝트 검색"><select id="ont-type" aria-label="객체 종류"><option value="">모든 종류</option>${Object.entries(TYPES).map(([type, label]) => `<option value="${type}">${label}</option>`).join('')}</select><button id="ont-sync">동기화</button><button id="ont-pause">일시정지</button></div>
    <div class="ont-toolbar"><input id="ont-question" aria-label="온톨로지 조회 질문" placeholder="지난주 온 메일 모두 알려줘"><button id="ont-query">직접 조회</button><button id="ont-browse">모든 객체</button><button id="ont-results" disabled>조회 결과</button><button id="ont-prev" aria-label="이전 결과 페이지">이전</button><span id="ont-page" role="status"></span><button id="ont-next" aria-label="다음 결과 페이지">다음</button></div>
    <div id="ont-status" role="status" aria-live="polite"></div><div class="ont-body" style="height:calc(100% - 295px)"><div id="ont-list" class="ont-list"></div><div id="ont-detail" class="ont-detail"></div></div>`;
  document.body.append(dialog);
  dialog.querySelector('#ont-close').onclick = () => dialog.close();
  dialog.querySelector('#ont-search').oninput = e => { query = e.target.value; resultView = false; listPage = 0; render(); };
  dialog.querySelector('#ont-type').onchange = e => { filter = e.target.value; resultView = false; listPage = 0; render(); };
  dialog.querySelector('#ont-query').onclick = async () => { await ready; await window.ClaraOntology.query(dialog.querySelector('#ont-question').value); resultView = true; listPage = 0; render(); };
  dialog.querySelector('#ont-question').onkeydown = e => { if (e.key === 'Enter') dialog.querySelector('#ont-query').click(); };
  dialog.querySelector('#ont-browse').onclick = () => { resultView = false; listPage = 0; render(); };
  dialog.querySelector('#ont-results').onclick = () => { resultView = true; listPage = 0; render(); };
  dialog.querySelector('#ont-prev').onclick = () => { listPage = Math.max(0, listPage - 1); render(); };
  dialog.querySelector('#ont-next').onclick = () => { listPage++; render(); };
  dialog.querySelector('#ont-sync').onclick = () => { if (running) return; if (['complete', 'stale'].includes(state.sync.mail.status) || state.sync.calendar.status === 'stale') refresh(); else run(); };
  dialog.querySelector('#ont-pause').onclick = () => { paused = true; statusText = '동기화를 일시정지했습니다. 재개하면 이어서 수집합니다.'; render(); };
  dialog.addEventListener('click', e => {
    const button = e.target.closest('[data-node]');
    if (button) { selectedId = button.dataset.node; render(); }
  });
  window.addEventListener('clara-source-changed', sourceChanged);
}
function open(id) {
  if (id) { selectedId = id; resultView = false; query = ''; filter = ''; listPage = Math.max(0, Math.floor(graph.nodes.findIndex(n => n.id === id) / 50)); }
  const dialog = document.getElementById('ontology-dialog');
  if (!dialog.open) dialog.showModal(); render();
}
function render() {
  const dialog = document.getElementById('ontology-dialog'); if (!dialog) return;
  const mails = Object.keys(state.emails).length, events = Object.keys(state.events).length;
  const done = state.sync.mail.status === 'complete' && state.sync.calendar.status === 'complete';
  document.getElementById('ont-status').textContent = `${mails.toLocaleString()}개 메일${state.sync.mail.estimatedTotal ? ' / Google 예상 ' + state.sync.mail.estimatedTotal.toLocaleString() + '개' : ''} · ${events.toLocaleString()}개 일정/반복 시리즈 · ${graph.nodes.length.toLocaleString()}개 객체 · ${graph.edges.length.toLocaleString()}개 관계\n` + (statusText || state.sync.calendar.error || state.sync.mail.error || (done ? '수집 완료 · ' : running ? '전체 데이터를 순차 수집 중 · ' : '미완료 인덱스 · ')) + '프로젝트·업무 자동 추출은 후보입니다. 반복 일정은 시리즈로 저장됩니다. ' + (persistence ? '이 브라우저에 계정별 저장.' : '현재 세션에만 저장.');
  const sync = document.getElementById('ont-sync'); sync.disabled = running; sync.textContent = running ? '수집 중…' : done || state.sync.mail.status === 'stale' ? '새로 동기화' : '동기화 재개';
  document.getElementById('ont-pause').disabled = !running || paused;
  document.getElementById('ont-results').disabled = !queryResult;
  if (!dialog.open) return;
  if (queryResult?.plan) {
    const fallbackMessage = queryResult.fallbackMessage;
    queryResult = queryOntology(graph, queryQuestion, { now: queryAt, timeZone: queryResult.plan.timeZone, accountEmail: account, plan: plannedQueries.get(queryQuestion), allowReason: Boolean(fallbackMessage) });
    if (fallbackMessage && queryResult) { queryResult.fallbackMessage = fallbackMessage; queryResult.text = fallbackMessage + '\n\n' + queryResult.text; }
  }
  const visible = query ? searchOntology(graph, query, graph.nodes.length) : graph.nodes;
  const ordered = resultView ? queryResult?.records || [] : visible.filter(n => !filter || n.type === filter);
  const pages = Math.max(1, Math.ceil(ordered.length / 50)); listPage = Math.min(listPage, pages - 1);
  document.getElementById('ont-prev').disabled = listPage === 0;
  document.getElementById('ont-next').disabled = listPage >= pages - 1;
  document.getElementById('ont-page').textContent = `${listPage + 1}/${pages} 페이지 · 전체 ${ordered.length}건`;
  if (resultView) document.getElementById('ont-status').textContent = queryResult?.text.split('\n\n').slice(0, 3).join('\n') || '지원하는 조회 질문을 입력해 주세요. 예: 지난주 온 메일 모두 알려줘.';
  const list = document.getElementById('ont-list');
  list.innerHTML = ordered.slice(listPage * 50, (listPage + 1) * 50).map(n => `<button class="ont-row" data-node="${escape(n.id)}" aria-current="${n.id === selectedId}"><small>${escape(TYPES[n.type])} · ${escape(n.properties.date || '')}</small><span>${escape(n.label)}</span></button>`).join('') || '<div class="ont-empty">현재 조회된 자료가 없습니다. 위 동기화 상태와 조회 조건을 확인해 주세요.</div>';
  const n = graph.byId.get(selectedId); const detail = document.getElementById('ont-detail');
  if (!n) { detail.innerHTML = '<div class="ont-empty">왼쪽 객체를 선택하면 관련 메일·일정·사람과 연결 근거를 볼 수 있습니다.<br>메일과 일정은 Google 원본 ID, 사람은 이메일 주소로 연결됩니다.</div>'; return; }
  const p = n.properties, relations = graph.adjacency.get(n.id) || [];
  const safeUrl = /^https:\/\/(?:mail\.google\.com|calendar\.google\.com|www\.google\.com)\//.test(p.url || '') ? p.url : '';
  detail.innerHTML = `<small>${escape(TYPES[n.type])}</small><h3>${escape(n.label)}</h3>${p.status === 'candidate' ? '<span class="ont-candidate">자동 추출 후보 · 실제 업무나 프로젝트로 확정되지 않았습니다.</span>' : ''}<p>${escape(p.email || p.date || p.domain || '')}${p.location ? '\n' + escape(p.location) : ''}</p>
    <div class="ont-actions">${safeUrl ? `<a href="${escape(safeUrl)}" target="_blank" rel="noopener noreferrer">Google 원본 열기 ↗</a>` : ''}<button id="ont-ask">AI에 질문</button>${['Email', 'Event'].includes(n.type) ? '<button id="ont-project">프로젝트에 연결</button>' : ''}</div>
    ${p.text ? `<p>${escape(p.text.slice(0, 3000))}</p>` : ''}${p.recurrence?.length ? '<p>반복 시리즈입니다. 이 인덱스는 미래의 개별 발생 일정을 전개하지 않습니다.</p>' : ''}<h4>연결 관계 (${relations.length})</h4>
    ${relations.slice(0, 50).map(e => { const other = graph.byId.get(e.from === n.id ? e.to : e.from); return `<div class="ont-relation">${escape(e.relation)} ${e.inferred ? '<span class="ont-candidate">추정</span>' : '· 원본/사용자 연결'}<br><button data-node="${escape(other.id)}">${escape(TYPES[other.type])} · ${escape(other.label)}</button><div>근거: ${e.evidence.slice(0, 2).map(id => `<button data-node="${escape(id)}">${escape(graph.byId.get(id)?.label || id)}</button>`).join(' ')}</div></div>`; }).join('') || '<p>연결 관계가 없습니다.</p>'}`;
  document.getElementById('ont-ask').onclick = () => {
    dialog.close();
    if (typeof window.openChatPanel === 'function') window.openChatPanel();
    const input = document.getElementById('cp-input-int');
    if (input) { input.value = n.label + ' 관련 메일, 일정, 업무를 근거와 함께 정리해줘'; document.getElementById('cp-send-int')?.classList.add('on'); input.focus(); }
  };
  const projectButton = document.getElementById('ont-project');
  if (projectButton) projectButton.onclick = async () => {
    const label = prompt('연결할 프로젝트 이름'); if (!label?.trim()) return;
    const projectId = 'project:' + label.trim().normalize('NFKC').toLowerCase();
    if (!state.manual.nodes.some(x => x.id === projectId)) state.manual.nodes.push({ id: projectId, type: 'Project', label: label.trim() });
    if (!state.manual.edges.some(x => x.from === n.id && x.to === projectId)) state.manual.edges.push({ from: n.id, to: projectId });
    await save(); rebuild();
  };
}
window.ClaraOntology = {
  ready, open, refresh, sourceChanged,
  async query(question, { messages = [] } = {}) {
    await ready;
    if (!account) return { kind: 'clarify', text: 'Google 로그인 후 지식 연결을 사용할 수 있습니다.' };
    const now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
    plannedQueries.delete(question);
    const publish = result => {
      if (result) { queryResult = result; queryQuestion = question; queryAt = now; listPage = 0; resultView = true; document.getElementById('ont-question').value = question; render(); }
      return result;
    };
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
    queryResult = result; queryQuestion = question; queryAt = now; listPage = 0; resultView = true; document.getElementById('ont-question').value = question; render();
    return result;
  },
  async context(question, focusId) { await ready; return account ? ontologyContext(graph, question, { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul', focusId, plan: plannedQueries.get(question) }) : undefined; },
  async export(scope) { await ready; if (!account) throw new Error('로그인이 필요합니다.'); return exportOntology(graph, scope); },
  async quality() { await ready; return { version: graph.version, ...graph.validation }; },
  async openMail(gmailId) { await ready; open('mail:' + gmailId); },
  async openEvent(calendarId, eventId) { await ready; open('event:' + calendarId + ':' + eventId); }
};
mount();
try {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
  const session = await res.json(); account = session?.user?.email?.toLowerCase() || '';
  if (account) {
    try { const saved = await restore(); if (saved?.version === 1) state = saved; } catch { persistence = false; }
    rebuild(); resolveReady();
    // Continue an interrupted pass; completed snapshots refresh on explicit request.
    if (state.sync.mail.status !== 'complete' || state.sync.calendar.status !== 'complete') {
      if (state.sync.mail.status === 'stale' || state.sync.calendar.status === 'stale') refresh(); else run();
    }
  } else { statusText = 'Google 로그인 후 지식 연결을 사용할 수 있습니다.'; resolveReady(); render(); }
} catch { statusText = '계정 확인에 실패했습니다. 다시 로그인해 주세요.'; resolveReady(); render(); }
