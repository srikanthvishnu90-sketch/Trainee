// Actual built app in a synthetic DOM; this is not browser verification.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {buildContext}=require('./helpers/app-stubs');
const thread='11111111-1111-4111-8111-111111111111',otherThread='22222222-2222-4222-8222-222222222222';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
  const {sandbox,byId}=buildContext(),timers=[];
  // Keep the app's unrelated startup session lookup pending; each test sets
  // its intended identity explicitly instead of racing a default null result.
  const originalClient=sandbox.window.supabase.createClient;sandbox.window.supabase.createClient=(...args)=>{const client=originalClient(...args);client.auth.getSession=()=>new Promise(()=>{});return client;};
  const original=sandbox.document.getElementById;sandbox.document.getElementById=id=>{const el=original(id);el.replaceChildren=()=>{el.children=[];el.innerHTML='';};el.insertAdjacentHTML=(_where,html)=>{el.innerHTML+=html;};return el;};
  const originalCreate=sandbox.document.createElement;sandbox.document.createElement=tag=>{const el=originalCreate(tag);el.insertAdjacentHTML=(_where,html)=>{el.innerHTML+=html;};return el;};
  sandbox.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};sandbox.clearTimeout=()=>{};
  const scripts=[...fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]),ctx=vm.createContext(sandbox);
  for(const block of scripts.filter(block=>/const UPMORE_DATA\s*=|globalThis\.Upmore(?:LedgerReview|BillWorkflow|ChatRequests)\s*=|function guideAnswer\s*\(/.test(block)))vm.runInContext(block,ctx);
  vm.runInContext('session={user:{id:"owner"},access_token:"token"};chat=threadEl(chatMode);',ctx);
  return {ctx,byId,timers,call:expr=>vm.runInContext(expr,ctx)};
}
test('actual agentAsk drops an old reply after new chat without adopting its server thread',async()=>{
  const f=fixture(),network=defer();f.ctx.fetch=()=>network.promise;
  const result=f.call('agentAsk("my rent")');await new Promise(r=>setImmediate(r));f.call('newGuideChat()');
  network.resolve({ok:true,json:async()=>({thread_id:thread,reply:'Old private bill'})});assert.equal((await result).stale,true);assert.equal(f.call('upmoreThread'),null);assert.equal(f.call('upmoreThreads.length'),0);
});
test('actual Guide discards stale remote responses without invoking local fallback or adding private text',async()=>{
  const f=fixture(),network=defer();f.ctx.fetch=()=>network.promise;
  f.call('trackedAnswer=async()=>null;guideAnswer=()=>{throw Error("private fallback must not run");};');
  const pending=f.call('guideAsk("an ordinary bill question")');await new Promise(r=>setImmediate(r));f.call('newGuideChat()');network.resolve({ok:true,json:async()=>({thread_id:thread,reply:'Old private bill'})});await pending;
  assert.equal(f.call('upmoreThread'),null);assert.doesNotMatch(f.byId('threadMain').innerHTML,/Old private bill/);
});
test('actual delayed typing render cannot append old financial content after owner reset',()=>{
  const f=fixture();f.call('addAI(["Private balance $42"],null,null,chatRequests.capture())');f.call('resetPrivateChat();session={user:{id:"other"},access_token:"other-token"};');
  for(const timer of f.timers.filter(t=>t.ms===700))timer.fn();assert.equal(f.byId('threadMain').children.length,0);assert.doesNotMatch(f.byId('threadMain').innerHTML,/Private balance/);
});
test('actual thread list discards late owner results and history verifies ownership before reading messages',async()=>{
  const f=fixture(),listing=defer(),owned=defer();let messageReads=0;
  f.ctx.threadListing=listing.promise;f.ctx.threadOwned=owned.promise;
  f.call('supa.from=table=>({select:()=>({eq(){return this;},order(){return this;},limit:()=>threadListing,single:()=>threadOwned})});');
  const load=f.call('loadChatThreads()');f.call('resetPrivateChat();session={user:{id:"other"},access_token:"other-token"};');listing.resolve({data:[{id:thread,user_id:'owner',title:'Private'}],error:null});await load;assert.equal(f.call('upmoreThreads.length'),0);
  f.call('session={user:{id:"owner"},access_token:"token"};upmoreThreads=[{id:"'+thread+'",user_id:"owner"},{id:"'+otherThread+'",user_id:"owner"}];');
  f.ctx.onMessage=()=>messageReads++;
  f.call('supa.from=table=>{if(table==="agent_messages")onMessage();return {select:()=>({eq(){return this;},order(){return this;},single:()=>threadOwned,limit:async()=>({data:[],error:null})})};};');
  const history=f.call('openGuideChat("'+thread+'")');f.call('newGuideChat()');owned.resolve({data:{id:thread,user_id:'owner'},error:null});await history;assert.equal(messageReads,0);assert.equal(f.call('upmoreThread'),null);
});
test('actual agent mode drops stale tracked results before rendering or writing its audit entry',async()=>{
  const f=fixture(),tracked=defer();let ledgerWrites=0;f.ctx.trackedResult=tracked.promise;f.ctx.countWrite=()=>ledgerWrites++;
  f.call('trackedAnswer=()=>trackedResult;writeLedger=async()=>countWrite();');
  const running=f.call('agentChat("my current bills")');f.call('newGuideChat()');tracked.resolve({paras:['Private old-owner bill']});await running;
  assert.equal(ledgerWrites,0);assert.doesNotMatch(f.byId('threadMain').innerHTML,/Private old-owner bill/);assert.equal(f.timers.filter(timer=>timer.ms===700).length,0);
});
test('actual workflow reply presents a read-only review link that cannot survive a thread switch',async()=>{
  const f=fixture(),obligation='33333333-3333-4333-8333-333333333333',task='44444444-4444-4444-8444-444444444444';let opened=0;
  f.ctx.countOpen=()=>opened++;f.call('openBillWorkflow=async()=>countOpen();');
  f.call('addAI(["Review your bill"],null,null,chatRequests.capture(),{type:"workflow",obligation_id:"'+obligation+'",task_id:"'+task+'",approved:true})');
  for(const timer of f.timers.filter(t=>t.ms===700))timer.fn();
  const message=f.byId('threadMain').children.at(-1),button=message.children.find(el=>el.textContent==='Review bill next step');assert.ok(button);
  button.onclick();await Promise.resolve();assert.equal(opened,1);f.call('newGuideChat()');button.onclick();await Promise.resolve();assert.equal(opened,1);
});
test('actual chat sheet distinguishes failed history reads from a verified empty list and supports retry',async()=>{
  const f=fixture();let attempts=0;f.ctx.readThreadList=async()=>{attempts++;return attempts===1?{data:null,error:{message:'offline'}}:{data:[],error:null};};
  f.call('supa.from=()=>({select:()=>({eq(){return this;},order(){return this;},limit:()=>readThreadList()})});');
  await f.call('openChatsSheet()');const host=f.byId('chatThreadList');assert.doesNotMatch(host.innerHTML,/No chats yet/);
  assert.match(host.children[0].textContent,/saved history may still exist/);assert.equal(host.children[1].textContent,'Reload chats');
  await host.children[1].onclick();assert.match(host.innerHTML,/No chats yet/);assert.equal(f.call('chatThreadListState'),'loaded');
  f.call('resetPrivateChat()');assert.equal(f.call('chatThreadListState'),'unknown');assert.equal(host.children.length,0);
});
