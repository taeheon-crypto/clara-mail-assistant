import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

async function transport(fetch) {
  const source = await readFile(new URL('../src/lib/gmail-transport.ts', import.meta.url), 'utf8');
  const exports = {}, clock = { now: 1000000 };
  class Clock extends Date { static now() { return clock.now; } }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: () => crypto, URL, Response, AbortSignal, Date: Clock, Math: { ...Math, random: () => 0, ceil: Math.ceil, min: Math.min, max: Math.max, floor: Math.floor }, fetch,
      setTimeout(fn, ms) { clock.now += ms; fn(); } });
  return { ...exports, clock };
}
const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc?format=full';
test('inbox and AI concurrent reads share one request, reuse body, and isolate tokens', async () => {
  let calls = 0;
  const t = await transport(async (_url, options) => { calls++; return Response.json({ owner: options.headers.Authorization }); });
  const [a, b] = await Promise.all([t.gmailFetch(url, 'a'), t.gmailFetch(url, 'a')]);
  assert.equal(calls, 1); assert.deepEqual(await a.json(), await b.json());
  await t.gmailFetch(url, 'a'); assert.equal(calls, 1);
  assert.equal((await (await t.gmailFetch(url, 'b')).json()).owner, 'Bearer b'); assert.equal(calls, 2);
  t.invalidateGmail('a', 'abc'); await t.gmailFetch(url, 'a'); assert.equal(calls, 3);
  t.clock.now += 61000; await t.gmailFetch(url, 'a'); assert.equal(calls, 4);
});
test('all read routes share pacing and Retry-After blocks upstream calls with exponential backoff', async () => {
  const starts = []; let limited = false, t;
  t = await transport(async () => { starts.push(t.clock.now); return limited ? Response.json({ error: { reason: 'userRateLimitExceeded' } }, { status: 403, headers: { 'Retry-After': '120' } }) : Response.json({ id: 'abc' }); });
  await Promise.all([t.gmailFetch(url, 'a'), t.gmailFetch(url.replace('abc', 'def'), 'a'), t.gmailFetch(url.replace('abc', 'ghi'), 'a')]);
  assert.ok(starts[1] - starts[0] >= 250); assert.ok(starts[2] - starts[1] >= 250);
  limited = true;
  const quota = await t.gmailFetch(url.replace('abc', 'quota'), 'a'); assert.equal(quota.headers.get('Retry-After'), '120');
  const count = starts.length;
  const blocked = await t.gmailFetch(url.replace('abc', 'other'), 'a'); assert.equal(blocked.status, 429); assert.equal(starts.length, count);
  // A cached message remains readable during quota cooldown.
  assert.equal((await t.gmailFetch(url, 'a')).status, 200); assert.equal(starts.length, count);
  t.clock.now += 120001;
  assert.equal((await t.gmailFetch(url.replace('abc', 'quota2'), 'a')).headers.get('Retry-After'), '120');
});
test('failed reads are never cached and a write racing a read cannot repopulate stale cache', async () => {
  let calls = 0, release;
  const t = await transport(async () => { calls++; if (calls === 1) return new Response('', { status: 500 }); if (calls === 2) await new Promise(resolve => { release = resolve; }); return Response.json({ id: 'abc' }); });
  assert.equal((await t.gmailFetch(url, 'a')).status, 500);
  const pending = t.gmailFetch(url, 'a');
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  t.invalidateGmail('a', 'abc'); release(); await pending;
  await t.gmailFetch(url, 'a'); assert.equal(calls, 3);
});


test('metadata page uses one multipart request, maps out-of-order parts, and reuses cached rows',async()=>{
  let calls=0;
  const t=await transport(async(url,options)=>{
    calls++;assert.equal(url,'https://gmail.googleapis.com/batch');assert.ok(!options.body.includes('format=full'));
    return new Response('--reply\r\nContent-Type: application/http\r\nContent-ID: <response-mail1>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify({id:'def',payload:{headers:[]}})+'\r\n--reply\r\nContent-Type: application/http\r\nContent-ID: <response-mail0>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify({id:'abc',payload:{headers:[]}})+'\r\n--reply--\r\n',{headers:{'Content-Type':'multipart/mixed; boundary="reply"'}});
  });
  const rows=await t.gmailMetadataBatch(['abc','def'],'token');assert.equal((await rows[0].json()).id,'abc');assert.equal((await rows[1].json()).id,'def');
  await t.gmailMetadataBatch(['abc','def'],'token');assert.equal(calls,1);
});
test('one throttled metadata part preserves successful rows and missing parts remain retryable',async()=>{
  const t=await transport(async()=>new Response('--reply\r\nContent-Type: application/http\r\nContent-ID: <response-mail0>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n'+JSON.stringify({id:'abc',payload:{headers:[]}})+'\r\n--reply\r\nContent-Type: application/http\r\nContent-ID: <response-mail1>\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nRetry-After: 120\r\n\r\n{"error":"rateLimitExceeded"}\r\n--reply--\r\n',{headers:{'Content-Type':'multipart/mixed; boundary=reply'}}));
  const rows=await t.gmailMetadataBatch(['abc','def','eee'],'token');assert.deepEqual(Array.from(rows,r=>r.status),[200,429,502]);
  assert.equal((await t.gmailMetadataBatch(['abc'],'token'))[0].status,200);
  assert.equal((await t.gmailFetch(url.replace('abc','fff'),'token')).status,429);
});


test('five parallel quota responses produce one cooldown instead of multiplying it to fifteen minutes',async()=>{
  const releases=[];const t=await transport(()=>new Promise(resolve=>releases.push(resolve)));
  const requests=Array.from({length:5},(_,i)=>t.gmailFetch(url.replace('abc','a'+i),'token'));
  while(releases.length<5)await new Promise(resolve=>setTimeout(resolve,0));
  releases.forEach(resolve=>resolve(Response.json({error:'rateLimitExceeded'},{status:429})));
  const responses=await Promise.all(requests);
  assert.ok(responses.every(r=>Number(r.headers.get('Retry-After'))<=61));
});
