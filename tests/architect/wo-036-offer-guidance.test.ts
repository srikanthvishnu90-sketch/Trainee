// WO-036 acceptance tests: the offer benchmark (offer_benchmark) and "how do I get into X" (career_path_answer).
// Contract in docs/architect/work-orders/WO-036-guidance-offer.md. Run: deno test -A --no-check tests/architect/wo-036-offer-guidance.test.ts
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { benchmarks, MIN_N, offerTurn, parseOfferWords, payData, saidIn } from "../../supabase/functions/_shared/career_offer.ts";
import { check, hiredDataLine, MAX_MOVES, pathAnswer } from "../../supabase/functions/_shared/career_path.ts";
import { CareerNegotiation, CareerPaths } from "../../supabase/functions/_shared/router_core.career.js";
import { HYGIENE } from "../../evals/career/compare.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const root = new URL("../../", import.meta.url);
const readJson = async (p: string) => JSON.parse(await Deno.readTextFile(new URL(p, root)));
const GUIDE = (CareerPaths as any).firmGuide();
const NOW = Date.UTC(2026, 9, 20, 15);

// Test fixtures built by the real importers from invented rows (tests/fixtures/career-pay); never DOL or BLS data.
async function fixtureData() {
  return { ...payData(), lca_wages: await readJson("tests/fixtures/career-pay/lca-wages.fixture.json"), oews_metro: await readJson("tests/fixtures/career-pay/oews-metro.fixture.json") };
}
// Plain text that reads the same on iMessage, WhatsApp and Telegram.
function plainText(messages: string[], where: string) {
  assert(messages.length > 0, `${where}: no messages`);
  for (const m of messages) {
    assert(m.length <= 1500, `${where}: a message of ${m.length} characters (max 1,500)`);
    for (const h of HYGIENE) if (h.id !== "too_long") assert(!h.test(m), `${where}: ${h.what}\n${m}`);
    assert(!/\[[^\]]*\]\(https?:/.test(m), `${where}: a markdown link`);
    for (const line of m.split("\n")) if (/https?:\/\//.test(line)) assert(/^https?:\/\/\S+$/.test(line.trim()), `${where}: a link not alone on its line: ${line}`);
  }
}
const PROFILES: Record<string, { id: string; kind: string; text: string }[]> = {
  empty: [],
  econ: [{ id: "F-001", kind: "education", text: "BS Economics at Rutgers, graduating May 2027" }, { id: "F-002", kind: "skill", text: "Python and SQL from two class projects" }],
  cs: [{ id: "F-010", kind: "education", text: "Junior at Georgia Tech, BS in Computer Science, class of 2028, GPA 3.6" }, { id: "F-011", kind: "skill", text: "Java, Python and C++; data structures and algorithms coursework" }, { id: "F-012", kind: "experience", text: "Software engineering internship at a fintech startup, summer 2026" }],
  mba: [{ id: "F-020", kind: "education", text: "MBA candidate at Wharton, graduating May 2027" }],
};

// ---------- the data file ----------
Deno.test("WO-036/T1 data file: 20+ target firms, every program, requirement and base rate with a URL and a checked date", () => {
  const firms: any[] = GUIDE.firms;
  assert(firms.length >= 20, `only ${firms.length} firms`);
  for (const id of ["palantir", "goldman-sachs", "jpmorgan", "mckinsey", "google", "jane-street", "citadel"]) assert(firms.some((f) => f.firm_id === id), `missing ${id}`);
  eq(GUIDE.hired_candidate_data.available, false, "hired-candidate data is not bought");
  const today = new Date(NOW).toISOString().slice(0, 10);
  const dated = (x: any, where: string) => {
    assert(/^https:\/\/[^\s]+\.[a-z]{2,}\//.test(x.source_url), `${where}: source_url ${x.source_url}`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(x.checked_at) && x.checked_at <= today, `${where}: checked_at ${x.checked_at}`);
  };
  for (const f of firms) {
    assert(f.programs.length >= 1, `${f.firm_id}: no program`);
    for (const p of f.programs) dated(p, `${f.firm_id} program ${p.name}`);
    for (const r of f.requirements) {
      dated(r, `${f.firm_id} ${r.id}`);
      assert(f.programs.some((p: any) => p.name === r.program), `${r.id}: names a program that is not listed`);
      assert(r.text && r.text.length >= 10, `${r.id}: the requirement in words`);
    }
    for (const b of f.base_rates || []) { dated(b, `${f.firm_id} ${b.id}`); assert(b.publisher && b.statement, `${b.id}: who published it`); }
    for (const n of f.not_required || []) dated(n, `${f.firm_id} not_required`);
  }
  assert(firms.reduce((n, f) => n + f.requirements.length, 0) >= 40, "requirements to derive moves from");
});

// ---------- the offer ----------
Deno.test("WO-036/T2 the offer is read from the person's words", () => {
  const o = parseOfferWords("JPM offered 110k base, 15k signing, NYC, analyst");
  eq([o.company, o.firm_id, o.base, o.signing, o.metro, o.role, o.occupation?.soc], ["JPMorganChase", "jpmorgan", 110000, 15000, "new-york", "analyst", "13-2051"]);
  eq(o.competing, [], "no competing offer was stated");
  const g = parseOfferWords("Goldman offered me $95,000 salary in New York as a summer analyst. I also have an offer from Citi at 105k. Need to answer by Friday");
  eq([g.company, g.base, g.metro, g.role], ["Goldman Sachs", 95000, "new-york", "summer analyst"]);
  eq(g.competing.map((c) => [c.company, c.base]), [["Citi", 105000]], "the competing offer is the one they named, not this offer's base");
  eq(g.deadline, { text: "Friday" });
  const h = parseOfferWords("Stripe is offering $60/hr as a software engineer intern in Seattle");
  eq([h.company, h.hourly, h.base, h.metro, h.occupation?.soc], ["Stripe", 60, 124800, "seattle", "15-1252"]);
  const consult = parseOfferWords("McKinsey offered 112k base as a business analyst in Chicago");
  eq([consult.occupation?.soc, consult.metro], ["13-1111", "chicago"]);
  const unknown = parseOfferWords("Acme Robotics offered 130k base, Denver, software engineer");
  eq([unknown.company, unknown.firm_id, unknown.base], ["Acme Robotics", null, 130000]);
  // A year, a count and an MS degree are not money or a company.
  const noise = parseOfferWords("I finish my MS in 2027 and have 2 offers");
  eq([noise.base, noise.firm_id], [null, null]);
});

// Architect amendment (owner decision 2026-11-13, D-078: confirm before compare): offer_benchmark shows its reading first
// (status "confirm") and only the person's plain yes to that reading, in the next turn, benchmarks and drafts. `yes` answers
// the reading shown; every assertion on the benchmarked reply is unchanged.
const yes = (t: ReturnType<typeof offerTurn>, data?: any) => t.result.status === "confirm" ? offerTurn({ words: "yes", pending: t.pending, now: NOW + 1000, data, lastReply: t.result.messages.join("\n") }) : t;
Deno.test("WO-036/T3 a missing piece is asked once, then what is still missing is said, never asked again", () => {
  const a = offerTurn({ words: "got an offer from Stripe, 150k", pending: null, now: NOW });
  eq(a.result.status, "ask");
  eq(a.result.missing, ["city", "role"]);
  eq(a.result.messages.length, 1);
  assert((a.result.messages[0].match(/\?/g) || []).length === 1, "one question");
  assert(a.pending, "the half-told offer waits");
  const b = yes(offerTurn({ words: "Seattle", pending: a.pending, now: NOW + 60_000 })); // Architect amendment (D-078)
  eq(b.result.status, "benchmarked", "asked once already: no second question");
  eq(b.result.missing, ["role"]);
  assert(b.result.messages[0].includes("Not given: the job title"), "says what is still missing");
  assert(!b.result.messages.some((m) => /what (is|are) (it|they)\?/i.test(m)), "never asks again");
  eq(b.pending, null);
  const full = yes(offerTurn({ words: "Stripe offered 150k base, software engineer in Seattle", pending: null, now: NOW })); // Architect amendment (D-078)
  eq(full.result.status, "benchmarked", "nothing missing, nothing asked");
  // A stale half-told offer does not leak into a new one.
  const later = offerTurn({ words: "Seattle", pending: a.pending, now: NOW + 3 * 86400_000 });
  eq(later.result.status, "ask");
});

Deno.test("WO-036/T4 a median from fewer than 5 filings is never a benchmark; every shown number says what it is, its period and its n", async () => {
  const data = await fixtureData();
  eq(MIN_N, 5);
  const gs = benchmarks(parseOfferWords("Goldman offered 100k base, NYC, analyst"), data);
  const lca = gs.find((b) => b.kind === "lca")!;
  eq([lca.shown, lca.n, lca.median], [false, 4, null], "4 filings: not shown");
  assert(/too few/.test(lca.reason!), lca.reason!);
  const gsReply = yes(offerTurn({ words: "Goldman offered 100k base, NYC, analyst", pending: null, now: NOW, data }), data).result; // Architect amendment (D-078)
  assert(!gsReply.messages.join("\n").includes("117,820"), "the n=4 median never appears");
  assert(gsReply.messages[0].includes("only 4 filings"), "says why it is left out");
  const jpm = yes(offerTurn({ words: "JPM offered 110k base, 15k signing, NYC, analyst", pending: null, now: NOW, data }), data).result; // Architect amendment (D-078)
  const shown = jpm.benchmarks.find((b) => b.kind === "lca")!;
  eq([shown.shown, shown.n, shown.median], [true, 5, 120000]);
  const text = jpm.messages[0];
  assert(text.includes("5 filings") && text.includes("FIXTURE Q0"), "n and period are said");
  assert(text.includes("Employers' filed wages for H-1B workers, not offers; a floor signal"), "what the number is");
  assert(/8% below the median/.test(text), "where the offer sits");
  const oews = jpm.benchmarks.find((b) => b.kind === "oews")!;
  eq([oews.shown, oews.median, oews.p25, oews.p75], [true, 120000, 90000, 160000]);
  // Top-coded BLS medians are not numbers.
  const sea = benchmarks(parseOfferWords("Stripe offered 180k base, Seattle, software engineer"), data);
  const seaOews = sea.find((b) => b.kind === "oews")!;
  eq(seaOews.shown, false);
  // With nothing imported (a dataset still awaiting its import), each source says "not loaded yet" and the national BLS
  // figure is labeled national. Built explicitly: the shipped files now carry CI's real import.
  const awaiting = (d: any) => ({ ...d, status: "awaiting_import", period: null, reference_period: null, cells: [] });
  const shipped = payData();
  const empty = { ...shipped, lca_wages: awaiting(shipped.lca_wages), oews_metro: awaiting(shipped.oews_metro) };
  const now = yes(offerTurn({ words: "JPM offered 110k base, 15k signing, NYC, analyst", pending: null, now: NOW, data: empty as any }), empty).result; // Architect amendment (D-078)
  assert(now.messages[0].includes("not loaded yet"), "a missing file is said, not filled");
  const nat = now.benchmarks.find((b) => b.kind === "bls_national")!;
  eq([nat.shown, nat.median, nat.period], [true, 101910, "May 2024"]);
  assert(now.messages[0].includes("nationwide; not the New York metro, not entry level"), "the caveat is plain");
});

Deno.test("WO-036/T4b the shipped data is CI's real import: a New York software offer gets a BLS metro benchmark with its period", () => {
  const shipped = payData();
  eq([shipped.oews_metro.status, shipped.lca_wages.status], ["imported", "imported"], "both datasets imported");
  const r = yes(offerTurn({ words: "Google offered 150k base, NYC, software engineer", pending: null, now: NOW })).result; // Architect amendment (D-078)
  const oews = r.benchmarks.find((b) => b.kind === "oews")!;
  assert(oews.shown && typeof oews.median === "number" && oews.median > 50000 && oews.median < 400000, JSON.stringify(oews));
  assert(/^May 20\d\d$/.test(String(oews.period)), `period is said: ${oews.period}`);
  assert(!r.messages.join("\n").includes("not loaded yet"), "nothing claims missing data when it is loaded");
  for (const b of r.benchmarks) if (b.kind === "lca" && b.shown) assert((b.n ?? 0) >= 5, "an LCA benchmark always has n >= 5");
});

Deno.test("WO-036/T5 the counter never invents a competing offer, a preference or a deadline", async () => {
  const data = await fixtureData();
  const none = yes(offerTurn({ words: "JPM offered 110k base, 15k signing, NYC, analyst", pending: null, now: NOW, data }), data).result; // Architect amendment (D-078)
  const draft = `${none.draft!.email}\n${none.draft!.call}`;
  assert(!/another offer|competing|other offer|second offer/i.test(draft), `invented a competing offer:\n${draft}`);
  assert(!/first choice|ready to sign|ready to accept|dream/i.test(draft), "invented a preference");
  assert(!/by (mon|tues|wednes|thurs|fri|satur|sun)day/i.test(draft), "invented a deadline");
  eq(none.draft!.sent, false);
  assert(none.messages.some((m) => m.includes("Nothing is sent")), "says nothing is sent");
  assert(none.messages.some((m) => m.includes(none.draft!.email)), "the draft is shown in full");
  const two = yes(offerTurn({ words: "Goldman offered me $95,000 salary in New York as a summer analyst. I also have an offer from Citi at 105k. Need to answer by Friday", pending: null, now: NOW, data }), data).result; // Architect amendment (D-078)
  const d2 = `${two.draft!.email}\n${two.draft!.call}`;
  assert(d2.includes("another offer from Citi with a base of $105,000"), "the stated competing offer, as stated");
  assert(d2.includes("by Friday"), "their actual deadline");
  eq((d2.match(/another offer/g) || []).length, 2, "once in the email, once on the call");
  // 128's script on its own: no competing offer in, none out, whatever the benchmark says.
  const s = (CareerNegotiation as any).factScript({ company: "X", role: "analyst", base: 90000 }, { benchmark: { median: 120000, cite: "A test citation" } });
  assert(!/another offer|competing/i.test(s.email + s.call), "128 factScript invented a competing offer");
  assert(s.email.includes("A test citation shows a median of $120,000"), "the benchmark is cited as given");
  eq(s.sends, false);
});

Deno.test("WO-036/T6 offer time: from the offer text to the reply, offline", () => {
  const t0 = performance.now();
  const r = yes(offerTurn({ words: "JPM offered 110k base, 15k signing, NYC, analyst", pending: null, now: NOW })); // Architect amendment (D-078): the reading, then the yes
  const ms = performance.now() - t0;
  eq(r.result.status, "benchmarked");
  assert(ms < 2000, `took ${ms.toFixed(0)} ms`);
  console.log(`WO-036 offer text to reply (code only, no model): ${ms.toFixed(1)} ms`);
});

// ---------- guidance ----------
Deno.test("WO-036/T7 every move cites the firm's stated requirement and the person's fact or gap; never more than 3", () => {
  let moves = 0;
  for (const f of GUIDE.firms) for (const [pname, facts] of Object.entries(PROFILES)) for (const role of ["", "software engineer", "analyst"]) {
    const r = pathAnswer({ firm: f.name, role, facts, tracked: [] });
    eq(r.status, "answered", f.name);
    assert(r.moves.length <= MAX_MOVES, `${f.name}: ${r.moves.length} moves`);
    const text = r.messages.join("\n");
    for (const m of r.moves) {
      moves++;
      assert(/^https:\/\//.test(m.requirement.source_url) && /^\d{4}-\d{2}-\d{2}$/.test(m.requirement.checked_at), `${f.name}/${pname}: move ${m.rank} has no source`);
      assert(m.requirement.text, `${f.name}/${pname}: move ${m.rank} names no requirement`);
      assert(m.fact || m.gap, `${f.name}/${pname}: move ${m.rank} cites neither a fact nor a gap`);
      if (m.fact) assert(facts.some((x) => x.id === m.fact!.id && x.text === m.fact!.text), `${f.name}: a fact that is not the person's`);
      assert(text.includes(m.requirement.source_url), `${f.name}: the move's source URL is in the reply`);
    }
    // The reply's move block: every numbered move is followed by its requirement and its fact or gap.
    const block = r.messages.find((x) => /^The (\d moves|one move) that matter/.test(x));
    if (r.moves.length) {
      assert(block, `${f.name}/${pname}: no move block`);
      const lines = block!.split("\n").slice(1);
      for (let i = 0; i < lines.length; i += 3) {
        assert(/^\d\. /.test(lines[i]), `${f.name}: move line ${lines[i]}`);
        assert(/^Their requirement: .+ \([a-z0-9.-]+\.[a-z]{2,}, checked \d{4}-\d{2}-\d{2}\)$/.test(lines[i + 1]), `${f.name}: requirement line ${lines[i + 1]}`);
        assert(/^(You: ".+" \(F-\d+\)|Gap: .+)/.test(lines[i + 2]), `${f.name}: fact or gap line ${lines[i + 2]}`);
      }
    }
  }
  assert(moves > 100, `only ${moves} moves checked`);
});

Deno.test("WO-036/T8 moves come from gaps: a fact outside the window rules a program out; a met requirement is not a gap", () => {
  const econ = pathAnswer({ firm: "Palantir", facts: PROFILES.econ });
  const window = econ.moves.find((m) => m.requirement.id === "palantir-r1")!;
  eq([window.status, window.fact?.id], ["unmet", "F-001"], "May 2027 is outside 'graduating in 2028'");
  const field = econ.moves.find((m) => m.requirement.id === "palantir-r3")!;
  eq([field.status, field.fact?.id], ["unmet", "F-001"], "Economics is not in their field list");
  const cs = pathAnswer({ firm: "Google", role: "software engineer", facts: PROFILES.cs });
  assert(!cs.moves.some((m) => m.status === "unmet" && !m.requirement.id.endsWith("-timeline")), "the CS profile meets Google's stated intern requirements");
  eq(check({ id: "x", program: "p", kind: "gpa", min: 3.2, text: "GPA 3.2", source_url: "https://a.b/", checked_at: "2026-10-20" }, PROFILES.cs).status, "met");
  eq(check({ id: "x", program: "p", kind: "degree_level", any: ["bachelor", "master"], not: ["mba"], text: "non-MBA", source_url: "https://a.b/", checked_at: "2026-10-20" }, PROFILES.mba).status, "unmet");
  eq(check({ id: "x", program: "p", kind: "grad_window", from: "2026-12", to: "2027-07", text: "Dec 2026 to Jul 2027", source_url: "https://a.b/", checked_at: "2026-10-20" }, PROFILES.econ).status, "met");
  // Nothing on the profile: every move is a gap, never a claim about the person.
  const empty = pathAnswer({ firm: "McKinsey", facts: [] });
  assert(empty.moves.every((m) => m.fact === null && m.gap), "no facts: gaps only");
  // A tracked application removes the "apply inside its window" move.
  const applied = pathAnswer({ firm: "Goldman Sachs", role: "summer analyst", facts: [], tracked: [{ company: "Goldman Sachs" }] });
  assert(!applied.moves.some((m) => m.requirement.id.endsWith("-timeline")), "already applied");
});

Deno.test("WO-036/T9 the missing hired-data line is always there, and no hired-candidate background is ever described", () => {
  const HIRED = /\b(hires|hired|new hires|alumni|people who got in|successful candidates|typical (?:hire|candidate|background)|most (?:hires|interns|analysts) (?:come|came|studied|went))\b/i;
  for (const f of GUIDE.firms) for (const facts of Object.values(PROFILES)) {
    const r = pathAnswer({ firm: f.name, facts });
    eq(r.hired_data, hiredDataLine(f.name));
    const text = r.messages.join("\n");
    assert(text.includes(`I don't have data on who ${f.name} actually hired yet.`), `${f.name}: the line is missing`);
    assert(!HIRED.test(text.replace(hiredDataLine(f.name), "")), `${f.name}: describes hired candidates:\n${text}`);
  }
  const unknown = pathAnswer({ firm: "Acme Robotics", facts: [] });
  eq(unknown.status, "no_record");
  assert(unknown.messages.join("\n").includes("I don't have data on who Acme Robotics actually hired yet."));
  eq(unknown.moves, [], "no requirements on file: no invented moves");
});

Deno.test("WO-036/T10 no probability without a cited base rate", () => {
  const ODDS = /\b\d+(?:\.\d+)?\s?%|\b(?:\d+ in \d+|one in \d+)\b|\b(?:chance|odds|likel(?:y|ihood)|probability) (?:is|are|of) (?:about |around )?\d/i;
  for (const f of GUIDE.firms) {
    const r = pathAnswer({ firm: f.name, facts: PROFILES.econ });
    const text = r.messages.join("\n");
    const sourced = (f.base_rates || []).filter((b: any) => b.source_url && b.checked_at && (b.rate_pct != null || b.applicants != null));
    if (!sourced.length) {
      eq(r.probability.kind, "none", f.name);
      assert(text.includes("No honest probability exists here"), `${f.name}: says no honest number exists`);
      assert(/What decides it: .*how you do in their interviews/.test(text), `${f.name}: says what would decide it`);
      assert(!ODDS.test(text), `${f.name}: a number that reads as odds:\n${text}`);
    } else {
      eq(r.probability.kind, "base_rate", f.name);
      assert(text.includes(sourced[0].statement) && text.includes(sourced[0].source_url), `${f.name}: the base rate with its source`);
      assert(text.includes("not your odds"), `${f.name}: a base rate is not a personal probability`);
    }
  }
  // A base rate with no source is not used.
  const guide = JSON.parse(JSON.stringify(GUIDE));
  const p = guide.firms.find((f: any) => f.firm_id === "palantir");
  p.base_rates = [{ id: "fake", statement: "Palantir accepts 2% of applicants", rate_pct: 2, publisher: "nobody", source_url: "", checked_at: "" }];
  const r = pathAnswer({ firm: "Palantir", facts: [], guide });
  eq(r.probability.kind, "none");
  assert(!r.messages.join("\n").includes("2%"), "an unsourced rate never appears");
});

Deno.test("WO-036/T11 plain text: every message of both tools, for every firm and profile", async () => {
  const data = await fixtureData();
  for (const f of GUIDE.firms) for (const [pname, facts] of Object.entries(PROFILES)) plainText(pathAnswer({ firm: f.name, facts }).messages, `${f.firm_id}/${pname}`);
  plainText(pathAnswer({ firm: "Acme Robotics", facts: [] }).messages, "no record");
  for (const words of ["JPM offered 110k base, 15k signing, NYC, analyst", "Goldman offered me $95,000 salary in New York as a summer analyst. I also have an offer from Citi at 105k. Need to answer by Friday",
    "Stripe is offering $60/hr as a software engineer intern in Seattle", "got an offer from Stripe, 150k", "Acme Robotics offered 130k base, Denver, software engineer"]) {
    for (const d of [undefined, data]) plainText(offerTurn({ words, pending: null, now: NOW, data: d }).result.messages, words);
  }
});

Deno.test("WO-036/T12 the brain tools: effects, descriptions that say when to use them, words only from this message", async () => {
  const tools = Object.fromEntries(careerTools({ postings: async () => [] }).map((t) => [t.name, t]));
  eq([tools.offer_benchmark.effect, tools.career_path_answer.effect], ["write_own", "read"]);
  assert(/^Use when the person texts a job offer/.test(tools.offer_benchmark.description));
  assert(/^Use for "how do I get into <firm>"/.test(tools.career_path_answer.description));
  eq(tools.career_path_answer.input_schema.required, ["firm"]);
  const state: Record<string, unknown> = {};
  const turn = (message: string) => ({ userId: "u1", threadId: "t1", now: NOW, state, turn: { message, added: [] as string[] } });
  let refused = "";
  try { await tools.offer_benchmark.run({ offer_words: "JPM offered 150k base" }, turn("JPM offered 110k base, 15k signing, NYC, analyst")); } catch (e) { refused = (e as Error).message; }
  assert(/own words/.test(refused), "a number the person did not say is refused");
  assert(!saidIn("JPM offered 110k base", "JPM offered 150k base"));
  const ask = await tools.offer_benchmark.run({}, turn("Got an offer from Stripe, 150k!")) as any;
  eq(ask.status, "ask");
  assert(state.offerBenchmark, "the half-told offer is kept on the thread");
  const shown = await tools.offer_benchmark.run({ offer_words: "software engineer in Seattle" }, turn("it's software engineer in Seattle")) as any;
  // Architect amendment (owner decision 2026-11-13, D-078): the reading is shown first; the person's yes in the next turn benchmarks.
  eq(shown.status, "confirm");
  const done = await tools.offer_benchmark.run({ offer_words: "yes" }, { ...turn("yes"), turn: { message: "yes", added: [] as string[], before: shown.messages.join("\n") } }) as any;
  eq([done.status, done.offer.company, done.offer.metro, done.draft.sent], ["benchmarked", "Stripe", "seattle", false]);
  eq(state.offerBenchmark, undefined, "cleared once benchmarked");
  // The guidance tool reads only confirmed facts.
  const c = { userId: "u1", threadId: "t2", now: NOW, state: {} as Record<string, any>, turn: { message: "I'm doing a BS in Computer Science, class of 2028", added: [] as string[] } }; // WO-061: a fact is saved only from the person's words
  await tools.add_profile_fact.run({ kind: "education", text: "BS Computer Science, class of 2028" }, c);
  const draftOnly = await tools.career_path_answer.run({ firm: "Palantir" }, c) as any;
  assert(draftOnly.moves.every((m: any) => m.fact === null), "a draft fact is not used");
  const id = c.state.profile.facts[0].id;
  await tools.confirm_profile_fact.run({ id }, { ...c, turn: { message: "yes that's right", added: [] } });
  const confirmed = await tools.career_path_answer.run({ firm: "Palantir", role: "software engineer" }, c) as any;
  assert(confirmed.moves.some((m: any) => m.fact?.id === id), "a confirmed fact is used");
});

Deno.test("WO-036/T13 the bundle carries the data (Deno has no packages/ directory at deploy)", async () => {
  const bundle = await Deno.readTextFile(new URL("supabase/functions/_shared/router_core.career.js", root));
  assert(bundle.includes("const CAREER_PAY_JSON = ") && bundle.includes("const CAREER_FIRM_GUIDE_JSON = "));
  eq(payData().maps.dataset_id, "pay-maps");
  eq(GUIDE.dataset_id, "firm-guide");
  const lca = payData().lca_wages;
  assert(lca.status === "awaiting_import" ? lca.cells.length === 0 : lca.status === "imported" && !!lca.period, "the shipped wage file is honest about its state");
});
