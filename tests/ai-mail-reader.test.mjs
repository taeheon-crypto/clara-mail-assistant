import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Window } from 'happy-dom';

test('AI source clicks preserve conversation and list while opening the original mail detail', async () => {
  const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
  const w = new Window();
  w.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
  let attachmentOpened = 0;
  const mail = (id, subject) => ({id, subject, sender:'Example', senderEmail:'sender@example.org', toHeader:'me@example.org', date:'10/05', dateHeader:'Mon, 05 Oct 2026 10:00:00 +0900', body:'Plain fallback', bodyHtml:`<p>${subject} <a href="https://example.org">Original link</a></p>`, project:'Inbox', pDesc:subject, attachments:[]});
  const emails = [mail('g_one','First mail'),mail('g_two','Second mail')];
  const ctx = vm.createContext({document:w.document, EMAILS:emails, _aiMode:true, _aiSidebarCollapsed:true, selId:null, starredIds:new Set(), pinnedList:[], setTimeout:()=>{}, renderList:()=>{}, updateNavCount:()=>{}, closeInlineCompose:()=>{}, setTab:()=>{}, _avatarInitial:()=> 'E', _avatarColor:()=> '#123', _getProjectColor:()=> '#123', _getProjectTag:()=> 'Inbox', _attIcon:()=> '', _genDocAnswer:()=> '', openAttachmentPopup:()=>{attachmentOpened++;}, _baAddUserMsg:text=>{w.document.getElementById('ba-msgs').textContent=text;}, _baAddAiMsg:()=>{} });
  for (const [name,next] of [['blankAiSearch','function baSortSel'],['_renderSourceList','function openAiSource'],['openAiSource','function openAttachmentPopup'],['renderEmailBody','function renderMailMetadata'],['renderMailMetadata','function openEmail'],['openEmail','function setTab']]) {
    vm.runInContext(html.slice(html.indexOf('function '+name+'('),html.indexOf(next,html.indexOf('function '+name+'(')+1)),ctx);
  }
  vm.runInContext("blankAiSearch('Show my related mail'); _renderSourceList(EMAILS)",ctx);
  const chat = w.document.getElementById('ba-msgs');
  const list = w.document.getElementById('ba-source-list');
  list.querySelector('tbody tr a').click();
  assert.equal(attachmentOpened,0);
  assert.equal(w.document.getElementById('ba-msgs'),chat);
  assert.equal(chat.textContent,'Show my related mail');
  assert.equal(w.document.getElementById('ba-source-list'),list);
  assert.equal(w.document.getElementById('ed-blank').style.display,'flex');
  assert.ok(w.document.querySelector('.ed').classList.contains('ai-workspace'));
  assert.ok(w.document.querySelector('.ed').classList.contains('ai-mail-open'));
  assert.equal(w.document.getElementById('g-subject').textContent,'First mail');
  assert.ok(w.document.querySelector('#ed-original-content iframe').srcdoc.includes(emails[0].bodyHtml));
  assert.ok(!w.document.querySelector('#ed-original-content iframe').getAttribute('sandbox').includes('allow-scripts'));
  list.querySelectorAll('tbody tr')[1].click();
  assert.equal(w.document.getElementById('g-subject').textContent,'Second mail');
  assert.equal(list.querySelector('tr.selected').dataset.mailId,'g_two');
  assert.equal(w.document.getElementById('att-viewer-modal'),null);
  vm.runInContext("openAiSource({name:'file.pdf'}, EMAILS[0], 'file.pdf', 'pdf')",ctx);
  assert.equal(attachmentOpened,1);
  vm.runInContext('_aiMode=false; openEmail(EMAILS[0].id)',ctx);
  assert.ok(!w.document.querySelector('.ed').classList.contains('ai-workspace'));
  assert.equal(w.document.getElementById('ed-blank').style.display,'none');
  w.happyDOM.abort();
});
