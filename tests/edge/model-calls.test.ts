import {reserveModelCall,recordModelUsage} from "../../supabase/functions/_shared/model_calls.ts";
import {plannerModel} from "../../supabase/functions/_shared/model_gateway.ts";
// The planner through the model gateway, Anthropic provider (the OpenAI path is in model-gateway.test.ts).
const anthropicPlannerModel=(a:any,u:string,t:string,model:string,apiKey:string,request:any)=>plannerModel(a,u,t,{provider:"anthropic",model,apiKey,reasoningEffort:null},{request});
import {rejects,user} from "./lib/model_fixture.ts";
function assert(v:unknown,m="assertion failed"){if(!v)throw new Error(m);}
function admin(data:any={ok:true,call_id:"slot"},error:any=null){const calls:any[]=[];return {calls,async rpc(name:string,args:any){calls.push({name,args});return {data,error};}};}
Deno.test("model budget failure and an existing slot prohibit a new provider call",async()=>{
 for(const data of [{ok:false,state:"monthly_limit"},{ok:false,state:"already_reserved",call_id:"old"}]){const a=admin(data);let sent=0;const m=anthropicPlannerModel(a,user,"thread","model","test-key",async()=>{sent++;return new Response();});await rejects(()=>m.complete({},0),data.state==="monthly_limit"?"monthly AI limit":"already reserved");assert(sent===0);}
 const a=admin(null,{message:"missing migration"});await rejects(()=>reserveModelCall(a,user,"thread","request",0,"model"),"could not be verified");
});
Deno.test("a reservation marker precedes HTTP and exact usage is saved against the same slot",async()=>{
 const a=admin();let sent=0;const request:typeof fetch=async(url,options)=>{assert(a.calls.length===1&&a.calls[0].name==="agent_model_call_reserve");assert(url==="https://api.anthropic.com/v1/messages");assert(options?.signal instanceof AbortSignal);const body=JSON.parse(String(options?.body));assert(body.model==="actual-model"&&body.max_tokens===1200&&body.tools.length===1);sent++;return Response.json({stop_reason:"tool_use",content:[],usage:{input_tokens:12,output_tokens:4,cache_read_input_tokens:7,cache_creation_input_tokens:2}});};
 const m=anthropicPlannerModel(a,user,"thread","actual-model","test-key",request);await m.complete({tools:[{name:"safe"}],model:"overridden",max_tokens:90000},0);assert(sent===1&&a.calls.length===2&&a.calls[1].name==="agent_model_call_record");assert(a.calls[1].args.p_call==="slot"&&a.calls[1].args.p_usage.input_tokens===12&&a.calls[1].args.p_usage.cache_write_tokens===2);
});
Deno.test("each tool-planning round reserves its own step under one request identity",async()=>{
 const a=admin();const m=anthropicPlannerModel(a,user,"thread","model","test-key",async()=>Response.json({content:[],usage:{input_tokens:1,output_tokens:0}}));await m.complete({},0);await m.complete({},1);const slots=a.calls.filter(c=>c.name==="agent_model_call_reserve");assert(slots.length===2&&slots[0].args.p_request===slots[1].args.p_request&&slots[1].args.p_step===1);assert(slots.every(c=>c.args.p_user===user&&c.args.p_thread==="thread"));
});
Deno.test("missing configuration reserves no quota and sends no model request",async()=>{const a=admin();let sent=0;const m=anthropicPlannerModel(a,user,"thread","model","",async()=>{sent++;return new Response();});await rejects(()=>m.complete({},0),"not configured");assert(a.calls.length===0&&sent===0);});
Deno.test("unknown, negative, fractional and null token usage cannot be logged as zero",async()=>{
 for(const usage of [undefined,{input_tokens:1},{input_tokens:-1,output_tokens:0},{input_tokens:1.5,output_tokens:0},{input_tokens:0,output_tokens:0,cache_read_input_tokens:null},{input_tokens:10000001,output_tokens:0}]){const a=admin();await rejects(()=>recordModelUsage(a,"slot",usage),"unknown or invalid");assert(a.calls.length===0);}
 const a=admin();await recordModelUsage(a,"slot",{input_tokens:0,output_tokens:0});assert(a.calls[0].args.p_usage.cache_read_tokens===0);
});
Deno.test("provider failure and missing usage leave a reservation without a fabricated receipt",async()=>{
 for(const reply of [new Response("rejected",{status:429}),Response.json({content:[]})]){const a=admin();const m=anthropicPlannerModel(a,user,"thread","model","test-key",async()=>reply);await rejects(()=>m.complete({},0),reply.status===429?"model unavailable":"usage is unknown");assert(a.calls.length===1&&a.calls[0].name==="agent_model_call_reserve");}
});
Deno.test("receipt persistence failure prevents an unjournaled model answer",async()=>{
 const calls:string[]=[];const a={async rpc(name:string){calls.push(name);return name==="agent_model_call_reserve"?{data:{ok:true,call_id:"slot"}}:{error:{message:"storage failure"}};}};const m=anthropicPlannerModel(a,user,"thread","model","test-key",async()=>Response.json({content:[],usage:{input_tokens:1,output_tokens:1}}));await rejects(()=>m.complete({},0),"receipt could not be saved");assert(calls.join(",")==="agent_model_call_reserve,agent_model_call_record");
});
