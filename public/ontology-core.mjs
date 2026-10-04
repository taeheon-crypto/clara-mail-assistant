// Shared, deterministic ontology projection. Google IDs and email addresses are
// identities; names and subject similarity never merge people or source records.
export const TYPES = { Person: '사람', Organization: '이메일 도메인', Project: '프로젝트 후보', Thread: '메일 대화', Email: '메일', Event: '일정', Task: '업무 후보', Document: '첨부파일' };
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'yahoo.com', 'icloud.com']);
const clean = v => String(v || '').trim();
const normalize = v => clean(v).normalize('NFKC').toLowerCase();
export function addresses(value) {
  return [...new Set((clean(value).match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/gi) || []).map(normalize))];
}
function projectTags(text) {
  return [...new Set([...clean(text).matchAll(/\[([^\]\n]{2,60})\]/g)].map(m => clean(m[1])).filter(t => !/^(re|fw|fwd|광고|스팸|공지|알림|안내|외부|external)$/i.test(t)))];
}
export function buildOntology(emails = [], events = [], coverage = {}, manual = { nodes: [], edges: [] }) {
  const nodes = new Map(), edges = new Map();
  function node(id, type, label, properties = {}) {
    if (!nodes.has(id)) nodes.set(id, { id, type, label: clean(label) || id, properties });
    return id;
  }
  function edge(from, relation, to, evidence, inferred = false) {
    const id = JSON.stringify([from, relation, to]);
    if (!edges.has(id)) edges.set(id, { id, from, relation, to, inferred, evidence: [] });
    const e = edges.get(id);
    if (evidence && !e.evidence.includes(evidence)) e.evidence.push(evidence);
  }
  function person(email, name, evidence) {
    email = normalize(email);
    if (!addresses(email).includes(email)) return null;
    const id = node('person:' + email, 'Person', name || email, { email });
    // Upgrade an address-only label when Google supplies a display name.
    if (name && nodes.get(id).label === email) nodes.get(id).label = clean(name);
    const domain = email.split('@')[1];
    if (!PUBLIC_DOMAINS.has(domain)) {
      const org = node('org:' + domain, 'Organization', domain, { domain });
      edge(id, 'uses_domain', org, evidence); // Domain is evidence, not an asserted employer.
    }
    return id;
  }
  function projectLinks(source, text) {
    for (const tag of projectTags(text)) {
      const project = node('project:' + normalize(tag), 'Project', tag, { status: 'candidate', extraction: 'subject_tag' });
      edge(source, 'about_project', project, source, true);
    }
  }
  for (const mail of emails) {
    if (!mail?.id) continue;
    const id = 'mail:' + mail.id;
    node(id, 'Email', mail.subject || '(제목 없음)', {
      sourceId: mail.id, threadId: mail.threadId, date: mail.dateISO || mail.date,
      sender: mail.sender, senderEmail: mail.senderEmail, to: mail.toHeader, cc: mail.ccHeader,
      text: clean(mail.body || mail.preview), labels: mail.labelIds || [],
      url: 'https://mail.google.com/mail/u/0/#all/' + encodeURIComponent(mail.id)
    });
    const sender = person(mail.senderEmail, mail.sender, id);
    if (sender) edge(sender, 'sent', id, id);
    for (const addr of addresses(mail.toHeader)) edge(id, 'to', person(addr, '', id), id);
    for (const addr of addresses(mail.ccHeader)) edge(id, 'cc', person(addr, '', id), id);
    if (mail.threadId) {
      const thread = node('thread:' + mail.threadId, 'Thread', clean(mail.subject).replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/gi, ''));
      edge(id, 'in_thread', thread, id);
    }
    projectLinks(id, mail.subject);
    for (const att of mail.attachments || []) {
      const doc = node('document:' + mail.id + ':' + (att.attachmentId || att.name), 'Document', att.name, { mimeType: att.mimeType, sourceId: mail.id });
      edge(id, 'has_attachment', doc, id);
    }
    // Candidates only: do not invent an assignee, due date or completion state.
    const candidates = clean(mail.body).split(/[\n]+|(?<=[.!?。])\s+/).filter(t => t.length > 8 && t.length < 350 && /(?:제출|회신|검토|전달|준비|보내).{0,40}(?:주세요|부탁|까지|요청)|(?:please|deadline|action item)\b/i.test(t));
    candidates.slice(0, 5).forEach((text, i) => {
      const task = node('task:' + mail.id + ':' + i, 'Task', text, { status: 'candidate', dueDate: null, assignee: null });
      edge(id, 'suggests_task', task, id, true);
    });
  }
  for (const ev of events) {
    if (!ev?.id || ev.status === 'cancelled') continue;
    const id = 'event:' + ev.calendarId + ':' + ev.id;
    node(id, 'Event', ev.title || ev.summary || '(제목 없음)', {
      sourceId: ev.id, calendarId: ev.calendarId, start: ev.start, end: ev.end,
      date: ev.start?.dateTime || ev.start?.date || ev.date,
      text: clean(ev.description || ev.detail), location: ev.location || ev.loc,
      recurrence: ev.recurrence || [], url: ev.htmlLink || ''
    });
    for (const p of ev.attendees || []) {
      const who = person(p.email, p.displayName, id);
      if (who) edge(who, 'attends', id, id);
    }
    const organizer = person(ev.organizer?.email, ev.organizer?.displayName, id);
    if (organizer) edge(organizer, 'organizes', id, id);
    projectLinks(id, ev.title || ev.summary);
  }
  for (const n of manual.nodes || []) {
    if (n.type === 'Project' && n.id.startsWith('project:')) {
      node(n.id, n.type, n.label, { status: 'confirmed', extraction: 'user' });
      nodes.get(n.id).properties = { status: 'confirmed', extraction: 'user' };
    }
  }
  for (const e of manual.edges || []) {
    if (nodes.has(e.from) && nodes.has(e.to)) {
      edge(e.from, 'about_project', e.to, e.from, false);
      edges.get(JSON.stringify([e.from, 'about_project', e.to])).inferred = false;
    }
  }
  const adjacency = new Map();
  for (const e of edges.values()) {
    for (const id of [e.from, e.to]) {
      if (!adjacency.has(id)) adjacency.set(id, []);
      adjacency.get(id).push(e);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], coverage, adjacency, byId: nodes };
}
export function searchOntology(graph, query, limit = 40) {
  const terms = normalize(query).split(/[\s,?!.]+/).map(t => t.replace(/(?:에게|에서|관련|와의|과의|의|와|과|은|는|을|를)$/, '')).filter(t => t.length > 1);
  return graph.nodes.map(n => {
    const title = normalize(n.label), detail = normalize(JSON.stringify(n.properties));
    const score = terms.reduce((sum, t) => sum + (title.includes(t) ? 5 : detail.includes(t) ? 1 : 0), 0);
    return { node: n, score };
  }).filter(r => !terms.length || r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(r => r.node);
}
function localDay(date, timeZone) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return date;
  if (!date || Number.isNaN(new Date(date).getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
}
export function ontologyContext(graph, query, { now = new Date(), timeZone = 'Asia/Seoul', focusId } = {}) {
  const today = localDay(now.toISOString(), timeZone);
  const monday = new Date(today + 'T00:00:00Z');
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const weekStart = monday.toISOString().slice(0, 10);
  const nextWeek = new Date(monday); nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  const weekEnd = nextWeek.toISOString().slice(0, 10);
  const mails = graph.nodes.filter(n => n.type === 'Email');
  const inbox = mails.filter(n => n.properties.labels.includes('INBOX'));
  const received = mails.filter(n => !n.properties.labels.includes('SENT') && !n.properties.labels.includes('DRAFT'));
  const inWeek = n => { const d = localDay(n.properties.date, timeZone); return d && d >= weekStart && d < weekEnd; };
  const counts = { indexedMail: mails.length, indexedInbox: inbox.length, indexedReceived: received.length, indexedMailThisWeek: mails.filter(inWeek).length, indexedInboxThisWeek: inbox.filter(inWeek).length, indexedReceivedThisWeek: received.filter(inWeek).length };
  const seeds = searchOntology(graph, query, 16);
  const ids = new Set(seeds.map(n => n.id));
  if (focusId && graph.byId.has(focusId)) ids.add(focusId);
  // Two hops follow explicit graph relations rather than only matching keywords.
  let frontier = [...ids];
  for (let hop = 0; hop < 2; hop++) {
    const next = [];
    for (const id of frontier) for (const e of graph.adjacency.get(id) || []) {
      const neighbor = e.from === id ? e.to : e.from;
      if (!ids.has(neighbor) && ids.size < 80) { ids.add(neighbor); next.push(neighbor); }
    }
    frontier = next;
  }
  if (/이번\s*주|this week|최근|recent|오늘|내일|tomorrow|today/i.test(query)) {
    mails.slice().sort((a, b) => Date.parse(b.properties.date) - Date.parse(a.properties.date)).slice(0, 8).forEach(n => ids.add(n.id));
    const tomorrow = new Date(today + 'T00:00:00Z'); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const nextDay = tomorrow.toISOString().slice(0, 10);
    const wanted = /내일|tomorrow/i.test(query) ? nextDay : /오늘|today/i.test(query) ? today : null;
    graph.nodes.filter(n => n.type === 'Event' && !n.properties.recurrence.length && (wanted ? localDay(n.properties.date, timeZone) === wanted : inWeek(n))).slice(0, 30).forEach(n => ids.add(n.id));
  }
  const nodes = [...ids].map(id => graph.byId.get(id)).filter(Boolean).slice(0, 80).map(n => ({ ...n, properties: { ...n.properties, text: clean(n.properties.text).slice(0, 1200) } }));
  const included = new Set(nodes.map(n => n.id));
  const relations = graph.edges.filter(e => included.has(e.from) && included.has(e.to)).slice(0, 120);
  const serialized = JSON.stringify({ today, timeZone, weekStart, weekEndExclusive: weekEnd, counts, coverage: graph.coverage, nodes, relations });
  // Preserve valid JSON and evidence when restricting model context.
  if (serialized.length <= 90000) return serialized;
  return JSON.stringify({ today, timeZone, counts, coverage: graph.coverage, nodes: nodes.slice(0, 30), relations: relations.filter(e => nodes.slice(0, 30).some(n => n.id === e.from) && nodes.slice(0, 30).some(n => n.id === e.to)), retrievalTruncated: true });
}
