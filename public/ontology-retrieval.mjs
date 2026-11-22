import { RELATIONS } from './ontology-schema.mjs';
const cached = new WeakMap();
const STOP = new Set(['메일', '이메일', '일정', '캘린더', '관련', '요약', '분석', '알려줘', '보여줘', '정리해줘', 'the', 'a', 'an', 'and', 'of', 'to', 'in', 'email', 'emails', 'calendar', 'summarize', 'please']);
export function terms(text) {
  const tokens = String(text || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}@._+-]+/gu) || [];
  return tokens.flatMap(token => {
    const base = token.replace(/(?:에게서|한테서|으로부터|에게|한테|와의|과의|관련|에서|을|를|은|는|의)$/, '');
    if (!base || STOP.has(base)) return [];
    const result = [base];
    // Hangul bigrams provide a lexical fallback for Korean spacing/particles.
    if (/^[가-힣]{3,}$/.test(base)) for (let i = 0; i < base.length - 1; i++) result.push(base.slice(i, i + 2));
    return result;
  });
}
function chunks(text) {
  const result = [];
  for (let start = 0; start < text.length;) {
    const end = Math.min(text.length, start + 900);
    result.push({ start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    start = end - 100;
  }
  return result;
}
function indexGraph(graph) {
  if (cached.has(graph)) return cached.get(graph);
  const entries = [], df = new Map();
  for (const n of graph.nodes) {
    const body = ['Email', 'Event'].includes(n.type) ? String(n.properties.text || '') : '';
    const passages = body ? chunks(body) : [{ start: 0, end: 0, text: '' }];
    for (const passage of passages) {
      const title = n.label + ' ' + (n.properties.email || n.properties.domain || '');
      const words = [...terms(title), ...terms(title), ...terms(passage.text)];
      const tf = new Map(); for (const word of words) tf.set(word, (tf.get(word) || 0) + 1);
      for (const word of tf.keys()) df.set(word, (df.get(word) || 0) + 1);
      entries.push({ sourceId: n.id, ...passage, tf, length: words.length || 1 });
    }
  }
  const index = { entries, df, average: entries.reduce((sum, e) => sum + e.length, 0) / (entries.length || 1) || 1 };
  cached.set(graph, index); return index;
}
export function lexicalSearch(graph, question, limit = 40) {
  const index = indexGraph(graph), wanted = [...new Set(terms(question))], count = index.entries.length;
  const scored = index.entries.map(e => {
    let score = 0;
    for (const term of wanted) {
      const frequency = e.tf.get(term) || 0; if (!frequency) continue;
      const idf = Math.log(1 + (count - index.df.get(term) + 0.5) / (index.df.get(term) + 0.5));
      score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * e.length / index.average));
    }
    return { sourceId: e.sourceId, start: e.start, end: e.end, text: e.text, score };
  }).filter(e => e.score > 0).sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.start - b.start);
  return scored.slice(0, limit);
}
export function personalizedPageRank(graph, seeds, { iterations = 24, damping = 0.85 } = {}) {
  const validSeeds = [...seeds].filter(([id, weight]) => graph.byId.has(id) && Number.isFinite(weight) && weight > 0);
  const restart = new Map(), sum = validSeeds.reduce((a, [, b]) => a + b, 0);
  if (!sum) return restart;
  for (const [id, weight] of validSeeds) restart.set(id, weight / sum);
  const reachable = new Set(restart.keys());
  let frontier = [...reachable];
  // Bound graph expansion, not exact queries. High-degree hubs get lower weights.
  for (let hop = 0; hop < 4 && reachable.size < 3000; hop++) {
    const next = [];
    for (const id of frontier) for (const e of graph.adjacency.get(id) || []) {
      if (!(RELATIONS[e.relation]?.weight > 0)) continue;
      const other = e.from === id ? e.to : e.from;
      if (!reachable.has(other) && reachable.size < 3000) { reachable.add(other); next.push(other); }
    }
    frontier = next;
  }
  const transitions = new Map();
  for (const id of reachable) {
    const neighbors = (graph.adjacency.get(id) || []).map(e => {
      const target = e.from === id ? e.to : e.from;
      return { target, weight: (RELATIONS[e.relation]?.weight || 0) * (e.inferred ? 0.5 : 1) / Math.sqrt(1 + (graph.adjacency.get(target)?.length || 0)) };
    }).filter(e => e.weight > 0 && reachable.has(e.target));
    const total = neighbors.reduce((s, e) => s + e.weight, 0);
    transitions.set(id, neighbors.map(e => ({ target: e.target, probability: e.weight / total })));
  }
  let scores = new Map(restart);
  for (let i = 0; i < iterations; i++) {
    const next = new Map([...restart].map(([id, v]) => [id, (1 - damping) * v]));
    let dangling = 0;
    for (const [id, score] of scores) {
      const edges = transitions.get(id) || [];
      if (!edges.length) dangling += damping * score;
      for (const e of edges) next.set(e.target, (next.get(e.target) || 0) + damping * score * e.probability);
    }
    for (const [id, v] of restart) next.set(id, (next.get(id) || 0) + dangling * v);
    scores = next;
  }
  return scores;
}
export function retrieveEvidence(graph, question, { limit = 60, focusId, allowedSourceIds } = {}) {
  const lexical = lexicalSearch(graph, question, 120), seeds = new Map();
  for (const p of lexical) if (seeds.size < 24 || seeds.has(p.sourceId)) seeds.set(p.sourceId, Math.max(seeds.get(p.sourceId) || 0, p.score));
  if (focusId && graph.byId.has(focusId)) seeds.set(focusId, Math.max(2, ...seeds.values(), 0));
  const scores = personalizedPageRank(graph, seeds);
  const lexicalIds = [...new Set(lexical.map(p => p.sourceId))];
  const graphIds = [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  // Reciprocal rank fusion preserves lexical matches and graph-linked source records.
  const fusion = new Map();
  for (const ranked of [lexicalIds, graphIds]) ranked.forEach((id, i) => fusion.set(id, (fusion.get(id) || 0) + 1 / (60 + i + 1)));
  const ranked = [...fusion].filter(([id]) => !allowedSourceIds || !['Email', 'Event', 'Task', 'Document'].includes(graph.byId.get(id)?.type) || allowedSourceIds.has(id)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const nodes = ranked.slice(0, limit).map(([id]) => graph.byId.get(id));
  const selected = new Set(nodes.map(n => n.id));
  const passages = [];
  for (const n of nodes) {
    if (!['Email', 'Event'].includes(n.type)) continue;
    const spans = lexical.filter(p => p.sourceId === n.id && p.text).slice(0, 2);
    if (spans.length) passages.push(...spans);
    else if (n.properties.text) passages.push({ sourceId: n.id, start: 0, end: Math.min(900, n.properties.text.length), text: n.properties.text.slice(0, 900), score: 0 });
  }
  return { nodes, passages, relations: graph.edges.filter(e => selected.has(e.from) && selected.has(e.to)), method: 'BM25+weighted-PPR+RRF', exhaustive: false, graphExpansionLimit: 3000 };
}
