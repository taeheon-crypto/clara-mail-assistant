import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOntology, ontologyContext } from '../public/ontology-core.mjs';

const mail = (id, senderEmail = 'founder@example.com') => ({ id, threadId: 't1', subject: '[Atlas] 자료 제출', sender: '김 대표', senderEmail, toHeader: 'Me <me@gmail.com>', dateISO: '2026-10-04T23:30:00Z', labelIds: ['INBOX'], body: '사업계획서를 금요일까지 보내주세요.', attachments: [{ name: 'plan.pdf', attachmentId: 'a1' }] });
const event = { id: 'e1', calendarId: 'primary', title: '[Atlas] 투자 미팅', start: { dateTime: '2026-10-06T10:00:00+09:00' }, attendees: [{ email: 'FOUNDER@example.com', displayName: '김 대표' }] };
test('email and calendar share address identities without merging homonyms', () => {
  const g = buildOntology([mail('m1'), mail('m2', 'other@example.com')], [event]);
  assert.equal(g.nodes.filter(n => n.type === 'Person' && n.label === '김 대표').length, 2);
  assert.ok(g.edges.some(e => e.from === 'person:founder@example.com' && e.relation === 'attends'));
  assert.ok(g.edges.some(e => e.from === 'person:founder@example.com' && e.relation === 'sent'));
  assert.equal(g.nodes.filter(n => n.type === 'Thread').length, 1);
});
test('every extracted relation carries evidence; inferred tasks have no invented deadlines', () => {
  const g = buildOntology([mail('m1')], [event]);
  assert.ok(g.edges.every(e => e.evidence.length && e.evidence.every(id => g.byId.has(id))));
  assert.equal(g.byId.get('project:atlas').properties.status, 'candidate');
  assert.equal(g.byId.get('task:m1:0').properties.dueDate, null);
  assert.equal(g.byId.get('task:m1:0').properties.assignee, null);
  assert.equal(g.byId.get('org:example.com').label, 'example.com');
});
test('confirmed project survives projection and overrides a inferred link', () => {
  const g = buildOntology([mail('m1')], [event], {}, { nodes: [{ id: 'project:atlas', type: 'Project', label: 'Atlas' }], edges: [{ from: 'mail:m1', to: 'project:atlas' }, { from: 'mail:deleted', to: 'project:atlas' }] });
  assert.equal(g.byId.get('project:atlas').properties.status, 'confirmed');
  assert.equal(g.edges.find(e => e.from === 'mail:m1' && e.to === 'project:atlas').inferred, false);
  assert.ok(!g.edges.some(e => e.from === 'mail:deleted'));
});
test('relation retrieval finds emails and events through a person and Korean particles', () => {
  const g = buildOntology([mail('m1')], [event], { mail: { status: 'complete' }, calendar: { status: 'complete' } });
  const context = JSON.parse(ontologyContext(g, '김 대표와의 대화를 정리해줘'));
  assert.ok(context.nodes.some(n => n.id === 'mail:m1'));
  assert.ok(context.nodes.some(n => n.id === 'event:primary:e1'));
});
test('weekly counts use full ISO dates and the user timezone, never model estimates', () => {
  const g = buildOntology([mail('m1'), { ...mail('old'), dateISO: '2025-10-05T00:00:00Z' }, { ...mail('sent'), labelIds: ['SENT'] }], []);
  const c = JSON.parse(ontologyContext(g, '이번주 받은편지함 몇 개?', { now: new Date('2026-10-05T01:00:00Z'), timeZone: 'Asia/Seoul' }));
  assert.equal(c.weekStart, '2026-10-05');
  assert.equal(c.counts.indexedMailThisWeek, 2);
  assert.equal(c.counts.indexedInboxThisWeek, 1);
});
test('tomorrow retrieval includes all-day events without inventing recurrence occurrences', () => {
  const ev = { id: 'allDay', calendarId: 'primary', title: 'Check-in', start: { date: '2026-10-05' } };
  const recurring = { ...ev, id: 'series', recurrence: ['RRULE:FREQ=DAILY'] };
  const g = buildOntology([], [ev, recurring]);
  const c = JSON.parse(ontologyContext(g, 'tomorrow', { now: new Date('2026-10-04T18:00:00Z'), timeZone: 'America/Los_Angeles' }));
  assert.ok(c.nodes.some(n => n.id === 'event:primary:allDay'));
  assert.ok(!c.nodes.some(n => n.id === 'event:primary:series'));
});
