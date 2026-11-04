// Live finding 2026-10-11 19:01 UTC (go-live on 4e1cf5c): every Anthropic call answered HTTP 400 and the code kept only
// the status, so the cause was invisible, and a balance question was answered "I couldn't complete the requested
// financial plan ... no payment was approved". These tests hold the fix: the provider's own error type and message are
// kept (never the key), the planner says plainly that the AI service isn't responding, and the router's problem names
// the cause.
import {ModelUnavailableError} from "../../supabase/functions/_shared/model_calls.ts";
import {plannerModel} from "../../supabase/functions/_shared/model_gateway.ts";
const anthropicPlannerModel=(a:any,u:string,t:string,model:string,apiKey:string,request:any)=>plannerModel(a,u,t,{provider:"anthropic",model,apiKey,reasoningEffort:null},{request});
import {runFinancialPlanner} from "../../supabase/functions/_shared/financial_planner.ts";
import {routeExtractor} from "../../supabase/functions/_shared/flow_router.ts";
const anthropicRouteExtractor=(a:any,u:string,t:string,model:string,apiKey:string,request:any)=>routeExtractor(a,u,t,{provider:"anthropic",model,apiKey,reasoningEffort:null},{request});
import {fixture,rejects,user} from "./lib/financial_fixture.ts";
function assert(v:unknown,m="assertion failed"){if(!v)throw new Error(m);}
const admin=()=>({calls:[] as any[],async rpc(name:string,args:any){this.calls.push({name,args});return {data:{ok:true,call_id:"slot"},error:null};}});
const credit=()=>Response.json({type:"error",error:{type:"invalid_request_error",message:"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}},{status:400});
const KEY="sk-ant-test-key-should-never-appear";

Deno.test("the planner model keeps the provider's error type and message, never the key",async()=>{
 const m=anthropicPlannerModel(admin(),user,"thread","claude-model",KEY,async()=>credit());
 let err:any=null;try{await m.complete({},0);}catch(e){err=e;}
 assert(err instanceof ModelUnavailableError,String(err));assert(err.status===400&&err.type==="invalid_request_error",JSON.stringify(err));
 assert(String(err.message).includes("model unavailable"),err.message);assert(/credit balance is too low/.test(err.detail),err.detail);
 assert(!String(err.message+err.detail).includes(KEY),"no key in the error");
 const garbage=anthropicPlannerModel(admin(),user,"thread","claude-model",KEY,async()=>new Response("<html>bad gateway</html>",{status:502}));
 await rejects(()=>garbage.complete({},0),"HTTP 502");
});

Deno.test("when the AI service refuses, the planner says so plainly, records the cause, and never talks about payments",async()=>{
 const f=fixture();const err=new ModelUnavailableError(400,"invalid_request_error","Your credit balance is too low to access the Anthropic API.");
 const r=await runFinancialPlanner(f.session,{async complete(){throw err;}},"what's my balance");
 assert(r.failure_code==="model_unavailable",JSON.stringify(r));
 assert(r.reply==="I can't answer that right now: the AI service Upmore uses isn't responding, so I didn't look anything up and nothing was changed. Try again in a few minutes.",r.reply);
 assert(!/payment|bill|plan/i.test(r.reply),"a balance question is never answered with payment words");
 assert(r.model_error==="HTTP 400 invalid_request_error: Your credit balance is too low to access the Anthropic API.",r.model_error);
});

Deno.test("the router's failure names the provider's cause",async()=>{
 const x=anthropicRouteExtractor(admin(),user,"thread","claude-model",KEY,async()=>credit());
 await rejects(()=>x("cancel netflix"),"router model HTTP 400 invalid_request_error: Your credit balance is too low");
});
