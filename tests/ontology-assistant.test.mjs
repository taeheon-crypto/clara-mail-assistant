import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantPlan, evidenceBatches, runAssistant } from '../public/ontology-assistant.mjs';

const now = new Date('2026-10-05T04:00:00Z');
test('simple mail tools resolve yesterday and exact rankings without model-authored plans', () => {
  const plan = assistantPlan('get_mail', { period: 'yesterday' }, { now, timeZone: 'Asia/Seoul' });
  assert.equal(plan.start, '2026-10-04'); assert.equal(plan.endExclusive, '2026-10-05'); assert.equal(plan.scope, 'received');
  const rank = assistantPlan('rank_correspondents', { period: 'recent 30 days' }, { now });
  assert.equal(rank.direction, 'exchanged'); assert.equal(rank.groupBy, 'person'); assert.equal(rank.scope, 'all');
  assert.throws(() => assistantPlan('get_mail', { period: 'some impossible date' }, { now }));
  assert.throws(() => assistantPlan('delete_mail', {}));
});
test('all selected body evidence survives batching instead of silently using a sample', () => {
  const nodes = Array.from({ length: 123 }, (_, i) => ({ id: 'mail:' + i, body: 'full original body ' + i + 'x'.repeat(500) }));
  const batches = evidenceBatches(nodes, 2000);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), nodes);
});
test('ordinary prose answers from preloaded bodies without an answer function or citation gate', async () => {
  const result = await runAssistant({ context: {}, evidence: { nodes: [{ id: 'mail:real', properties: { text: 'The deadline is Friday.' } }] }, history: [{ role: 'user', content: '어제 받은 메일 정리해봐' }], execute: () => { throw new Error('No unnecessary tool'); }, complete: async ({ evidence }) => ({ content: evidence.nodes[0].properties.text }) });
  assert.match(result.text, /Friday/); assert.match(result.text, /조회한 자료.*mail:real/); assert.equal(result.trace.length, 0);
});
test('tool errors go back to AI and a corrected call preserves conversation context', async () => {
  let requests = 0;
  const history = [{ role: 'assistant', content: '어제 받은 메일을 정리했습니다.' }, { role: 'user', content: '그중 내가 할 일은?' }];
  const result = await runAssistant({ context: {}, history, evidence: { nodes: [] },
    complete: async ({ transcript, history: received }) => {
      assert.deepEqual(received, history); requests++;
      if (!transcript.length) return { tool_calls: [{ id: 'bad', function: { name: 'get_mail', arguments: '{bad' } }] };
      if (transcript.length === 2) { assert.match(transcript[1].content, /error/); return { tool_calls: [{ id: 'good', function: { name: 'get_mail', arguments: '{"period":"yesterday"}' } }] }; }
      return { content: '제안서를 금요일까지 보내세요. [mail:real] [mail:invented]' };
    }, execute: async () => ({ nodes: [{ id: 'mail:real', properties: { text: 'Send proposal Friday' } }] }) });
  assert.equal(requests, 3); assert.match(result.text, /mail:real/); assert.ok(!result.text.includes('mail:invented'));
});
