// R9-G: the apply asks the end-to-end eval (evals/career/e2e) found unrouted, each through the product's own turn:
//   E05 "apply to these 20: <links>"        every posting link, ONE batch (career_apply_chat.ts linksApplyTurn)
//   E06 "find <role> in <place> and apply to all of them"   the search and the batch in one message (findThenApplyAsk)
//   E08 "apply to the X role at A and the Y role at B"      each named role, ONE batch (namedAsks / namedApplyTurn)
//   E09 "tailor my resume for the X role at A and apply with it"      the two halves (career_compound_ask.ts)
//   E18 "apply to the X role at A and email Maya there about it"      "there" is A (career_compound_ask.ts)
//   E40 "tailor my resume for the X role at A and the Y role at B"    both tailored, both files (142 handleMultiTailor)
// Each batch goes through the same screens, resume check and pace as every batch ask: queued, nothing approved or sent
// (each application is prepared and goes only on the person's yes to its exact payload, D-MS-1). No network, no database.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn, findThenApplyAsk, MANY_MAX, matchesFilter, namedAsks } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { linksAsk } from "../../supabase/functions/_shared/career_apply_link.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../supabase/functions/_shared/career_ingest.ts";
import { applyAndReachOf, tailorAndApplyOf } from "../../supabase/functions/_shared/career_compound_ask.ts";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-07T16:00:00Z");
const gh = (board: string, id: number, company: string, title: string, location = "Chicago, IL") =>
  ({ job_id: `greenhouse:${board}:${id}`, ats_id: String(id), provider: "greenhouse", board, company, title, location, url: `https://boards.greenhouse.io/${board}/jobs/${id}`,
    description: `${title}. TEST posting.`, first_seen_at: new Date(NOW - 86400_000).toISOString(), last_seen_at: new Date(NOW).toISOString(), closed_at: null });
const POSTINGS = [
  gh("acme", 101, "Acme", "Frontend Engineering Intern"), gh("brite", 102, "Brite", "Frontend Developer Intern"),
  gh("ember", 105, "Ember Health", "UI Engineering Intern"), gh("juno", 701, "Juno", "Product Design Intern"),
  gh("kite", 702, "Kite", "Data Science Intern"), gh("plaid", 401, "Plaid", "Data Analyst Intern", "San Francisco, CA"),
  gh("stripe", 301, "Stripe", "Data Analyst"), gh("ramp", 201, "Ramp", "Software Engineer Intern", "New York, NY"),
];
async function world() {
  const db = memoryPostingsDb();
  for (const p of POSTINGS) await db.put(p as any);
  const wants = memoryWantStore();
  const words = (p: any) => `${p.company} ${p.title} ${p.location}`.toLowerCase();
  const search = async (ws: string[], limit: number) => POSTINGS.filter((p) => ws.every((w) => words(p).includes(String(w).toLowerCase()))).slice(0, limit);
  let feedReads = 0;
  const fetchFeed = async (b: { board: string }) => { feedReads++; return POSTINGS.filter((p) => p.board === b.board); };
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: NOW, postings: { search }, wants, apps: async () => [], facts: [],
    link: { db, fetchFeed: fetchFeed as any } });
  return { turn, keys: async () => (await wants.list("u1")).map((w) => w.posting_key).sort(), reads: () => feedReads };
}

Deno.test("E05 linksAsk: two or more posting links in one apply ask, in order, each once; a link no reader knows is named", () => {
  const m = "apply to these 3:\nhttps://boards.greenhouse.io/acme/jobs/101\nhttps://boards.greenhouse.io/brite/jobs/102\nhttps://www.linkedin.com/jobs/view/1\nhttps://boards.greenhouse.io/acme/jobs/101";
  const a = linksAsk(m)!;
  eq(a.asks.map((x) => x.key), ["greenhouse:acme:101", "greenhouse:brite:102"]);
  eq(a.unread, ["https://www.linkedin.com/jobs/view/1"]);
  eq(linksAsk("apply to https://boards.greenhouse.io/acme/jobs/101"), null, "one link is linkAsk's");
  eq(linksAsk("how do I apply to https://boards.greenhouse.io/acme/jobs/101 and https://boards.greenhouse.io/brite/jobs/102?"), null);
});

Deno.test("E05 'apply to these N: <links>' queues every linked posting as ONE batch (before: 'I haven't listed any postings', nothing queued)", async () => {
  const w = await world();
  const urls = ["acme/jobs/101", "brite/jobs/102", "ember/jobs/105", "kite/jobs/702", "stripe/jobs/301"].map((p) => `https://boards.greenhouse.io/${p}`);
  const r = await w.turn(`apply to these ${urls.length}:\n${urls.join("\n")}\nhttps://boards.greenhouse.io/acme/jobs/999999`);
  eq([r?.status, r?.intent], ["queued", "career_apply_queue"], r?.reply);
  eq(await w.keys(), ["greenhouse:acme:101", "greenhouse:brite:102", "greenhouse:ember:105", "greenhouse:kite:702", "greenhouse:stripe:301"]);
  eq(r?.coverage, { queued: 5, total: 6 });
  ok(/not among the open postings its board lists/.test(r!.reply), `the closed link is named: ${r!.reply}`);
  ok(/Nothing is sent/i.test(r!.reply) && !/approved/i.test(r!.reply), r!.reply);
});

Deno.test("E06 'find <role> in <place> and apply to all of them': the search and one batch; a UI engineer is a frontend role, a designer is not", async () => {
  eq(findThenApplyAsk("find frontend internships in Chicago and apply to all of them")?.place, "chicago");
  eq(applyManyAsk("find frontend internships in Chicago and apply to all of them")?.kind, "all");
  eq(findThenApplyAsk("should I find frontend internships in Chicago and apply to all of them?"), null);
  eq(findThenApplyAsk("find frontend internships in Chicago"), null, "a search alone is the router's");
  ok(matchesFilter({ title: "UI Engineering Intern" }, { remote: false, words: ["frontend"], said: "frontend" }));
  ok(!matchesFilter({ title: "Product Design Intern" }, { remote: false, words: ["frontend"], said: "frontend" }));
  ok(!matchesFilter({ title: "UI Designer" }, { remote: false, words: ["frontend"], said: "frontend" }));
  const w = await world();
  const r = await w.turn("find frontend internships in Chicago and apply to all of them");
  eq([r?.status, r?.intent], ["queued", "career_apply_queue"], r?.reply);
  eq(await w.keys(), ["greenhouse:acme:101", "greenhouse:brite:102", "greenhouse:ember:105"]);
  ok(MANY_MAX <= 200, "one message stays under the 200-a-day pace (D-R9-1)");
});

Deno.test("E08 two named roles in one apply ask: each found on file, ONE batch (before: the router's 'not in the list I can work from')", async () => {
  eq(namedAsks("apply to the Data Science Intern role at Kite and the Data Analyst Intern role at Plaid"),
    [{ role: "Data Science Intern", company: "Kite" }, { role: "Data Analyst Intern", company: "Plaid" }]);
  eq(namedAsks("apply to the Data Analyst role at Stripe"), null, "one role is the single ask's");
  eq(namedAsks("apply to the Data Analyst role at Stripe and email Maya there"), null, "an email half is not a second role");
  const w = await world();
  const r = await w.turn("apply to the Data Science Intern role at Kite and the Data Analyst Intern role at Plaid");
  eq([r?.status, r?.coverage], ["queued", { queued: 2, total: 2 }], r?.reply);
  eq(await w.keys(), ["greenhouse:kite:702", "greenhouse:plaid:401"]);
  const none = await (await world()).turn("apply to the Data Science Intern role at Kite and the Chef role at Plaid");
  eq(none?.coverage, { queued: 1, total: 2 });
  ok(/Chef at Plaid: no open posting for it at Plaid is on file/.test(none!.reply), none!.reply);
});

Deno.test("E09 / E18 compound asks: each half to its own turn; 'there' and 'about it' are the same message's employer and role", () => {
  eq(applyAndReachOf("apply to the Data Analyst role at Stripe and email Maya there about it"),
    { apply: "apply to the Data Analyst role at Stripe", outreach: "email Maya at Stripe about the Data Analyst role", company: "Stripe", role: "Data Analyst" });
  eq(applyAndReachOf("apply to the Data Analyst role at Stripe and email Maya at Ramp"), null, "another employer is not 'there'");
  eq(applyAndReachOf("should I apply to the Data Analyst role at Stripe and email Maya there?"), null);
  eq(tailorAndApplyOf("tailor my resume for the Data Analyst role at Lumen and apply with it"),
    { tailor: "tailor my resume for the Data Analyst role at Lumen", apply: "apply to the Data Analyst role at Lumen", company: "Lumen", role: "Data Analyst" });
  eq(tailorAndApplyOf("tailor my resume for the Data Analyst role at Lumen"), null);
});

Deno.test("E40 two named roles in one tailor ask: both tailored by the truth-checked tailor, both PDFs on the turn (before: one)", () => {
  const host = (CareerHost as any).createCareerHost(core);
  const P = (core as any).CareerProfile;
  const RESUME = Deno.readTextFileSync(new URL("../../packages/career-data/fixtures/test-resume.txt", import.meta.url));
  const posting = (id: string, company: string, title: string, jd: string) => ({ id, job_id: id, company, title, location: "Chicago, IL", jd_text: jd, url: `https://boards.greenhouse.io/x/jobs/${id}` });
  const ctx = host.createTurnCtx({ userId: "TEST-r9g", threadId: "t-r9g", now: NOW, accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false },
    postings: [posting("gh-802", "Mosaic", "Software Engineer, New Grad", "Software Engineer, New Grad. Requirements: Python, Go, PostgreSQL, Docker."),
      posting("gh-803", "Nimbus", "Backend Engineer, New Grad", "Backend Engineer, New Grad. Requirements: Go, Kubernetes, PostgreSQL.")] });
  const p = P.createProfile({ id: "TEST-r9g" }); P.ingestResume(p, RESUME); for (const f of p.facts) P.confirmFact(p, f.id); ctx.profile = p;
  const r = host.runTurn("tailor my resume for the Software Engineer, New Grad role at Mosaic and the Backend Engineer, New Grad role at Nimbus and send both back", ctx);
  eq(r.intent, "career_tailor", r.reply);
  const docs = (r.result?.documents ?? []).filter((d: any) => d && d.base64);
  eq(docs.length, 2, `two PDFs: ${r.reply}`);
  eq(new Set(docs.map((d: any) => d.sha256 ?? d.base64)).size, 2, "two different files");
  ok(/Mosaic/.test(r.reply) && /Nimbus/.test(r.reply), r.reply);
  ok(!/DOCX/.test(r.reply), "no file is claimed that the turn does not carry");
});
