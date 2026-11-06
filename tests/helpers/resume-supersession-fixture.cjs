'use strict';
// Synthetic owners and resume text only. A source is supplied through each
// verified owner's existing saved resumeTexts field, never a request override.
const path=require('node:path');
const F=require('./correction-privacy-fixture.cjs');
const NEW=year=>`Education\nB.S., Synthetic University, graduating ${year}.`;
async function fixture(t,options={}){
 let active=0;
 const dbs=F.OWNERS.map((u,i)=>({state:{career:F.snapshot(u,F.profile(i?'2031':'2027',options.collision||'default-id'))},messages:[],options:{}}));
 const client={auth:{getUser:async()=>({data:{user:{id:F.OWNERS[active]}}})},async rpc(name,args){
  if(options.rpc){const result=await options.rpc(name,args);if(result!==undefined)return result;}
  return require('./career-persistence-fake.cjs')(dbs[active],F.OWNERS[active],F.THREADS[active],name,args);
 },from(table){const filters={},q={select(){return q;},eq(k,v){filters[k]=v;return q;},async upsert(row){if(table!=='profiles'||row.id!==F.OWNERS[active])throw Error('Unexpected profile authority');return {error:null};},async maybeSingle(){if(table!=='agent_threads'||filters.user_id!==F.OWNERS[active])throw Error('Unexpected thread authority');return {data:filters.id===F.THREADS[active]?{id:filters.id,user_id:filters.user_id}:null,error:null};}};return q;}};
 const entry=await require('./career-staged-entry.cjs')(path.resolve(__dirname,'../..'),client);t.after(()=>entry.close());
 return {entry,dbs,source(i,value){dbs[i].state.career.stores.resumeTexts={'resume-new.txt':value};},request(i=0,message=F.CORRECT,key='correction',thread=F.THREADS[i]){active=i;return entry.request(thread,message,key);}};
}
module.exports={...F,NEW,fixture};
