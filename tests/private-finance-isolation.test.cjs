// Executes the actual built app with synthetic records and no provider network.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {buildContext}=require('./helpers/app-stubs');
const ownerA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',ownerB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(){
  const {sandbox,store,byId}=buildContext();let onAuth;
  const original=sandbox.window.supabase.createClient;sandbox.window.supabase.createClient=(...args)=>{const client=original(...args);client.auth.getSession=()=>new Promise(()=>{});client.auth.onAuthStateChange=fn=>{onAuth=fn;return {};};return client;};
  const get=sandbox.document.getElementById;sandbox.document.getElementById=id=>{const el=get(id);el.replaceChildren=()=>{el.children=[];el.innerHTML='';};return el;};sandbox.setTimeout=()=>0;sandbox.clearTimeout=()=>{};
  const ctx=vm.createContext(sandbox),blocks=[...fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  for(const block of blocks.filter(block=>/const UPMORE_DATA\s*=|globalThis\.Upmore(?:LedgerReview|BillWorkflow|ChatRequests)\s*=|function guideAnswer\s*\(/.test(block)))vm.runInContext(block,ctx);
  const call=code=>vm.runInContext(code,ctx);
  function auth(owner){onAuth(owner?'SIGNED_IN':'SIGNED_OUT',owner?{user:{id:owner,email:'synthetic@example.invalid'},access_token:'synthetic-token'}:null);}
  return {ctx,store,byId,call,auth};
}
test('actual Auth owner switch clears bank, task, profile and UI memory while retaining scoped inputs for their owner',()=>{
  const f=fixture();f.auth(ownerA);
  f.call('goalsSet([{id:"synthetic",name:"private goal",target:100,current:1}]);saveManualHolding({symbol:"SYNTHETIC",quantity:1,price:10});trackData={isLive:true,owner_id:"'+ownerA+'",accounts:[{id:"owned-a",balance:100}],transactions:[]};tasksCache=[{user_id:"'+ownerA+'"}];tasksCacheOwner="'+ownerA+'";dbProfile={id:"'+ownerA+'"};prog.synthetic=["done"];');
  f.byId('subList').innerHTML='private subscription';f.auth(ownerB);
  assert.equal(f.call('goalsGet().length'),0);assert.equal(f.call('getManualHoldings().length'),0);assert.equal(f.call('loadTrackData().isLive===true'),false);assert.equal(f.call('tasksCache'),null);assert.equal(f.call('dbProfile'),null);assert.equal(f.call('Object.keys(prog).length'),0);assert.equal(f.byId('subList').innerHTML,'');
  f.auth(ownerA);assert.equal(f.call('goalsGet().length'),1);assert.equal(f.call('getManualHoldings().length'),1);
});
test('sign-out does not display signed-in private records or a prior anonymous workspace',()=>{
  const f=fixture();f.call('goalsSet([{name:"guest private"}])');f.auth(ownerA);f.call('goalsSet([{name:"signed-in private"}])');f.auth(null);
  assert.equal(f.call('goalsGet().length'),0);assert.ok(Object.keys(f.store).some(key=>key.includes('guest:')));assert.ok(Object.keys(f.store).some(key=>key.includes('user:'+ownerA)));
});
test('unowned legacy private records remain preserved but cannot become the current financial picture',()=>{
  const f=fixture();f.store.upmore_goals_v1=JSON.stringify([{name:'legacy private'}]);f.store.upmore_holdings_manual_v1=JSON.stringify([{symbol:'LEGACY',value:99}]);f.store.cfo_debts=JSON.stringify([{balance:999}]);f.store['upmore-feed']=JSON.stringify({data:{public:true}});
  f.auth(ownerA);assert.equal(f.call('goalsGet().length'),0);assert.equal(f.call('getManualHoldings().length'),0);assert.equal(f.call('cfoGet("debts",[]).length'),0);
  assert.match(f.store.upmore_goals_v1,/legacy private/);assert.match(f.store.upmore_holdings_manual_v1,/LEGACY/);assert.match(f.store.cfo_debts,/999/);assert.match(f.call('financeStorage.getItem("upmore-feed")'),/public/);
});
test('a delayed bank response cannot populate another owner or repopulate a disconnected bank',async()=>{
  for(const switchOwner of [true,false]){
    const f=fixture(),proxy=defer();f.auth(ownerA);f.ctx.proxyResult=proxy.promise;f.call('supa.auth.getSession=async()=>({data:{session:{user:{id:"'+ownerA+'"}}}});supa.functions={invoke:()=>proxyResult};');
    const sync=f.call('initLiveTrackData()');await new Promise(r=>setImmediate(r));if(switchOwner)f.auth(ownerB);else f.call('clearLocalBankData()');
    proxy.resolve({data:{accounts:[{id:'owned-a',balance:100}],transactions:[]}});await sync;assert.equal(f.call('loadTrackData().isLive===true'),false);assert.equal(f.call('prevLiveBatch'),null);
  }
});
test('late profile, subscription and task reads cannot refill a switched owner cache or DOM',async()=>{
  const f=fixture(),read=defer();f.auth(ownerA);f.ctx.readResult=read.promise;
  f.call('supa.from=()=>({select:()=>({eq(){return this;},order:()=>readResult,maybeSingle:()=>readResult})});');
  const profile=f.call('loadProfile()'),subs=f.call('renderSubs()'),tasks=f.call('getTasks()');await new Promise(r=>setImmediate(r));f.auth(ownerB);
  read.resolve({data:{id:ownerA},error:null});await profile;await subs;await tasks;
  assert.equal(f.call('dbProfile'),null);assert.equal(f.call('tasksCache'),null);assert.equal(f.byId('subList').innerHTML,'');
});
test('export is captured to one owner and aborts before download after an identity change',async()=>{
  const f=fixture(),read=defer();f.auth(ownerA);f.ctx.readResult=read.promise;f.call('supa.from=()=>({select:()=>({eq(){return this;},maybeSingle:()=>readResult})});');
  const exporting=f.call('exportUserData()');f.auth(ownerB);read.resolve({data:{id:ownerA},error:null});await exporting;
  assert.equal(f.ctx.document.body.children.length,0);
});
test('Auth changes clear every retained finance surface, not only the bank transaction list',()=>{
  const f=fixture();f.auth(ownerA);const surfaces=['homeMoneyList','ledgerList','ledgerTotals','householdList','claimBody','tasksGroups','tasksSummary','budgetReportBody','referralBody','subscriptionBody','auditList','queue'];
  for(const id of surfaces)f.byId(id).innerHTML='synthetic owner A private';f.auth(ownerB);for(const id of surfaces)assert.equal(f.byId(id).innerHTML,'',id);
});
test('same-owner auth generation changes fence a pending bank refresh',async()=>{
  const f=fixture(),read=defer();f.auth(ownerA);f.ctx.readResult=read.promise;
  f.call('supa.auth.getSession=async()=>({data:{session:{user:{id:"'+ownerA+'"}}}});supa.functions={invoke:()=>readResult};');
  const sync=f.call('initLiveTrackData()');await new Promise(r=>setImmediate(r));f.auth(ownerA);read.resolve({data:{accounts:[{id:'synthetic',balance:100}],transactions:[]}});await sync;
  assert.equal(f.call('loadTrackData().isLive===true'),false);
});
test('late Plaid refresh cannot store positions or status under a new owner',async()=>{
  const f=fixture(),read=defer();f.auth(ownerA);f.ctx.readResult=read.promise;f.call('supa.functions={invoke:()=>readResult}');
  const refresh=f.call('refreshPlaidHoldings()');f.auth(ownerB);read.resolve({data:{holdings:[{symbol:'SYNTHETIC',quantity:1}],refreshed:true},error:null});await refresh;
  assert.equal(f.call('plaidStatusCache'),null);assert.equal(Object.keys(f.store).filter(key=>key.includes('user:'+ownerB)&&key.includes('plaid')).length,0);
});
test('disconnect invalidates UI immediately and cannot delete the next owner vault after a delayed first step',async()=>{
  const f=fixture(),read=defer();f.auth(ownerA);let vaultCalls=0;f.ctx.readResult=read.promise;f.ctx.vault=()=>{vaultCalls++;return Promise.resolve({error:null});};
  f.call('supa.from=()=>({delete:()=>({eq:()=>readResult})});supa.rpc=vault;trackData={isLive:true,owner_id:"'+ownerA+'",accounts:[],transactions:[]};');
  f.byId('homeMoneyList').innerHTML='synthetic private balance';const disconnect=f.call('disconnectBank()');assert.equal(f.byId('homeMoneyList').innerHTML,'');assert.equal(f.call('trackData'),null);
  f.auth(ownerB);read.resolve({error:null});await disconnect;assert.equal(vaultCalls,0);assert.equal(f.byId('discBankConfirm').disabled,false);
});
test('OAuth onboarding answers and referral state cannot cross owner namespaces',()=>{
 const f=fixture();f.store['upmore-onboarding-oldnonce']=JSON.stringify({name:'legacy private',cash:'900'});
 f.auth(ownerA);assert.equal(f.call('financeStorage.getItem("upmore-onboarding-oldnonce")'),null);
 f.call('financeStorage.setItem("upmore-onboarding-newnonce",JSON.stringify({cash:"42"}));financeStorage.setItem("upmore-ref","PRIVATE-REF");');
 f.auth(ownerB);assert.equal(f.call('financeStorage.getItem("upmore-onboarding-newnonce")'),null);assert.equal(f.call('financeStorage.getItem("upmore-ref")'),null);
 assert.match(f.store['upmore-onboarding-oldnonce'],/legacy private/);
 f.auth(ownerA);assert.match(f.call('financeStorage.getItem("upmore-onboarding-newnonce")'),/42/);
});
test('same-owner Auth refresh and bank disconnect discard delayed recovery evidence in the actual app',async()=>{
 for(const disconnect of [false,true]){
  const f=fixture(),pending=defer();f.auth(ownerA);f.ctx.recoveryPending=pending.promise;f.ctx.AbortController=AbortController;
  f.call('fetch=async()=>await recoveryPending;');const reading=f.call('recoveryController.scan()');
  if(disconnect)f.call('clearLocalBankData()');else f.auth(ownerA);
  const hash='a'.repeat(64);pending.resolve({ok:true,json:async()=>({ok:true,report:{owner_id:ownerA,currency:'USD',today:'2026-10-10',coverage_complete:false,verified_recovered_cents:0,recovery_verification:'unavailable_without_trusted_refund_linkage',candidates:[],total_candidates:0,next_offset:null,excluded:{unsupported_currency:0,unavailable:0,unknown_hold_date:0},reference_hash:hash,source:{type:'retained_bank_records',reference_hash:hash,observations_are_not_complete_history:true,accounts:[]},as_of:'2026-10-10T10:00:00Z'}})});
  assert.equal(await reading,null,disconnect?'disconnect':'same-owner Auth generation');
 }
});
