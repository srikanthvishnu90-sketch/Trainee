// D-069 (2026-11-12): the seven product bugs the real-input sets found (evals/real-sets/README.md, "Product findings"), each
// reproduced at $0 from the recorded real inputs: the 35 recorded postings (evals/real-sets/postings, sha256-checked), the 27
// hand-labelled pay figures (evals/real-sets/offers/figures.json) and the recorded job-board answers (evals/real-sets/research/
// boards, real bodies or their first roles unchanged, with the full body's size). No model, no network, nothing sent.
//
//   deno test -A --no-check tests/architect/d069-real-input-fixes-20261112.test.ts
// deno-lint-ignore-file no-explicit-any
import { CareerProfile, CareerTailor } from "../../supabase/functions/_shared/router_core.career.js";
import { boardPay, boardPayZones, PAY_MAX } from "../../supabase/functions/_shared/career_ingest.ts";
import { paysByPlace } from "../../supabase/functions/_shared/posting_pay.ts";
import { parseWorkdayCxs } from "../../supabase/functions/_shared/workday_posting.ts";
import { benchmarks, moneyIn, parseOfferWords } from "../../supabase/functions/_shared/career_offer.ts";
import { offerChatTurn } from "../../supabase/functions/_shared/career_offer_chat.ts";
import { boardVerdict, convertFree, freeProvider, freeReader, streamFree } from "../../supabase/functions/_shared/research_free_sources.ts";
import { BOARD_KEEP, jsonType, pruneJson } from "../../supabase/functions/_shared/json_stream.ts";
import { loadPostings } from "../../evals/real-sets/postings/postings.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const NOW = Date.UTC(2026, 10, 12, 15);
function assert(c: unknown, m = "assertion failed"): asserts c { if (!c) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const rec = async (f: string) => JSON.parse(await Deno.readTextFile(`${ROOT}evals/real-sets/postings/recorded/${f}`));
const board = async (n: string) => JSON.parse(await Deno.readTextFile(`${ROOT}evals/real-sets/research/boards/${n}.json`));
const manifest = async (n: string) => (JSON.parse(await Deno.readTextFile(`${ROOT}evals/real-sets/research/boards/manifest.json`)).boards as any[]).find((b) => b.name === n);

// ---------------------------------------------------------------- 1. skillEvidence: whole tokens, known aliases
async function persona(): Promise<any> {
  const text = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
  const prof = (CareerProfile as any).createProfile({ basics: { name: "Alex Testcase (TEST)" } });
  const r = (CareerProfile as any).ingestResume(prof, { text, fileName: "alex-testcase-test-resume.txt" });
  assert(r.ok, "the persona ingests");
  for (const f of prof.facts) (CareerProfile as any).confirmFact(prof, f.id);
  return prof;
}
Deno.test("D-069/1 skillEvidence: on the 35 real postings, R and SQL are never proven by a letter or by PostgreSQL; aliases are one skill", async () => {
  const prof = await persona(), P: any = CareerProfile;
  const rows = await loadPostings();
  eq(rows.length, 35, "the recorded postings");
  let named = 0;
  for (const row of rows) {
    for (const sk of (CareerTailor as any).skillsInText(row.description) as string[]) {
      named++;
      const ev = P.skillEvidence(prof, sk);
      for (const id of ev.supportingFactIds) {
        const f = P.getFact(prof, id);
        assert(P.textNamesSkill(f.text, sk) || (f.skills || []).some((s: string) => P.skillForms(sk).some((x: string) => x.toLowerCase() === String(s).toLowerCase())), `${row.job_id}: "${sk}" proven by a fact that does not name it: ${f.text}`);
      }
    }
  }
  assert(named > 35, "the postings name skills");
  // The two the set found: every fact has an r, and the persona names PostgreSQL, never SQL alone or R.
  eq(P.skillEvidence(prof, "R").supportingFactIds, [], "R is not proven by the letter r");
  eq(P.skillEvidence(prof, "SQL").supportingFactIds, [], "SQL is not proven by PostgreSQL");
  assert(P.skillEvidence(prof, "PostgreSQL").supportingFactIds.length > 0, "PostgreSQL is");
  eq(P.skillEvidence(prof, "Postgres").supportingFactIds, P.skillEvidence(prof, "PostgreSQL").supportingFactIds, "Postgres is PostgreSQL");
  // Case and punctuation.
  const p2 = { facts: [{ id: "a", kind: "experience", text: "Ran R&D reviews; led go-to-market; I excel at the rest of it" }, { id: "b", kind: "project", text: "Models in R, a REST API in Go, Node.js on k8s, CI/CD." }] };
  for (const [sk, want] of [["R", ["b"]], ["Go", ["b"]], ["REST", ["b"]], ["Excel", []], ["Kubernetes", ["b"]], ["Node.js", ["b"]], ["CI/CD", ["b"]], ["C", []], ["JavaScript", []]] as [string, string[]][]) eq(P.skillEvidence(p2, sk).supportingFactIds, want, sk);
});

// ---------------------------------------------------------------- 2 and 3. the offer: any place, any title, its own currency
const turns = async (msgs: string[]) => { let state: any = null, last: any = null; for (const m of msgs) { last = await offerChatTurn({ message: m, state, now: NOW, postings: null }); state = last.state; } return last; };
Deno.test("D-069/2 a non-USD offer keeps its currency everywhere; offers in two currencies are not converted or added", async () => {
  const o = parseOfferWords("Coinbase offered me AUD 87,600 base and a $10,000 signing bonus as a complaints analyst in Sydney");
  eq([o.company, o.base, o.currency, o.currencies?.signing, o.signing, o.place, o.title], ["Coinbase", 87600, "AUD", "USD", 10000, "Sydney", "complaints analyst"]);
  eq(benchmarks(o), [], "US data in dollars is never placed against an AUD offer");
  for (const [said, cur] of [["PLN 272,000", "PLN"], ["272,000 PLN", "PLN"], ["A$120k", "AUD"], ["€95,000", "EUR"], ["£70k", "GBP"], ["$110k", "USD"], ["110k", "USD"]]) eq(parseOfferWords(`Acme offered me ${said} base as a data analyst in Berlin`).currency, cur, said);
  const one = await turns(["Coinbase offered me AUD 87,600 base as a complaints analyst in Sydney"]);
  assert(one.answer && one.answer.status !== "ask", "kept without asking");
  assert(!/\$87,600/.test(one.answer.reply) && /AUD 87,600/.test(one.answer.reply), one.answer.reply);
  const two = await turns(["Discord offered me $116,000 base as a strategic finance analyst in San Francisco", "Dropbox offered me PLN 368,000 base and a $10,000 signing bonus as an infrastructure software engineer in Warsaw", "compare my offers"]);
  const cmp = two.answer.comparison, row = (i: number, k: string) => cmp.offers[i].rows.find((r: any) => r.k === k);
  eq(row(1, "Base").v, "PLN 368,000");
  eq(row(1, "Signing bonus").v, "$10,000");
  assert(/not added up/.test(row(1, "Guaranteed first-year cash").v) && !/\$378,000|378,000/.test(two.answer.reply), "PLN and USD never added");
  assert(/No sourced exchange rate is on file/.test(two.answer.reply), "the reply says the currencies differ and nothing is converted");
  assert(!/\$368,000/.test(two.answer.reply), "PLN never restated in dollars");
  eq(moneyIn(87600, "AUD"), "AUD 87,600");
});
Deno.test("D-069/3 the 27 real pay figures: every offer is kept (any place, any title the person states) and compared", async () => {
  const figs: any[] = JSON.parse(await Deno.readTextFile(`${ROOT}evals/real-sets/offers/figures.json`)).figures;
  eq(figs.length, 27);
  const an = (w: string) => /^[aeiou]/i.test(w) || /^AI\b/.test(w) ? "an" : "a";
  const said = (f: any, n: number) => f.currency !== "USD" ? `${f.currency} ${n.toLocaleString("en-US")}` : f.unit === "hour" || f.asker_unit === "hour" ? `$${n} an hour` : `$${n.toLocaleString("en-US")}`;
  let kept = 0;
  for (const f of figs) {
    const r = await offerChatTurn({ message: `${f.employer} offered me ${said(f, f.lo)} base as ${an(f.role)} ${f.role} in ${f.city}`, state: null, now: NOW, postings: null });
    const o = r.state?.offers?.at(-1)?.offer;
    if (r.answer && r.answer.status !== "ask" && o) {
      kept++;
      eq(o.company, f.employer, f.id);
      eq(o.currency, f.currency, `${f.id} currency`);
      assert(o.title === f.role.toLowerCase() || o.role === f.role, `${f.id} title "${o.title}" for "${f.role}"`);
      assert(o.place === f.city || o.city === f.city || (o.metro_label ?? "").includes(f.city.split(",")[0]) || o.metro_label, `${f.id} place`);
    } else throw new Error(`${f.id}: not kept (${r.answer?.reply})`);
  }
  eq(kept, 27);
  // The follow-up answers a person gives: the title alone, the place alone, or both.
  const t = await turns(["PayPal offered me $28 an hour", "I'm a cybersecurity intern in Austin"]);
  assert(t.answer?.status !== "ask", "both pieces taken from one answer");
  eq([t.state.offers.at(-1).offer.title, t.state.offers.at(-1).offer.hourly], ["cybersecurity intern", 28]);
  const p = await turns(["Zoox offered me $221,000 base as an embedded software engineer", "It's in San Diego"]);
  eq(p.state.offers.at(-1).offer.place, "San Diego");
});

// ---------------------------------------------------------------- 4. every pay zone stored
Deno.test("D-069/4 Robinhood's three zones are all stored as a structured array (the third did not fit in PAY_MAX)", async () => {
  const raw = await rec("greenhouse-robinhood-7263592.json");
  const text = boardPay("greenhouse", raw)!;
  assert(text.length <= PAY_MAX && !text.includes("Lake Mary"), "the column text still drops zone 3 (it is whole ranges in 200 characters)");
  const z = boardPayZones("greenhouse", raw);
  eq(z.length, 3);
  eq(z.map((x) => [x.min, x.max, x.currency]), [[166000, 195000, "USD"], [147000, 172000, "USD"], [130000, 152000, "USD"]]);
  eq(z[2].text, "$130,000–$152,000 (Zone 3 (Lake Mary, FL; Clearwater, FL; Gainesville, FL))");
  // Every recorded Greenhouse posting: each range the board states is a zone, none dropped.
  for (const r of (await loadPostings()).filter((x) => x.provider === "greenhouse")) eq(r.pay_zones.length, new Set((await rec(r.file)).pay_input_ranges?.filter((p: any) => p.min_cents > 0).map((p: any) => `${p.min_cents}-${p.max_cents}-${p.title}`) ?? []).size, r.job_id);
  // An Ashby tier and a Lever range keep their numbers, currency and period.
  const ash = boardPayZones("ashby", await rec("ashby-plaid-1bcfe93d-97bd-4618-b81e-dc308ef69d30.json"))[0];
  eq([ash.min, ash.max, ash.currency, ash.period, ash.label], [162000, 243600, "USD", "year", "Zone 1"]);
  const migration = await Deno.readTextFile(`${ROOT}supabase/migrations/20261112130000_career_postings_pay_zones.sql`);
  assert(/add column if not exists pay_zones jsonb/.test(migration), "stored in career_postings.pay_zones");
});

// ---------------------------------------------------------------- 5. Workday "City, State: (range)"
Deno.test("D-069/5 PayPal R0137491: Scottsdale's range is read from \"City, State: (range)\", San Jose's still is", async () => {
  const p = parseWorkdayCxs(await rec("workday-paypal-R0137491-1.json"), "https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/R0137491-1")!;
  eq(p.pays, [{ place: "San Jose, California", pay: "$116,500.00 - $173,250.00 Annually" }, { place: "Scottsdale, Arizona", pay: "$100,500.00 - $149,600.00 Annually" }]);
  // The bar form is still read (R0138587: four places).
  eq(parseWorkdayCxs(await rec("workday-paypal-R0138587.json"), "https://paypal.wd1.myworkdayjobs.com/en-US/jobs/job/R0138587")!.pays.length, 4);
  eq(paysByPlace("Hours: 9 to 5. Remote: (none)").length, 0, "a colon with no pay is not a pay");
});

// ---------------------------------------------------------------- 6 and 7. research: the company's own board, large boards read
// A body of the full recorded size from the recorded roles: the real roles repeated (ids made unique) until it is as large as
// the board was (Palantir's Lever 5,900,393 bytes; Notion's Ashby 2,892,173), sent with the board's own content type.
async function bigBody(name: string): Promise<{ body: string; type: string; roles: number }> {
  const m = await manifest(name), ex = await board(name);
  const list: any[] = Array.isArray(ex) ? ex : ex.jobs;
  const out: any[] = [];
  let size = 0;
  for (let i = 0; size < m.full_bytes; i++) { const j = { ...list[i % list.length], id: `${list[i % list.length].id}-${i}` }; out.push(j); size += JSON.stringify(j).length + 1; }
  const body = JSON.stringify(Array.isArray(ex) ? out : { ...ex, jobs: out });
  assert(body.length >= m.full_bytes, "as large as the real board");
  return { body, type: m.content_type, roles: out.length };
}
function fakeFetch(routes: Record<string, () => Promise<{ body: string; type: string }> | { body: string; type: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [k, v] of Object.entries(routes)) if (url.startsWith(k)) { const r = await v(); return new Response(new Blob([r.body]).stream(), { status: 200, headers: { "content-type": r.type } }); }
    if (/robots\.txt$/.test(url)) return new Response("", { status: 404 });
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
}
Deno.test("D-069/7 pruneJson reads a 5.9 MB board as a stream, keeps only the needed fields, and stops at its cap", async () => {
  const { body, roles } = await bigBody("lever-palantir");
  const got: any = await pruneJson(new Blob([body]).stream(), { keep: BOARD_KEEP.Lever, maxBytes: 16_000_000 });
  assert(got.ok, "read");
  eq(got.value.length, roles);
  eq(Object.keys(got.value[0]).sort(), ["categories", "hostedUrl", "id", "text"]);
  assert(JSON.stringify(got.value).length < body.length / 20, "only the needed fields are kept");
  const cap: any = await pruneJson(new Blob([body]).stream(), { keep: BOARD_KEEP.Lever, maxBytes: 2_000_000 });
  eq([cap.ok, cap.why], [false, "too_large"]);
  // Escapes, unicode, nesting; malformed bodies are refused.
  const e: any = await pruneJson(new Blob([`{"jobs":[{"title":"A \\"q\\" \\u00e9\\n","x":{"y":[1,{"z":"drop"}]},"location":"Kraków"}],"n":-1.5e3}`]).stream(), { keep: ["$.jobs[].title", "$.jobs[].location", "$.n"], maxBytes: 1e6 });
  eq(e.value, { jobs: [{ title: "A \"q\" é\n", location: "Kraków" }], n: -1500 });
  for (const bad of ['{"a":', '{"a":1}x', "[1,]", '{"a" 1}', "nul"]) eq((await pruneJson(new Blob([bad]).stream(), { keep: ["$.a"], maxBytes: 1e6 }) as any).ok, false, bad);
  assert(jsonType("application/json; charset=utf-8") && jsonType("application/vnd.api+json") && jsonType("text/json") && !jsonType("text/html") && jsonType("text/plain", true));
});
Deno.test("D-069/6+7 Palantir, Ramp, Notion and Plaid: the company's own board is found, read and cited; another company's is not", async () => {
  const ua = "TraineeBot/1.0 (+https://trainee.chat/bot) test";
  const gh = await board("greenhouse-ramp"), sr = await board("smartrecruiters-palantir");
  const mType = async (n: string) => (await manifest(n)).content_type;
  const cases: { company: string; site: string; routes: Record<string, any>; want: string; not?: string }[] = [
    { company: "Palantir", site: "palantir.com", want: "https://api.lever.co/v0/postings/palantir", not: "https://api.smartrecruiters.com/v1/companies/palantir/postings",
      routes: { "https://api.lever.co/v0/postings/palantir": () => bigBody("lever-palantir"), "https://api.smartrecruiters.com/v1/companies/palantir/postings": async () => ({ body: JSON.stringify(sr), type: await mType("smartrecruiters-palantir") }) } },
    { company: "Ramp", site: "ramp.com", want: "https://api.ashbyhq.com/posting-api/job-board/ramp", not: "https://boards-api.greenhouse.io/v1/boards/ramp/jobs",
      routes: { "https://api.ashbyhq.com/posting-api/job-board/ramp": () => bigBody("ashby-ramp"), "https://boards-api.greenhouse.io/v1/boards/ramp/jobs": async () => ({ body: JSON.stringify(gh), type: await mType("greenhouse-ramp") }) } },
    { company: "Notion", site: "notion.so", want: "https://api.ashbyhq.com/posting-api/job-board/notion", routes: { "https://api.ashbyhq.com/posting-api/job-board/notion": () => bigBody("ashby-notion") } },
    { company: "Plaid", site: "plaid.com", want: "https://api.ashbyhq.com/posting-api/job-board/plaid", routes: { "https://api.ashbyhq.com/posting-api/job-board/plaid": () => bigBody("ashby-plaid") } },
  ];
  for (const c of cases) {
    const f = fakeFetch(c.routes);
    const out = await freeProvider({ fetch: f, now: () => NOW, userAgent: ua }).search({ queries: [c.company], companies: [c.company], sites: [c.site] } as any);
    const boards = out.hits.filter((h) => h.provider === "ats_board").map((h) => h.url);
    assert(boards.some((u) => u.startsWith(c.want)), `${c.company}: its own board is proposed (${boards.join(", ")})`);
    if (c.not) { assert(!boards.some((u) => u.startsWith(c.not!)), `${c.company}: another company's board is not proposed`); assert(out.notes.some((n) => n.includes("Not used for")), "the left-out board is said"); }
    const read = await freeReader({ fetch: f, userAgent: ua, now: () => NOW, resolver: async () => ["8.8.8.8"] })(boards);
    const page = read.verified.find((v) => v.url.startsWith(c.want));
    assert(page, `${c.company}: the reader reads its board (refused: ${JSON.stringify(read.rejected)})`);
    assert(/lists [\d,]+ open roles/.test(page!.text), page!.text.slice(0, 200));
  }
  // The verdicts, from each board's own metadata.
  eq(boardVerdict("Ramp", "Greenhouse", gh, 0).verdict, "name", "RAMP names itself; with no link to ramp.com it ranks below the board that links it");
  eq(boardVerdict("Stripe", "Greenhouse", gh, 0).verdict, "other", "a board naming another company is never cited");
  eq(boardVerdict("Palantir", "SmartRecruiters", sr, 0).verdict, "name");
  eq(boardVerdict("Palantir", "Lever", [], 3).verdict, "domain");
  // streamFree takes only the board lists, with any JSON content type.
  assert(streamFree("https://api.ashbyhq.com/posting-api/job-board/plaid", "application/json; charset=utf-8"));
  assert(!streamFree("https://boards-api.greenhouse.io/v1/boards/stripe/jobs/1?content=true", "application/json"), "one posting is read as before");
  assert(convertFree("https://boards-api.greenhouse.io/v1/boards/ramp/jobs", "application/json", JSON.stringify(gh))!.text.includes("RAMP"));
});
