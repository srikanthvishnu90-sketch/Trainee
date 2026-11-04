// Executes the built Messages integration with invented actors; never contacts a service.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {buildContext}=require('./helpers/app-stubs');
const OWNER='11111111-1111-4111-8111-111111111111',THREAD='22222222-2222-4222-8222-222222222222',CARD='33333333-3333-4333-8333-333333333333';
function fixture(){
  const {sandbox,byId}=buildContext(),timers=[],mounts=[];
  const original=sandbox.window.supabase.createClient;
  sandbox.window.supabase.createClient=(...args)=>{const client=original(...args);client.auth.getSession=()=>new Promise(()=>{});return client;};
  const create=sandbox.document.createElement;
  sandbox.document.createElement=tag=>{const el=create(tag);el.insertAdjacentHTML=(_where,html)=>{el.innerHTML+=html;};return el;};
  const get=sandbox.document.getElementById;
  sandbox.document.getElementById=id=>{const el=get(id);el.replaceChildren=()=>{el.children=[];el.innerHTML='';};el.insertAdjacentHTML=(_where,html)=>{el.innerHTML+=html;};return el;};
  sandbox.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};sandbox.clearTimeout=()=>{};
  sandbox.TraineeApprovalCards={createController(options){sandbox.approvalOptions=options;return {async mount(node,id,scope){mounts.push({node,id,scope});}};}};
  const html=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');
  const blocks=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  const ctx=vm.createContext(sandbox);
  for(const block of blocks.filter(b=>/const UPMORE_DATA\s*=|globalThis\.Upmore(?:LedgerReview|BillWorkflow|ChatRequests)\s*=|function guideAnswer\s*\(/.test(b)))vm.runInContext(block,ctx);
  vm.runInContext(`session={user:{id:'${OWNER}'},access_token:'test-token'};upmoreThread='${THREAD}';chat=threadEl(chatMode);`,ctx);
  return {ctx,byId,timers,mounts,call:expr=>vm.runInContext(expr,ctx)};
}
test('Messages history keeps the server card reference and binds it to the current owned thread',async()=>{
  const f=fixture(),selections=[];
  f.ctx.selectRows=(table,columns)=>{selections.push({table,columns});return table==='agent_threads'?{id:THREAD,user_id:OWNER}:[{id:17,thread_id:THREAD,role:'assistant',content:'Review these exact answers.',meta:{intent:'career_message_approval',career_approval_card_id:CARD}}];};
  f.call(`upmoreThreads=[{id:'${THREAD}',user_id:'${OWNER}'}];supa.from=table=>({select:columns=>({eq(){return this;},order(){return this;},single:async()=>({data:selectRows(table,columns),error:null}),limit:async()=>({data:selectRows(table,columns),error:null})})});`);
  await f.call(`openGuideChat('${THREAD}')`);
  assert.match(selections.find(x=>x.table==='agent_messages').columns,/\bmeta\b/);
  assert.equal(f.mounts.length,1);assert.equal(f.mounts[0].id,CARD);assert.equal(f.mounts[0].scope.current(),true);
  f.call('newGuideChat()');assert.equal(f.mounts[0].scope.current(),false);
});
test('actual delayed assistant render mounts the exact approval reference; plain yes and user messages never do',async()=>{
  const f=fixture();
  f.call(`addAI(['Review your application'],null,null,chatRequests.capture(),null,{intent:'career_message_approval',career_approval_card_id:'${CARD}'})`);
  for(const timer of f.timers.filter(t=>t.ms===700))timer.fn();await Promise.resolve();
  assert.equal(f.mounts.length,1);assert.equal(f.mounts[0].id,CARD);
  f.call(`histBubble(chat,'user','yes',{intent:'career_message_approval',career_approval_card_id:'${CARD}'});histBubble(chat,'assistant','yes',{});`);
  assert.equal(f.mounts.length,1);
});
test('actual adapter uses authenticated own RPCs with only the card id and reviewed hash',async()=>{
  const f=fixture(),calls=[];assert.ok(f.ctx.approvalOptions,'actual app must construct the controller');
  f.ctx.rpcCall=(name,args)=>{calls.push({name,args});return {data:{marker:'synthetic'},error:null};};
  f.call(`supa.rpc=async(name,args)=>rpcCall(name,args);supa.auth.getUser=async()=>({data:{user:{id:'${OWNER}'}},error:null});`);
  assert.equal(await f.ctx.approvalOptions.authenticate(),OWNER);
  await f.ctx.approvalOptions.readCard(CARD);
  await f.ctx.approvalOptions.approve({card_id:CARD,card_hash:'a'.repeat(64)});
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[
    {name:'career_apply_message_card_read_own',args:{p_card:CARD}},
    {name:'career_apply_message_card_approve_own',args:{p_card:CARD,p_hash:'a'.repeat(64)}}
  ]);
  f.call(`supa.auth.getUser=async()=>({data:{user:null},error:{message:'expired'}});`);
  await assert.rejects(f.ctx.approvalOptions.authenticate());
});
test('TEST profile configuration defaults closed and malformed identifiers cannot enter a build',()=>{
  const template=fs.readFileSync(path.resolve(__dirname,'../src/upmore-app-template.html'),'utf8'),builder=fs.readFileSync(path.resolve(__dirname,'../src/build-app.py'),'utf8');
  assert.ok(/CAREER_APPROVAL_CARD/.test(template),'render injection required');assert.ok(/CAREER_APPROVAL_TEST_USER_ID/.test(template),'TEST scope required');
  assert.ok(/UPMORE_APPROVAL_CARD_TEST_USER_ID/.test(builder),'TEST config required');assert.ok(/uuid\.UUID/.test(builder),'UUID validation required');
  assert.ok(/CAREER_APPROVAL_CARD.*career-approval-card\.js/.test(builder),'builder must inject actual card module');
});
