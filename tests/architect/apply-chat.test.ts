// STEP 4 F1/F2 (2026-10-25): the chat-to-queue turn (career_apply_chat.ts) in memory. What it claims, what it queues, and
// that no volume ceiling applies on this path (owner, 2026-10-22: no cap on applications): the 26th posting of a day is
// queued like the first. Fail-first on edd6f90c: the 26th was refused "over today's limit of 25 applications".
import assertNode from "node:assert/strict";
import { applyAsk, applyTurn, trackedFromRows } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-10-25T16:00:00Z");
const posting = (n: number, company = `Test Co ${n}`, title = "Data Analyst") =>
  ({ job_id: `greenhouse:testco${n}:${n}`, company, title, url: `https://boards.greenhouse.io/testco${n}/jobs/${n}`, location: "Chicago, IL" });
const world = (postings: any[], apps: any[] = []) => {
  const wants = memoryWantStore();
  const search = async (words: string[]) => postings.filter((p) => words.every((w) => `${p.company} ${p.title}`.toLowerCase().includes(w.toLowerCase())));
  const turn = (message: string, facts: any[] = []) => applyTurn({ message, userId: "u1", now: NOW, postings: { search }, wants, apps: async () => apps, facts });
  return { wants, turn };
};

Deno.test("the ask: a role at an employer, or an employer alone; questions and batch shapes are never claimed", () => {
  eq(applyAsk("apply to the Data Analyst role at Test Co 1"), { role: "Data Analyst", company: "Test Co 1" });
  eq(applyAsk("Apply me to Test Co 1"), { role: null, company: "Test Co 1" });
  eq(applyAsk("how do I apply to Test Co 1?"), null);
  eq(applyAsk("apply to these"), null);
  eq(applyAsk("apply to 25 data analyst roles"), null);
  eq(applyAsk("I applied to Test Co 1 yesterday"), null);
});

Deno.test("queued once, said truthfully; a repeat changes nothing; no posting on file is not claimed", async () => {
  const w = world([posting(1)]);
  const r = await w.turn("apply to the Data Analyst role at Test Co 1");
  eq([r?.status, r?.intent], ["queued", "career_apply_queue"]);
  assert(/Nothing is sent and nothing is filled yet/.test(r!.reply) && /approve it on the card that shows it exactly/.test(r!.reply), r!.reply);
  eq((await w.wants.list("u1")).map((x) => x.posting_key), ["greenhouse:testco1:1"]);
  eq((await w.turn("apply to the Data Analyst role at Test Co 1"))?.status, "already");
  eq(await w.turn("apply to the Data Analyst role at Nowhere Inc"), null, "not on file: the router's turn");
  eq((await w.wants.list("u1")).length, 1);
});

Deno.test("several open postings ask which; a role the employer lacks is said with what it has", async () => {
  const w = world([posting(1, "Acme", "Data Analyst"), posting(2, "Acme", "Product Manager")]);
  const which = await w.turn("apply to Acme");
  eq(which?.status, "which");
  assert(/1\. Data Analyst/.test(which!.reply) && /2\. Product Manager/.test(which!.reply), which!.reply);
  const none = await w.turn("apply to the Staff Engineer role at Acme");
  eq(none?.status, "none");
  assert(/Data Analyst/.test(none!.reply) && /nothing was queued/.test(none!.reply), none!.reply);
  eq((await w.wants.list("u1")).length, 0);
});

Deno.test("the exact posting already applied to refuses the pick, at any date; another posting at that employer does not (D-MS-3); the employer guard stands", async () => {
  // The queue's own rows (career_apply_jobs), as the handler reads them; applyTurn maps them to applications.
  const row = (url: string, ago: number, state = "submitted_unconfirmed") => ({ id: "j1", company: "Test Co 1", url, state, created_at: new Date(NOW - ago * 86400_000).toISOString(), updated_at: "" });
  const same = posting(1).url;
  eq(trackedFromRows([row(same, 5)] as any).map((a) => [a.stage, a.url]), [["Submitted", same]], "a sent application counts and keeps its link; a failed one would not");
  for (const ago of [5, 45]) {
    const w = world([posting(1)], [row(same, ago)]);
    const r = await w.turn("apply to the Data Analyst role at Test Co 1");
    eq(r?.status, "refused", `${ago} days ago`);
    assert(/already/.test(r!.reply) && /same posting/.test(r!.reply) && !/30 days/.test(r!.reply), r!.reply);
    eq((await w.wants.list("u1")).length, 0);
  }
  // A different posting at Test Co 1 applied to 5 days ago: this one is queued.
  const other = world([posting(1)], [row("https://boards.greenhouse.io/testco1/jobs/777", 5)]);
  const q = await other.turn("apply to the Data Analyst role at Test Co 1");
  eq(q?.status, "queued", q?.reply);
  eq((await other.wants.list("u1")).map((x) => x.posting_key), ["greenhouse:testco1:1"]);
  // The employer guard stands: a fact that they work there holds the pick and asks first; nothing is queued.
  const cur = world([posting(1)]);
  const c = await cur.turn("apply to the Data Analyst role at Test Co 1", [{ kind: "experience", text: "you work at Test Co 1" }]);
  eq(c?.status, "asking_employer", c?.reply);
  assert(/where you work now/i.test(c!.reply), c!.reply);
  eq((await cur.wants.list("u1")).length, 0);
});

Deno.test("no volume ceiling: the 26th and 51st postings of a day are queued like the first", async () => {
  const postings = Array.from({ length: 51 }, (_, i) => posting(i + 1));
  const w = world(postings);
  for (let i = 1; i <= 51; i++) {
    const r = await w.turn(`apply to the Data Analyst role at Test Co ${i}`);
    eq(r?.status, "queued", `posting ${i}: ${r?.reply}`);
  }
  eq((await w.wants.list("u1")).length, 51);
});
