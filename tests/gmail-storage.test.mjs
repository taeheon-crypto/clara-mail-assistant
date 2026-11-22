import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';

test('mailbox cache survives reload, isolates accounts, and seeds sent mail from the ontology index', async () => {
  const indexedDB = new IDBFactory(), source = await readFile(new URL('../public/gmail-request-budget.js', import.meta.url), 'utf8');
  const open = email => {
    const window = {};
    vm.runInNewContext(source, { window, indexedDB, setTimeout, fetch: async () => Response.json({user:{email}}) });
    return window.ClaraMailboxStore;
  };
  const first = open('first@example.com');
  await first.save('sent', { emails: [{ id:'a',subject:'Saved subject',bodyLoaded:false }], time:123, cursor:'next', hasMore:true });
  assert.equal((await open('first@example.com').load('sent')).emails[0].subject,'Saved subject');
  assert.equal(await open('other@example.com').load('sent'),null);
  await first.clear();
  assert.equal(await first.load('sent'),null);
  const db = await new Promise(resolve => { const req=indexedDB.open('clara-ontology-v1',1); req.onsuccess=()=>resolve(req.result); });
  await new Promise((resolve,reject)=>{const tx=db.transaction('accounts','readwrite');tx.objectStore('accounts').put({emails:{
    sent:{id:'sent',subject:'Indexed sent',labelIds:['SENT'],dateISO:'2026-10-05T00:00:00Z',body:'Indexed content'},
    received:{id:'received',subject:'Inbox',labelIds:['INBOX'],dateISO:'2026-10-05T00:00:00Z'},
    trash:{id:'trash',subject:'Deleted',labelIds:['SENT','TRASH'],dateISO:'2026-10-05T00:00:00Z'}
  }},'first@example.com');tx.oncomplete=resolve;tx.onerror=reject;});db.close();
  const seeded = await open('first@example.com').load('sent');
  assert.equal(seeded.sourceEmails.length,1);assert.equal(seeded.sourceEmails[0].id,'sent');assert.equal(seeded.sourceEmails[0].bodyLoaded,false);
});
