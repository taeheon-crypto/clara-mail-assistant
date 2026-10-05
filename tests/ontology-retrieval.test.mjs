import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOntology, exportOntology } from '../public/ontology-core.mjs';
import { lexicalSearch, personalizedPageRank, retrieveEvidence } from '../public/ontology-retrieval.mjs';
import { traversePath, validateGraph } from '../public/ontology-schema.mjs';
import { queryOntology } from '../public/ontology-query.mjs';

const mails = [
  { id: 'invite', subject: 'Launch invitation', senderEmail: 'alice@company.com', toHeader: 'me@example.com', body: 'Launch rendezvous', calendarUIDs: ['uid1'], messageId: '<one>', dateISO: '2026-10-04T12:00:00Z' },
  { id: 'reply', subject: 'Confirmation', senderEmail: 'me@example.com', toHeader: 'alice@company.com', body: 'Confirmed', inReplyTo: '<one>', labelIds: ['SENT'], dateISO: '2026-10-04T13:00:00Z' },
  { id: 'noise', subject: 'Other department', senderEmail: 'bob@company.com', body: 'Unrelated invoices', dateISO: '2026-10-04T14:00:00Z' },
];
const events = [{ id: 'meeting', calendarId: 'work', title: 'Planning', iCalUID: 'uid1', start: { date: '2026-10-05' }, end: { date: '2026-10-06' }, organizer: { email: 'alice@company.com' }, attendees: [{ email: 'alice@company.com', responseStatus: 'accepted' }, { email: 'bob@company.com', responseStatus: 'declined' }] }];
const graph = () => buildOntology(mails, events, { accountEmail: 'me@example.com', mail: { status: 'complete' }, calendar: { status: 'complete' } });

test('explicit invitation and reply links carry both original source identities', () => {
  const g = graph();
  assert.equal(g.validation.conforms, true);
  const edge = g.edges.find(e => e.relation === 'references_event');
  assert.deepEqual(edge.evidence, ['mail:invite', 'event:work:meeting']);
  assert.equal(edge.provenance.method, 'ical_uid');
  assert.ok(g.edges.some(e => e.from === 'mail:reply' && e.to === 'mail:invite' && e.relation === 'replies_to'));
  assert.ok(!g.edges.some(e => e.from === 'mail:noise' && e.relation === 'references_event'));
});

test('retrieval sees deep body passages and preserves exact source offsets', () => {
  const body = 'Routine introduction. '.repeat(160) + 'zebraquartz project milestone';
  const g = buildOntology([{ id: 'deep', subject: 'Weekly digest', body }, { id: 'noise', subject: 'Digest', body: 'ordinary content' }]);
  const found = lexicalSearch(g, 'zebraquartz', 1)[0];
  assert.equal(found.sourceId, 'mail:deep');
  assert.ok(found.start > 1200);
  assert.equal(body.slice(found.start, found.end), found.text);
});

test('graph diffusion links an invitation to its event without spreading through company domains', () => {
  const g = graph();
  const scores = personalizedPageRank(g, new Map([['mail:invite', 1], ['missing', 100]]));
  assert.ok(scores.get('event:work:meeting') > 0);
  assert.ok(!scores.has('org:company.com'));
  assert.ok(Math.abs([...scores.values()].reduce((a, b) => a + b, 0) - 1) < 1e-8);
  const evidence = retrieveEvidence(g, 'rendezvous');
  assert.ok(evidence.nodes.some(n => n.id === 'event:work:meeting'));
  assert.equal(evidence.exhaustive, false);
});

test('directed multi-hop query returns exact matches with a verifiable path', () => {
  const g = graph();
  const path = [{ relation: 'sent', direction: 'out' }, { relation: 'references_event', direction: 'out' }];
  const reached = traversePath(g, 'person:alice@company.com', path);
  assert.deepEqual([...reached.keys()], ['event:work:meeting']);
  assert.equal(reached.get('event:work:meeting').length, 2);
  const result = queryOntology(g, 'associated meetings', { plan: { operation: 'list', types: ['Event'], scope: 'all', filters: [{ name: 'alice@company.com', entityType: 'Person', relation: 'related', path }] } });
  assert.equal(result.total, 1);
  assert.ok(result.paths.has('event:work:meeting'));
});

test('mixed source aggregation deduplicates organizer and attendee and excludes declined invitations', () => {
  const result = queryOntology(graph(), 'communication contacts', { accountEmail: 'me@example.com', plan: { operation: 'aggregate', types: ['Email', 'Event'], scope: 'all', groupBy: 'person', direction: 'exchanged', limit: 10 } });
  const alice = result.groups.find(r => r.id === 'person:alice@company.com');
  const bob = result.groups.find(r => r.id === 'person:bob@company.com');
  assert.equal(alice.count, 3); assert.equal(alice.events, 1);
  assert.equal(bob.count, 1); assert.equal(bob.events, 0);
});

test('JSON-LD export scopes identities and retains assertion predicates and provenance', () => {
  const g = graph(), one = exportOntology(g, 'account1'), two = exportOntology(g, 'account2');
  assert.notEqual(one['@graph'][0]['@id'], two['@graph'][0]['@id']);
  assert.equal(one['@context'].predicate['@type'], '@id');
  assert.ok(one['@graph'].some(n => n.predicate === 'clara:references_event' && n.sourceIds.length === 2));
  assert.throws(() => exportOntology(g, 'me@example.com'));
  g.edges.push({ id: 'invalid', from: 'mail:invite', relation: 'sent', to: 'person:alice@company.com', evidence: ['mail:invite'] });
  assert.equal(validateGraph(g).conforms, false);
});
