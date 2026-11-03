// RESEARCH AND COMPANY ANSWERS, ROUND 3 (architect, 2026-11-02; owner rule D-007, never invent a fact). ~10,000 seeded
// scenarios (tests/architect/scenarios/research-r3-generator.ts, a fresh seed) through the product's own pure code, every
// case carrying its own truth. Rounds 1 and 2 are scenarios-research.test.ts and scenarios-research-r2.test.ts; the sampled
// end-to-end run through the production handler on real Postgres is flow-scenarios-research-r3.test.ts.
//   A  pay        3,000 postings' pay as written (another country's dollar, a currency code before or after, €, £, ₹, a
//                 European thousands dot; per hour / year / month / week or none; "Up to" / "Starting at"; DOE; a signing
//                 bonus, relocation, funding or equity beside it) through payFrom (posting_pay.ts), statedPay and
//                 outsideLimits (posting_constraints.ts): the pay read is the posting's own words with its currency, its
//                 period, both ends of its range and its bound; no decoy is read as pay; a posting is dropped as "paying
//                 below the floor you named" only when it states a US-dollar hourly or yearly ceiling below that floor.
//   B  employer   1,500 searches "at <employer>" over look-alike, parent and subsidiary, renamed and non-English employers
//                 (searchTextOf, outsideLimits): the employer read is the whole name typed; a posting is kept exactly when its
//                 company is that name in whole words (accents folded), never on a substring ("Meta" is not Metabase).
//   C  money      2,500 replies about a tool's pay figures and counts through unsourcedFigures (agent/reply_guards.ts, the
//                 agent loop's figure check): a figure restated in another format passes; another currency, an invented
//                 range end, a changed decimal or scale, a conversion no source made, an invented figure and an invented
//                 head count ("hiring 500 people") are caught; a posting read as closed is said to be closed (closedNotes).
//   D  facts      1,500 web facts about layoffs, lawsuits, visa filings and pay through acceptFacts (agent/research/guard.ts),
//                 and 600 pairs of disagreeing sources through lintChat (chat.ts): an altered number, currency, year or
//                 firm is rejected, an injected instruction never kept; a paragraph that gives one of two conflicting
//                 figures is sent back, one that gives both (or neither) is not.
//   E  posting    1,000 posting texts through postingTextForModel (what get_posting hands the model): no sentence written to
//                 an AI survives, no sentence written to applicants is removed, and the 4,000-character cut never lands
//                 inside a figure. Plus research_reply.ts's bubble: a draft sentence with a number no page states is dropped,
//                 and a cut never leaves half a range.
// No network, no model, no database.
//   deno test -A --no-check tests/architect/scenarios-research-r3.test.ts
import assertNode from "node:assert/strict";
import { conflictCases, comparableTop, curOfText, employerCases, factCases, moneyCases, payCases, periodOfText, postingTextCases, rng, SEED } from "./scenarios/research-r3-generator.ts";
import { payFrom } from "../../supabase/functions/_shared/posting_pay.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { NO_LIMITS, outsideLimits, searchTextOf, statedPay } from "../../supabase/functions/_shared/posting_constraints.ts";
import { closedNotes, unsourcedFigures } from "../../supabase/functions/_shared/agent/reply_guards.ts";
import { acceptFacts } from "../../supabase/functions/_shared/agent/research/guard.ts";
import { lintChat } from "../../supabase/functions/_shared/agent/research/chat.ts";
import { clip } from "../../supabase/functions/_shared/agent/research/reply.ts";
import { buildResearchReply } from "../../supabase/functions/_shared/research_reply.ts";

type Fails = Map<string, string[]>;
const fail = (f: Fails, family: string, line: string) => { if (!f.has(family)) f.set(family, []); f.get(family)!.push(line); };
function report(f: Fails, total: number, what: string, extra = "") {
  const n = [...f.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[research-r3] ${what}: ${total} scenarios, ${n} failures${extra ? `; ${extra}` : ""}`];
  for (const [k, xs] of f) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  assertNode.equal(n, 0, `${what}: ${n} of ${total} failed (see the report above)`);
}
const numsOf = (s: string) => [...s.matchAll(/\d[\d,.]*/g)].map((m) => m[0].replace(/[.,]+$/, ""));
const plain = (s: string) => s.replace(/[.,\s]/g, "");

// ------------------------------------------------------------------------------------------------ A: pay
Deno.test("A. 3,000 postings' pay: the posting's own words, with its currency, period, both ends and bound; no decoy; dropped below a floor only on a comparable US-dollar ceiling", () => {
  const cases = payCases(rng(SEED), 3000);
  const f: Fails = new Map();
  for (const c of cases) {
    const got = payFrom(c.text), t = c.truth;
    const fam = c.family.split("+")[0];
    if (!t) { if (got !== null) fail(f, `no-pay read as pay`, `${c.text} -> ${got}`); }
    else if (!got) fail(f, `pay not read:${fam}`, c.text);
    else {
      const body = got.replace(/^(?:Up to|Starting at)\s+/, "");
      if (!c.text.includes(body)) fail(f, `not the posting's words:${fam}`, `${c.text} -> ${got}`);
      if (curOfText(got) !== t.cur) fail(f, `currency changed:${fam}`, `${c.text} -> ${got} (${curOfText(got)}, is ${t.cur})`);
      if (periodOfText(got) !== t.period) fail(f, `period changed:${fam}`, `${c.text} -> ${got} (${periodOfText(got)}, is ${t.period})`);
      const ns = numsOf(got).map(plain);
      const want = [t.lo, ...(t.hi != null ? [t.hi] : [])];
      // every end is in what was read (as written: "120,000", "120k", "120.000")
      for (const v of want) if (!ns.some((x) => x === String(v) || x === String(v / 1000) || x.replace(/k$/i, "") === String(v / 1000))) fail(f, `range end lost:${fam}`, `${c.text} -> ${got} (missing ${v})`);
      if ((t.bound ?? null) !== (/^(Up to|Starting at)\b/.exec(got)?.[1] ?? null)) fail(f, `bound lost:${fam}`, `${c.text} -> ${got} (is ${t.bound})`);
      for (const d of c.decoys) if (ns.includes(String(d))) fail(f, `decoy read as pay:${c.family}`, `${c.text} -> ${got}`);
    }
    // statedPay and the floor: a posting is dropped for pay only when it states a comparable ceiling under the floor.
    const top = comparableTop(t);
    const sp = statedPay({ description: c.text });
    if (!top && sp) fail(f, `a ceiling read where none is comparable:${fam}`, `${c.text} -> ${JSON.stringify(sp)}`);
    const floorHr = c.floor.period === "hour" ? c.floor.amount : c.floor.amount / 2080, floorYr = c.floor.period === "year" ? c.floor.amount : c.floor.amount * 2080;
    const below = !!top && ((top.hour != null && top.hour < floorHr) || (top.year != null && top.year < floorYr));
    const dropped = outsideLimits({ title: "Data Analyst", company: "TEST Co", description: c.text }, { ...NO_LIMITS, pay: c.floor }) === "pay";
    if (dropped !== below) fail(f, `${dropped ? "dropped as below the floor" : "kept though below the floor"}:${fam}`, `${c.text} floor ${JSON.stringify(c.floor)}`);
  }
  report(f, cases.length, "pay");
});

// ------------------------------------------------------------------------------------------------ B: employers
Deno.test("B. 1,500 searches at an employer: the whole name typed, kept on whole words (accents folded), never a look-alike", () => {
  const cases = employerCases(rng(SEED + 1), 1500);
  const f: Fails = new Map();
  for (const c of cases) {
    const l = searchTextOf(c.message).limits;
    if (l.company !== c.typed) { fail(f, `employer misread:${c.family}`, `${c.message} -> ${JSON.stringify(l.company)}`); continue; }
    if (/\b(?:at|with)\b/i.test(searchTextOf(c.message).role) || searchTextOf(c.message).role.split(" ").some((w) => w.length > 2 && c.typed.toLowerCase().includes(w) && !/analyst|engineer|software|financial|marketing|product|manager|data/.test(w))) fail(f, `employer left in the role:${c.family}`, `${c.message} -> role ${searchTextOf(c.message).role}`);
    for (const p of c.postings) {
      const kept = outsideLimits({ ...p, description: "" }, l) !== "company";
      if (kept !== c.is.has(p.company)) fail(f, `${kept ? "look-alike kept" : "the employer dropped"}:${c.family}`, `${c.message}: ${p.company}`);
    }
  }
  report(f, cases.length, "employer");
});

// ------------------------------------------------------------------------------------------------ C: money
Deno.test("C. 2,500 replies about a tool's pay: a restated figure passes; another currency, an invented end, a changed decimal or scale, a conversion, an invented figure are caught", () => {
  const cases = moneyCases(rng(SEED + 2), 2500);
  const f: Fails = new Map();
  for (const c of cases) {
    const flagged = unsourcedFigures(c.reply, c.sources);
    if (c.sourced && flagged.length) fail(f, `restated figure flagged:${c.family}`, `${c.reply} -> ${JSON.stringify(flagged)} | ${c.sources[1].slice(0, 160)}`);
    if (!c.sourced && !flagged.length) fail(f, `unsourced figure passed:${c.family}`, `${c.reply} | ${c.sources[1].slice(0, 160)}`);
  }
  // A closed posting the tool read this turn: a reply naming its employer without saying it closed gets code's note.
  const closedResult = JSON.stringify({ job_id: "greenhouse:r3:c", company: "TEST Contoso", title: "Data Analyst", closed: true, closed_on: "2026-09-15", pay: "$70,000 - $80,000 per year" });
  const openResult = closedResult.replace('"closed":true', '"closed":false');
  const closedAsks: [string, string, boolean][] = [["TEST Contoso pays $70,000 - $80,000 per year.", closedResult, true], ["The TEST Contoso posting has closed; it paid $70,000 - $80,000.", closedResult, false],
    ["TEST Contoso pays $70,000 - $80,000 per year.", openResult, false], ["That role is no longer open at TEST Contoso.", closedResult, false], ["Meta pays well.", closedResult, false]];
  for (const [reply, result, note] of closedAsks) {
    const got = closedNotes(reply, [result]);
    if (!!got.length !== note) fail(f, `closed note ${note ? "missing" : "added"}`, `${reply} -> ${JSON.stringify(got)}`);
    if (note && !got.some((x) => /closed on 2026-09-15/.test(x))) fail(f, "closed note without its date", JSON.stringify(got));
  }
  report(f, cases.length + closedAsks.length, "money");
});

// ------------------------------------------------------------------------------------------------ D: facts and conflicts
Deno.test("D. 1,500 web facts (layoffs, lawsuits, visa filings, pay) and 600 disagreeing pairs: altered or injected never kept; one of two conflicting figures never sent alone", () => {
  const cases = factCases(rng(SEED + 3), 1500);
  const f: Fails = new Map();
  for (const c of cases) {
    const { kept } = acceptFacts([c.fact as any], c.urls);
    if (!!kept.length !== c.keep) fail(f, `${kept.length ? "kept" : "rejected"}:${c.family}`, `${c.fact.text} | quote: ${c.fact.quote}`);
    for (const k of kept) if (/hiring 500|never had layoffs|every applicant|recommend this employer/i.test(k.text)) fail(f, `injected claim kept:${c.family}`, k.text);
  }
  const conflicts = conflictCases(rng(SEED + 4), 600);
  for (const c of conflicts) {
    const problems = lintChat(c.reply, { noLink: true, facts: c.facts, person: [], message: "what do they earn?" });
    const flagged = problems.some((p) => /sources disagree/.test(p));
    if (flagged !== c.picksOne) fail(f, `${flagged ? "conflict flagged though both or neither were given" : "one of two conflicting figures passed"}:${c.family}`, `${c.reply} | ${problems.join("; ")}`);
  }
  report(f, cases.length + conflicts.length, "facts");
});

// ------------------------------------------------------------------------------------------------ E: posting text and cuts
Deno.test("E. 1,000 posting texts for the model: no sentence to an AI survives, none to applicants is removed, the cut never lands in a figure; the research bubble drops unpaged numbers and half ranges", async () => {
  const cases = postingTextCases(rng(SEED + 5), 1000);
  const f: Fails = new Map();
  // What get_posting hands the model (careerTools, the brain's own tool), over a posting store of one row.
  let row: any = null;
  const getPosting = careerTools({ postings: async () => [], posting: async () => row } as any).find((x) => x.name === "get_posting")!;
  for (const [i, c] of cases.entries()) {
    row = { job_id: `greenhouse:r3:${i}`, company: "TEST Northwind", title: "Data Analyst", location: "Chicago, IL", url: "https://boards.greenhouse.io/r3/jobs/1", description: c.text };
    const got: any = await getPosting.run({ job_id: row.job_id }, {} as any);
    const out = { text: String(got.text ?? "") };
    for (const x of c.injected) if (out.text.includes(x)) fail(f, `injection kept:${c.family}`, x);
    if (c.injected.length && !/written to an AI/.test(String(got.note ?? ""))) fail(f, `injection removed without a word to the model:${c.family}`, JSON.stringify(got.note ?? null));
    if (/\$400,000/.test(String(got.pay ?? ""))) fail(f, `an injected figure read as the pay:${c.family}`, String(got.pay));
    for (const b of c.benign) if (!out.text.includes(b) && !(c.figure && out.text.endsWith("[cut]"))) fail(f, `applicant sentence removed:${c.family}`, b);
    if (c.figure && out.text.endsWith("[cut]")) {
      const tail = out.text.replace(/… \[cut\]$/, "");
      const last = tail.split(/\s+/).pop() ?? "";
      if (/\$\d/.test(last) && !c.figure.startsWith(last.replace(/[.,]+$/, "")) ) fail(f, `cut inside a figure:${c.family}`, last);
      if (/\$\d/.test(last) && last.replace(/[.,]+$/, "") !== c.figure) fail(f, `cut inside a figure:${c.family}`, `${last} of ${c.figure}`);
    }
    if (out.text.length > 4000 + 12) fail(f, `over the cap:${c.family}`, String(out.text.length));
  }
  // A closed posting says so, with the date it closed; an open one does not.
  for (const closed of [null, "2026-09-15T00:00:00Z"]) {
    row = { job_id: "greenhouse:r3:c", company: "TEST Contoso", title: "Data Analyst", url: "https://boards.greenhouse.io/r3/jobs/2", description: "Salary: $70,000 - $80,000 per year.", closed_at: closed, first_seen_at: "2026-08-01T00:00:00Z" };
    const got: any = await getPosting.run({ job_id: row.job_id }, {} as any);
    if (closed && !(got.closed === true && got.closed_on === "2026-09-15" && /closed/.test(String(got.status ?? "")))) fail(f, "closed posting not marked closed with its date", JSON.stringify(got).slice(0, 200));
    if (!closed && (got.closed || got.status)) fail(f, "open posting marked closed", JSON.stringify(got).slice(0, 200));
  }
  // The research bubble (research_reply.ts): a sentence whose number no page states is dropped; a cut never leaves half a range.
  const page = { url: "https://www.bls.gov/ooh/x.htm", status: 200, title: "OOH", text: "The median annual wage for financial analysts was $99,890 in May 2023. Employment is projected to grow 9 percent." } as any;
  const r = rng(SEED + 6);
  let bubbles = 0;
  for (let i = 0; i < 300; i++) {
    const invented = pick3(r, ["They are hiring 500 analysts this quarter.", "Pay is $250,000 at the top.", "Growth is 40 percent a year."]);
    const draft = { facts: `The median annual wage for financial analysts was $99,890 in May 2023. ${invented}`, limits: "These pages do not show pay at one firm.", interpretation: "", details: [{ text: "Median wage $99,890.", quote: "The median annual wage for financial analysts was $99,890 in May 2023.", url: page.url }] };
    const rep = await buildResearchReply({ question: "what do financial analysts earn?", draft, verified: [page] });
    bubbles++;
    if (rep.answer.includes(invented)) fail(f, "bubble: unpaged number kept", invented);
    if (!rep.answer.includes("$99,890")) fail(f, "bubble: the paged figure lost", rep.answer);
  }
  for (const [text, max] of [["Pay for analysts in the program runs from $80,000 to $95,000 a year at most firms and more in New York", 9], ["The range is between $120,000 and $140,000 for the first year", 6], ["Analysts are paid $45 to $60 an hour", 6]] as [string, number][]) {
    const c = clip(text, max);
    if (/\$[\d,]+$/.test(c) && /(?:to|and)\s*\$/.test(text.slice(c.length, c.length + 8))) fail(f, "clip: half a range", `${text} -> ${c}`);
    bubbles++;
  }
  report(f, cases.length + bubbles, "posting");
});
function pick3<T>(r: () => number, xs: T[]): T { return xs[Math.floor(r() * xs.length)]; }
