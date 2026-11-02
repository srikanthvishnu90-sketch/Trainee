'use strict';
// #354 re-review 2: the crisis reply is a gentle check-in (988, the text line, 911 only for danger right now, no alarm
// words), and "i'm fine" / "you misread me" right after it picks up what the person had asked, through the production
// career bundle and host as agent-chat runs them. The handler path (its trust turn answers first) notes the check-in with
// CareerRouter.noteCrisisCheckin; the router path notes it itself.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ROOT = path.resolve(__dirname, "..");
let host, B;
async function setup() {
  if (host) return;
  B = await import(pathToFileURL(path.join(ROOT, "supabase/functions/_shared/router_core.career.js")));
  const { CareerHost } = await import(pathToFileURL(path.join(ROOT, "supabase/functions/_shared/career_host.js")));
  host = CareerHost.createCareerHost(B);
}
const copy = (x) => JSON.parse(JSON.stringify(x ?? null));
function person(userId) {
  let snap = null, acct = { version: 0, epoch: 0 }, minutes = 0;
  const turn = (text, before) => {
    const ctx = host.createTurnCtx({ userId, threadId: `t-${userId}`, now: Date.parse("2026-11-02T15:00:00Z") + minutes * 60000, accountPersistence: true, accountMemory: true, snapshot: copy(snap), account: copy(acct), watchState: {}, postings: [] });
    const out = before ? before(ctx) : host.runTurn(text, ctx);
    snap = copy(host.extractSnapshot(ctx));
    acct = { ...acct, ...copy(ctx._hostPatch || {}), version: acct.version + 1 };
    return out;
  };
  return { say: (t) => turn(t), handlerAnswersDistress: (t, rest) => turn(t, (ctx) => B.CareerRouter.noteCrisisCheckin(ctx, t, rest)), wait: (m) => { minutes += m; } };
}
const ALARM = /please reach out now|right now to someone|emergency|immediately/i;

test("the crisis reply is a gentle check-in: 988, the text line, 911 only for danger, a way back, no alarm words", async () => {
  await setup();
  const r = person("u-gentle").say("honestly kms");
  assert.equal(r.intent, "safety_support");
  assert.match(r.reply, /\b988\b/); assert.match(r.reply, /741741/); assert.match(r.reply, /911/);
  assert.match(r.reply, /check in/i); assert.match(r.reply, /read that wrong/i);
  assert.ok(!ALARM.test(r.reply), r.reply);
});

test("'i'm fine' after the check-in picks up the career ask from the same message (router path)", async () => {
  await setup();
  const p = person("u-resume");
  assert.equal(p.say("find me data analyst jobs in chicago. honestly kms").intent, "safety_support");
  const back = p.say("lol im fine, just venting");
  assert.notEqual(back.intent, "safety_support");
  assert.notEqual(back.intent, "career_fallback", back.reply);
  assert.match(String(back.reply), /analyst|chicago|role|job/i, back.reply);
});

test("the handler path notes the check-in too, and 'you misread me' resumes it", async () => {
  await setup();
  const p = person("u-handler");
  p.handlerAnswersDistress("find me product manager internships in new york? i want to die lol");
  const back = p.say("you misread me");
  assert.notEqual(back.intent, "career_fallback", back.reply);
  assert.match(String(back.reply), /product|intern|new york/i, back.reply);
});

test("a check-in with nothing else asked gets a short, open reply; anything other than 'fine' is not taken as a resume; it expires", async () => {
  await setup();
  const a = person("u-only");
  a.say("i want to die");
  const r = a.say("im ok");
  assert.equal(r.intent, "conversation_ack"); assert.match(r.reply, /What should we work on/);
  const b = person("u-other");
  b.say("find me jobs in chicago. kms");
  const o = b.say("what's the weather");
  assert.notEqual(o.intent, "safety_support");
  assert.notEqual(b.say("im fine").intent, "career_discovery", "the check-in was answered by something else, so it is spent");
  const c = person("u-late");
  c.say("find me data analyst jobs in chicago. kms");
  c.wait(180);
  assert.notEqual(c.say("im fine").intent, "career_discovery", "after two hours it is not resumed");
  const d = person("u-still");
  d.say("find me data analyst jobs in chicago. kms");
  assert.equal(d.say("i'm fine. actually no, i want to die").intent, "safety_support", "a 'fine' that is still distress is distress");
});

test("the handler's full-screen remainder is what resumes (not the list's reading)", async () => {
  await setup();
  const p = person("u-rest");
  // the models flagged the second clause, which the list cannot see; the handler stored the remainder it judged
  p.handlerAnswersDistress("find me product manager internships in new york. i gave away my things", "find me product manager internships in new york");
  const back = p.say("im fine");
  assert.notEqual(back.intent, "career_fallback", back.reply);
  assert.match(String(back.reply), /product|intern|new york/i, back.reply);
  assert.doesNotMatch(String(back.reply), /gave away/i);
  const q = person("u-rest-empty");
  q.handlerAnswersDistress("find me jobs. tonight is the night", "");
  assert.equal(q.say("im fine").intent, "conversation_ack", "an empty remainder asks what to work on");
});
