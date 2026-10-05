// Structured queries run over the whole account graph, never the AI top-k sample.
import { validatePlan } from './ontology-plan.mjs';
import { traversePath } from './ontology-schema.mjs';
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
export function dayAt(date, timeZone = 'Asia/Seoul') {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return validDay(date) ? date : null;
  if (!date || Number.isNaN(new Date(date).getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
}
function validDay(day) { const d = new Date(day + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day; }
function shift(day, days) { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
export function queryRange(question, now = new Date(), timeZone = 'Asia/Seoul') {
  const today = dayAt(now.toISOString(), timeZone);
  let rest = question, start, end;
  const dates = [...question.matchAll(/\d{4}-\d{2}-\d{2}|\d{4}년\s*\d{1,2}월\s*\d{1,2}일/g)];
  if (dates.length) {
    const values = dates.map(m => m[0].includes('년') ? m[0].match(/\d+/g).map((v, i) => i ? v.padStart(2, '0') : v).join('-') : m[0]);
    if (values.length > 2 || values.some(v => !validDay(v)) || (values.length === 2 && values[0] > values[1])) return { error: '날짜 범위를 확인해 주세요. 예: 2026-09-28부터 2026-10-04까지.' };
    [start] = values; end = shift(values[values.length - 1], 1);
    for (const m of dates) rest = rest.replace(m[0], '');
    rest = rest.replace(/부터|까지|between|through|to|[~〜–]/gi, ' ');
  } else {
    const match = question.match(/이번\s*주|지난\s*주|저번\s*주|이번\s*달|지난\s*달|저번\s*달|오늘|어제|내일|최근\s*\d+\s*일|최근(?!에?\s*(?:\d|몇|한|두|세))(?:에)?|this week|last week|this month|last month|today|yesterday|tomorrow|last \d+ days|recently|lately|recent\b/i);
    if (match) {
      const key = normalize(match[0]); rest = rest.replace(match[0], '');
      const dow = new Date(today + 'T00:00:00Z').getUTCDay();
      const monday = shift(today, -(dow + 6) % 7);
      if (/주|week/.test(key)) { start = /지난|저번|last/.test(key) ? shift(monday, -7) : monday; end = shift(start, 7); }
      else if (/달|month/.test(key)) {
        const first = new Date(today.slice(0, 7) + '-01T00:00:00Z');
        if (/지난|저번|last/.test(key)) first.setUTCMonth(first.getUTCMonth() - 1);
        start = first.toISOString().slice(0, 10); first.setUTCMonth(first.getUTCMonth() + 1); end = first.toISOString().slice(0, 10);
      } else if (/최근|days|recent|lately/.test(key)) {
        const days = Number(key.match(/\d+/)?.[0] || 30);
        if (!days || days > 3660) return { error: '최근 조회 기간은 1~3660일로 지정해 주세요.' };
        start = shift(today, 1 - days); end = shift(today, 1);
      } else { start = shift(today, /어제|yesterday/.test(key) ? -1 : /내일|tomorrow/.test(key) ? 1 : 0); end = shift(start, 1); }
    }
  }
  return { today, timeZone, start, end, rest };
}
export function planQuery(question, options = {}) {
  const q = String(question || '').trim();
  if (/^(?:오늘\s*(?:은\s*)?(?:무슨\s*요일(?:이야|인가요|이지|예요)?|날짜(?:가|는)?\s*(?:뭐야|언제야)?|몇\s*월\s*며칠(?:이야|인가요)?)|what (?:day|date) is (?:it|today))[?.!\s]*$/i.test(q)) return { kind: 'date', ...queryRange('오늘', options.now, options.timeZone) };
  const types = [];
  if (/메일|이메일|편지함|emails?|messages?/i.test(q)) types.push('Email');
  if (/일정|캘린더|미팅|회의|events?|calendar|meetings?/i.test(q)) types.push('Event');
  if (/업무|할\s*일|태스크|tasks?/i.test(q)) types.push('Task');
  if (/첨부|문서|documents?|attachments?/i.test(q)) types.push('Document');
  if (!types.length) return null;
  const range = queryRange(q, options.now, options.timeZone);
  const reason = /요약|분석|작성|왜|중요|우선|답장|추천|비교|summari[sz]e|analy[sz]e|draft|important|why/i.test(q);
  let rest = range.rest || q, filter;
  const entity = rest.match(/(.+?)(?:한테서|에게서|한테|에게|로부터|와의|과의|관련|프로젝트)/);
  if (entity) {
    const name = entity[1].replace(/^(?:내|나의|제)\s+/, '').trim();
    filter = { name, relation: /한테|에게|로부터/.test(entity[0]) ? /보낸|보내준/.test(q) && !/온|받은|수신/.test(q) ? 'to' : 'from' : /프로젝트/.test(entity[0]) ? 'project' : 'related' };
    rest = rest.replace(entity[0], '');
  }
  // Consume lookup grammar; any leftover constraint must never silently disappear.
  // Consume the complete question ending before the generic "뭐" token.
  // Only terminal endings are grammar; unknown content constraints remain intact.
  rest = rest.replace(/(?:뭐임|뭐야|뭐예요|뭐지|뭐냐)[?!.\s]*$/, ' ');
  rest = rest.replace(/받은\s*편지함|이메일|메일|편지함|캘린더|일정|미팅|회의|할\s*일|업무|태스크|첨부\s*파일|첨부|문서|emails?|messages?|events?|calendar|meetings?|tasks?|documents?|attachments?/gi, ' ')
    .replace(/몇\s*(?:개|통|건)(?:야|임|인가요|인지|예요|왔어|왔나요|있어|있나요)?|개수|건수|목록|리스트|전체|모든|모두|전부|총|받은|수신한|온|보낸|발신한|보내준|안\s*읽은|읽지\s*않은|미확인|읽은|수신|내|나의|제|알려\s*줘|알려\s*주세요|보여\s*줘|보여\s*주세요|조회해\s*줘|찾아\s*줘|찾아\s*주세요|나열해\s*줘|정리해\s*줘|어떤|뭐|뭔지|있어|있나요|이야|인가요|이랑|하고|관련|에서|동안|것|좀|해줘|unread|the|all|list|show|tell me|how many|did i|get|receive|in my|my|are/gi, ' ')
    .replace(/[은는이가의를과와에?!.\s,]+/g, '');
  const count = /몇\s*(?:개|통|건)|개수|건수|how many/i.test(q);
  const analysisRemainder = rest.replace(/요약|분석|작성|중요한|중요|우선순위|우선|답장|추천|비교|summari[sz]e|analy[sz]e|draft|important|why/g, '');
  return { ...range, kind: reason ? 'reason' : rest ? 'clarify' : count ? 'count' : 'list', types, filter, scope: filter && ['related', 'project'].includes(filter.relation) && !/온|받은|수신/.test(q) ? 'all' : /보낸|발신한|보내준/.test(q) && !/온|받은|수신/.test(q) ? 'sent' : /편지함|inbox/i.test(q) ? 'inbox' : /전체\s*(?:메일|이메일)|모든\s*(?:메일|이메일)/.test(q) ? 'all' : 'received', unread: /안\s*읽은|읽지\s*않은|미확인|unread/i.test(q), read: /읽은/.test(q) && !/안\s*읽은|읽지\s*않은/.test(q), unsupported: reason ? analysisRemainder : rest, question: q };
}
export const rangeKey = plan => [plan.start, plan.end, plan.timeZone].join('|');
const sourceOf = (graph, n) => ['Task', 'Document'].includes(n.type) ? graph.byId.get('mail:' + (n.properties.sourceId || n.id.split(':')[1])) : n;
function selectQuery(graph, plan) {
  let related, ambiguity;
  const paths = new Map();
  for (const filter of plan.filters || (plan.filter ? [plan.filter] : [])) {
    const name = normalize(filter.name);
    const candidates = graph.nodes.filter(n => (filter.entityType ? n.type === filter.entityType : filter.relation === 'project' ? n.type === 'Project' : ['from', 'to'].includes(filter.relation) ? n.type === 'Person' : ['Person', 'Project'].includes(n.type)) && (normalize(n.label).includes(name) || normalize(n.properties.email) === name));
    const exact = candidates.filter(n => normalize(n.label) === name || normalize(n.properties.email) === name);
    const entities = exact.length ? exact : candidates;
    if (entities.length !== 1) ambiguity = entities.length ? '같은 이름이나 비슷한 이름의 객체가 여러 개입니다. 이메일 주소나 정확한 프로젝트 이름을 지정해 주세요.' : '지식 연결에서 해당 사람·프로젝트를 찾지 못했습니다. 이메일 주소나 정확한 이름을 지정해 주세요.';
    else {
      if (filter.path) {
        const reached = traversePath(graph, entities[0].id, filter.path);
        const matches = new Set(reached.keys());
        related = related ? new Set([...related].filter(id => matches.has(id))) : matches;
        for (const [id, proof] of reached) paths.set(id, proof);
        continue;
      }
      const matches = new Set();
      for (const edge of graph.adjacency.get(entities[0].id) || []) {
        if (filter.relation === 'from' && edge.relation !== 'sent') continue;
        if (filter.relation === 'to' && !['to', 'cc'].includes(edge.relation)) continue;
        const id = edge.from === entities[0].id ? edge.to : edge.from;
        matches.add(id);
        // Tasks and attachments inherit the same mail relationship.
        for (const child of graph.adjacency.get(id) || []) if (['suggests_task', 'has_attachment', 'recurs_as'].includes(child.relation)) matches.add(child.to);
      }
      related = related ? new Set([...related].filter(id => matches.has(id))) : matches;
    }
  }
  let unknownDates = 0;
  const records = graph.nodes.filter(n => {
    if (!plan.types.includes(n.type) || related && !related.has(n.id)) return false;
    if (plan.keywords?.some(k => !normalize(n.label + ' ' + (n.properties.text || '')).includes(normalize(k)))) return false;
    const source = sourceOf(graph, n);
    if (source?.type === 'Email') {
      const labels = source.properties.labels || [];
      if (plan.scope === 'sent' && !labels.includes('SENT') || plan.scope === 'inbox' && !labels.includes('INBOX') || plan.scope === 'received' && (labels.includes('SENT') || labels.includes('DRAFT')) || plan.unread && !labels.includes('UNREAD')) return false;
      if (plan.read && labels.includes('UNREAD')) return false;
    }
    const day = dayAt(source?.properties.date, plan.timeZone);
    if (plan.start && !day) { unknownDates++; return false; }
    // Recurring masters are kept separately; do not imply their instances occur in this window.
    if (n.type === 'Event' && n.properties.recurrence?.length && plan.start) return false;
    if (n.type === 'Event' && !plan.start && n.properties.recurringEventId) return false;
    if (n.type === 'Event' && plan.start) {
      const range = graph.coverage.calendar?.ranges?.[rangeKey(plan)];
      if (range && !range.ids?.includes(n.properties.calendarId + ':' + n.properties.sourceId)) return false;
      const end = n.properties.end;
      const lastDay = end?.date ? shift(end.date, -1) : end?.dateTime && !Number.isNaN(Date.parse(end.dateTime)) ? dayAt(new Date(Date.parse(end.dateTime) - 1).toISOString(), plan.timeZone) : day;
      return day < plan.end && lastDay >= plan.start;
    }
    return !plan.start || day >= plan.start && day < plan.end;
  }).sort((a, b) => String(b.properties.date || '').localeCompare(String(a.properties.date || '')) || a.id.localeCompare(b.id));
  return { records, ambiguity, unknownDates, paths: new Map([...paths].filter(([id]) => records.some(n => n.id === id))) };
}
export function queryOntology(graph, question, options = {}) {
  const plan = resolvePlan(question, options); if (!plan || plan.kind === 'reason' && !options.allowReason) return null;
  if (plan.kind === 'reason') { if (plan.unsupported) return null; plan.kind = 'list'; }
  if (plan.kind === 'date') {
    const weekday = new Intl.DateTimeFormat('ko-KR', { timeZone: plan.timeZone, weekday: 'long' }).format(options.now || new Date());
    return { kind: 'date', text: `오늘은 ${plan.today}, ${weekday}입니다. (${plan.timeZone} 기준)` };
  }
  if (plan.error || plan.kind === 'clarify') return { kind: 'clarify', text: plan.error || plan.clarification || '조회 조건을 정확히 해석하지 못했습니다. 조건을 줄이지 않고 다시 확인하겠습니다. 예: “지난주 온 메일 모두 알려줘”, “김 대표에게서 받은 메일 목록”, “내일 일정 알려줘”.' };
  const selected = selectQuery(graph, plan);
  if (plan.kind === 'list' && plan.order === 'asc') selected.records.reverse();
  if (selected.ambiguity) return { kind: 'clarify', text: selected.ambiguity };
  const sources = plan.types.includes('Event') ? ['calendar', ...(plan.types.some(t => t !== 'Event') ? ['mail'] : [])] : ['mail'];
  const occurrenceRange = graph.coverage.calendar?.ranges?.[rangeKey(plan)];
  const complete = sources.every(s => s === 'calendar' && plan.start ? occurrenceRange?.status === 'complete' && (!(plan.filter || plan.filters?.length) || graph.coverage.calendar?.status === 'complete') : graph.coverage[s]?.status === 'complete');
  const stale = sources.some(s => graph.coverage[s]?.status === 'stale');
  const coverageText = complete ? '마지막 동기화된 자료 기준입니다. 새 자료는 지식 연결에서 다시 동기화해 주세요.' : stale ? '변경 후 다시 동기화하지 않은 자료 기준입니다. 최신 전체 결과가 아닙니다.' : '전체 동기화가 끝나지 않아 현재 수집된 자료만 조회했습니다. 결과가 0건이어도 실제로 없다는 뜻은 아닙니다.';
  const rangeText = plan.start ? `${plan.start} ~ ${shift(plan.end, -1)} (${plan.timeZone}, 종료일 포함)` : `전체 기간 (${plan.timeZone})`;
  const recurring = plan.types.includes('Event') && plan.start && occurrenceRange?.status !== 'complete' ? graph.nodes.filter(n => n.type === 'Event' && n.properties.recurrence?.length).length : 0;
  const scopeText = plan.types.includes('Email') ? plan.scope === 'sent' ? '보낸 메일' : plan.scope === 'inbox' ? '현재 받은편지함' : plan.scope === 'all' ? '모든 메일(보낸 메일·스팸·휴지통 포함)' : '수신 메일(보낸 메일·임시보관 제외, 보관·스팸·휴지통 포함)' : '저장된 일정·업무·문서';
  const notes = [coverageText, ...(plan.assumptions || []), occurrenceRange?.status === 'complete' ? 'Google에서 이 기간의 반복 일정 발생일·변경·취소를 조회했습니다.' : occurrenceRange?.error || '', recurring ? `반복 일정 ${recurring}개 시리즈의 발생일 조회가 완료되지 않았습니다. 실제 일정은 더 있을 수 있습니다.` : '', !plan.start && plan.types.includes('Event') ? '전체 기간은 반복 시리즈 단위입니다. 발생 일정 목록은 날짜 범위를 지정해 주세요.' : '', plan.types.includes('Task') ? '업무는 메일에서 추출한 후보이며 실제 담당·기한·완료 상태는 확정되지 않았습니다.' : '', selected.unknownDates ? `날짜를 확인할 수 없는 ${selected.unknownDates}건은 날짜 필터에서 제외했습니다.` : ''].filter(Boolean).join('\n');
  if (plan.kind === 'aggregate') return aggregateQuery(graph, plan, selected, { ...options, complete, rangeText, notes });
  const matchedTotal = selected.records.length;
  if (plan.kind === 'list' && plan.limit) selected.records = selected.records.slice(0, plan.limit);
  const page = selected.records.slice(0, 50);
  const text = [`${rangeText} · ${scopeText}${plan.filter ? ' · ' + plan.filter.name : ''}${plan.unread ? ' · 안 읽은 메일' : plan.read ? ' · 읽은 메일' : ''}`, `${complete ? '' : '현재 수집된 자료에서 '}조회 결과 ${selected.records.length}건. [ontology:query]`, notes, plan.kind === 'list' ? page.map((n, i) => `${i + 1}. ${n.properties.date || ''} ${n.properties.sender || ''} · ${n.label} [${n.id}]`).join('\n') : '', plan.kind === 'list' && selected.records.length > 50 ? `총 ${selected.records.length}건 중 1~50건 표시. 전체 결과는 지식 연결 → 조회 결과에서 모든 페이지를 확인할 수 있습니다.` : ''].filter(Boolean).join('\n\n');
  return { kind: plan.kind, plan, records: selected.records, paths: selected.paths, total: selected.records.length, matchedTotal, complete, text: matchedTotal !== selected.records.length ? text + `\n\n전체 일치 ${matchedTotal}건 중 날짜순 ${plan.limit}건을 조회했습니다.` : text };
}
export function retrievalQuery(graph, question, options = {}) {
  const plan = resolvePlan(question, options);
  if (!plan || plan.error || plan.kind === 'date' || plan.kind === 'clarify' || plan.unsupported) return null;
  const selected = selectQuery(graph, plan);
  return selected.ambiguity ? null : { plan, ...selected };
}

export function resolvePlan(question, options = {}) {
  if (!options.plan) return planQuery(question, options);
  const result = validatePlan(options.plan);
  if (result.error) return { kind: 'clarify', error: result.error };
  const p = result.plan;
  const range = queryRange(question, options.now, options.timeZone);
  if (range.error) return { kind: 'clarify', error: range.error };
  const recentDefault = !/\d/.test(question) && /최근(?!에?\s*(?:몇|한|두|세))(?:에)?|recent\b|recently|lately/i.test(question) && range.start;
  return { ...p, ...range, start: range.start || p.start || undefined, end: range.end || p.endExclusive || undefined, assumptions: recentDefault ? ['최근은 오늘을 포함한 30일로 조회했습니다.'] : p.assumptions, kind: p.operation, question };
}

function aggregateQuery(graph, plan, selected, options) {
  const groups = new Map(), self = new Set((options.selfEmails || []).map(normalize));
  if (options.accountEmail) self.add(normalize(options.accountEmail));
  if (['person', 'domain'].includes(plan.groupBy) && !self.size) return { kind: 'clarify', text: '내 계정 이메일을 확인하지 못했습니다. 다시 로그인해 주세요.' };
  // Gmail SENT identifies account aliases even when their address differs from OAuth.
  for (const n of graph.nodes) if (n.type === 'Email' && n.properties.labels?.includes('SENT') && !n.properties.labels.includes('DRAFT')) {
    for (const e of graph.adjacency.get(n.id) || []) if (e.relation === 'sent') {
      const email = graph.byId.get(e.from)?.properties.email;
      if (email) self.add(normalize(email));
    }
  }
  let unknownParticipants = 0;
  const used = new Set();
  for (const n of selected.records) {
    if (n.type === 'Email' && n.properties.labels?.includes('DRAFT')) continue;
    const adjacent = graph.adjacency.get(n.id) || [];
    const source = sourceOf(graph, n);
    const outgoing = source?.properties.labels?.includes('SENT');
    if (source?.type === 'Email' && (plan.direction === 'sent' && !outgoing || plan.direction === 'received' && outgoing)) continue;
    let members = [];
    if (['person', 'domain'].includes(plan.groupBy)) {
      members = adjacent.filter(e => n.type === 'Event' ? ['attends', 'organizes'].includes(e.relation) && e.participation !== 'declined' : outgoing ? ['to', 'cc'].includes(e.relation) : e.relation === 'sent').map(e => graph.byId.get(n.type === 'Event' || !outgoing ? e.from : e.to)).filter(p => p?.type === 'Person' && !self.has(normalize(p.properties.email)));
      if (!members.length) unknownParticipants++;
      members = members.map(p => plan.groupBy === 'domain' ? { id: 'domain:' + p.properties.email.split('@')[1], label: p.properties.email.split('@')[1] } : p);
    } else if (plan.groupBy === 'project') {
      const source = sourceOf(graph, n);
      members = [...adjacent, ...(source && source !== n ? graph.adjacency.get(source.id) || [] : [])].filter(e => e.relation === 'about_project').map(e => graph.byId.get(e.to)).filter(Boolean);
    } else {
      const date = dayAt(sourceOf(graph, n)?.properties.date, plan.timeZone);
      const key = plan.groupBy === 'type' ? n.type : date ? plan.groupBy === 'month' ? date.slice(0, 7) : date : '날짜 미확인';
      members = [{ id: key, label: key }];
    }
    for (const member of new Map(members.map(p => [p.id, p])).values()) {
      if (!groups.has(member.id)) groups.set(member.id, { id: member.id, label: member.label, email: member.properties?.email, candidate: member.properties?.status === 'candidate', ids: new Set(), received: 0, sent: 0, events: 0 });
      const row = groups.get(member.id);
      if (row.ids.has(n.id)) continue;
      row.ids.add(n.id); used.add(n.id);
      if (n.type === 'Email') { if (outgoing) row.sent++; else row.received++; }
      if (n.type === 'Event') row.events++;
    }
  }
  const rows = [...groups.values()].map(r => ({ ...r, count: r.ids.size, sourceIds: [...r.ids], ids: undefined })).sort((a, b) => (plan.order === 'asc' ? a.count - b.count : b.count - a.count) || a.id.localeCompare(b.id));
  const limit = plan.limit || 10;
  // Preserve every tie at the cutoff instead of arbitrarily declaring one winner.
  const cutoff = rows[Math.min(limit, rows.length) - 1]?.count;
  const ranked = rows.filter((r, i) => i < limit || r.count === cutoff);
  const shown = ranked.slice(0, 50);
  const labels = { person: '사람별', domain: '이메일 도메인별', project: '프로젝트별', day: '날짜별', month: '월별', type: '자료 유형별' };
  const text = [
    `${options.rangeText} · ${labels[plan.groupBy]} ${plan.types.includes('Email') ? plan.direction === 'received' ? '수신' : plan.direction === 'sent' ? '발신' : '송수신' : '자료'} 건수 순위`,
    `${options.complete ? '' : '현재 수집된 자료에서 '}원본 ${used.size}건을 전체 조회하여 ${rows.length}개 그룹으로 집계했습니다. [ontology:query]`,
    options.notes,
    ['person', 'domain'].includes(plan.groupBy) ? '원본 기준으로 집계했습니다. 메일의 수신·참조 상대와 일정의 주최·참석 상대를 포함하고, 같은 원본은 같은 상대에게 한 번만 셉니다. 내 계정·발신 별칭·임시보관·참석 거절은 제외합니다.' : plan.groupBy === 'project' ? '자동 연결 프로젝트는 후보입니다. 하나의 원본이 여러 프로젝트에 연결될 수 있습니다.' : '',
    unknownParticipants ? `상대 주소를 확인할 수 없는 ${unknownParticipants}건은 집계에서 제외했습니다.` : '',
    ranked.length > limit ? '기준 건수가 같은 공동 순위를 함께 표시합니다.' : '',
    shown.length ? shown.map((r, i) => `${i + 1}. ${r.label}${r.email && r.label !== r.email ? ' <' + r.email + '>' : ''}${r.candidate ? ' (프로젝트 후보)' : ''}: ${r.count}건 (받은 ${r.received} · 보낸 ${r.sent} · 일정 ${r.events})\n근거: ${r.sourceIds.slice(0, 3).map(id => '[' + id + ']').join(' ')}`).join('\n\n') : '현재 집계할 자료가 없습니다.',
    ranked.length > shown.length ? `공동 순위 ${ranked.length}개 중 첫 50개를 표시합니다.` : '',
    '전체 집계 근거는 지식 연결 → 조회 결과에서 확인할 수 있습니다.',
  ].filter(Boolean).join('\n\n');
  return { kind: 'aggregate', plan, groups: rows, records: selected.records.filter(n => used.has(n.id)), total: used.size, complete: options.complete, text };
}
