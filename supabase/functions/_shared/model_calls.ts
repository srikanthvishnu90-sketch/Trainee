export class ModelBudgetError extends Error {
  constructor(message:string,readonly code:"quota_unavailable"|"monthly_limit"|"already_reserved"="quota_unavailable"){super(message);}
}
// The provider refused or failed the call. Keeps the provider's own error type and message (never the key, never a
// header) so the cause is visible in the reply's meta and the logs; "model unavailable" stays in the message.
export class ModelUnavailableError extends Error {
  readonly detail:string;
  constructor(readonly status:number,readonly type:string|null,detail:string){
    const d=String(detail||"").replace(/sk-[A-Za-z0-9_*.-]{3,}/g,"[key]").replace(/Bearer\s+\S+/gi,"Bearer [key]").replace(/\s+/g," ").trim().slice(0,240);
    super(`Financial model unavailable (HTTP ${status}${type?" "+type:""}${d?": "+d:""}).`);this.detail=d;
  }
  summary():string{return `HTTP ${this.status}${this.type?" "+this.type:""}${this.detail?": "+this.detail:""}`;}
}
// The global daily budget said no (limit reached, switched off, or not checkable): no request was made. A model failure
// to every caller that already handles one; type says which, so the reply can say it in plain words (model_budget.ts).
export class ModelBudgetBlockedError extends ModelUnavailableError {
  constructor(readonly block:"limit"|"paused"|"unavailable"|"before"|"after",detail:string){
    super(block==="limit"?429:503,{limit:"global_daily_limit",paused:"budget_paused",unavailable:"budget_unavailable",before:"budget_not_open",after:"budget_ended"}[block],detail);
  }
}
export async function providerError(res:Response):Promise<ModelUnavailableError> {
  const text=await res.text().catch(()=>"");let type:string|null=null,message="";
  try{const j=JSON.parse(text);type=typeof j?.error?.type==="string"&&j.error.type?j.error.type:typeof j?.error?.code==="string"?j.error.code:null;message=typeof j?.error?.message==="string"?j.error.message:"";}catch(_){message="";}
  return new ModelUnavailableError(res.status,type,message);
}
export async function reserveModelCall(admin:any,userId:string,threadId:string,requestId:string,step:number,model:string):Promise<string> {
  const result=await admin.rpc("agent_model_call_reserve",{p_user:userId,p_thread:threadId,p_request:requestId,p_step:step,p_model:model});
  if(result.error)throw new ModelBudgetError("Model budget could not be verified.");
  if(!result.data?.ok || !result.data.call_id) {
    if(result.data?.state==="monthly_limit")throw new ModelBudgetError("The monthly AI limit has been reached.","monthly_limit");
    if(result.data?.state==="already_reserved")throw new ModelBudgetError("This model call was already reserved; its result needs review.","already_reserved");
    throw new ModelBudgetError("Model budget could not be verified.");
  }
  return result.data.call_id;
}
export async function recordModelUsage(admin:any,callId:string,usage:any):Promise<void> {
  const values={input_tokens:usage?.input_tokens,output_tokens:usage?.output_tokens,
    cache_read_tokens:usage?.cache_read_input_tokens===undefined?0:usage.cache_read_input_tokens,
    cache_write_tokens:usage?.cache_creation_input_tokens===undefined?0:usage.cache_creation_input_tokens};
  if(Object.values(values).some(v=>!Number.isSafeInteger(v)||v<0||v>10000000))throw new Error("Model token usage is unknown or invalid.");
  const result=await admin.rpc("agent_model_call_record",{p_call:callId,p_usage:values});
  if(result.error)throw new Error("Model usage receipt could not be saved.");
}
