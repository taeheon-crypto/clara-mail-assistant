// All six chat surfaces share deterministic queries and the same evidence graph.
window._claraChatFetch = async function(url, options) {
  const payload = JSON.parse(options.body);
  const lastUser = [...(payload.messages || [])].reverse().find(m => m.role === 'user');
  const question = typeof lastUser?.content === 'string' ? lastUser.content : '';
  let focusId;
  if (typeof selId !== 'undefined' && typeof EMAILS !== 'undefined') {
    const current = EMAILS.find(e => e.id === selId);
    if (current?.gmailId) focusId = 'mail:' + current.gmailId;
  }
  if (window.ClaraOntology) {
    const answer = await window.ClaraOntology.query?.(question);
    if (answer) return Response.json({ content: [{ text: answer.text }], knowledgeSource: 'ontology', answerMode: answer.kind });
    payload.ontologyContext = await window.ClaraOntology.context(question, focusId);
  }
  let response;
  try { response = await fetch(url, { ...options, body: JSON.stringify(payload) }); }
  catch {
    const evidence = await window.ClaraOntology?.fallback?.(question, 'AI 연결에 실패했습니다.');
    if (evidence) return Response.json({ content: [{ text: evidence.text }], knowledgeSource: 'ontology', answerMode: 'evidence' });
    throw new Error('AI 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  }
  if (!response.ok) {
    const error = await response.clone().json().catch(() => ({}));
    // Every UI sees the same useful error, including surfaces that forgot res.ok.
    const message = error.error?.message || 'AI 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.';
    const evidence = await window.ClaraOntology?.fallback?.(question, message);
    if (evidence) return Response.json({ content: [{ text: evidence.text }], knowledgeSource: 'ontology', answerMode: 'evidence' });
    throw new Error(message);
  }
  return response;
};
