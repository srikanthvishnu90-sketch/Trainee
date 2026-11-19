// MASS APPLY CONVERSATIONS (2026-11-17): regressions from the review rv-ma7 of ag/ma-03 (probes x03, x03b), under the
// architect's rulings:
//   1 "that I qualify for" never queues and never decides eligibility: the postings found, each with the requirements it
//     states quoted as posted, "I couldn't confirm you're eligible", and one question; no "Ranked best fit"; no labels from facts.
//   2 any exclusion-like word left anywhere in the message that the clause did not consume queues nothing and is asked about;
//     a US state or major city ruled out is a place even with no posting there (a no-op, no question).
//   3 the thread-list "all of them except Stripe" path is trunk's, unchanged (a follow-up; not tested here).
// Fails on 81301b49a (the branch before this fix). No network, no database.
import assertNode from "node:assert/strict";
import { applyTurn } from "../../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../../supabase/functions/_shared/career_apply_want.ts";
import { memoryPostingsDb } from "../../../supabase/functions/_shared/career_ingest.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const T = Date.parse("2026-11-17T18:00:00Z");
let seq = 0;
const posting = (company: string, title: string, location: string, description = "Build product UI.") => {
  const i = ++seq;
  return { job_id: `greenhouse:y${i}:${5500 + i}`, provider: "greenhouse", board: `y${i}`, company, title, location, url: `https://boards.greenhouse.io/y${i}/jobs/${5500 + i}`,
    description, first_seen_at: new Date(T - i * 60000).toISOString(), last_seen_at: new Date(T).toISOString(), posted_at: null, closed_at: null } as any;
};
async function world(rows: any[], facts: any[] = []) {
  const db = memoryPostingsDb();
  await db.putMany(rows);
  const wants = memoryWantStore();
  const turn = (message: string) => applyTurn({ message, userId: "u1", now: T, wants, apps: async () => [], facts, shortlist: null,
    postings: { search: (w: string[], l: number) => db.search(w, l) }, resumeOnFile: async () => true });
  return { turn, companies: async () => (await wants.list("u1")).map((w) => w.company).sort() };
}
const ROWS = () => [posting("Northwind", "Software Engineering Intern", "Chicago, IL"), posting("Stripe", "Software Engineer Intern", "Chicago, IL"),
  posting("Google", "Software Engineer Intern", "Chicago, IL"), posting("Ohioco", "Software Engineer Intern", "Columbus, OH")];

// Every wording the review tried. Either nothing is queued (asked, or not this turn's), or exactly what was asked for: the
// postings in the place named, without Stripe when Stripe is named, without Ohio when Ohio is named. Never Stripe or Ohio.
const EX = ["skip Stripe and apply to every SWE internship in Chicago", "Except Stripe, apply to every SWE internship in Chicago", "not Stripe though. apply to every SWE internship in Chicago",
  "apply to every SWE internship in Chicago minus Stripe", "apply to every SWE internship in Chicago aside from Stripe", "apply to every SWE internship in Chicago apart from Stripe",
  "apply to every SWE internship in Chicago barring Stripe", "apply to every SWE internship in Chicago save Stripe", "apply to every SWE internship in Chicago with the exception of Stripe",
  "apply to every SWE internship in Chicago, Stripe excluded", "apply to every SWE internship in Chicago leaving out Stripe", "apply to every SWE internship in Chicago omit Stripe",
  "apply to every SWE internship in Chicago excl. Stripe", "apply to every SWE internship in Chicago (not Stripe)", "apply to every SWE internship in Chicago - not Stripe",
  "apply to every SWE internship in Chicago, Stripe's a no", "apply to every SWE internship in Chicago but stay away from Stripe", "apply to every SWE internship in Chicago not including Stripe",
  "apply to every SWE internship in Chicago excepting Stripe", "apply to every SWE internship in Chicago unless it's Stripe", "apply to every SWE internship in Chicago. I hate Stripe, leave it off",
  "apply to every SWE internship in Chicago except Stripe Inc", "apply to every SWE internship in Chicago except stripe.com", "apply to every SWE internship in Chicago — except Stripe",
  "apply to every SWE internship in Chicago except Stripe!", "apply to every SWE internship in Chicago except Stripe?", "apply me to every SWE internship in Chicago except Stripe",
  "please apply to every SWE internship in Chicago except Stripe", "go ahead and apply to every SWE internship in Chicago except Stripe", "apply to all SWE internships in Chicago, except Stripe",
  "apply to all the SWE internships in Chicago except Stripe", "apply to each SWE internship in Chicago except Stripe", "apply to every SWE internship in Chicago besides Stripe",
  "apply to every SWE internship in Chicago other than Stripe", "apply to every SWE internship in Chicago w/o Stripe", "apply to every SWE internship in Chicago sans Stripe",
  "apply to every SWE internship in Chicago, Stripe no", "apply to every SWE internship in Chicago except the Stripe one", "apply to every SWE internship in Chicago except for the one at Stripe",
  "apply to every SWE internship except at Stripe in Chicago", "apply to the top 5 SWE internships in Chicago except Stripe", "apply to the top 5 SWE internships in Chicago, skip Stripe",
  "apply to the top 5 SWE internships in Chicago not Stripe", "find SWE internships in Chicago except Stripe and apply to all of them", "find SWE internships in Chicago and apply to all of them except Stripe",
  "find SWE internships in Chicago, skip Stripe, and apply to all of them", "search SWE internships in Chicago and apply to them all but not Stripe",
  "apply to every SWE internship in Chicago except Stripe and the ones in Florida", "apply to every SWE internship except the ones in Florida", "apply to every SWE internship except Meta",
  "apply to every SWE internship except the ones in Ohio", "apply to every SWE internship not in Ohio", "apply to every SWE internship except Ohio", "apply to every SWE internship except Columbus",
  "apply to every SWE internship except the ones in OH", "apply to every SWE internship except the ones in Columbus, OH"];
Deno.test("2: every wording: never Stripe or Ohio when named; nothing queued, or exactly what was asked", async () => {
  for (const m of EX) {
    const w = await world(ROWS());
    const r = await w.turn(m);
    const got = await w.companies();
    const want = ["Google", "Northwind", "Ohioco", "Stripe"].filter((c) => !(/chicago/i.test(m) && c === "Ohioco")).filter((c) => !(/stripe/i.test(m) && c === "Stripe"))
      .filter((c) => !((/ohio|columbus/i.test(m) || /\bOH\b/.test(m)) && c === "Ohioco"));
    assert(!got.length || JSON.stringify(got) === JSON.stringify(want), `${m}: ${JSON.stringify(got)} / ${r?.reply}`);
    if (!got.length && r) eq(r.status, "none", `${m}: ${r.reply}`);
  }
});

Deno.test("2: an unread exclusion word queues nothing and names the words; postfix and prefix forms included", async () => {
  for (const [m, words] of [["Except Stripe, apply to every SWE internship in Chicago", "Except Stripe"], ["apply to every SWE internship in Chicago, Stripe excluded", "Stripe excluded"],
    ["apply to every SWE internship in Chicago, Stripe's a no", "Stripe's a no"], ["apply to every SWE internship in Chicago, Stripe no", "Stripe no"],
    ["apply to every SWE internship in Chicago unless it's Stripe", "unless it's Stripe"], ["apply to the top 5 SWE internships in Chicago, skip Stripe", "skip Stripe"]] as const) {
    const w = await world(ROWS());
    const r = await w.turn(m);
    eq([await w.companies(), r?.status], [[], "none"], `${m}: ${r?.reply}`);
    assert(r!.reply.includes("I couldn't read") && r!.reply.includes(words) && /Which employer or place/.test(r!.reply), r?.reply);
  }
});

Deno.test("2: a known state or city with no posting there is a place (a no-op, no question)", async () => {
  const a = await world(ROWS());
  await a.turn("apply to every SWE internship except the ones in Florida");
  eq(await a.companies(), ["Google", "Northwind", "Ohioco", "Stripe"]);
  const b = await world(ROWS());
  await b.turn("apply to every SWE internship in Chicago except Stripe and the ones in Florida");
  eq(await b.companies(), ["Google", "Northwind"]);
  const c = await world(ROWS());
  const r = await c.turn("apply to every SWE internship except Meta");
  eq([await c.companies(), r?.status], [[], "none"], `an unknown name is still asked about: ${r?.reply}`);
});

const SKILL = { kind: "skill", name: "Python", text: "Skill: Python" };
const EDU = { kind: "education", text: "B.S. Computer Science, UIUC, 2027", title: "B.S. Computer Science" };
const Q: [string, string | null, any[]][] = [
  ["Must be authorized to work in the United States.", "Must be authorized to work in the United States.", [SKILL, EDU]],
  ["Applicants must be U.S. citizens.", "Applicants must be U.S. citizens.", [SKILL, EDU]],
  ["Candidates must hold U.S. citizenship.", "Candidates must hold U.S. citizenship.", [SKILL, EDU]],
  ["US citizens only.", "US citizens only.", [SKILL, EDU, { kind: "citizenship", value: "not a US citizen", text: "Not a US citizen" }]],
  ["US citizens only.", "US citizens only.", [SKILL, EDU, { kind: "citizenship", value: "US citizen", text: "US citizen" }]],
  ["We will not sponsor visas.", "We will not sponsor visas.", [SKILL, EDU, { kind: "sponsorship", value: "needs sponsorship", text: "Needs visa sponsorship" }]],
  ["No sponsorship available.", "No sponsorship available.", [SKILL, EDU, { kind: "work_authorization", value: "F-1 visa", text: "F-1 visa (OPT)" }]],
  ["Open to students graduating in 2025.", "Open to students graduating in 2025.", [SKILL, EDU]],
  ["Minimum GPA of 3.7 required.", "Minimum GPA of 3.7 required.", [SKILL, EDU]],
  ["Must reside in Texas.", "Must reside in Texas.", [SKILL, EDU, { kind: "location", text: "Chicago, IL" }]],
  ["Fluency in Japanese is required.", "Fluency in Japanese is required.", [SKILL, EDU]],
  ["Active TS/SCI security clearance required.", "Active TS/SCI security clearance required.", [SKILL, EDU, { kind: "clearance", text: "Active TS/SCI security clearance" }]],
  ["Must be enrolled in a Master's program.", "Must be enrolled in a Master's program.", [SKILL, EDU]],
  ["Must be 18 years of age or older.", "Must be 18 years of age or older.", [SKILL, EDU]],
  ["Build product UI.", null, [{ kind: "other", text: "Interest: chess" }]],
];
Deno.test("1: 'that I qualify for' queues nothing, whatever the facts; each stated requirement quoted as posted; one question", async () => {
  for (const [desc, quote, facts] of Q) {
    const w = await world([posting("Acme", "Software Engineer Intern", "Chicago, IL", desc), posting("Plain", "Software Engineer Intern", "Chicago, IL")], facts);
    const r = await w.turn("apply to every SWE internship in Chicago that I qualify for");
    eq([await w.companies(), r?.status], [[], "none"], `${desc}: ${r?.reply}`);
    if (quote) assert(r!.reply.includes(`Acme (Chicago, IL): the posting says "${quote}"`), `${desc}: ${r?.reply}`);
    assert(/Plain \(Chicago, IL\): no citizenship, sponsorship, clearance, degree, graduation, residence, GPA, language or age requirement in its text/.test(r!.reply), r?.reply);
    assert(/I couldn't confirm you're eligible for them/.test(r!.reply) && /Which should I queue\? Say "all of them"/.test(r!.reply), r?.reply);
    assert(!/best fit|Ranked|Left out|Not checked|your confirmed facts|qualif(?:y|ied) for (?:it|them)/i.test(r!.reply.replace(/that I qualify for/g, "")), `no eligibility label: ${r?.reply}`);
    eq(((r as any).listed ?? []).map((e: any) => e.company).sort(), ["Acme", "Plain"], "the postings shown become the thread's list");
  }
});
