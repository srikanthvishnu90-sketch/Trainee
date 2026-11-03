// Live finding 2026-10-11 19:01 UTC (go-live on 4e1cf5c): every Anthropic call answered HTTP 400 and the code kept only
// the status, so the cause was invisible. This test holds the fix: the provider's own error type and message are kept
// (never the key). The finance planner and router checks that lived beside it were removed with that code (2026-10-28).
import {ModelUnavailableError} from "../../supabase/functions/_shared/model_calls.ts";
import {plannerModel} from "../../supabase/functions/_shared/model_gateway.ts";
const anthropicPlannerModel=(a:any,u:string,t:string,model:string,apiKey:string,request:any)=>plannerModel(a,u,t,{provider:"anthropic",model,apiKey,reasoningEffort:null},{request});
import {rejects,user} from "./lib/model_fixture.ts";
function assert(v:unknown,m="assertion failed"){if(!v)throw new Error(m);}
const admin=()=>({calls:[] as any[],async rpc(name:string,args:any){this.calls.push({name,args});return {data:{ok:true,call_id:"slot"},error:null};}});
const credit=()=>Response.json({type:"error",error:{type:"invalid_request_error",message:"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}},{status:400});
const KEY="sk-ant-test-key-should-never-appear";

Deno.test("the planner model keeps the provider's error type and message, never the key",async()=>{
 const m=anthropicPlannerModel(admin(),user,"thread","model",KEY,async()=>credit());
 let err:any=null;try{await m.complete({},0);}catch(e){err=e;}
 assert(err instanceof ModelUnavailableError,String(err));assert(err.status===400&&err.type==="invalid_request_error",JSON.stringify(err));
 assert(String(err.message).includes("model unavailable"),err.message);assert(/credit balance is too low/.test(err.detail),err.detail);
 assert(!String(err.message+err.detail).includes(KEY),"no key in the error");
 const garbage=anthropicPlannerModel(admin(),user,"thread","model",KEY,async()=>new Response("<html>bad gateway</html>",{status:502}));
 await rejects(()=>garbage.complete({},0),"HTTP 502");
});
