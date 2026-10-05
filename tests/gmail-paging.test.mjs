import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { Window } from 'happy-dom';

const ids = Array.from({length:30},(_,i)=>(i+1).toString(16).padStart(16,'0'));
const message = id => ({id,threadId:id,labelIds:['INBOX'],payload:{headers:[{name:'From',value:'Sender <sender@example.com>'},{name:'To',value:'me@example.com'},{name:'Subject',value:'Mail '+id},{name:'Date',value:'Mon, 05 Oct 2026 10:00:00 +0900'}],mimeType:'text/plain',body:{data:Buffer.from('Original message').toString('base64url')}}});

async function api(fetchStub) {
  const source=await readFile(new URL('../src/app/api/gmail/messages/route.ts',import.meta.url),'utf8');
  const exports={};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,fetch:fetchStub,URL,Buffer,setTimeout:fn=>fn(),console:{error(){}},require(name){if(name==='@/lib/gmail-transport')return {gmailFetch:(url)=>fetchStub(url),invalidateGmail(){}};if(name==='@/auth')return {auth:async()=>({accessToken:'test'})};if(name==='next/server')return {NextResponse:{json:Response.json}};throw Error(name);}});
  return exports.GET;
}

test('Gmail requests 30 messages and retains the current page on quota failure without skipping mail',async()=>{
  let blocked=true;
  const fetched=[];
  const get=await api(async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/messages')){assert.equal(u.searchParams.get('maxResults'),'30');return Response.json({messages:ids.map(id=>({id})),nextPageToken:'older'});}
    const id=u.pathname.split('/').pop();fetched.push(id);
    if(blocked&&ids.indexOf(id)>=5)return Response.json({error:{message:'userRateLimitExceeded'}},{status:403});
    return Response.json(message(id));
  });
  const first=await (await get(new Request('https://clara.test/api/gmail/messages'))).json();
  assert.equal(first.emails.length,5);
  assert.equal(first.retryPage,true);
  assert.equal(first.nextPageToken,null);
  assert.equal(first.retryAfterMs,60000);
  blocked=false;fetched.length=0;
  const resumed=await (await get(new Request('https://clara.test/api/gmail/messages?loadedIds='+first.emails.map(e=>e.id).join(',')))).json();
  assert.equal(resumed.emails.length,25);
  assert.equal(resumed.nextPageToken,'older');
  assert.equal(resumed.retryPage,false);
  assert.equal(new Set([...first.emails,...resumed.emails].map(e=>e.id)).size,30);
  assert.ok(first.emails.every(e=>!fetched.includes(e.id)));
  blocked=true;
  const older=await (await get(new Request('https://clara.test/api/gmail/messages?pageToken=current'))).json();
  assert.equal(older.nextPageToken,'current');
  assert.equal(older.retryPage,true);
});

async function client(pages) {
  const html=await readFile(new URL('../public/app.html',import.meta.url),'utf8');
  const w=new Window();
  w.document.body.innerHTML='<div id="el-scroll"></div>';
  const requests=[],timers=[];
  const emails=[];
  const ctx=vm.createContext({document:w.document,window:w,EMAILS:emails,starredIds:new Set(),AbortController,selId:null,_gmailConnected:false,_gmailIcon:()=>'',_gmailShortDate:()=> '10/05',URLSearchParams,Date,console,showToast:()=>{},_updateGmailBtn:()=>{},setTimeout(fn,ms){timers.push({fn,ms});return timers.length;},clearTimeout(){},fetch:async url=>{requests.push(url);const page=pages.shift();return Response.json(page.body??page,{status:page.status||200});},renderList:()=>{w.document.getElementById('el-scroll').innerHTML=emails.map(e=>'<div class="em-row">'+e.subject+'</div>').join('');vm.runInContext('_renderGmailPagingFooter()',ctx);}});
  vm.runInContext(html.slice(html.indexOf('const _gmailFolderCache'),html.indexOf('function _gmailConnect()')),ctx);
  return {w,ctx,requests,timers,emails,run:code=>vm.runInContext(code,ctx)};
}
const pageEmail=id=>({id,sender:'Sender',senderEmail:'sender@example.com',subject:'Mail '+id,date:'2026-10-05',body:'Original',attachments:[]});

test('Inbox starts with 30 mails and bottom scrolling appends another 30 without resetting position',async()=>{
  const c=await client([{emails:ids.map(pageEmail),nextPageToken:'older'},{emails:ids.map(id=>pageEmail('f'+id)),nextPageToken:null}]);
  await c.run('_gmailFetchMessages()');
  assert.equal(c.emails.length,30);
  assert.equal(c.requests.length,1);
  const scroll=c.w.document.getElementById('el-scroll');
  Object.defineProperties(scroll,{clientHeight:{value:500},scrollHeight:{get:()=>c.emails.length*70+60}});
  scroll.scrollTop=1900;
  scroll.dispatchEvent(new c.w.Event('scroll'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.emails.length,60);
  assert.match(c.requests[1],/pageToken=older/);
  assert.equal(scroll.scrollTop,1900);
  assert.match(scroll.textContent,/60개 메일/);
  assert.match(scroll.textContent,/모든 메일/);
  scroll.dispatchEvent(new c.w.Event('scroll'));
  assert.equal(c.requests.length,2);
  c.w.happyDOM.abort();
});

test('Partial first page resumes automatically, keeps existing mails and then continues older pages',async()=>{
  const c=await client([{emails:ids.slice(0,5).map(pageEmail),retryPage:true,nextPageToken:null,retryAfterMs:60000},{emails:ids.slice(5).map(pageEmail),nextPageToken:'older'}]);
  await c.run('_gmailFetchMessages()');
  assert.equal(c.emails.length,5);
  assert.equal(c.run('_gmailHasMore'),true);
  assert.ok(c.timers.some(t=>t.ms>=60000));
  c.run('_gmailScrollCooldownUntil=0');
  await c.run('_gmailLoadMore(true)');
  assert.equal(c.emails.length,30);
  assert.equal(new Set(c.emails.map(e=>e.id)).size,30);
  assert.match(c.requests[1],/loadedIds=/);
  assert.equal(c.run('_gmailNextPageToken'),'older');
  assert.equal(c.run('_gmailHasMore'),true);
  c.w.happyDOM.abort();
});

test('A failed older-page request retains its cursor and exposes automatic retry without discarding 30 mails',async()=>{
  const c=await client([{emails:ids.map(pageEmail),nextPageToken:'older'},{status:429,body:{error:'quota_exceeded'}},{emails:[pageEmail('abc123')],nextPageToken:null}]);
  await c.run('_gmailFetchMessages()');
  await c.run('_gmailLoadMore()');
  assert.equal(c.emails.length,30);
  assert.equal(c.run('_gmailNextPageToken'),'older');
  assert.equal(c.run('_gmailHasMore'),true);
  assert.match(c.w.document.getElementById('el-load-more-row').textContent,/자동 재시도/);
  assert.ok(c.timers.some(t=>t.ms>=60000));
  c.run('_gmailScrollCooldownUntil=0');
  await c.run('_gmailLoadMore()');
  assert.equal(c.emails.length,31);
  assert.match(c.requests[2],/pageToken=older/);
  c.w.happyDOM.abort();
});

test('All sidebar folders query native Gmail labels and search categories',async()=>{
  const expected={inbox:{label:'INBOX'},starred:{label:'STARRED'},snoozed:{query:'in:snoozed'},important:{label:'IMPORTANT'},sent:{label:'SENT'},drafts:{label:'DRAFT'},purchases:{query:'category:purchases'},social:{query:'category:social'},updates:{query:'category:updates'},forums:{query:'category:forums'},promotions:{query:'category:promotions'},all:{},spam:{label:'SPAM',trash:true},deleted:{label:'TRASH',trash:true},primary:{label:'INBOX',query:'category:primary'}};
  for(const [folder,scope] of Object.entries(expected)){
    const get=await api(async url=>{const u=new URL(url);assert.equal(u.searchParams.get('labelIds'),scope.label||null,folder);assert.equal(u.searchParams.get('q'),scope.query||null,folder);assert.equal(u.searchParams.get('includeSpamTrash'),scope.trash?'true':null,folder);return Response.json({messages:[]});});
    const body=await (await get(new Request('https://clara.test/api/gmail/messages?folder='+folder))).json();
    assert.equal(body.mailbox,folder);assert.deepEqual(body.emails,[]);
  }
  const get=await api(()=>{throw Error('Invalid folder reached Google');});
  assert.equal((await get(new Request('https://clara.test/api/gmail/messages?folder=invalid'))).status,400);
});

test('Rapid folder switching ignores stale responses and older-page requests retain their folder',async()=>{
  const c=await client([]),pending=[];
  c.ctx.fetch=(url,options)=>new Promise(resolve=>pending.push({url,signal:options.signal,resolve}));
  const first=c.run("_gmailFetchMessages('inbox')");await new Promise(resolve=>setImmediate(resolve));
  const sent=c.run("_gmailFetchMessages('sent')");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(pending[0].signal.aborted,true);
  pending[1].resolve(Response.json({emails:ids.map(id=>({...pageEmail(id),mailbox:'sent',labelIds:['SENT']})),nextPageToken:'sent-older'}));await sent;
  pending[0].resolve(Response.json({emails:[pageEmail('bbb')],nextPageToken:'inbox-older'}));await first;
  assert.equal(c.emails.length,30);assert.equal(c.emails[0].label,'sent');assert.equal(c.run('_gmailNextPageToken'),'sent-older');
  const more=c.run('_gmailLoadMore()');await new Promise(resolve=>setImmediate(resolve));
  assert.match(pending[2].url,/folder=sent/);assert.match(pending[2].url,/pageToken=sent-older/);
  pending[2].resolve(Response.json({emails:[{...pageEmail('ccc'),mailbox:'sent'}],nextPageToken:null}));await more;assert.equal(c.emails.length,31);
  const draft=c.run("_gmailFetchMessages('drafts')");await new Promise(resolve=>setImmediate(resolve));
  pending[3].resolve(Response.json({emails:[],mailbox:'drafts',nextPageToken:null}));await draft;
  assert.equal(c.emails.length,0);assert.equal(c.run('_gmailHasMore'),false);
  c.w.happyDOM.abort();
});

test('Sidebar matches the requested Gmail Korean names and order',async()=>{
  const html=await readFile(new URL('../public/app.html',import.meta.url),'utf8');
  const section=html.slice(html.indexOf('id="fp-mail-list"'),html.indexOf('<!-- /fp-mail-list -->'));
  const w=new Window();w.document.body.innerHTML='<div '+section;
  const items=Array.from(w.document.querySelectorAll('[data-mailbox]'));
  assert.deepEqual(items.slice(0,11).map(e=>e.textContent),['받은편지함','별표편지함','다시 알림 항목','중요편지함','보낸편지함','임시보관함','구매','소셜','업데이트','포럼','프로모션']);
  assert.equal(section.includes('No shared emails'),false);assert.ok(items.some(e=>e.dataset.mailbox==='deleted'));
  w.happyDOM.abort();
});

test('Star, unstar and archive actions update native Gmail labels',async()=>{
  const source=await readFile(new URL('../src/app/api/gmail/action/route.ts',import.meta.url),'utf8');
  const exports={},calls=[];
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,fetch:async(url,options)=>{calls.push({url,options});return Response.json({id:'abc'});},require(name){if(name==='@/lib/gmail-transport')return {gmailFetch:(url)=>fetchStub(url),invalidateGmail(){}};if(name==='@/auth')return {auth:async()=>({accessToken:'test'})};if(name==='next/server')return {NextResponse:{json:Response.json}};throw Error(name);}});
  for(const [action,add,remove] of [['star',['STARRED'],[]],['unstar',[],['STARRED']],['archive',[],['INBOX']]]){
    const response=await exports.POST(new Request('https://clara.test/api/gmail/action',{method:'POST',body:JSON.stringify({action,gmailId:'abc'})}));
    assert.equal(response.status,200);assert.match(calls.at(-1).url,/users\/me\/messages\/abc\/modify$/);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body),{addLabelIds:add,removeLabelIds:remove});
  }
});


test('returning to a recently loaded folder reuses mails and its cursor without another API call',async()=>{
  const c=await client([{emails:ids.map(pageEmail),nextPageToken:'older'},{emails:[pageEmail('sent')],nextPageToken:null}]);
  await c.run("_gmailFetchMessages('inbox')");await c.run("_gmailFetchMessages('sent')");await c.run("_gmailFetchMessages('inbox')");
  assert.equal(c.requests.length,2);assert.equal(c.emails.length,30);assert.equal(c.run('_gmailNextPageToken'),'older');
});
