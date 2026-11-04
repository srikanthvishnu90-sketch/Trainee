import { supabaseApplyStore, hashApplyPayload, APPLY_TIMEOUT_MS } from '../../supabase/functions/_shared/career_apply_store.ts';
const eq=(a:unknown,b:unknown)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);};
const assert=(v:unknown)=>{if(!v)throw Error('assertion failed');};
const now=Date.UTC(2026,9,20),payload={version:1,user_id:'owner',job_id:'posting',company:'Test Employer',url:'https://jobs.lever.co/test/posting',fields:[],privacy_epoch:1,account_version:1,expires_at:new Date(now+60000).toISOString()};
function fake(log:unknown[]=[],answer:(name:string,args:any)=>any=()=>[]){
 const calls:any[]=[];return {calls,admin:{rpc:async(name:string,args:any)=>{calls.push({name,args});return {data:answer(name,args),error:null};},from:(table:string)=>({select:()=>({eq:async(key:string,value:string)=>{calls.push({table,key,value});return {data:log,error:null};}})})}};
}
async function refuses(fn:()=>Promise<unknown>,text:string){let got='';try{await fn();}catch(e){got=String(e);}assert(got.includes(text));}
Deno.test('009b-1 approval and admission precede every insert; owner log is authoritative',async()=>{
 const f=fake(),s=supabaseApplyStore(f.admin);await refuses(()=>s.enqueue(payload,'0'.repeat(64),{now}),'not_approved');eq(f.calls,[]);
 const hash=await hashApplyPayload(payload);await s.enqueue(payload,hash,{now});eq(f.calls.map(c=>c.name||c.table),['career_apply_jobs','career_apply_enqueue']);eq(f.calls[0].value,'owner');
 eq(f.calls[1].args.p_hash,hash);eq(f.calls[1].args.p_approval,hash);eq(f.calls[1].args.p_daily,null);/* no pace set: no number at all (D-MS-2); the SQL reads no ceiling from p_daily since 20261025140000 and takes any value or none since 20261027140000 */
});
Deno.test('009b-1 permanent job uniqueness and uncertain/driving jobs count toward admission',async()=>{
 const hash=await hashApplyPayload(payload);
 for(const state of ['failed','not_submitted','unknown_outcome','driving']){
  const f=fake([{job_id:'posting',company:'Other',created_at:new Date(now).toISOString(),state}]);await refuses(()=>supabaseApplyStore(f.admin).enqueue(payload,hash,{now}),'duplicate_job');eq(f.calls.length,1);
 }
 // D-MS-3: the same posting under another id (its canonical link) is a duplicate; another role at the employer is not.
 const f=fake([{job_id:'other',company:'Test Employer LLC',url:'https://www.jobs.lever.co/test/posting/apply',created_at:new Date(now).toISOString(),state:'unknown_outcome'}]);await refuses(()=>supabaseApplyStore(f.admin).enqueue(payload,hash,{now}),'duplicate_job');eq(f.calls.length,1);
 const g=fake([{job_id:'other',company:'Test Employer LLC',url:'https://jobs.lever.co/test/another-role',created_at:new Date(now).toISOString(),state:'confirmed'}]);await supabaseApplyStore(g.admin).enqueue(payload,hash,{now});eq(g.calls.map(c=>c.name||c.table),['career_apply_jobs','career_apply_enqueue']);
});
Deno.test('009b-1 the legacy p_daily carries only the person\'s own pace (D-MS-2), the claim takes 50 at once, and a claim sweeps dead drives first',async()=>{
 const f=fake([],name=>name==='career_apply_claim'?[{id:'j',lease_token:'lease',state:'driving'}]:3),s=supabaseApplyStore(f.admin);
 await s.enqueue(payload,await hashApplyPayload(payload),{now,daily:500});eq(f.calls[1].args.p_daily,500);f.calls.length=0;
 eq((await s.claim(now,50)).length,1);eq(f.calls[1].args.p_limit,50);f.calls.length=0;await refuses(()=>s.claim(now,-1),'INVALID_APPLY_CLAIM');await refuses(()=>s.claim(now,1.5),'INVALID_APPLY_CLAIM');eq(f.calls.length,0);
 f.calls.length=0;eq((await s.claim(now,6)).length,1);eq(f.calls.map(c=>c.name),['career_apply_sweep','career_apply_claim']);eq(f.calls[0].args,{p_now:new Date(now).toISOString()});assert(APPLY_TIMEOUT_MS===900000);
});
Deno.test('009b-1 finish is lease-bound and transport uncertainty is never retried',async()=>{
 let n=0;const s=supabaseApplyStore({rpc:async()=>{n++;throw Error('response lost');}});await refuses(()=>s.finish({id:'j',lease_token:'lease'},'unknown_outcome',{reason:'lost'}),'response lost');eq(n,1);
 const f=fake();await supabaseApplyStore(f.admin).finish({id:'j',lease_token:'lease'},'not_submitted',{reason:'form remains'});eq(f.calls[0].args,{p_id:'j',p_lease:'lease',p_state:'not_submitted',p_evidence:{reason:'form remains'}});
});
Deno.test('009b-1 payload hashing is stable across key order and rejects non-JSON numbers',async()=>{
 eq(await hashApplyPayload({b:1,a:{'10':'x','2':'y'}}),await hashApplyPayload({a:{'2':'y','10':'x'},b:1}));await refuses(()=>hashApplyPayload({salary:NaN}),'INVALID_APPLY_PAYLOAD');
});
Deno.test('SERIAL-1450 an unset pace enqueues (never read as unreadable); a stored pace is passed as stored; an unreadable one refuses by name',async()=>{
 const hash=await hashApplyPayload(payload);
 for(const daily of [undefined,null] as any[]){const f=fake();await supabaseApplyStore(f.admin).enqueue(payload,hash,{now,daily});eq(f.calls[1].args.p_daily,null);}
 const seven=fake();await supabaseApplyStore(seven.admin).enqueue(payload,hash,{now,daily:7});eq(seven.calls[1].args.p_daily,7);
 const big=fake();await supabaseApplyStore(big.admin).enqueue(payload,hash,{now,daily:1000000});eq(big.calls[1].args.p_daily,1000000);
 const bad=fake();await refuses(()=>supabaseApplyStore(bad.admin).enqueue(payload,hash,{now,daily:'lots' as any}),'pace_unreadable');eq(bad.calls.length,0);
});
