import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOntology, ontologyContext } from '../public/ontology-core.mjs';
import { queryOntology, queryRange } from '../public/ontology-query.mjs';
const options = { now: new Date('2026-10-04T16:24:00Z'), timeZone: 'Asia/Seoul' };
const coverage = { mail: { status: 'complete' }, calendar: { status: 'complete' } };
const mail = (id, props = {}) => ({ id, subject: '[Atlas] Plan ' + id, sender: '김 대표', senderEmail: 'founder@example.com', toHeader: 'Me <me@example.com>', dateISO: '2026-09-30T10:00:00Z', labelIds: ['INBOX', 'UNREAD'], ...props });
test('the reported last-week list queries all 123 sources and exposes every result beyond the model sample', () => {
  const g = buildOntology(Array.from({length:123}, (_, i) => mail(String(i))), [], coverage);
  const result = queryOntology(g, '지난주 온 메일 모두 알려줘', options);
  assert.equal(result.kind, 'list'); assert.equal(result.total, 123); assert.equal(result.records.length, 123);
  assert.equal(result.plan.start, '2026-09-28'); assert.equal(result.plan.end, '2026-10-05');
  assert.match(result.text, /1~50건 표시/); assert.match(result.text, /조회 결과/);
  const context = JSON.parse(ontologyContext(g, '지난주 메일 요약해줘', options));
  assert.equal(context.sourceQuery.matchedRecords, 123); assert.ok(context.sourceQuery.includedRecords <= 60); assert.equal(context.sourceQuery.exhaustive, false);
});
test('dates respect timezone/week/month boundaries, inclusive custom ranges and leap days', () => {
  assert.equal(queryRange('지난주', options.now, 'America/Los_Angeles').start, '2026-09-21');
  assert.equal(queryRange('지난달', new Date('2026-01-02T00:00Z'), 'Asia/Seoul').start, '2025-12-01');
  assert.equal(queryRange('최근 7일', options.now, options.timeZone).start, '2026-09-29');
  assert.equal(queryRange('2024년 2월 29일', options.now).end, '2024-03-01');
  const g = buildOntology([mail('last', {dateISO:'2026-10-04T14:59:59Z'}), mail('next', {dateISO:'2026-10-04T15:00:00Z'}), mail('old', {dateISO:'2025-09-30T00:00:00Z'})], [], coverage);
  assert.deepEqual(queryOntology(g, '2026-09-28부터 2026-10-04까지 온 메일 모두 알려줘', options).records.map(n=>n.id), ['mail:last']);
  assert.equal(queryOntology(g, '2026-02-30 메일 알려줘', options).kind, 'clarify');
  assert.equal(queryOntology(g, '2026-10-05부터 2026-10-01까지 메일 알려줘', options).kind, 'clarify');
});
test('received, sent, inbox, read and unread are distinct and archives remain queryable', () => {
  const g = buildOntology([mail('unread'), mail('archive', {labelIds:[]}), mail('sent', {labelIds:['SENT']}), mail('draft', {labelIds:['DRAFT']})], [], coverage);
  assert.equal(queryOntology(g, '지난주 받은 메일 몇개야?', options).total, 2);
  assert.equal(queryOntology(g, '지난주 보낸 메일 목록', options).total, 1);
  assert.equal(queryOntology(g, '지난주 받은편지함 몇개야?', options).total, 1);
  assert.equal(queryOntology(g, '지난주 전체 메일 몇개야?', options).total, 4);
  assert.equal(queryOntology(g, '지난주 안읽은 메일 몇개야?', options).total, 1);
  assert.equal(queryOntology(g, '지난주 읽은 메일 몇개야?', options).total, 1);
});
test('person/project relationships filter the full graph and homonyms require addresses', () => {
  const event = {id:'e',calendarId:'work',title:'[Atlas] Meeting',start:{date:'2026-09-30'},attendees:[{email:'founder@example.com'}]};
  const g = buildOntology([mail('a'), mail('b',{senderEmail:'other@example.com',subject:'Unrelated'})], [event], coverage);
  assert.equal(queryOntology(g, '김 대표에게서 받은 메일 모두 알려줘', options).kind, 'clarify');
  assert.equal(queryOntology(g, 'founder@example.com에게서 받은 메일 모두 알려줘', options).total, 1);
  assert.equal(queryOntology(g, '지난주 Atlas 프로젝트 관련 메일 일정 모두 알려줘', options).total, 2);
  assert.equal(queryOntology(g, '지난주 김 대표 해외출장 메일 모두 알려줘', options).kind, 'clarify');
});
test('calendar lookup retains date precision and openly excludes unexpanded recurrence instances', () => {
  const g = buildOntology([], [{id:'once',calendarId:'c',title:'Meeting',start:{date:'2026-10-06'}},{id:'series',calendarId:'c',title:'Daily',start:{date:'2026-01-01'},recurrence:['RRULE:FREQ=DAILY']}], coverage);
  const r = queryOntology(g, '내일 일정 알려줘', options);
  assert.equal(r.total, 1); assert.equal(r.records[0].id, 'event:c:once'); assert.match(r.text, /발생일 조회가 완료되지 않았습니다/);
  assert.match(queryOntology(g, '오늘 무슨 요일이야?', options).text, /2026-10-05, 월요일/);
});
test('partial/error/stale snapshots never imply absence or freshness; reason requests preserve AI path', () => {
  for (const status of ['idle','syncing','error','stale']) {
    const g = buildOntology([], [], {mail:{status}});
    const r = queryOntology(g, '지난주 온 메일 모두 알려줘', options);
    assert.equal(r.complete, false); assert.match(r.text, status==='stale' ? /최신 전체 결과가 아닙니다/ : /실제로 없다는 뜻은 아닙니다/);
  }
  const g = buildOntology([mail('a')], [], coverage);
  assert.equal(queryOntology(g, '지난주 메일 요약해줘', options), null);
  assert.equal(queryOntology(g, '지난주 메일 요약해줘', {...options,allowReason:true}).total, 1);
  assert.equal(queryOntology(g, '존재하지않는회사 메일 요약해줘', {...options,allowReason:true}), null);
});

test('expanded calendar instances include overlapping events and respect exact completed window membership', () => {
  const key = '2026-10-06|2026-10-07|Asia/Seoul';
  const g = buildOntology([], [
    {id:'series',calendarId:'c',title:'Daily',start:{date:'2026-01-01'},recurrence:['RRULE:FREQ=DAILY']},
    {id:'instance',calendarId:'c',title:'Daily',start:{date:'2026-10-06'},recurringEventId:'series'},
    {id:'long',calendarId:'c',title:'Conference',start:{date:'2026-10-05'},end:{date:'2026-10-08'}},
    {id:'stale',calendarId:'c',title:'Cancelled elsewhere',start:{date:'2026-10-06'}}
  ],{...coverage,calendar:{status:'complete',ranges:{[key]:{status:'complete',ids:['c:instance','c:long']}}}});
  const r = queryOntology(g,'내일 일정 알려줘',options);
  assert.equal(r.complete,true); assert.equal(r.total,2);
  assert.ok(!r.records.some(n=>n.id==='event:c:stale'));
  assert.match(r.text,/Google에서 이 기간의 반복 일정/);
  assert.ok(g.edges.some(e=>e.relation==='recurs_as'));
});
