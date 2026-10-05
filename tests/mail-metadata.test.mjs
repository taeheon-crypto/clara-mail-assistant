import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Window } from 'happy-dom';

test('Gmail mapping and detail show each message recipients, sender and original date safely', async () => {
  const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
  const w = new Window();
  w.document.body.innerHTML = ['mp-from','mp-to','mp-cc','mp-cc-row','mp-date','mp-subj','mp-domain','to-me-btn','g-date'].map(id => `<div id="${id}"></div>`).join('');
  const ctx = vm.createContext({ document: w.document, _gmailFolder:'inbox', _gmailFolderNames:{inbox:'받은편지함'} });
  for (const [name, next] of [['_gmailIcon','function _gmailShortDate'],['_gmailShortDate','let _gmailNextPageToken'],['_mapGmailEmail','async function _gmailFetchMessages'],['renderMailMetadata','function openEmail']]) {
    const start = html.indexOf('function ' + name + '(');
    const end = html.indexOf(next, start + 1);
    vm.runInContext(html.slice(start, end), ctx);
  }
  const received = { id:'1', sender:'Example <img src=x onerror=alert(1)>', senderEmail:'sender@example.org', toHeader:'"Recipient, One" <one@example.com>, two@example.net', ccHeader:'Team <team@example.org>', date:'Mon, 2 Dec 2024 10:11:12 +0900', subject:'Hello', body:'Text' };
  ctx.mail = received;
  vm.runInContext('renderMailMetadata(_mapGmailEmail(mail))', ctx);
  const text = id => w.document.getElementById(id).textContent;
  assert.equal(text('mp-to'), received.toHeader);
  assert.equal(text('mp-cc'), received.ccHeader);
  assert.equal(w.document.getElementById('mp-cc-row').hidden, false);
  assert.equal(text('mp-from'), received.sender + ' <sender@example.org>');
  assert.equal(w.document.querySelector('img'), null);
  assert.equal(text('mp-date'), received.date);
  assert.equal(text('mp-domain'), 'example.org');
  assert.ok(!text('g-date').includes('2026'));
  ctx.mail = { ...received, id:'2', sender:'Me', senderEmail:'me@example.net', toHeader:'Other <other@example.com>', ccHeader:'' };
  vm.runInContext('renderMailMetadata(_mapGmailEmail(mail))', ctx);
  assert.equal(text('mp-to'), 'Other <other@example.com>');
  assert.equal(text('mp-cc'), '');
  assert.equal(w.document.getElementById('mp-cc-row').hidden, true);
  assert.ok(text('to-me-btn').includes('other@example.com'));
  ctx.mail = { subject:'No headers' };
  vm.runInContext('renderMailMetadata(mail)', ctx);
  assert.equal(text('mp-to'), '수신자 헤더 없음');
  assert.equal(text('mp-domain'), '정보 없음');
  w.happyDOM.abort();
});
