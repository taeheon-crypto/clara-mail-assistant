// Structured queries run over the whole account graph, never the AI top-k sample.
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
    const match = question.match(/이번\s*주|지난\s*주|저번\s*주|이번\s*달|지난\s*달|저번\s*달|오늘|어제|내일|최근\s*\d+\s*일|this week|last week|this month|last month|today|yesterday|tomorrow|last \d+ days/i);
    if (match) {
      const key = normalize(match[0]); rest = rest.replace(match[0], '');
      const dow = new Date(today + 'T00:00:00Z').getUTCDay();
      const monday = shift(today, -(dow + 6) % 7);
      if (/주|week/.test(key)) { start = /지난|저번|last/.test(key) ? shift(monday, -7) : monday; end = shift(start, 7); }
      else if (/달|month/.test(key)) {
        const first = new Date(today.slice(0, 7) + '-01T00:00:00Z');
        if (/지난|저번|last/.test(key)) first.setUTCMonth(first.getUTCMonth() - 1);
        start = first.toISOString().slice(0, 10); first.setUTCMonth(first.getUTCMonth() + 1); end = first.toISOString().slice(0, 10);
      } else if (/최근|days/.test(key)) {
        const days = Number(key.match(/\d+/)?.[0]);
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
  rest = rest.replace(/받은\s*편지함|이메일|메일|편지함|캘린더|일정|미팅|회의|할\s*일|업무|태스크|첨부\s*파일|첨부|문서|emails?|messages?|events?|calendar|meetings?|tasks?|documents?|attachments?/gi, ' ')
    .replace(/몇\s*(?:개|통|건)(?:야|임|인가요|인지|예요|왔어|왔나요|있어|있나요)?|개수|건수|목록|리스트|전체|모든|모두|전부|총|받은|수신한|온|보낸|발신한|보내준|안\s*읽은|읽지\s*않은|미확인|읽은|수신|내|나의|제|알려\s*줘|알려\s*주세요|보여\s*줘|보여\s*주세요|조회해\s*줘|찾아\s*줘|찾아\s*주세요|나열해\s*줘|정리해\s*줘|어떤|뭐|뭔지|있어|있나요|이야|인가요|이랑|하고|관련|에서|동안|것|좀|해줘|unread|the|all|list|show|tell me|how many|did i|get|receive|in my|my|are/gi, ' ')
    .replace(/[은는이가의를과와에?!.\s,]+/g, '');
  const count = /몇\s*(?:개|통|건)|개수|건수|how many/i.test(q);
  const analysisRemainder = rest.replace(/요약|분석|작성|중요한|중요|우선순위|우선|답장|추천|비교|summari[sz]e|analy[sz]e|draft|important|why/g, '');
  return { ...range, kind: reason ? 'reason' : rest ? 'clarify' : count ? 'count' : 'list', types, filter, scope: filter && ['related', 'project'].includes(filter.relation) && !/온|받은|수신/.test(q) ? 'all' : /보낸|발신한|보내준/.test(q) && !/온|받은|수신/.test(q) ? 'sent' : /편지함|inbox/i.test(q) ? 'inbox' : /전체\s*(?:메일|이메일)|모든\s*(?:메일|이메일)/.test(q) ? 'all' : 'received', unread: /안\s*읽은|읽지\s*않은|미확인|unread/i.test(q), read: /읽은/.test(q) && !/안\s*읽은|읽지\s*않은/.test(q), unsupported: reason ? analysisRemainder : rest, question: q };
}
export const rangeKey = plan => [plan.start, plan.end, plan.timeZone].join('|');
function selectQuery(graph, plan) {
  let related, ambiguity;
  if (plan.filter) {
    const name = normalize(plan.filter.name);
    const candidates = graph.nodes.filter(n => (plan.filter.relation === 'project' ? n.type === 'Project' : ['from', 'to'].includes(plan.filter.relation) ? n.type === 'Person' : ['Person', 'Project'].includes(n.type)) && (normalize(n.label).includes(name) || normalize(n.properties.email) === name));
    const exact = candidates.filter(n => normalize(n.label) === name || normalize(n.properties.email) === name);
    const entities = exact.length ? exact : candidates;
    if (entities.length !== 1) ambiguity = entities.length ? '같은 이름이나 비슷한 이름의 객체가 여러 개입니다. 이메일 주소나 정확한 프로젝트 이름을 지정해 주세요.' : '지식 연결에서 해당 사람·프로젝트를 찾지 못했습니다. 이메일 주소나 정확한 이름을 지정해 주세요.';
    else {
      related = new Set();
      for (const edge of graph.adjacency.get(entities[0].id) || []) {
        if (plan.filter.relation === 'from' && edge.relation !== 'sent') continue;
        if (plan.filter.relation === 'to' && !['to', 'cc'].includes(edge.relation)) continue;
        const id = edge.from === entities[0].id ? edge.to : edge.from;
        related.add(id);
        // Tasks and attachments inherit the same mail relationship.
        for (const child of graph.adjacency.get(id) || []) if (['suggests_task', 'has_attachment', 'recurs_as'].includes(child.relation)) related.add(child.to);
      }
    }
  }
  let unknownDates = 0;
  const records = graph.nodes.filter(n => {
    if (!plan.types.includes(n.type) || related && !related.has(n.id)) return false;
    if (n.type === 'Email') {
      const labels = n.properties.labels || [];
      if (plan.scope === 'sent' && !labels.includes('SENT') || plan.scope === 'inbox' && !labels.includes('INBOX') || plan.scope === 'received' && (labels.includes('SENT') || labels.includes('DRAFT')) || plan.unread && !labels.includes('UNREAD')) return false;
      if (plan.read && labels.includes('UNREAD')) return false;
    }
    const source = ['Task', 'Document'].includes(n.type) ? graph.byId.get('mail:' + (n.properties.sourceId || n.id.split(':')[1])) : n;
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
  return { records, ambiguity, unknownDates };
}
export function queryOntology(graph, question, options = {}) {
  const plan = planQuery(question, options); if (!plan || plan.kind === 'reason' && !options.allowReason) return null;
  if (plan.kind === 'reason') { if (plan.unsupported) return null; plan.kind = 'list'; }
  if (plan.kind === 'date') {
    const weekday = new Intl.DateTimeFormat('ko-KR', { timeZone: plan.timeZone, weekday: 'long' }).format(options.now || new Date());
    return { kind: 'date', text: `오늘은 ${plan.today}, ${weekday}입니다. (${plan.timeZone} 기준)` };
  }
  const selected = selectQuery(graph, plan);
  if (plan.error || plan.kind === 'clarify' || selected.ambiguity) return { kind: 'clarify', text: plan.error || selected.ambiguity || `조회 조건을 정확히 해석하지 못했습니다. 조건을 줄이지 않고 다시 확인하겠습니다. 예: “지난주 온 메일 모두 알려줘”, “김 대표에게서 받은 메일 목록”, “내일 일정 알려줘”.` };
  const sources = plan.types.includes('Event') ? ['calendar', ...(plan.types.some(t => t !== 'Event') ? ['mail'] : [])] : ['mail'];
  const occurrenceRange = graph.coverage.calendar?.ranges?.[rangeKey(plan)];
  const complete = sources.every(s => s === 'calendar' && plan.start ? occurrenceRange?.status === 'complete' && (!plan.filter || graph.coverage.calendar?.status === 'complete') : graph.coverage[s]?.status === 'complete');
  const stale = sources.some(s => graph.coverage[s]?.status === 'stale');
  const coverageText = complete ? '마지막 동기화된 자료 기준입니다. 새 자료는 지식 연결에서 다시 동기화해 주세요.' : stale ? '변경 후 다시 동기화하지 않은 자료 기준입니다. 최신 전체 결과가 아닙니다.' : '전체 동기화가 끝나지 않아 현재 수집된 자료만 조회했습니다. 결과가 0건이어도 실제로 없다는 뜻은 아닙니다.';
  const rangeText = plan.start ? `${plan.start} ~ ${shift(plan.end, -1)} (${plan.timeZone}, 종료일 포함)` : `전체 기간 (${plan.timeZone})`;
  const recurring = plan.types.includes('Event') && plan.start && occurrenceRange?.status !== 'complete' ? graph.nodes.filter(n => n.type === 'Event' && n.properties.recurrence?.length).length : 0;
  const scopeText = plan.types.includes('Email') ? plan.scope === 'sent' ? '보낸 메일' : plan.scope === 'inbox' ? '현재 받은편지함' : plan.scope === 'all' ? '모든 메일(보낸 메일·스팸·휴지통 포함)' : '수신 메일(보낸 메일·임시보관 제외, 보관·스팸·휴지통 포함)' : '저장된 일정·업무·문서';
  const notes = [coverageText, occurrenceRange?.status === 'complete' ? 'Google에서 이 기간의 반복 일정 발생일·변경·취소를 조회했습니다.' : occurrenceRange?.error || '', recurring ? `반복 일정 ${recurring}개 시리즈의 발생일 조회가 완료되지 않았습니다. 실제 일정은 더 있을 수 있습니다.` : '', !plan.start && plan.types.includes('Event') ? '전체 기간은 반복 시리즈 단위입니다. 발생 일정 목록은 날짜 범위를 지정해 주세요.' : '', plan.types.includes('Task') ? '업무는 메일에서 추출한 후보이며 실제 담당·기한·완료 상태는 확정되지 않았습니다.' : '', selected.unknownDates ? `날짜를 확인할 수 없는 ${selected.unknownDates}건은 날짜 필터에서 제외했습니다.` : ''].filter(Boolean).join('\n');
  const page = selected.records.slice(0, 50);
  const text = [`${rangeText} · ${scopeText}${plan.filter ? ' · ' + plan.filter.name : ''}${plan.unread ? ' · 안 읽은 메일' : plan.read ? ' · 읽은 메일' : ''}`, `${complete ? '' : '현재 수집된 자료에서 '}조회 결과 ${selected.records.length}건. [ontology:query]`, notes, plan.kind === 'list' ? page.map((n, i) => `${i + 1}. ${n.properties.date || ''} ${n.properties.sender || ''} · ${n.label} [${n.id}]`).join('\n') : '', plan.kind === 'list' && selected.records.length > 50 ? `총 ${selected.records.length}건 중 1~50건 표시. 전체 결과는 지식 연결 → 조회 결과에서 모든 페이지를 확인할 수 있습니다.` : ''].filter(Boolean).join('\n\n');
  return { kind: plan.kind, plan, records: selected.records, total: selected.records.length, complete, text };
}
export function retrievalQuery(graph, question, options = {}) {
  const plan = planQuery(question, options);
  if (!plan || plan.error || plan.kind === 'date' || plan.kind === 'clarify' || plan.unsupported) return null;
  const selected = selectQuery(graph, plan);
  return selected.ambiguity ? null : { plan, ...selected };
}
