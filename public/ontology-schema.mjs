// A bounded domain ontology. Runtime validation is NOT a complete SHACL engine.
export const ONTOLOGY_VERSION = '2.0.0';
export const NODE_TYPES = ['Person', 'Organization', 'Project', 'Thread', 'Email', 'Event', 'Task', 'Document'];
export const RELATIONS = {
  sent: { from: ['Person'], to: ['Email'], weight: 1 },
  to: { from: ['Email'], to: ['Person'], weight: 1 },
  cc: { from: ['Email'], to: ['Person'], weight: 0.6 },
  uses_domain: { from: ['Person'], to: ['Organization'], weight: 0 },
  in_thread: { from: ['Email'], to: ['Thread'], weight: 1.4 },
  about_project: { from: ['Email', 'Event'], to: ['Project'], weight: 1.2 },
  suggests_task: { from: ['Email'], to: ['Task'], weight: 0.8 },
  has_attachment: { from: ['Email', 'Event'], to: ['Document'], weight: 1.3 },
  attends: { from: ['Person'], to: ['Event'], weight: 1 },
  organizes: { from: ['Person'], to: ['Event'], weight: 1.2 },
  recurs_as: { from: ['Event'], to: ['Event'], weight: 1.3 },
  references_event: { from: ['Email'], to: ['Event'], weight: 3 },
  replies_to: { from: ['Email'], to: ['Email'], weight: 2 },
};
const SOURCE_TYPES = new Set(['Email', 'Event']);
export function validateGraph(graph) {
  const violations = [], ids = new Set();
  const report = (id, rule) => { if (violations.length < 100) violations.push({ id, rule }); };
  for (const n of graph.nodes) {
    if (ids.has(n.id)) report(n.id, 'duplicate_identity');
    ids.add(n.id);
    if (!NODE_TYPES.includes(n.type)) report(n.id, 'unknown_type');
    if (n.type === 'Person' && n.id !== 'person:' + n.properties.email?.trim().toLowerCase()) report(n.id, 'email_identity');
    if (SOURCE_TYPES.has(n.type) && !n.properties.sourceId) report(n.id, 'missing_source_id');
    if (n.type === 'Task' && n.properties.status === 'candidate' && (n.properties.assignee || n.properties.dueDate || n.properties.completed)) report(n.id, 'unverified_task_state');
    if (n.type === 'Event') {
      const start = n.properties.start?.dateTime || n.properties.start?.date;
      const end = n.properties.end?.dateTime || n.properties.end?.date;
      if (start && end && Date.parse(end) < Date.parse(start)) report(n.id, 'invalid_interval');
    }
  }
  for (const e of graph.edges) {
    const spec = RELATIONS[e.relation], from = graph.byId.get(e.from), to = graph.byId.get(e.to);
    if (!from || !to) report(e.id, 'dangling_relation');
    else if (!spec || !spec.from.includes(from.type) || !spec.to.includes(to.type)) report(e.id, 'relation_domain_range');
    if (!e.evidence?.length || e.evidence.some(id => !SOURCE_TYPES.has(graph.byId.get(id)?.type))) report(e.id, 'missing_source_evidence');
    if (e.inferred && e.provenance?.status !== 'candidate') report(e.id, 'candidate_promoted');
  }
  return { conforms: !violations.length, violations, checkedNodes: graph.nodes.length, checkedRelations: graph.edges.length, truncated: violations.length === 100 };
}

// Validate and enrich provenance without asserting that source statements are true.
export function finalizeOntology(graph) {
  const evidence = new Map();
  for (const e of graph.edges) {
    const manual = e.method === 'user';
    e.provenance = { status: e.inferred ? 'candidate' : manual ? 'user_confirmed' : 'source_asserted', method: e.method || (e.inferred ? 'deterministic_candidate_rule' : 'provider_metadata'), sourceIds: [...e.evidence], spans: e.spans || [] };
    for (const id of [e.from, e.to]) {
      if (!evidence.has(id)) evidence.set(id, new Set());
      for (const source of e.evidence) evidence.get(id).add(source);
    }
  }
  for (const n of graph.nodes) {
    const source = SOURCE_TYPES.has(n.type);
    n.provenance = { status: n.properties.status === 'candidate' ? 'candidate' : n.properties.extraction === 'user' ? 'user_confirmed' : 'source_asserted', sourceIds: source ? [n.id] : [...(evidence.get(n.id) || [])], observedAt: n.properties.observedAt || null, sourceUpdatedAt: n.properties.updated || null, validAt: n.properties.date || null };
  }
  graph.version = ONTOLOGY_VERSION;
  graph.validation = validateGraph(graph);
  return graph;
}

// JSON-LD uses a caller-supplied, nonsecret account scope. Export is explicit only.
export function exportOntology(graph, scope) {
  if (typeof scope !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(scope)) throw new Error('An explicit account scope is required');
  const id = value => 'urn:clara:' + scope + ':' + encodeURIComponent(value);
  const context = {
    clara: 'urn:clara:ontology:v2:', prov: 'http://www.w3.org/ns/prov#', time: 'http://www.w3.org/2006/time#',
    label: 'http://www.w3.org/2000/01/rdf-schema#label',
    sourceIds: { '@id': 'prov:wasDerivedFrom', '@type': '@id', '@container': '@set' },
    properties: { '@id': 'clara:properties', '@type': '@json' },
    provenance: { '@id': 'clara:provenance', '@type': '@json' },
    predicate: { '@id': 'clara:predicate', '@type': '@id' },
    version: 'clara:version',
    subject: { '@id': 'clara:subject', '@type': '@id' }, object: { '@id': 'clara:object', '@type': '@id' },
  };
  return { '@context': context, version: graph.version, '@graph': [
    ...graph.nodes.map(n => ({ '@id': id(n.id), '@type': ['clara:' + n.type, n.type === 'Person' ? 'prov:Agent' : 'prov:Entity'], label: n.label, properties: n.properties, sourceIds: n.provenance.sourceIds.map(id), provenance: n.provenance })),
    ...graph.edges.map(e => ({ '@id': id(e.id), '@type': 'clara:Assertion', subject: id(e.from), predicate: 'clara:' + e.relation, object: id(e.to), sourceIds: e.evidence.map(id), provenance: e.provenance })),
  ] };
}

// Exact, directed, bounded path execution; no graph sampling for query answers.
export function traversePath(graph, startId, path) {
  let frontier = new Map([[startId, []]]);
  for (const step of path) {
    const next = new Map();
    for (const [id, proof] of frontier) for (const edge of graph.adjacency.get(id) || []) {
      if (edge.relation !== step.relation || step.direction === 'out' && edge.from !== id || step.direction === 'in' && edge.to !== id) continue;
      const target = edge.from === id ? edge.to : edge.from;
      if (!next.has(target)) next.set(target, [...proof, { from: edge.from, relation: edge.relation, to: edge.to, sourceIds: edge.evidence, status: edge.provenance?.status || (edge.inferred ? 'candidate' : 'source_asserted') }]);
    }
    frontier = next;
  }
  return frontier;
}
