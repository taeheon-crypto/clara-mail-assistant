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
    // A simple aggregate is a graph query, not a model generation. Match only
    // whole unfiltered questions so sender/project/date filters still reach AI.
    const simpleWeeklyCount = /^(?:이번\s*주\s*(?:(?:온|받은|수신한|전체|모든)\s*)?(?:메일|이메일|받은\s*편지함)(?:은|이|이랑|의)?\s*(?:총\s*)?(?:몇\s*(?:개|통)(?:야|임|인가요|인지|예요|왔어|왔나요|있어|있나요)?|개수(?:를)?(?:\s*(?:알려줘|알려주세요))?)|how many (?:emails?|messages?) (?:did i (?:get|receive) this week|(?:are )?in my inbox this week))[?.!\s]*$/i.test(question.trim());
    if (simpleWeeklyCount && payload.ontologyContext) {
      try {
        const c = JSON.parse(payload.ontologyContext);
        const inbox = /받은\s*편지함|inbox/i.test(question);
        const all = /전체|모든/.test(question);
        const key = inbox ? 'indexedInboxThisWeek' : all ? 'indexedMailThisWeek' : 'indexedReceivedThisWeek';
        const count = c.counts?.[key];
        if (Number.isInteger(count) && count >= 0 && c.weekStart && c.weekEndExclusive) {
          const complete = c.coverage?.mail?.status === 'complete';
          const label = inbox ? '받은편지함에 있는 메일' : all ? '전체 메일(보낸 메일 포함)' : '받은 메일(보낸 메일·임시보관 제외, 보관·스팸·휴지통 포함)';
          const text = `이번 주 ${label}은 ${count}통입니다.\n기준: ${c.timeZone}, ${c.weekStart}부터 ${c.weekEndExclusive} 이전까지. [ontology:counts]\n` + (complete ? '마지막 동기화된 지식 연결 기준입니다. 새 메일은 지식 연결에서 다시 동기화해 주세요.' : '아직 전체 동기화가 끝나지 않아 현재 수집된 메일만 센 결과입니다. 지식 연결에서 동기화 완료 후 다시 확인해 주세요.');
          return Response.json({ content: [{ text }], knowledgeSource: 'ontology', answerMode: 'aggregate' });
        }
      } catch { /* Invalid/unavailable evidence falls through to the server. */ }
    }
  }
  return fetch(url, { ...options, body: JSON.stringify(payload) });
};
