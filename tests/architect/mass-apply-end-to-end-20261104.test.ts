// MASS APPLY END TO END (2026-11-04; real employer submission is ON, D-041). The deployed path is: the person asks, the
// postings go on their apply list (career_apply_wanted), the server prepares each one, the card shows each exact payload,
// the person's yes approves exactly what the card showed (career_apply_card_answer_as, by payload hash), and the cloud
// submitter sends it. This file holds the chat side of three gaps found on that path:
//   1. "approve the second one" on a standing card read "second" as an employer's name, matched no item and approved
//      nothing; "approve the 2nd one" was refused as unclear. A position in words or with an ordinal suffix is that number.
//   2. "apply to the good ones" after a list was read as an employer called "the good ones". It is the listed postings
//      their confirmed facts fit (the search's own fit: Match or Safety, nothing that rules them out), and with no
//      confirmed facts nothing is guessed or queued.
//   3. A broad batch ask reaches the batch stack, whose executor is not deployed (CAREER_BATCH_EXECUTOR pending, D-037):
//      the reply said applying "runs in the Trainee extension", which is no longer the deployed path. It now says plainly
//      that the batch was not started and names, in the person's words, the ask that does run.
// Synthetic only: no network, no database, nothing sent.
import assertNode from "node:assert/strict";
import { parseCardReply } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { applyManyAsk, applyTurn, type ShortlistEntry } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { db } from "./mass-submit-fixture.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-11-04T16:00:00Z");

// ------------------------------------------------------------------------------------------------ 1. positions on a card
Deno.test("MASS-E2E/1 a card position in words or with an ordinal is that number; a bare number and an employer name are as before", () => {
  const ONLY: [string, number[]][] = [
    ["approve the second one", [2]], ["approve the second", [2]], ["approve the second application", [2]], ["approve the 2nd one", [2]],
    ["just the second one", [2]], ["only the third", [3]], ["yes to the second one", [2]], ["approve the first and third", [1, 3]],
    ["send the 1st and 3rd", [1, 3]],
  ];
  for (const [m, nums] of ONLY) {
    const r = parseCardReply(m) as any;
    eq([r?.kind, r?.only, r?.onlyNames], ["only", nums, undefined], m);
  }
  eq((parseCardReply("yes except the second one") as any)?.except, [2]);
  // Unchanged: one bare number may be a count, so it stays unclear; a name stays a name.
  eq(parseCardReply("approve 2")?.kind, "unclear");
  eq(parseCardReply("send 3")?.kind, "unclear");
  eq([(parseCardReply("only acme") as any)?.onlyNames], [["acme"]]);
  eq(parseCardReply("yes but not the one in Ohio")?.kind, "unclear");
});

Deno.test("MASS-E2E/1 'approve the second one' on a card of 4 approves exactly #2 by its hash, once; nothing else is queued", async () => {
  const w = db({ n: 4 });
  await w.say("show my applications");
  const r = await w.say("approve the second one");
  eq(r?.status, "answered", r?.reply);
  eq(w.answerCalls.map((c) => c.approve), [[2]]);
  eq(w.queue.length, 1);
  eq(w.queue[0].approval, w.prepared[1].hash, "bound to the second item's own payload hash");
  assert(/^1 approved exactly as shown/.test(r!.reply), r!.reply);
  const again = await w.say("approve the second one");
  eq([again?.status, w.queue.length, w.answerCalls.length], ["answered_before", 1, 1]);
  const past = db({ n: 2 });
  await past.say("show my applications");
  const out = await past.say("approve the fifth one");
  eq([out?.status, past.queue.length], ["not_on_card", 0], out?.reply);
});

// ------------------------------------------------------------------------------------------------ 2. "the good ones"
const LIST: ShortlistEntry[] = [
  { id: "greenhouse:fitco:1", title: "Data Analyst", company: "Fit Co", location: "Chicago, IL", url: "https://boards.greenhouse.io/fitco/jobs/1" },
  { id: "greenhouse:nurseco:2", title: "Registered Nurse", company: "Nurse Co", location: "Chicago, IL", url: "https://boards.greenhouse.io/nurseco/jobs/2" },
  { id: "greenhouse:fitco2:3", title: "Junior Data Analyst", company: "Fit Two", location: "Chicago, IL", url: "https://boards.greenhouse.io/fitco2/jobs/3" },
];
const RECORDS: Record<string, any> = {
  "greenhouse:fitco:1": { job_id: "greenhouse:fitco:1", company: "Fit Co", title: "Data Analyst", location: "Chicago, IL", url: LIST[0].url, description: "Data analyst. SQL, Excel, Tableau dashboards. Entry level." },
  "greenhouse:nurseco:2": { job_id: "greenhouse:nurseco:2", company: "Nurse Co", title: "Registered Nurse", location: "Chicago, IL", url: LIST[1].url, description: "RN license required. BLS certification." },
  "greenhouse:fitco2:3": { job_id: "greenhouse:fitco2:3", company: "Fit Two", title: "Junior Data Analyst", location: "Chicago, IL", url: LIST[2].url, description: "Junior data analyst. SQL and Excel reporting, Tableau." },
};
const FACTS = [
  { kind: "skill", text: "Skill: SQL", name: "SQL", status: "confirmed", confirmed: true },
  { kind: "skill", text: "Skill: Excel", name: "Excel", status: "confirmed", confirmed: true },
  { kind: "skill", text: "Skill: Tableau", name: "Tableau", status: "confirmed", confirmed: true },
  { kind: "education", text: "B.S. Statistics at TEST University, 2024", status: "confirmed", confirmed: true },
];
const world = (facts: any[]) => {
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: NOW, postings: { search: async () => [] }, wants, apps: async () => [], facts,
    shortlist: LIST, posting: async (id) => RECORDS[id] ?? null, resumeOnFile: async () => true });
  return { turn, keys: async () => (await wants.list("u1")).map((x) => x.posting_key).sort() };
};

Deno.test("MASS-E2E/2 the ask: 'the good ones', 'the best matches', 'the ones that fit me' are the list filtered by fit; 'the best 3' stays a count", () => {
  for (const m of ["apply to the good ones", "apply to the best ones", "apply to all the good ones", "apply to the best matches", "apply me to the strong fits",
    "apply to the ones that fit me", "apply to the ones I'm a good fit for", "apply to the good ones you found"]) eq(applyManyAsk(m), { kind: "all", good: true }, m);
  eq(applyManyAsk("apply to the best 3"), { kind: "first", n: 3 });
  eq(applyManyAsk("apply to all of them"), { kind: "all" });
  for (const m of ["should I apply to the good ones?", "apply to the Good Ones role at Acme"]) assert((applyManyAsk(m) as any)?.good !== true, m);
});

Deno.test("MASS-E2E/2 'apply to the good ones' queues only what their confirmed facts fit; the posting that rules them out is left out, said by count", async () => {
  const w = world(FACTS);
  const r = await w.turn("apply to the good ones");
  eq(r?.status, "queued", r?.reply);
  eq(await w.keys(), ["greenhouse:fitco2:3", "greenhouse:fitco:1"]);
  assert(/2 of the 3 I listed fit your confirmed facts/.test(r!.reply), r!.reply);
  eq(r!.queued?.map((q) => q.job_id).sort(), ["greenhouse:fitco2:3", "greenhouse:fitco:1"], "the knocked-out posting is not queued");
  assert(!/Nurse Co/.test(r!.reply), `a posting left out by fit is not named as queued: ${r!.reply}`);
  assert(!/\bsubmitted\b|applied for you/.test(r!.reply), `queueing is never called a submission: ${r!.reply}`);
});

Deno.test("MASS-E2E/2 'the good ones' with no confirmed facts: nothing ranked, nothing guessed, nothing queued; the reply says what to say", async () => {
  const w = world([]);
  const r = await w.turn("apply to the good ones");
  eq(r?.status, "none");
  eq(await w.keys(), []);
  assert(/none of your facts are confirmed yet/.test(r!.reply) && /won't guess/.test(r!.reply) && /nothing was queued/.test(r!.reply), r!.reply);
  assert(/apply to all of them/.test(r!.reply), r!.reply);
});

// ------------------------------------------------------------------------------------------------ 3. the batch not started
Deno.test("MASS-E2E/3 the not-started batch reply: says nothing was searched, prepared or sent, never 'handed' or the extension, and names an ask that runs", async () => {
  const { BATCH_NOT_STARTED_REPLY, batchNotStartedReply } = await import("../../supabase/functions/agent-chat/handler-career.ts");
  for (const m of ["apply to 15 software engineering intern roles", "apply me to 50 data analyst jobs in chicago", "apply to every job", "do the batch"]) {
    const r = batchNotStartedReply(m);
    assert(/nothing was searched, prepared or sent/.test(r), r);
    assert(!/browser worker|handed|extension/i.test(r), r);
    assert(/only after your yes to that card/.test(r), r);
  }
  const r = batchNotStartedReply("apply to 15 software engineering intern roles");
  const said = /say "([^"]+)"/.exec(r)?.[1];
  eq(said, "apply to the top 15 software engineering intern roles");
  const ask = applyManyAsk(said!) as any;
  eq([ask?.kind, ask?.n, ask?.what?.words], ["first", 15, ["software", "engineering", "intern"]], "the named ask is one the deployed path takes as a search");
  eq(batchNotStartedReply("do the batch"), BATCH_NOT_STARTED_REPLY, "no count in their words: the general reply");
});
