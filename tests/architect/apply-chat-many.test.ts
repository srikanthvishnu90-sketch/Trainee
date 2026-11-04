// SERIAL-1410 (1): the batch ask in chat ("apply to these", "apply to the top 2", "apply to 3 roles", "apply to the second
// one") queues from the thread's last listed postings (discovery.lastShortlist), each posting through the same screens as
// a single ask (their current employer, this exact posting already applied to, their own pace), nothing approved, nothing sent;
// the reply lists what was queued and what was not, with the reason for each. No list on the thread: not this turn's.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn, type ShortlistEntry } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-10-25T16:00:00Z");
const LIST: ShortlistEntry[] = [
  { id: "greenhouse:chattest:7", title: "TEST Analyst", company: "TEST Chat Employer", location: "Chicago, IL", url: "https://boards.greenhouse.io/chattest/jobs/7" },
  { id: "greenhouse:chatsib:8", title: "TEST Analyst", company: "TEST Sibling Employer", location: "Chicago, IL", url: "https://boards.greenhouse.io/chatsib/jobs/8" },
  { id: "greenhouse:current:9", title: "Data Analyst", company: "Contoso Analytics", location: "Chicago, IL", url: "https://boards.greenhouse.io/current/jobs/9" },
  { id: "greenhouse:prior:10", title: "Data Analyst", company: "Fabrikam Data", location: "Chicago, IL", url: "https://boards.greenhouse.io/prior/jobs/10" },
];
const FACTS = [{ kind: "experience", text: "you work at Contoso Analytics" }];
// Fabrikam Data: the very posting on the list was applied to (10 days ago). TEST Chat Employer: a different posting there
// was applied to 3 days ago, which blocks nothing (D-MS-3: only an exact duplicate blocks, no one-per-company window).
const PRIOR = [
  { id: "j1", company: "Fabrikam Data", title: "Data Analyst", url: "https://boards.greenhouse.io/prior/jobs/10", state: "submitted_unconfirmed", created_at: new Date(NOW - 10 * 86400_000).toISOString(), updated_at: "" },
  { id: "j2", company: "TEST Chat Employer", title: "Other Analyst", url: "https://boards.greenhouse.io/chattest/jobs/99", state: "submitted_unconfirmed", created_at: new Date(NOW - 3 * 86400_000).toISOString(), updated_at: "" },
];
const world = (o: { shortlist?: ShortlistEntry[]; apps?: any[]; facts?: any[]; limits?: () => Promise<any> } = {}) => {
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: NOW, postings: { search: async () => [] }, wants, apps: async () => o.apps ?? [], facts: o.facts ?? [], shortlist: o.shortlist, limits: o.limits });
  return { wants, turn, keys: async () => (await wants.list("u1")).map((w) => w.posting_key).sort() };
};

Deno.test("SERIAL-1410/1 the ask: these, both, all of them, the top N, the first N, N roles, the Nth one; questions and a named employer are not it", () => {
  for (const m of ["apply to these", "apply to those", "apply to them", "apply to both", "apply to all of them", "apply to them all", "Apply me to each of these", "apply to the ones you listed", "apply to all of those please"]) eq(applyManyAsk(m), { kind: "all" }, m);
  eq(applyManyAsk("apply to the top 2"), { kind: "first", n: 2 });
  eq(applyManyAsk("apply to the first two"), { kind: "first", n: 2 });
  eq(applyManyAsk("apply to 3 roles"), { kind: "first", n: 3 });
  eq(applyManyAsk("apply to 25 data analyst jobs"), null, "a count with a role family is the broad ask (the batch delegation's), not the list's");
  eq(applyManyAsk("apply to 15 software engineering intern roles"), null, "the owner's delegation message stays the delegation's (career_batch_apply)");
  eq(applyManyAsk("apply to 2 of them"), { kind: "first", n: 2 });
  eq(applyManyAsk("apply to the first one"), { kind: "nth", i: 1 });
  eq(applyManyAsk("apply to the second one"), { kind: "nth", i: 2 });
  for (const m of ["how do I apply to these?", "apply to the Data Analyst role at Acme", "apply to Acme", "I applied to both", "should I apply to these"]) eq(applyManyAsk(m), null, m);
});

Deno.test("SERIAL-1440/2 no list on the thread: a clarification that says what to say, nothing queued, never a router answer that disappears", async () => {
  const w = world();
  for (const m of ["apply to these", "apply to the top 2", "apply to 3 roles", "apply to the second one"]) {
    const r = await w.turn(m);
    eq([r?.status, r?.intent], ["no_list", "career_apply_queue"], m);
    assert(/haven't listed any postings in this thread|no list of postings in this thread/i.test(r!.reply), r!.reply);
    assert(/find <role> jobs in <place>/i.test(r!.reply) && /apply to the <role> role at <Company>/i.test(r!.reply), `says what to say: ${r!.reply}`);
    assert(/nothing was queued/i.test(r!.reply), r!.reply);
  }
  eq(await w.keys(), []);
});

Deno.test("SERIAL-1410/1 'apply to these': every posting screened on its own; two queued (one at an employer applied to 3 days ago for another posting), two refused with their reasons; nothing approved or sent", async () => {
  const w = world({ shortlist: LIST, apps: PRIOR, facts: FACTS });
  const r = await w.turn("apply to these");
  eq([r?.status, r?.intent], ["queued", "career_apply_queue"]);
  eq(await w.keys(), ["greenhouse:chatsib:8", "greenhouse:chattest:7"]);
  const reply = r!.reply;
  assert(/Queued 2/.test(reply) && reply.includes("TEST Analyst at TEST Chat Employer") && reply.includes("TEST Analyst at TEST Sibling Employer"), reply);
  assert(/Not queued/.test(reply), reply);
  assert(/Contoso Analytics[^\n]*current employer/i.test(reply), `the current-employer refusal names its reason: ${reply}`);
  assert(/Fabrikam Data[^\n]*already[^\n]*same posting/i.test(reply) && !/30 days/.test(reply), `the exact-duplicate refusal names its reason, with no 30-day rule: ${reply}`);
  assert(/Nothing is sent and nothing is filled yet/.test(reply) && /the card that shows it exactly/.test(reply) && /one yes to that card approves exactly what it shows/.test(reply), reply);
  assert(!/\bsubmitted\b|applied for you/.test(reply.replace(/already applied[^.]*/g, "")), `never a submission claimed: ${reply}`);
  eq(r!.queued?.map((p) => p.job_id), ["greenhouse:chattest:7", "greenhouse:chatsib:8"]);
  eq(r!.refused?.length, 2);
});

Deno.test("SERIAL-1410/1 a slice of the list: the top 1 queues the first only; the second one queues that one; a repeat changes nothing", async () => {
  const w = world({ shortlist: LIST });
  const top = await w.turn("apply to the top 1");
  eq([top?.status, await w.keys()], ["queued", ["greenhouse:chattest:7"]]);
  assert(!/Not queued/.test(top!.reply), `a slice refuses nothing it did not pick: ${top!.reply}`);
  const nth = await w.turn("apply to the second one");
  eq([nth?.status, await w.keys()], ["queued", ["greenhouse:chatsib:8", "greenhouse:chattest:7"]]);
  const again = await w.turn("apply to the first two");
  eq(again?.status, "already");
  assert(/already in your queue/.test(again!.reply), again!.reply);
  eq((await w.keys()).length, 2);
});

Deno.test("SERIAL-1410/1 more asked than listed: the list is what there is, said plainly; no volume ceiling of the product's", async () => {
  const w = world({ shortlist: LIST });
  const r = await w.turn("apply to 25 roles");
  eq(r?.status, "queued");
  assert(/I listed 4, not 25/.test(r!.reply), r!.reply);
  eq((await w.keys()).length, 4, "all four queued: no screen refuses them and no product number stops them");
});

Deno.test("SERIAL-1410/1 their own pace binds across the batch; an unreadable pace queues nothing", async () => {
  const paced = world({ shortlist: LIST, limits: async () => ({ daily: 1 }) });
  const r = await paced.turn("apply to these");
  eq([r?.status, (await paced.keys()).length], ["queued", 1]);
  assert(/over the daily pace you set \(1 a day\)/.test(r!.reply) && !/\btheir\b|\bthey (?:said|set|did|work|named|already)\b|themselves|the person/i.test(r!.reply), r!.reply);
  let calls = 0;
  const unknown = world({ shortlist: LIST, limits: async () => { calls++; throw new Error("rpc down"); } });
  const u = await unknown.turn("apply to these");
  eq([u?.status, calls, (await unknown.keys()).length], ["pace_unknown", 2, 0]);
  assert(/nothing was queued/i.test(u!.reply), u!.reply);
});
