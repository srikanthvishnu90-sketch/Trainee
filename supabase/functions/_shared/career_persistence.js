// Host-only persistence adapter. The RPCs preserve Muse's snapshot shape;
// callers cannot turn client-supplied owner/state into storage authority.
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function validTask(value,userId){return record(value)&&value.userId===userId&&typeof value.status==='string'&&((value.version==='career_task_intent/v1'&&value.kind==='pending_task_intent'&&/^[a-f0-9]{64}$/.test(value.intent_id||'')&&(value.id===null||/^[a-f0-9]{32}$/.test(value.id)))||(value.version==='career_task/v1'&&/^[a-f0-9]{32}$/.test(value.id||'')));}
function validBatchField(value,userId){return record(value)&&value.userId===userId&&typeof value.status==='string'&&/^batch-[A-Za-z0-9-]{4,96}$/.test(value.id||'')&&((value.version==='career_batch_intent/v1'&&value.kind==='pending_batch_intent'&&/^[a-f0-9]{64}$/.test(value.intent_id||''))||(value.version==='career_batch_run/v1'&&value.kind==='batch_run'));}
function validBatchRun(value,userId){return record(value)&&value.version==='career_batch_run/v1'&&value.userId===userId&&/^batch-[A-Za-z0-9-]{4,96}$/.test(value.runId||'')&&typeof value.status==='string'&&record(value.run)&&value.run.id===value.runId;}
function validResponse(value,threadId,turnKey,userId){return record(value)&&value.thread_id===threadId&&value.turn_key===turnKey&&typeof value.reply==='string'&&Array.isArray(value.reminders)&&(!('task' in value)||validTask(value.task,userId))&&(!('batch' in value)||validBatchField(value.batch,userId));}
function unavailable(){throw Object.assign(new Error('career_storage_invalid'),{code:'storage_unavailable'});}
export function createCareerPersistence(client) {
  async function call(name, args) {
    const result = await client.rpc(name, args);
    if (result.error) throw Object.assign(new Error('career_storage_unavailable'), { code: 'storage_unavailable' });
    if (!record(result.data)) throw Object.assign(new Error('career_storage_invalid'), { code: 'storage_unavailable' });
    if (result.data.error) throw Object.assign(new Error(result.data.error), { code: result.data.error });
    return result.data;
  }
  return {
    async load({ userId, threadId, turnKey, requestHash }) {
      const data=await call('career_host_load',{p_user:userId,p_thread:threadId,p_key:turnKey,p_hash:requestHash});
      if('replay' in data){if(!validResponse(data.replay,threadId,turnKey,userId))unavailable();}
      else if(!Number.isSafeInteger(data.revision)||data.revision<0||!Number.isSafeInteger(data.accountVersion)||data.accountVersion<0||!record(data.account)||!record(data.watchState)||!Array.isArray(data.reminders)||(data.snapshot!==null&&!record(data.snapshot)))unavailable();
      return data;
    },
    async commit({ userId, threadId, turnKey, requestHash, revision, accountVersion, snapshot, patch, input, response, taskIntent, batchIntent, events }) {
      const base={
        p_user:userId,p_thread:threadId,p_key:turnKey,p_hash:requestHash,
        p_revision:revision,p_account_version:accountVersion,
        p_snapshot:snapshot,p_patch:patch||{},p_input:input,p_response:response,
      };
      // RESUME CONFIRM RACE (2026-10-30): a turn that confirmed resume entries commits their fact_confirmed events with the
      // save itself (career_host_commit_evidenced, 20261030060000): both, or neither when the save is refused.
      const data=Array.isArray(events)&&events.length?await call('career_host_commit_evidenced',{p_base:base,p_events:events,p_task:taskIntent&&!batchIntent?taskIntent:null,p_batch:batchIntent||null})
        :batchIntent?await call('career_batch_turn_commit_v1',{p_base:base,p_intent:batchIntent}):taskIntent?await call('career_task_turn_commit_v1',{p_base:base,p_intent:taskIntent}):await call('career_host_commit',base);
      if(!validResponse(data.response,threadId,turnKey,userId))unavailable();
      return data;
    },
    async readTask({userId,taskId,intentId}) {
      const data=await call('career_task_result_v1',{p_user:userId,p_task:taskId,p_intent:intentId});
      if(data.task!==null&&!validTask(data.task,userId))unavailable();
      return data.task;
    },
    async readBatchRun({userId,runId}) {
      const data=await call('career_batch_result_v1',{p_user:userId,p_run:runId});
      if(data.batch!==null&&!validBatchRun(data.batch,userId))unavailable();
      return data.batch;
    },
  };
}

/** @param {unknown} message @param {unknown} images @param {unknown} careerTask */
export async function careerRequestHash(message, images, careerTask=null) {
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({version:'career_turn/v2',message,acceptedImages:images||null,careerTask})));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
