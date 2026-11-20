'use strict';
// Actual staged ESM graph. Only auth/rate-limit identities and service
// transport are injected. Persistence can be backed by real local Postgres.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const {stripTypeScriptTypes}=require('node:module');
module.exports=async function stagedEntry(root,client){
  if(!vm.SourceTextModule)throw Error('Run with --experimental-vm-modules');
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'career-real-pg-entry-'));
  execFileSync(process.execPath,[path.join(root,'scripts/career/stage-career.cjs'),stage,'--json']);
  let handle,networkCalls=0;
  const context=vm.createContext({Request,Response,Headers,URL,TextEncoder,TextDecoder,AbortController,crypto:require('node:crypto').webcrypto,setTimeout,clearTimeout,
    console:{log(){},error(){},warn(){}},fetch(){networkCalls++;throw Error('external network forbidden');},
    Deno:{env:{get:name=>({SUPABASE_URL:'https://supabase.example.test',SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'})[name]}}});
  const modules=new Map();
  function load(id){if(modules.has(id))return modules.get(id);let m;
    if(id==='https://deno.land/std@0.208.0/http/server.ts')m=new vm.SyntheticModule(['serve'],function(){this.setExport('serve',fn=>{handle=fn;});},{context,identifier:id});
    else if(id==='https://esm.sh/@supabase/supabase-js@2.117.1')m=new vm.SyntheticModule(['createClient'],function(){this.setExport('createClient',()=>client);},{context,identifier:id});
    else{if(!id.startsWith(stage+path.sep))throw Error('import escaped staged graph');let code=fs.readFileSync(id,'utf8');if(id.endsWith('.ts'))code=stripTypeScriptTypes(code,{mode:'transform'});m=new vm.SourceTextModule(code,{context,identifier:id});}modules.set(id,m);return m;
  }
  try{const entry=load(path.join(stage,'agent-chat/index.ts'));await entry.link((s,r)=>load(s.startsWith('https:')?s:path.resolve(path.dirname(r.identifier),s)));await entry.evaluate();}
  catch(e){fs.rmSync(stage,{recursive:true,force:true});throw e;}
  return {async request(thread,message,key){const res=await handle(new Request('https://upmore.example.test/chat',{method:'POST',headers:{Authorization:'Bearer synthetic-user','Content-Type':'application/json'},body:JSON.stringify({thread_id:thread,message,turn_key:key})}));if(networkCalls)throw Error('external network was attempted');return {status:res.status,body:await res.json()};},close(){fs.rmSync(stage,{recursive:true,force:true});}};
};
