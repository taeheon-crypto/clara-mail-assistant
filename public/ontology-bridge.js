// All six existing chat surfaces use the same indexed knowledge context.
window._claraChatFetch = async function(url, options) {
  const payload = JSON.parse(options.body);
  const lastUser = [...(payload.messages || [])].reverse().find(m => m.role === 'user');
  let question = typeof lastUser?.content === 'string' ? lastUser.content : '';
  let focusId;
  if (typeof selId !== 'undefined' && typeof EMAILS !== 'undefined') {
    const current = EMAILS.find(e => e.id === selId);
    if (current?.gmailId) focusId = 'mail:' + current.gmailId;
  }
  if (window.ClaraOntology) {
    payload.ontologyContext = await window.ClaraOntology.context(question, focusId);
  }
  return fetch(url, { ...options, body: JSON.stringify(payload) });
};
