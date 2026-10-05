import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOntology, ontologyContext } from '../public/ontology-core.mjs';
import { queryOntology } from '../public/ontology-query.mjs';
import { validatePlan } from '../public/ontology-plan.mjs';

const options = { now: new Date('2026-10-05T03:00:00Z'), timeZone: 'Asia/Seoul', accountEmail: 'me@example.com' };
const coverage = { mail: { status: 'complete' }, calendar: { status: 'complete' } };
const mail = (id, extra = {}) => ({ id, sender: 'Kim', senderEmail: 'kim@example.com', subject: '[Atlas] report', toHeader: 'Me <me@example.com>', dateISO: '2026-10-04T10:00:00Z', labelIds: ['INBOX'], ...extra });
const rank = { operation: 'aggregate', types: ['Email'], scope: 'all', groupBy: 'person', direction: 'exchanged', order: 'desc', limit: 1, start: '2026-09-06', endExclusive: '2026-10-06', assumptions: ['최근은 오늘을 포함한 30일로 조회했습니다.'] };

test('correspondence ranks the full graph, deduplicates To/CC, excludes self/aliases/drafts and exposes exact sources', () => {
  const mails = Array.from({ length: 125 }, (_, i) => mail('received' + i));
  mails.push(mail('sent', { senderEmail: 'alias@example.com', toHeader: 'kim@example.com, me@example.com', ccHeader: 'kim@example.com, lee@example.com', labelIds: ['SENT'] }));
  mails.push(mail('draft', { senderEmail: 'me@example.com', toHeader: 'lee@example.com', labelIds: ['DRAFT'] }));
  mails.push(mail('old', { senderEmail: 'lee@example.com', dateISO: '2025-01-01T00:00:00Z' }));
  const g = buildOntology(mails, [], coverage);
  const result = queryOntology(g, '나랑 최근에 가장 많이 메일 주고받은 사람 누구임?', { ...options, plan: rank });
  assert.equal(result.kind, 'aggregate');
  assert.equal(result.groups[0].email, 'kim@example.com');
  assert.equal(result.groups[0].count, 126);
  assert.equal(result.groups[0].received, 125);
  assert.equal(result.groups[0].sent, 1);
  assert.equal(result.groups[0].sourceIds.length, 126);
  assert.equal(result.groups[1].email, 'lee@example.com');
  assert.equal(result.groups[1].count, 1);
  assert.equal(result.records.length, 126);
  assert.ok(!result.groups.some(p => ['me@example.com', 'alias@example.com'].includes(p.email)));
  assert.match(result.text, /126건/); assert.match(result.text, /최근은 오늘을 포함한 30일/);
});

test('rank ties and homonyms are distinct by email; quota/index freshness is not invented', () => {
  const g = buildOntology([mail('a'), mail('b', { senderEmail: 'other@example.com' })], [], { mail: { status: 'stale' } });
  const result = queryOntology(g, 'most frequent contacts', { ...options, plan: rank });
  assert.equal(result.groups.length, 2); assert.equal(result.complete, false);
  assert.match(result.text, /공동 순위/); assert.match(result.text, /최신 전체 결과가 아닙니다/);
  assert.match(result.text, /kim@example.com/); assert.match(result.text, /other@example.com/);
  const unknown = queryOntology(g, 'Kim related emails', { ...options, plan: { operation: 'list', types: ['Email'], scope: 'all', filters: [{ name: 'Kim', relation: 'related' }] } });
  assert.equal(unknown.kind, 'clarify');
});

test('generic plans intersect graph relationships, date/scope/read state and literal content filters before counting', () => {
  const g = buildOntology([
    mail('a', { body: 'budget proposal', labelIds: ['UNREAD'] }),
    mail('b', { body: 'other topic', labelIds: ['UNREAD'] }),
    mail('c', { body: 'budget', subject: '[Beta] proposal', labelIds: ['UNREAD'] }),
    mail('d', { body: 'budget', senderEmail: 'other@example.com' }),
  ], [], coverage);
  const plan = { operation: 'count', types: ['Email'], scope: 'received', unread: true, start: '2026-10-01', endExclusive: '2026-10-06', filters: [{ name: 'kim@example.com', relation: 'from' }, { name: 'Atlas', relation: 'project' }], keywords: ['budget'] };
  const result = queryOntology(g, 'Atlas budget emails from Kim', { ...options, plan });
  assert.equal(result.total, 1); assert.equal(result.records[0].id, 'mail:a');
  const context = JSON.parse(ontologyContext(g, 'summarize Atlas budget', { ...options, plan: { ...plan, operation: 'reason' } }));
  assert.equal(context.sourceQuery.matchedRecords, 1);
  assert.deepEqual(context.sourceQuery.matchedSourceIds, ['mail:a']);
  assert.deepEqual(context.sourceQuery.filters, plan.filters);
});

test('domain, project and date aggregation reuse source edges without promoting candidate projects', () => {
  const g = buildOntology([mail('a'), mail('b', { senderEmail: 'other@example.com' })], [], coverage);
  const domain = queryOntology(g, 'domains', { ...options, plan: { ...rank, groupBy: 'domain' } });
  assert.equal(domain.groups[0].label, 'example.com'); assert.equal(domain.groups[0].count, 2);
  const project = queryOntology(g, 'projects', { ...options, plan: { ...rank, groupBy: 'project' } });
  assert.equal(project.groups[0].candidate, true); assert.match(project.text, /프로젝트 후보/);
  const daily = queryOntology(g, 'days', { ...options, plan: { ...rank, groupBy: 'day' } });
  assert.equal(daily.groups[0].label, '2026-10-04'); assert.equal(daily.groups[0].count, 2);
  assert.equal(queryOntology(g, 'sent rank', { ...options, plan: { ...rank, direction: 'sent' } }).groups.length, 0);
});

test('unsafe/unsupported model plans fail closed instead of executing actions or dropping conditions', () => {
  for (const plan of [
    { ...rank, operation: 'delete' }, { ...rank, sql: 'DROP TABLE' },
    { ...rank, scope: 'any' }, { ...rank, types: ['Secret'] },
    { ...rank, start: '2026-02-30' }, { ...rank, endExclusive: null },
    { ...rank, limit: 999 }, { ...rank, read: true, unread: true },
    { ...rank, filters: [{ name: 'Kim', relation: 'employer' }] },
    { ...rank, filters: [{ name: 'Kim', relation: 'from', hiddenConstraint: true }] },
    { ...rank, groupBy: 'person', types: ['Task'] },
    { ...rank, operation: 'count' },
  ]) {
    assert.ok(validatePlan(plan).error);
    assert.equal(queryOntology(buildOntology(), 'bad plan', { ...options, plan }).kind, 'clarify');
  }
  assert.equal(validatePlan(rank).plan.operation, 'aggregate');
  assert.equal(queryOntology(buildOntology(), 'unresolved reference', { ...options, plan: { operation: 'clarify', clarification: '어떤 프로젝트를 말씀하시나요?' } }).text, '어떤 프로젝트를 말씀하시나요?');
});

test('list plans honor explicit date order and limit without changing the full matched count', () => {
  const g = buildOntology([mail('new'), mail('old', { dateISO: '2026-09-20T00:00:00Z' })], [], coverage);
  const result = queryOntology(g, 'earliest mail', { ...options, plan: { operation: 'list', types: ['Email'], scope: 'all', order: 'asc', limit: 1 } });
  assert.equal(result.records[0].id, 'mail:old'); assert.equal(result.total, 1); assert.equal(result.matchedTotal, 2);
  assert.match(result.text, /전체 일치 2건/);
});

test('task/document queries inherit their source mailbox scope and date for grouping', () => {
  const g = buildOntology([
    mail('in', { body: 'Please review this report.', attachments: [{ name: 'report.pdf' }], labelIds: ['UNREAD'] }),
    mail('out', { senderEmail: 'me@example.com', toHeader: 'kim@example.com', body: 'Please review this report.', attachments: [{ name: 'report.pdf' }], labelIds: ['SENT'] }),
  ], [], coverage);
  const plan = { operation: 'list', types: ['Task', 'Document'], scope: 'received', unread: true };
  const received = queryOntology(g, 'received attachments and tasks', { ...options, plan });
  assert.equal(received.total, 2);
  assert.ok(received.records.every(n => n.id.includes(':in:')));
  const byDay = queryOntology(g, 'attachments by date', { ...options, plan: { operation: 'aggregate', types: ['Document'], scope: 'received', groupBy: 'day', direction: 'exchanged' } });
  assert.equal(byDay.groups[0].label, '2026-10-04'); assert.equal(byDay.groups[0].count, 1);
});

test('explicit dates and bare recent are resolved from the clock even if the model supplies another range', () => {
  const g = buildOntology([mail('new'), mail('old', { dateISO: '2026-01-01T00:00:00Z' })], [], coverage);
  const result = queryOntology(g, '나랑 최근에 가장 많이 메일 주고받은 사람 누구임?', { ...options, plan: { ...rank, start: '2020-01-01', endExclusive: '2030-01-01' } });
  assert.equal(result.plan.start, '2026-09-06'); assert.equal(result.plan.end, '2026-10-06'); assert.equal(result.total, 1);
  const week = queryOntology(g, '지난주 가장 많이 연락한 사람', { ...options, plan: rank });
  assert.equal(week.plan.start, '2026-09-28'); assert.equal(week.plan.end, '2026-10-05');
});
