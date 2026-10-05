import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, validateDecision } from '../public/ontology-agent.mjs';

test('normal wire variations preserve every meaningful plan constraint', () => {
  const input = { operation: 'aggregate', types: 'Email', scope: 'sent', groupBy: 'person', direction: 'sent', limit: '1', start: '2026-09-01', endExclusive: '2026-10-01', unread: null, read: null, keywords: null, assumptions: null, filters: [{ name: 'founder@example.com', relation: 'to', entityType: null, path: null }] };
  for (const args of [{ plan: input }, input]) {
    const checked = validateDecision({ action: 'tool', name: 'query_ontology', arguments: args });
    assert.ok(checked.decision);
    const plan = checked.decision.arguments.plan;
    assert.equal(plan.scope, 'sent'); assert.equal(plan.direction, 'sent');
    assert.equal(plan.limit, 1); assert.deepEqual(plan.types, ['Email']);
    assert.deepEqual(plan.filters, [{ name: 'founder@example.com', relation: 'to' }]);
    assert.equal(plan.start, '2026-09-01');
  }
  assert.equal(input.unread, null);
  assert.ok(validateDecision({ action: 'tool', name: 'query_ontology', arguments: { plan: { ...input, execute: 'delete()' } } }).error);
  assert.ok(validateDecision({ action: 'tool', name: 'search_evidence', arguments: { question: 'launch', plan: null } }).decision);
});

test('missing aggregate direction is diagnosed for AI repair, never guessed or executed', () => {
  const checked = validateDecision({ action: 'tool', name: 'query_ontology', arguments: { plan: { operation: 'aggregate', types: ['Email'], scope: 'all', groupBy: 'person' } } });
  assert.equal(checked.code, 'aggregate_direction_required');
});

test('agent searches, reads evidence, then answers rather than matching question grammar', async () => {
  let turn = 0;
  const executed = [];
  const answer = await runAgent({ context: { focusId: 'mail:m1' },
    decide: async ({ trace }) => {
      turn++;
      if (turn === 1) return { action: 'tool', name: 'search_evidence', arguments: { question: '지원사업 마감 제출' } };
      if (turn === 2) { assert.equal(trace[0].output.nodes[0].id, 'mail:m1'); return { action: 'tool', name: 'read_sources', arguments: { ids: ['mail:m1'] } }; }
      assert.equal(trace[1].output.nodes[0].properties.text, '사업계획서 제출 요청');
      return { action: 'answer', text: '지원사업 제출 요청을 먼저 확인하세요. [mail:m1]' };
    },
    execute: async name => { executed.push(name); return { nodes: [{ id: 'mail:m1', properties: { text: name === 'read_sources' ? '사업계획서 제출 요청' : 'excerpt' } }] }; },
  });
  assert.deepEqual(executed, ['search_evidence', 'read_sources']);
  assert.equal(answer.kind, 'answer'); assert.match(answer.text, /제출 요청/);
});

test('general conversation is answered by AI without an unnecessary mailbox tool', async () => {
  const answer = await runAgent({ decide: async () => ({ action: 'answer', text: '안녕하세요. 무엇을 도와드릴까요?' }), execute: () => { throw new Error('unexpected'); } });
  assert.equal(answer.trace.length, 0); assert.equal(answer.kind, 'answer');
});

test('tool errors are available to AI for recovery and repeated calls are bounded', async () => {
  let calls = 0;
  const result = await runAgent({ maxTools: 2,
    decide: async ({ trace }) => { if (trace.length) assert.match(trace[0].output.error, /일시 실패/); return { action: 'tool', name: 'search_evidence', arguments: { question: 'launch' } }; },
    execute: () => { calls++; throw new Error('일시 실패'); },
  });
  assert.equal(calls, 2); assert.equal(result.kind, 'incomplete');
});

test('unknown or mutation tools, invalid plans and oversized reads never execute', async () => {
  for (const decision of [
    { action: 'tool', name: 'send_mail', arguments: {} },
    { action: 'tool', name: 'query_ontology', arguments: { plan: { operation: 'delete' } } },
    { action: 'tool', name: 'read_sources', arguments: { ids: Array(7).fill('mail:m1') } },
    { action: 'answer', text: 'hello', execute: 'fetch()' },
  ]) assert.ok(validateDecision(decision).error);
  await assert.rejects(runAgent({ decide: async () => ({ action: 'tool', name: 'eval', arguments: {} }), execute: () => { throw new Error('should not execute'); } }), /검증/);
});

test('large source results are marked as truncated and do not crowd out subsequent reasoning', async () => {
  let step = 0;
  const result = await runAgent({
    decide: async ({ trace }) => ++step === 1 ? { action: 'tool', name: 'read_sources', arguments: { ids: ['mail:m1', 'mail:m2'] } } : { action: 'answer', text: String(trace[0].output.truncated) },
    execute: async () => ({ nodes: [{ id: 'mail:m1', properties: { text: 'x'.repeat(9000) } }, { id: 'mail:m2', properties: { text: 'x'.repeat(9000) } }] }),
  });
  assert.equal(result.text, 'true'); assert.ok(JSON.stringify(result.trace).length < 15000);
});
