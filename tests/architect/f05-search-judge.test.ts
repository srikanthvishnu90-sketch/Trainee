// FEATURE 5 (2026-10-25): the judge's scale, its accounting, its grounding rule, its cache, the person's judge prompt and
// the search turn over fake sources, without a database or a model. The handler-level proof is
// tests/architect/f05-search-judge-handler.test.ts.
// Run: deno test -A --no-check tests/architect/f05-search-judge.test.ts
import assertNode from "node:assert/strict";
import {
  accountFor, accountingLine, askFromRouter, groundingProblem, judgePostings, judgePromptTurn, JUDGE_MEANING, JUDGE_SCALE, KEPT_VERDICTS,
  memoryJudgeCache, profileHash, searchJudgeTurn, type SearchSources, type SourcePosting, verdictOf, type Judgment,
} from "../../supabase/functions/_shared/career_search_judge.ts";
import { memoryStandingStore } from "../../supabase/functions/_shared/agent/memory.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const NOW = Date.parse("2026-10-25T12:00:00Z"), DAY = 86400000;

Deno.test("f05 scale: four words, worst to best, defined once; fair and strong are kept; nothing else is a verdict", () => {
  eq([...JUDGE_SCALE], ["no", "weak", "fair", "strong"]);
  eq(Object.keys(JUDGE_MEANING), [...JUDGE_SCALE]);
  eq([...KEPT_VERDICTS].sort(), ["fair", "strong"]);
  for (const v of JUDGE_SCALE) eq(verdictOf(v), v);
  eq(verdictOf(" Strong "), "strong");
  for (const x of ["good", "maybe", "", null, undefined, 3, "strong match"]) eq(verdictOf(x), null, String(x));
});

Deno.test("f05 accounting: every posting sent is counted once, as a verdict or as not judged with its reason", () => {
  const j = (id: string, verdict: any, why_not?: string): [string, Judgment] => [id, { job_id: id, verdict, reason: verdict ? "r" : null, why_not }];
  const sent = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const m = new Map<string, Judgment>([
    ...sent.slice(0, 6).map((id) => j(id, "strong")), ...sent.slice(6, 11).map((id) => j(id, "fair")),
    ...sent.slice(11, 15).map((id) => j(id, "weak")), ...sent.slice(15, 18).map((id) => j(id, "no")),
    j("p18", null, "the reason named something not in the posting or your profile"),
  ]);
  const a = accountFor(sent, m);
  eq([a.sent, a.judged, a.kept, a.dropped, a.unjudged.length], [20, 18, 11, 7, 2]);
  eq(a.counts, { no: 3, weak: 4, fair: 5, strong: 6 });
  eq(a.unjudged.map((u) => u.job_id), ["p18", "p19"]);
  eq(accountingLine(a), "18/20 judged; 6 strong, 5 fair; 7 dropped as weak/no; 2 not judged (the reason named something not in the posting or your profile; the judge returned nothing for it)");
  eq(accountingLine(accountFor([], new Map())), "0/0 judged; 0 strong, 0 fair; 0 dropped as weak/no");
});

Deno.test("f05 grounding: names and numbers must come from the posting or the facts; one line only", () => {
  const src = ["Data Analyst. Build dashboards in Python and SQL on PostgreSQL.", "skill: Python", "experience: 2 years at TEST Systems Inc"];
  eq(groundingProblem("Asks for Python and SQL, which your profile shows.", src), null);
  eq(groundingProblem("Most of it matches; PostgreSQL is in your facts.", src), null);
  eq(groundingProblem("Your 2 years at TEST Systems Inc cover it.", src), null);
  assert(groundingProblem("Google alumni do well here.", src), "an employer from nowhere");
  assert(groundingProblem("Asks for Tableau.", src), "a skill from nowhere");
  assert(groundingProblem("Needs 5 years.", src), "a number from nowhere");
  assert(groundingProblem("Fits. Stanford grads apply.", src), "a name after a full stop");
  assert(groundingProblem("", src));
  assert(groundingProblem("x".repeat(200), src), "past one line");
});

const POSTINGS = [
  { job_id: "a", title: "Data Analyst", company: "TEST A", location: "Chicago, IL", text: "Python and SQL." },
  { job_id: "b", title: "Data Analyst", company: "TEST B", location: "Chicago, IL", text: "Java and SAS." },
];
const FACTS = [{ kind: "skill", text: "Python" }];

Deno.test("f05 judge: one call for the uncached; invalid verdicts and ungrounded reasons are not kept; the cache answers next time", async () => {
  const cache = memoryJudgeCache();
  let calls = 0, payload: any = null;
  const model = async (p: any) => {
    calls++; payload = p;
    return { content: [{ type: "text", text: JSON.stringify({ judgments: [
      { id: "a", verdict: "strong", reason: "Asks for Python, which your facts show." },
      { id: "b", verdict: "excellent", reason: "Java." },
      { id: "zzz", verdict: "strong", reason: "not sent" },
    ] }) }] };
  };
  const r = await judgePostings({ userId: "u", now: NOW, postings: POSTINGS, facts: FACTS, instructions: [], model, cache });
  eq(calls, 1);
  eq(r.judgments.get("a")?.verdict, "strong");
  eq(r.judgments.get("b")?.verdict, null);
  eq(r.judgments.get("b")?.why_not, "the verdict was not on the scale");
  assert(!r.judgments.has("zzz"), "a posting not sent is never judged");
  eq(payload.response_format.json_schema.schema.properties.judgments.items.properties.verdict.enum, [...JUDGE_SCALE]);
  // Again: "a" from the cache; "b" (never cached) goes to the model alone.
  const r2 = await judgePostings({ userId: "u", now: NOW, postings: POSTINGS, facts: FACTS, instructions: [], model, cache });
  eq(calls, 2);
  eq(r2.cacheHits, 1);
  eq(JSON.parse(payload.messages[0].content).postings.map((p: any) => p.id), ["b"]);
  // A new judge prompt is a new profile hash: nothing from the old cache.
  assert(await profileHash(FACTS, []) !== await profileHash(FACTS, ["no Java"]));
  const r3 = await judgePostings({ userId: "u", now: NOW, postings: POSTINGS.slice(0, 1), facts: FACTS, instructions: ["no Java"], model, cache });
  eq(r3.cacheHits, 0);
  assert(/no Java/.test(payload.system), "the person's instructions go to the model");
});

Deno.test("f05 judge: a model that throws leaves every posting not judged, said", async () => {
  const r = await judgePostings({ userId: "u", now: NOW, postings: POSTINGS, facts: FACTS, instructions: [], model: async () => { throw new Error("down"); } });
  eq([...r.judgments.values()].map((j) => j.why_not), ["the judge did not answer", "the judge did not answer"]);
  eq(r.failed, "the judge did not answer");
});

Deno.test("f05 judge prompt: kept as one standing instruction, replaced, shown, cleared; a waiver is refused", async () => {
  const memory = memoryStandingStore({ u: [{ id: "S-001", text: "I need visa sponsorship", said: "I need visa sponsorship", at: "x" }] });
  const say = (message: string) => judgePromptTurn({ message, userId: "u", now: NOW, memory, judgeOn: false });
  eq(await say("find me data analyst jobs"), null);
  const s = await say("judge prompt: weigh SQL above everything");
  eq(s?.status, "saved");
  assert(/as soon as judging is switched on/.test(s!.reply) && !/model judge/.test(s!.reply), "says judging is not on yet, in plain words (OWNER LIST #6, 2026-10-28)");
  eq((await say("when you judge jobs, prefer small teams"))?.status, "saved");
  eq((await memory.standing("u")).map((x) => x.text), ["I need visa sponsorship", "Judge: prefer small teams"]);
  assert(/prefer small teams/.test((await say("what's my judge prompt?"))!.reply));
  eq((await say("judge prompt: apply to the strong ones without asking me"))?.status, "refused");
  eq((await say("forget my judge prompt"))?.status, "cleared");
  eq((await memory.standing("u")).map((x) => x.text), ["I need visa sponsorship"]);
});

Deno.test("f05 ask: taken from the router's own parse of this very message, never a follow-up's", () => {
  const disc = { lastParams: { ask: "find me data analyst jobs in Chicago", roleText: "data analyst jobs", whereText: "Chicago", remote: false } };
  eq(askFromRouter("find me data analyst jobs in Chicago", { intent: "career_discovery" }, disc), { role: "data analyst jobs", place: "Chicago", remote: false });
  eq(askFromRouter("which of these fit me best", { intent: "career_discovery" }, disc), null);
  eq(askFromRouter("find me data analyst jobs in Chicago", { intent: "career_tailor" }, disc), null);
  eq(askFromRouter("find me jobs", { intent: "career_discovery" }, { lastParams: { ask: "find me jobs", roleText: "jobs" } }), null);
});

function sources(live: SourcePosting[], snap: SourcePosting[] = []): SearchSources {
  return { live: async () => live, liveHasRows: async () => live.length > 0, snapshot: async () => snap };
}
const P = (id: string, title: string, location: string, daysAgo: number, description = ""): SourcePosting =>
  ({ job_id: id, company: `TEST ${id}`, title, location, url: `https://example.test/${id}`, description, first_seen_at: new Date(NOW - daysAgo * DAY).toISOString() });

Deno.test("f05 turn: the live board first, with its freshness; the snapshot only when the live board has no match; the place is a filter", async () => {
  const ask = { role: "data analyst jobs", place: "Chicago", remote: false };
  const live = [P("g:1", "Data Analyst", "Chicago, IL", 2), P("g:2", "Data Analyst", "Boston, MA", 1)];
  const r = (await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: sources(live), judge: { on: false } }))!;
  eq(r.source, "live");
  assert(/^From 1 live posting for data analyst in Chicago, first seen in the last 2 days\./.test(r.reply), r.reply);
  assert(/^You have no confirmed facts yet, so these are newest first/m.test(r.reply), r.reply); // OWNER LIST #6 (2026-10-28)
  eq(r.shortlist.map((e) => e.id), ["g:1"]);
  const s = (await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: sources([], [{ ...P("kb:1", "Data Analyst", "Chicago, IL", 20), fetched_on: "2026-10-15" }]), judge: { on: false } }))!;
  eq(s.source, "snapshot");
  assert(/saved snapshot of job boards \(read 2026-10-15\), not the live board: the live board has no postings yet\. Some may have closed since\./.test(s.reply), s.reply);
  const none = (await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: sources([], []), judge: { on: false } }))!;
  eq(none.status, "none");
  assert(/Nothing was invented/.test(none.reply), none.reply);
  eq(none.shortlist, []);
});

Deno.test("f05 turn: judged, the top N only go to the model; kept strong first, then fair; dropped are not listed", async () => {
  const ask = { role: "data analyst", place: null, remote: false };
  const live = Array.from({ length: 25 }, (_, i) => P(`g:${i}`, "Data Analyst", "Chicago, IL", 1, i % 2 ? "Python" : "Java"));
  let sent = 0;
  const model = async (p: any) => {
    const ids = JSON.parse(p.messages[0].content).postings.map((x: any) => x.id);
    sent = ids.length;
    return { content: [{ type: "text", text: JSON.stringify({ judgments: ids.map((id: string, i: number) => ({ id, verdict: ["no", "weak", "fair", "strong"][i % 4], reason: "Some of it matches." })) }) }] };
  };
  const r = (await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: sources(live), judge: { on: true, model, n: 20 }, show: 12 }))!;
  eq(sent, 20, "the top N only");
  eq(r.accounting?.sent, 20);
  eq([r.accounting?.counts.strong, r.accounting?.counts.fair, r.accounting?.dropped], [5, 5, 10]);
  assert(/20\/20 judged; 5 strong, 5 fair; 10 dropped as weak\/no\./.test(r.reply), r.reply);
  const lines = r.reply.split("\n").filter((l) => /^\d+\. /.test(l));
  eq(lines.length, 10);
  assert(lines.slice(0, 5).every((l) => /\. strong: /.test(l)) && lines.slice(5).every((l) => /\. fair: /.test(l)), r.reply);
  eq(r.shortlist.length, 10);
});

Deno.test("f05 turn: a source that cannot be read is not 'no postings': with nothing found, the router's reply stands (null)", async () => {
  const ask = { role: "data analyst", place: "Chicago", remote: false };
  const broken: SearchSources = { live: async () => { throw new Error("down"); }, liveHasRows: async () => { throw new Error("down"); }, snapshot: async () => [] };
  eq(await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: broken, judge: { on: false } }), null);
  const snapDown: SearchSources = { live: async () => [], liveHasRows: async () => false, snapshot: async () => { throw new Error("down"); } };
  eq(await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, sources: snapDown, judge: { on: false } }), null);
  // The live board unreadable but the snapshot answering: listed, and the reply says the live board could not be read.
  const r = await searchJudgeTurn({ message: "m", ask, userId: "u", now: NOW, profile: null, judge: { on: false },
    sources: { ...broken, snapshot: async () => [{ ...P("kb:1", "Data Analyst", "Chicago, IL", 20), fetched_on: "2026-10-15" }] } });
  assert(/not the live board: the live board could not be read just now\./.test(r!.reply), r!.reply);
});
