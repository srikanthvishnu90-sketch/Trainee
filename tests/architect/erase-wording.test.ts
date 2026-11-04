// Review of #364 (2026-11-01): "forget everything" deletes the person's chat messages from Trainee's records (the
// agent_messages rows, career_erase_messages). Copies already delivered stay in the person's own Telegram, iMessage or
// WhatsApp app: Trainee cannot delete those, so no answer may say the messages go "on every channel". Every place that
// describes the erase says the messages are deleted from Trainee's records, and the confirmation says where copies stay.
import assertNode from "node:assert/strict";
import * as B from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";

const OVERCLAIM = /on every channel|every channel|from (?:every|all) (?:your )?(?:apps?|channels?|devices?)|from telegram|from imessage|from whatsapp|everywhere/i;
const RECORDS = /from Trainee's records/;
// The erase keeps the erase turn's own two messages (the person's "yes, erase it" and the answer; migration
// 20261104120000), so a reply may say only "this exchange" is kept, never only the answer.
const ONLY_ANSWER = /only (?:this|the) answer|answer confirming the erase is kept/i;

Deno.test("the erase confirmation says the messages leave Trainee's records, and that delivered copies stay in the person's app", () => {
  const host = (CareerHost as any).createCareerHost(B);
  let snap: unknown = null, acct: Record<string, unknown> = { version: 0, epoch: 0 };
  const say = (text: string) => {
    const ctx = host.createTurnCtx({ userId: "u-erase", threadId: "t-erase", now: Date.parse("2026-11-01T15:00:00Z"), accountPersistence: true, accountMemory: true, snapshot: snap, account: acct, watchState: {}, postings: [] });
    const out = host.runTurn(text, ctx);
    snap = JSON.parse(JSON.stringify(host.extractSnapshot(ctx) ?? null));
    acct = { ...acct, ...JSON.parse(JSON.stringify(ctx._hostPatch ?? {})), version: Number(acct.version) + 1 };
    return out;
  };
  say("i want a data analyst job in chicago");
  const ask = say("forget everything");
  eq(ask.intent, "career_erase_confirm", ask.reply);
  assert(!OVERCLAIM.test(ask.reply), `no claim beyond Trainee's records: ${ask.reply}`);
  assert(RECORDS.test(ask.reply) && /chat messages/.test(ask.reply), `the messages go from Trainee's records: ${ask.reply}`);
  assert(!ONLY_ANSWER.test(ask.reply) && /only this exchange is kept/i.test(ask.reply), `what is kept is the exchange: ${ask.reply}`);
  assert(/Telegram/.test(ask.reply) && /iMessage/.test(ask.reply) && /WhatsApp/.test(ask.reply) && /stay/.test(ask.reply), `where copies stay is said: ${ask.reply}`);
  const done = say("yes, erase it");
  eq(done.intent, "career_profile_erased", done.reply);
  assert(!OVERCLAIM.test(done.reply) && RECORDS.test(done.reply) && !ONLY_ANSWER.test(done.reply), done.reply);
});

Deno.test("every erase description in code says 'from Trainee's records' and none says 'every channel'", () => {
  const ROUTER = Deno.readTextFileSync(new URL("../../packages/domain/142-career-router.js", import.meta.url));
  const HOST = Deno.readTextFileSync(new URL("../../supabase/functions/_shared/career_host.js", import.meta.url));
  const erased = HOST.match(/intent: "career_profile_erased", reply: "([^"]+)"/)?.[1] ?? "";
  assert(erased && !OVERCLAIM.test(erased) && RECORDS.test(erased) && !ONLY_ANSWER.test(erased) && /only this exchange is kept/i.test(erased), erased);
  for (const line of ROUTER.split("\n").filter((l) => /career_erase_confirm|career_profile_erased/.test(l) && /chat messages/.test(l))) {
    assert(!OVERCLAIM.test(line) && RECORDS.test(line), line.trim().slice(0, 200));
  }
});

function eq(a: unknown, b: unknown, m?: string) { assertNode.deepStrictEqual(a, b, m); }
function assert(v: unknown, m?: string) { assertNode.ok(v, m); }
