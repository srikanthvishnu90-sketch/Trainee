// INGEST ROUND 3 (2026-11-03): a fresh-seed battery of ~10,700 scenarios over parsing and merging posting data, in
// categories rounds 1 and 2 did not cover. Fake ATS boards serve each provider's public body shape from a canonical list
// (so what each board says, and what each text means as plain text, is known exactly); the store refuses what Postgres
// refuses (ingest-r2-world.ts pgLikeDb) and models the queue rule of 20261030110000_career_ingest_r2.sql (a posting that
// closes ends the applications still queued for it). Families:
//   markup   titles, places, departments and descriptions carrying tags, entities (named, numeric, escaped twice),
//            script / style / comment / iframe blocks (raw, escaped, never closed), bidi overrides, "<Remote>" as text
//   dates    posted dates in other zones, date-only, a few hours ahead, days or a year ahead, 1970, garbage, Workday's
//            "Posted 30+ Days Ago" read on a later day
//   pay      pay written with entities in a description ("$100,000&ndash;$120,000"); the pay column only from the
//            board's structured fields
//   place    Workday and Greenhouse places: "US Remote" / "Remote - US" / "USA - Remote", time zone only ("Remote (PST)"),
//            "3 Locations", "Remote - IN" (Indiana or India), en dashes
//   unicode  RTL titles with bidi controls, CJK, ZWJ emoji, combining marks, a title cut at 500 inside an emoji
//   paging   SmartRecruiters / Workday totals that lie low or high, a posting taken down mid-read (the next page skips one),
//            a cursor that repeats a page, a list an exact multiple of the page
//   empty    the scheduled handler over runs: 200 with an empty list during an outage, between good reads and failures
//   reuse    a board giving an id to another job, a title edited, a closed id reused, applications queued for each
//   migrate  one company on two ATS boards at once (a migration): never merged; the old board emptied
//   large    boards of 1,000 to 12,000 postings read over runs inside a posting budget and bounded memory
// Invariants: never close an open posting on a transient or empty read; never merge two different jobs; never store
// markup (a page shows a stored text escaped); dates and pay stay truthful (unknown stays unknown); each run inside its
// posting budget and memory bound; a queued application follows its posting's true state.
// Seeded, fakes at every boundary: no database, no network, no model.
import { boardFetchFeed, boardPay, EMPTY_AFTER, ingestBoards, INGEST_BATCH, type Board, type BoardOutcome, type FetchFeed, type IngestRunRow, type IngestStats, type Posting } from "../../../supabase/functions/_shared/career_ingest.ts";
import { streamProbe } from "../../../supabase/functions/_shared/career_ingest_stream.ts";
import { workdayPostedAt } from "../../../supabase/functions/_shared/career_ingest_feeds.ts";
import { boardKey, memoryBoardState } from "../../../supabase/functions/_shared/career_shards.ts";
import { handleIngest } from "../../../supabase/functions/career-ingest/handler.ts";
import { payFrom } from "../../../supabase/functions/_shared/posting_pay.ts";
import { postingCountry, postingPlaces } from "../../../supabase/functions/_shared/posting_place.ts";
import { postingScope } from "../../../supabase/functions/_shared/posting_region.ts";
import { esc } from "../../../supabase/functions/_shared/file_page.ts";
import { renderThings } from "../../../supabase/functions/_shared/results_page.ts";
import { atsId, canonUrl, pgLikeDb, rng, whose, type PgLike, type Provider, type Rng } from "./ingest-r2-world.ts";

export const T0 = Date.UTC(2026, 10, 3, 9, 7), MIN = 60000, H = 3600000, DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString();
export function ok(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
export function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x?.slice(0, 600)}\n  want: ${y?.slice(0, 600)}`); }
const sorted = (xs: Iterable<string>) => [...xs].sort();
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
export async function grade<S extends { id: string }>(name: string, xs: S[], run: (s: S) => Promise<void>) {
  const fails: string[] = [];
  for (const s of xs) { try { await run(s); } catch (e) { fails.push(`${s.id} ${JSON.stringify(s)}: ${(e as Error).message}`); } }
  if (fails.length) throw new Error(`${name}: ${fails.length} of ${xs.length} scenarios failed\n${fails.slice(0, 6).join("\n")}`);
}

// ------------------------------------------------------------------------------------------------ the boards
// One listing as a board states it. `title`, `loc`, `desc`, `dept` are what the board's body carries (markup and all);
// the oracle keeps the plain text they mean beside them.
export interface Listing { n: number; title: string; loc: string; desc: string; dept: string; posted?: unknown; postedOn?: string; pay?: unknown }
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export type PageMode = "clean" | "total_low" | "total_high" | "skip" | "repeat_later" | "exact";
export interface Srv { list: Listing[]; mode?: PageMode; lie?: number; skipAt?: number; status?: number; body?: string; etag?: boolean; served?: number }
export const PAGE_SIZE: Partial<Record<Provider, number>> = { smartrecruiters: 100, workday: 20 };

export function bodyOf(p: Provider, board: string, list: Listing[], page?: { offset: number; limit: number; total: number }): string {
  const id = (l: Listing) => atsId(p, l.n), url = (l: Listing) => canonUrl(p, board, l.n);
  switch (p) {
    case "greenhouse": return JSON.stringify({ jobs: list.map((l) => ({ id: Number(id(l)), title: l.title, location: { name: l.loc }, absolute_url: url(l), first_published: l.posted ?? null,
      content: htmlEsc(l.desc), departments: l.dept ? [{ name: l.dept }] : [], ...(l.pay ? { pay_input_ranges: l.pay } : {}) })), meta: { total: list.length } });
    case "lever": return JSON.stringify(list.map((l) => ({ id: id(l), text: l.title, categories: { location: l.loc, team: l.dept }, hostedUrl: url(l), applyUrl: `${url(l)}/apply`,
      ...(l.posted !== undefined ? { createdAt: l.posted } : {}), description: l.desc, ...(l.pay ? { salaryRange: l.pay } : {}) })));
    case "ashby": return JSON.stringify({ apiVersion: "1", jobs: list.map((l) => ({ id: id(l), title: l.title, locationName: l.loc, jobUrl: url(l), ...(l.posted !== undefined ? { publishedAt: l.posted } : {}),
      descriptionHtml: l.desc, departmentName: l.dept, ...(l.pay ? { compensation: { compensationTierSummary: l.pay } } : {}) })) });
    case "workable": return JSON.stringify({ name: "Acme", description: "", jobs: list.map((l) => ({ title: l.title, shortcode: id(l), department: l.dept, url: url(l), published_on: l.posted ?? null, city: l.loc, state: "", country: "", telecommuting: false, description: l.desc })) });
    case "recruitee": return JSON.stringify({ offers: list.map((l) => ({ id: Number(id(l)), title: l.title, careers_url: url(l), location: l.loc, department: l.dept, published_at: l.posted ?? null, description: l.desc, requirements: "", company_name: "Acme BV" })) });
    case "breezy": return JSON.stringify(list.map((l) => ({ id: id(l), name: l.title, url: url(l), published_date: l.posted ?? null, location: { name: l.loc, is_remote: false }, department: l.dept, description: l.desc })));
    case "bamboohr": return JSON.stringify({ meta: { totalCount: list.length }, result: list.map((l) => ({ id: id(l), jobOpeningName: l.title, departmentLabel: l.dept, atsLocation: { city: l.loc }, isRemote: false })) });
    case "teamtailor": return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:tt="https://teamtailor.com/locations"><channel><title>Acme AB</title><link>https://${board}.teamtailor.com/jobs</link>\n` +
      list.map((l) => `<item><title>${xmlEsc(l.title)}</title><description><![CDATA[${l.desc}]]></description>${l.posted ? `<pubDate>${xmlEsc(String(l.posted))}</pubDate>` : ""}<link>https://${board}.teamtailor.com/jobs/${id(l)}-associate</link><guid>g-${id(l)}</guid><remoteStatus>none</remoteStatus><tt:locations><tt:location><tt:name>${xmlEsc(l.loc)}</tt:name></tt:location></tt:locations><tt:department>${xmlEsc(l.dept)}</tt:department></item>`).join("\n") + "</channel></rss>";
    case "personio": return `<?xml version="1.0" encoding="UTF-8"?>\n<workzag-jobs>` + list.map((l) => `<position><id>${id(l)}</id><subcompany>Acme GmbH</subcompany><office>${xmlEsc(l.loc)}</office><department>${xmlEsc(l.dept)}</department><name>${xmlEsc(l.title)}</name><jobDescriptions><jobDescription><name>About</name><value><![CDATA[${l.desc}]]></value></jobDescription></jobDescriptions>${l.posted ? `<createdAt>${xmlEsc(String(l.posted))}</createdAt>` : ""}</position>`).join("") + "</workzag-jobs>";
    case "smartrecruiters": {
      const off = page?.offset ?? 0, lim = page?.limit ?? 100;
      return JSON.stringify({ offset: off, limit: lim, totalFound: page?.total ?? list.length, content: list.slice(off, off + lim).map((l) => ({ id: id(l), name: l.title, refNumber: `REF${l.n}`, location: { city: l.loc }, ...(l.posted !== undefined ? { releasedDate: l.posted } : {}), department: { label: l.dept } })) });
    }
    case "workday": {
      const off = page?.offset ?? 0, lim = page?.limit ?? 20;
      return JSON.stringify({ total: off === 0 ? (page?.total ?? list.length) : 0, jobPostings: list.slice(off, off + lim).map((l) => ({ title: l.title, externalPath: `/job/Austin-TX/${id(l)}`, locationsText: l.loc, postedOn: l.postedOn ?? "Posted 3 Days Ago", bulletFields: [id(l)] })), facets: [] });
    }
  }
}
function chunked(text: string, size: number, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(c) { if (i >= bytes.length) { c.close(); return; } c.enqueue(bytes.slice(i, i + size)); i += size; } }), { status: 200, headers });
}
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
// The fake network: each board's server by provider:board. A paged board pages (and misbehaves as its mode says).
export interface Net { srv: Map<string, Srv>; calls: { url: string; board: string }[] }
export function netFetch(net: Net, r: Rng): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const who = whose(url);
    if (!who) return new Response("no such host", { status: 599 });
    const key = `${who.provider}:${who.board.toLowerCase()}`;
    net.calls.push({ url, board: key });
    const s = net.srv.get(key);
    if (!s) return new Response("{}", { status: 404 });
    if (s.status) return new Response(s.body ?? "", { status: s.status });
    if (s.body !== undefined) return chunked(s.body, r.int(16, 70000));
    const size = PAGE_SIZE[who.provider];
    if (size) {
      const q = who.provider === "workday" ? JSON.parse(String(init?.body ?? "{}")) : Object.fromEntries(new URL(url).searchParams);
      let off = Number(q.offset || 0);
      const lim = Number(q.limit || size);
      s.served = (s.served ?? 0) + 1;
      if (s.mode === "repeat_later" && off >= 2 * lim) off -= lim; // the cursor hands back the page before
      const real = s.list.length;
      const total = s.mode === "total_low" ? Math.max(1, real - (s.lie ?? 1)) : s.mode === "total_high" ? real + (s.lie ?? 1) : real;
      const text = bodyOf(who.provider, who.board, s.list, { offset: off, limit: lim, total });
      // A posting taken down while the read is between pages: every later page moves up one place.
      if (s.mode === "skip" && s.skipAt !== undefined && off === 0) { s.list = s.list.filter((_, i) => i !== s.skipAt); s.skipAt = undefined; }
      return new Response(text, { status: 200 });
    }
    const text = bodyOf(who.provider, who.board, s.list);
    if (s.etag) {
      const tag = `"${fnv(text)}"`;
      if (new Headers(init?.headers).get("if-none-match") === tag) return new Response(null, { status: 304, headers: { etag: tag } });
      return chunked(text, r.int(16, 70000), { etag: tag });
    }
    return chunked(text, r.int(16, 70000));
  }) as unknown as typeof fetch;
}
const boardName = (p: Provider, r: Rng, tag = "") => p === "workday" ? `acme${tag}${r.int(1, 99)}.wd${r.int(1, 12)}/External_Careers` : `acme${tag}${r.int(1, 99999)}`;
const idOf = (p: Provider, board: string, n: number) => `${p}:${board.toLowerCase()}:${atsId(p, n)}`;

// The store: Postgres's refusals (ingest-r2-world.ts) and the queue rule of 20261030110000_career_ingest_r2.sql: a posting
// whose closed_at goes from null to a time ends every application still queued for it.
export interface App { job_id: string; title: string; state: "queued" | "not_submitted"; reason?: string }
export type QDb = PgLike & { apps: App[]; closes: { id: string; at: string }[] };
export function queueDb(): QDb {
  const db = pgLikeDb() as QDb;
  db.apps = []; db.closes = [];
  const close = db.close.bind(db);
  db.close = async (ids, at) => {
    const was = new Map((await db.getMany(ids)).map((p) => [p.job_id, p.closed_at]));
    await close(ids, at);
    for (const id of ids) {
      if (was.get(id) !== null) continue;
      db.closes.push({ id, at });
      for (const a of db.apps) if (a.job_id === id && a.state === "queued") Object.assign(a, { state: "not_submitted", reason: "posting_closed" });
    }
  };
  return db;
}
const feedOf = (net: Net, r: Rng, wholeMax = 2_000_000): FetchFeed => boardFetchFeed(netFetch(net, r), { stream: true, bodyHash: true, wholeMax, userAgent: "Trainee job alerts (contact: test)" });

// ------------------------------------------------------------------------------------------------ text: plain and dressed
const LEVELS = ["", "", "Senior ", "Staff ", "Junior ", "Lead "];
export const ROLES = ["Data Analyst", "Software Engineer", "Registered Nurse", "Pharmacy Technician", "R&D Lab Technician", "C++ <Remote> Engineer", "Q&A Specialist",
  "Café Barista", "Ingénieur Logiciel", "Développeur Full-Stack", "Werkstudent (m/w/d) Vertrieb", "مهندس برمجيات", "מהנדס תוכנה", "販売スタッフ", "Product Manager — Growth",
  "Customer Success Manager", "Line Cook $18/hr", "🚀 Growth Marketing Lead", "Account Executive – EMEA", "Nurse’s Aide", "Señor Contador", "Forklift Operator", "Tax Associate"];
const SUFFIX = ["", "", ", Payments", " (Nights)", " - Austin, TX", " 2026", " #4411"];
const PLACES = ["Austin, TX", "New York, NY; San Francisco, CA", "Remote - US", "São Paulo, Brazil", "Zürich, Switzerland", "Tel Aviv-Yafo, Israel", "Montréal, QC", "Dubai, UAE 🇦🇪", "London, England, United Kingdom", "Hybrid – Berlin"];
const DEPTS = ["Operations", "R&D", "Ventes & Marketing", "Engineering", "Pflege & Betreuung", "Customer Success"];
const SENTENCES = ["We’re looking for someone who cares about details.", "You’ll work with a small team – and own your projects.", "Café perks, a 401(k) match and health benefits.",
  "Résumés in English or français are welcome.", "Work “on site” three days a week.", "Training is provided — no experience needed.", "Our mission: make shopping simple for everyone."];
// Each pay as a board's HTML writes it, and what it says as plain text (payFrom reads both the same way).
export const PAY_FORMS: [string, string][] = [
  ["$100,000&ndash;$120,000 per year", "$100,000–$120,000 per year"], ["&euro;60,000 &ndash; &euro;75,000", "€60,000 – €75,000"],
  ["&pound;40,000&nbsp;-&nbsp;&pound;50,000 per annum", "£40,000 - £50,000 per annum"], ["$45&#8211;$55/hr", "$45–$55/hr"],
  ["CA$120,000 &mdash; CA$140,000", "CA$120,000 — CA$140,000"], ["$18.50&#x2013;$22.00 per hour", "$18.50–$22.00 per hour"], ["Up to &#36;90,000", "Up to $90,000"],
["$153,000&nbsp;&ndash;&nbsp;$221,000 USD", "$153,000 – $221,000 USD"],
  ["&#8364;48.000 &#8211; &#8364;56.000 brutto", "€48.000 – €56.000 brutto"], ["USD&nbsp;85,000 to USD&nbsp;95,000", "USD 85,000 to USD 95,000"], ["$32&ndash;$38 an hour", "$32–$38 an hour"],
];
const SCRIPTS = (n: number) => [`<script>var PWNED_${n}=1;</script>`, `&lt;script&gt;alert('PWNED_${n}')&lt;/script&gt;`, `&amp;lt;script&amp;gt;PWNED_${n}()&amp;lt;/script&amp;gt;`,
  `<style>.PWNED_${n}{color:red}</style>`, `<!-- PWNED_${n} -->`, `<noscript>PWNED_${n}</noscript>`, `<iframe src="https://example.test/x">PWNED_${n}</iframe>`, `<SCRIPT type="text/javascript">PWNED_${n}</SCRIPT>`];
const ENTITY_OF: Record<string, string[]> = { "é": ["&eacute;", "&#233;", "&#xE9;"], "è": ["&egrave;"], "ç": ["&ccedil;"], "ü": ["&uuml;"], "ã": ["&atilde;"], "ñ": ["&ntilde;"],
  "–": ["&ndash;", "&#8211;"], "—": ["&mdash;", "&#x2014;"], "’": ["&rsquo;", "&#8217;"], "“": ["&ldquo;"], "”": ["&rdquo;"], "<": ["&lt;", "&#60;"], ">": ["&gt;", "&#x3E;"], "€": ["&euro;"], "£": ["&pound;"] };
// The board's text for a plain one: entities for some characters, a word in a tag, a line break, bidi controls, script
// blocks. `html` false: no tag of any kind (a field a board gives as text).
export function dress(plain: string, r: Rng, n: number, o: { html?: boolean; scripts?: boolean } = {}): string {
  let t = plain;
  if (r.chance(0.6)) {
    t = t.replace(/&/g, () => (r.chance(0.7) ? "&amp;" : "&#38;"));
    t = [...t].map((c) => (ENTITY_OF[c] && r.chance(0.7) ? r.pick(ENTITY_OF[c]) : c)).join("");
  }
  if (r.chance(0.3)) { const at = t.indexOf(" "); t = at > 0 ? `${t.slice(0, at)}${r.pick(["\u202e", "\u2066", "\u202b"])} ${t.slice(at + 1)}${r.chance(0.5) ? "\u202c" : ""}` : `\u202e${t}`; }
  if (o.html !== false && r.chance(0.6)) {
    if (r.chance(0.3)) t = t.replace(" ", r.pick(["<br>", "<br/>", " <br /> "]));
    const words = t.split(" ");
    const i = r.int(0, words.length - 1);
    if (!/[<>&]/.test(words[i]) && words[i]) { const tag = r.pick(["b", "strong", "em", "span", "i"]); words[i] = `<${tag}${tag === "span" ? ' class="hl"' : ""}>${words[i]}</${tag}>`; }
    t = words.join(" ");
  }
  if (o.scripts !== false && r.chance(0.5)) {
    const s = r.pick(SCRIPTS(n));
    t = r.chance(0.5) ? `${s}${t}` : `${t} ${s}`;
    if (r.chance(0.15)) t = `${t} <script>PWNED_${n} never closed`;
  }
  return t;
}
const KNOWN_TAG = /<\/?(?:b|strong|em|span|i|br|p|div|script|style|noscript|iframe|h3)\b[^>]*>/i;
function plainOk(stored: string, what: string) {
  ok(!/PWNED/.test(stored), `${what}: a script's body stored: ${JSON.stringify(stored.slice(0, 200))}`);
  ok(!KNOWN_TAG.test(stored), `${what}: a tag stored: ${JSON.stringify(stored.slice(0, 200))}`);
  ok(!/&(?:amp|lt|gt|eacute|ndash|mdash|rsquo|euro|pound|nbsp|#\d+|#x[0-9a-f]+);/i.test(stored), `${what}: an entity stored: ${JSON.stringify(stored.slice(0, 200))}`);
  ok(!/[\u202a-\u202e\u2066-\u2069]/.test(stored), `${what}: a bidi override stored`);
}

// ------------------------------------------------------------------------------------------------ the scenarios
export interface S { id: string; seed: number; provider: Provider; kind?: string }
export const COUNTS = { markup: 2400, dates: 1500, pay: 900, place: 1000, unicode: 400, paging: 1500, empty: 1200, reuse: 1200, migrate: 500, large: 120 };
export type Family = keyof typeof COUNTS;
const MARKUP_P: Provider[] = ["greenhouse", "lever", "ashby", "workable", "recruitee", "breezy", "bamboohr", "teamtailor", "personio", "smartrecruiters", "workday"];
const DATE_P: Provider[] = ["greenhouse", "lever", "ashby", "workable", "recruitee", "breezy", "teamtailor", "personio", "smartrecruiters", "workday"];
const PAGE_MODES: PageMode[] = ["clean", "total_low", "total_high", "skip", "repeat_later", "exact"];
export function generate(): Record<Family, S[]> {
  const r = rng(20261103);
  const out = Object.fromEntries(Object.keys(COUNTS).map((k) => [k, [] as S[]])) as Record<Family, S[]>;
  const add = (f: Family, provider: Provider, kind?: string) => out[f].push({ id: `${f}-${out[f].length}`, seed: r.int(1, 2 ** 31), provider, ...(kind ? { kind } : {}) });
  for (let i = 0; i < COUNTS.markup; i++) add("markup", MARKUP_P[i % MARKUP_P.length]);
  for (let i = 0; i < COUNTS.dates; i++) add("dates", DATE_P[i % DATE_P.length]);
  for (let i = 0; i < COUNTS.pay; i++) add("pay", (["greenhouse", "lever", "ashby"] as Provider[])[i % 3]);
  for (let i = 0; i < COUNTS.place; i++) add("place", i % 3 ? "workday" : (["greenhouse", "lever"] as Provider[])[i % 2]);
  for (let i = 0; i < COUNTS.unicode; i++) add("unicode", (["greenhouse", "lever", "ashby", "personio", "teamtailor"] as Provider[])[i % 5]);
  for (let i = 0; i < COUNTS.paging; i++) add("paging", i % 2 ? "workday" : "smartrecruiters", PAGE_MODES[Math.floor(i / 2) % PAGE_MODES.length]);
  for (let i = 0; i < COUNTS.empty; i++) add("empty", MARKUP_P[i % MARKUP_P.length]);
  for (let i = 0; i < COUNTS.reuse; i++) add("reuse", DATE_P[i % DATE_P.length]);
  for (let i = 0; i < COUNTS.migrate; i++) add("migrate", (["greenhouse", "lever", "workday", "smartrecruiters", "workable"] as Provider[])[i % 5]);
  for (let i = 0; i < COUNTS.large; i++) add("large", (["greenhouse", "lever", "workday", "smartrecruiters"] as Provider[])[i % 4], i % 10 === 9 ? "huge" : "big");
  return out;
}

// ------------------------------------------------------------------------------------------------ markup
const HAS_DESC = (p: Provider) => !["bamboohr", "smartrecruiters", "workday"].includes(p);
const HAS_DEPT = (p: Provider) => p !== "workday";
export async function runMarkup(s: S) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  const net: Net = { srv: new Map(), calls: [] }, db = queueDb(), wholeMax = r.chance(0.5) ? r.int(200, 4000) : 2_000_000;
  const plain = new Map<number, { title: string; loc: string; dept: string; sentences: string[]; pay: string | null }>();
  const list: Listing[] = [];
  for (let n = 0, k = r.int(1, 12); n < k; n++) {
    const title = `${r.pick(LEVELS)}${r.pick(ROLES)}${r.pick(SUFFIX)}`, loc = r.pick(PLACES), dept = r.pick(DEPTS);
    const sentences = Array.from({ length: r.int(1, 3) }, () => r.pick(SENTENCES));
    const pay = r.chance(0.5) ? r.pick(PAY_FORMS) : null;
    plain.set(n, { title, loc, dept, sentences, pay: pay ? pay[1] : null });
    const html = `<div>${sentences.map((x) => `<p>${dress(x, r, n, { scripts: false })}</p>`).join(r.chance(0.5) ? r.pick(SCRIPTS(n)) : "")}${pay ? `<p>Pay: ${pay[0]}.</p>` : ""}${r.chance(0.5) ? r.pick(SCRIPTS(n)) : ""}</div>`;
    list.push({ n, title: dress(title, r, n), loc: dress(loc, r, n, { html: p !== "teamtailor" && p !== "personio" && r.chance(0.5) }), dept: dress(dept, r, n, { scripts: false }), desc: html });
  }
  net.srv.set(key, { list });
  const B: Board = { company: "Acme", provider: p, board };
  const st = await ingestBoards({ boards: [B], db, now: T0, useCursor: false, fetchFeed: feedOf(net, r, wholeMax), touchAfterMs: 6 * H });
  eq(st.failures, [], "the read succeeded");
  for (const [n, want] of plain) {
    const id = idOf(p, board, n), row = await db.get(id);
    ok(row, `${id}: stored`);
    eq(row.title, collapse(want.title), `${id}: the title is the plain text the board meant`);
    eq(row.location, collapse(want.loc), `${id}: the place is the plain text the board meant`);
    if (HAS_DEPT(p)) eq(row.department, collapse(want.dept), `${id}: the department is the plain text`);
    for (const k of ["title", "location", "department", "company", "description"] as const) plainOk(String(row[k] ?? ""), `${id} ${k}`);
    if (HAS_DESC(p)) {
      const d = collapse(row.description ?? "");
      for (const x of want.sentences) ok(d.includes(collapse(x)), `${id}: the description keeps "${x}": ${JSON.stringify(d.slice(0, 300))}`);
      eq(payFrom(d), want.pay ? payFrom(`Pay: ${want.pay}.`) : null, `${id}: the pay the description states, read as it states it`);
      if (want.pay) ok(payFrom(d), `${id}: a stated pay is read`);
    }
    eq(row.pay ?? null, null, `${id}: no structured pay: none stored (a description's figure never becomes the pay column)`);
    // The page shows it escaped: the title's own "<" (C++ <Remote>) as an entity, no script anywhere.
    if (n % 3 === 0) {
      const html = renderThings({ token: "t", ref: "r", title: row.title, company: row.company, link: null, questions: [] });
      ok(html.includes(esc(row.title)) && !/PWNED/.test(html), `${id}: rendered escaped`);
      if (row.title.includes("<")) ok(!html.includes(row.title), `${id}: a "<" in a title is never written raw into a page`);
    }
  }
  // A full re-read of the same body (no validators) changes nothing: the plain text is stable.
  const writes = db.writes;
  const st2 = await ingestBoards({ boards: [B], db, now: T0 + H, useCursor: false, fetchFeed: feedOf(net, r, wholeMax), touchAfterMs: 6 * H });
  eq([st2.new, st2.replaced ?? 0, st2.closed, db.writes - writes], [0, 0, 0, 0], "re-read: nothing new, replaced, closed or rewritten");
  eq(db.refused, [], "nothing refused by the table");
}

// ------------------------------------------------------------------------------------------------ dates
type DateKind = "past_zone" | "date_only" | "near_future" | "far_future" | "ancient" | "seconds" | "garbage" | "none";
const DATE_KINDS: DateKind[] = ["past_zone", "date_only", "near_future", "far_future", "ancient", "seconds", "garbage", "none"];
const ZONES = ["Z", "+05:30", "-08:00", "+14:00", "-12:00", "+09:00"];
const pad = (n: number) => String(n).padStart(2, "0");
// A time in a zone, as ISO 8601 with that offset.
function inZone(t: number, z: string): string {
  if (z === "Z") return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
  const sign = z[0] === "-" ? -1 : 1, [hh, mm] = z.slice(1).split(":").map(Number), off = sign * (hh * 60 + mm) * MIN;
  const d = new Date(t + off);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${z}`;
}
// The board's value for an instant, in its own format; and the instant (or NaN) the board means.
function dateFor(p: Provider, kind: DateKind, r: Rng, now: number): { v: unknown; t: number } {
  const z = r.pick(ZONES);
  const at = kind === "past_zone" ? now - r.int(1, 400) * H - r.int(0, 59) * MIN : kind === "near_future" ? now + r.int(1, 36) * H : kind === "far_future" ? now + r.int(3, 400) * DAY
    : kind === "ancient" ? Date.UTC(r.int(1960, 1994), r.int(0, 11), r.int(1, 28)) : NaN;
  if (kind === "none") return { v: undefined, t: NaN };
  if (kind === "garbage") return { v: r.pick(["not a date", "Invalid Date", "yesterday", "0000-00-00", "TBD"]), t: NaN };
  if (kind === "seconds") { const sec = Math.floor((now - r.int(1, 90) * DAY) / 1000); return p === "lever" ? { v: sec, t: sec } : { v: String(sec), t: NaN }; }
  if (kind === "date_only") { const d = new Date(now - r.int(1, 60) * DAY); const s = d.toISOString().slice(0, 10); return { v: s, t: Date.parse(s) }; }
  if (p === "lever") return { v: at, t: at };
  if (p === "teamtailor") return { v: new Date(at).toUTCString().replace("GMT", "+0000"), t: Math.floor(at / 1000) * 1000 };
  if (p === "recruitee") { const s = new Date(at).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC"); return { v: s, t: Math.floor(at / 1000) * 1000 }; }
  return { v: inZone(at, z), t: Math.floor(at / 1000) * 1000 };
}
const truthful = (t: number, now: number) => Number.isFinite(t) && t >= Date.UTC(1995, 0, 1) && t <= now + 2 * DAY ? iso(t) : null;
const WD_POSTED = ["Posted Today", "Posted Yesterday", "Posted 2 Days Ago", "Posted 7 Days Ago", "Posted 29 Days Ago", "Posted 30+ Days Ago", "Posted Recently", ""];
export async function runDates(s: S) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  // Workday states an age the reader reads against the real clock; its scenarios run on it.
  const now = p === "workday" ? Date.now() : T0;
  const net: Net = { srv: new Map(), calls: [] }, db = queueDb();
  const list: Listing[] = [], want = new Map<number, string | null>(), seeded = new Map<number, string>();
  for (let n = 0, k = r.int(1, 10); n < k; n++) {
    const title = `${r.pick(ROLES.slice(0, 4))} ${n}`;
    if (p === "workday") {
      const postedOn = r.pick(WD_POSTED);
      list.push({ n, title, loc: "Austin, TX", desc: "", dept: "", postedOn });
      const at = workdayPostedAt(postedOn, now);
      want.set(n, at ? truthful(Date.parse(at), now) : null);
      // Read on an earlier day: the date stored then is earlier than today's reading of "N Days Ago" and stays.
      if (at && r.chance(0.5)) {
        const earlier = iso(Date.parse(at) - r.int(1, 5) * DAY);
        seeded.set(n, earlier);
        await db.putMany([{ job_id: idOf(p, board, n), provider: p, board, ats_id: atsId(p, n), company: "Acme", title, location: "Austin, TX", url: canonUrl(p, board, n), description: "",
          department: "", posted_at: earlier, first_seen_at: iso(now - 6 * DAY), last_seen_at: iso(now - 6 * DAY), closed_at: null, remote: "onsite" } as Posting]);
        want.set(n, earlier);
      }
      continue;
    }
    const kind = r.pick(DATE_KINDS), d = dateFor(p, kind, r, now);
    list.push({ n, title, loc: "Austin, TX", desc: "Plain description.", dept: "Ops", posted: d.v });
    want.set(n, truthful(d.t, now));
  }
  net.srv.set(key, { list });
  const B: Board = { company: "Acme", provider: p, board };
  const st = await ingestBoards({ boards: [B], db, now, useCursor: false, fetchFeed: feedOf(net, r), touchAfterMs: 6 * H });
  eq(st.failures, [], "the read succeeded");
  for (const [n, w] of want) {
    const row = await db.get(idOf(p, board, n));
    ok(row, `${n}: stored`);
    const got = row.posted_at ? iso(Date.parse(row.posted_at)) : null;
    eq(got, w, `${row.job_id}: posted ${JSON.stringify(list[n].posted ?? list[n].postedOn)}: the instant the board means when it can be true, else unknown`);
    if (got) ok(Date.parse(got) <= now + 2 * DAY, `${row.job_id}: a posted date in the future`);
    if (seeded.has(n)) eq(row.first_seen_at, iso(now - 6 * DAY), `${row.job_id}: the same job: first seen kept`);
  }
  // Read again a day on: nothing rewritten, dates as they were.
  const writes = db.writes;
  await ingestBoards({ boards: [B], db, now: now + H, useCursor: false, fetchFeed: feedOf(net, r), touchAfterMs: 6 * H });
  eq(db.writes - writes, 0, "re-read: dates stable, nothing rewritten");
}

// ------------------------------------------------------------------------------------------------ pay
const GH_RANGES = [null, [{ min_cents: 10000000, max_cents: 12000000, currency_type: "USD", title: "US" }], [{ min_cents: 1750, max_cents: 2250, currency_type: "USD", title: "Hourly" }]];
const LEVER_RANGES = [null, { min: 85000, max: 95000, currency: "USD", interval: "per-year-salary" }, { min: 17.5, max: 22, currency: "USD", interval: "per-hour-wage" }];
const ASHBY_TEXT = [null, "$190K – $262K", "€100K – €120K"];
export async function runPay(s: S) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  const net: Net = { srv: new Map(), calls: [] }, db = queueDb();
  const list: Listing[] = [], forms = new Map<number, [string, string]>();
  for (let n = 0, k = r.int(1, 8); n < k; n++) {
    const form = r.pick(PAY_FORMS);
    forms.set(n, form);
    const structured = p === "greenhouse" ? r.pick(GH_RANGES) : p === "lever" ? r.pick(LEVER_RANGES) : r.pick(ASHBY_TEXT);
    list.push({ n, title: `Data Analyst ${n}`, loc: "Austin, TX", dept: "Ops", desc: `<p>${r.pick(SENTENCES)}</p><p>${r.pick(["Pay", "Salary", "Compensation", "The range"])}: ${form[0]}.</p>`, pay: structured ?? undefined });
  }
  net.srv.set(key, { list });
  await ingestBoards({ boards: [{ company: "Acme", provider: p, board }], db, now: T0, useCursor: false, fetchFeed: feedOf(net, r) });
  const raw = JSON.parse(bodyOf(p, board, list));
  const rawJobs: any[] = p === "lever" ? raw : raw.jobs;
  for (const [n, [, plainPay]] of forms) {
    const row = await db.get(idOf(p, board, n));
    ok(row, `${n}: stored`);
    const want = payFrom(`Pay: ${plainPay}.`);
    ok(want, `the oracle reads ${plainPay}`);
    eq(payFrom(row.description), want, `${row.job_id}: the description's pay read as written: ${JSON.stringify(row.description?.slice(0, 200))}`);
    plainOk(row.description ?? "", `${row.job_id} description`);
    // The pay column: the board's structured fields only, as round 2 writes them; none stated, none stored.
    eq(row.pay ?? null, boardPay(p, rawJobs[n]), `${row.job_id}: the pay column is the board's structured pay, never the description's`);
  }
}

// ------------------------------------------------------------------------------------------------ place
// Each place text with what it settles: country ("us", "abroad", "" unsettled), whether it says remote, and the regions a
// remote posting is open to.
export const PLACE_LABELS: [string, "us" | "abroad" | "", boolean, string[]][] = [
  ["US Remote", "us", true, ["us"]], ["Remote - US", "us", true, ["us"]], ["Remote US", "us", true, ["us"]], ["US-Remote", "us", true, ["us"]], ["USA - Remote", "us", true, ["us"]],
  ["United States - Remote", "us", true, ["us"]], ["Remote, USA", "us", true, ["us"]], ["Remote (United States)", "us", true, ["us"]], ["Remote – US", "us", true, ["us"]],
  ["Remote — United States", "us", true, ["us"]], ["Texas Remote", "us", true, ["us"]], ["Remote in Texas", "us", true, ["us"]], ["Remote - TX", "us", true, ["us"]],
  ["Remote (PST)", "", true, []], ["Remote - Pacific Time", "", true, []], ["Remote (EST)", "", true, []], ["Remote, Eastern Time Zone", "", true, []], ["Remote (CET +/- 2)", "", true, []],
  ["Remote - GMT+1", "", true, []], ["Remote (ET)", "", true, []], ["Remote - PT", "", true, []], ["Remote (UTC-5 to UTC-8)", "", true, []], ["Remote - Americas", "", true, []],
  ["Remote - IN", "", true, []], ["Remote - DE", "", true, []], ["Remote - CA", "", true, []], ["Remote (IL)", "", true, []],
  ["Remote - Canada", "abroad", true, ["canada"]], ["Canada Remote", "abroad", true, ["canada"]], ["Remote – Germany", "abroad", true, ["germany"]],
  ["Austin, TX", "us", false, []], ["Berlin, Germany", "abroad", false, []], ["2 Locations", "", false, []], ["3 Locations", "", false, []], ["12 Locations", "", false, []],
  ["Austin, TX; US Remote", "us", true, ["us"]], ["New York, NY; Remote - US", "us", true, ["us"]], ["Toronto, ON; Remote - Canada", "abroad", true, ["canada"]],
];
export async function runPlace(s: S) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  const net: Net = { srv: new Map(), calls: [] }, db = queueDb();
  const list: Listing[] = [], labels = new Map<number, (typeof PLACE_LABELS)[number]>();
  for (let n = 0, k = r.int(1, 6); n < k; n++) {
    const lab = r.pick(PLACE_LABELS);
    labels.set(n, lab);
    // The board writes its dashes as entities now and then (Greenhouse, Lever); Workday as text.
    const loc = p === "workday" ? lab[0] : lab[0].replace(/–/g, () => (r.chance(0.5) ? "&ndash;" : "–")).replace(/—/g, () => (r.chance(0.5) ? "&mdash;" : "—"));
    list.push({ n, title: `Data Analyst ${n}`, loc, desc: "Plain.", dept: "Ops" });
  }
  net.srv.set(key, { list });
  await ingestBoards({ boards: [{ company: "Acme", provider: p, board }], db, now: T0, useCursor: false, fetchFeed: feedOf(net, r) });
  for (const [n, [text, country, remote, scope]] of labels) {
    const row = await db.get(idOf(p, board, n));
    ok(row, `${n}: stored`);
    eq(row.location, text, `${row.job_id}: the place as the board wrote it, as text`);
    const parts = postingPlaces(row.location ?? "");
    eq(postingCountry(parts), country, `${text}: the country it settles (${JSON.stringify(parts)})`);
    eq(parts.some((x) => x.remote), remote, `${text}: says remote`);
    ok(!parts.some((x) => /\b(pst|est|cet|gmt|utc|time|zone|pt|et|locations?|americas)\b/i.test(x.city)), `${text}: a zone or a count read as a city: ${JSON.stringify(parts)}`);
    eq(postingScope({ location: row.location, remote: remote ? "remote" : "onsite" }).sort(), [...scope].sort(), `${text}: the regions a remote posting is open to`);
  }
}

// ------------------------------------------------------------------------------------------------ unicode
const RTL = ["مهندس برمجيات أول", "מהנדס תוכנה בכיר", "محلل بيانات", "אחות מוסמכת"];
const OTHER = ["販売スタッフ（パート）", "软件工程师", "데이터 분석가", "👩\u200d💻 Software Engineer", "Ingénieur(e) Logiciel (H/F)", "Café Barista", "Ελληνικά Υπάλληλος"];
export async function runUnicode(s: S) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  const net: Net = { srv: new Map(), calls: [] }, db = queueDb();
  const list: Listing[] = [], plain = new Map<number, string>();
  const bidi = (t: string) => { const w = t.split(" "); const i = r.int(0, w.length - 1); w[i] = `${r.pick(["\u202b", "\u202e", "\u2067", "\u2068"])}${w[i]}${r.pick(["\u202c", "\u2069", ""])}`; return w.join(" "); };
  for (let n = 0, k = r.int(1, 8); n < k; n++) {
    let t = r.chance(0.5) ? r.pick(RTL) : r.pick(OTHER);
    if (r.chance(0.15)) t = "x".repeat(499) + "🚀 Lead"; // cut at 500 inside the emoji
    plain.set(n, t);
    list.push({ n, title: r.chance(0.7) ? bidi(t) : t, loc: "Tel Aviv-Yafo, Israel", desc: `<p dir="rtl">${t}</p>`, dept: "R&D" });
  }
  net.srv.set(key, { list });
  const B: Board = { company: "Acme", provider: p, board };
  await ingestBoards({ boards: [B], db, now: T0, useCursor: false, fetchFeed: feedOf(net, r), touchAfterMs: 6 * H });
  const first = new Map<string, string>();
  for (const [n, t] of plain) {
    const row = await db.get(idOf(p, board, n));
    ok(row, `${n}: stored`);
    const want = t.length > 500 ? "x".repeat(499) : t;
    eq(row.title, want, `${row.job_id}: the title without its bidi controls, cut between characters`);
    plainOk(row.title, row.job_id);
    first.set(row.job_id, row.first_seen_at);
  }
  // The board writes its bidi marks differently on the next read: the same jobs, nothing rewritten, nothing replaced.
  for (const l of list) l.title = r.chance(0.5) ? bidi(plain.get(l.n)!) : plain.get(l.n)!;
  const writes = db.writes;
  const st = await ingestBoards({ boards: [B], db, now: T0 + H, useCursor: false, fetchFeed: feedOf(net, r), touchAfterMs: 6 * H });
  eq([st.replaced ?? 0, st.new, db.writes - writes], [0, 0, 0], "bidi marks moved: the same jobs, not rewritten");
  for (const [id, f] of first) eq((await db.get(id))?.first_seen_at, f, `${id}: first seen kept`);
}

// ------------------------------------------------------------------------------------------------ paging
export async function runPaging(s: S) {
  const r = rng(s.seed), p = s.provider, mode = s.kind as PageMode, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  const size = PAGE_SIZE[p]!, net: Net = { srv: new Map(), calls: [] }, db = queueDb();
  const n0 = mode === "exact" ? size * r.int(2, 5) : r.int(size * 2 + 5, size * 5 - 1);
  const mk = (n: number): Listing => ({ n, title: `${r.pick(ROLES.slice(0, 4))} ${n}`, loc: "Austin, TX", desc: "", dept: "Ops" });
  const L1 = Array.from({ length: n0 }, (_, i) => mk(i));
  net.srv.set(key, { list: L1 });
  const B: Board = { company: "Acme", provider: p, board };
  const outcomes: BoardOutcome[] = [];
  const read = (at: number) => ingestBoards({ boards: [B], db, now: at, useCursor: false, fetchFeed: feedOf(net, r), onBoard: (_b, o) => { outcomes.push(o); } });
  await read(T0);
  eq(outcomes[0].status, "ok", "a clean first read");
  const open = async () => sorted((await db.open()).map((x) => x.job_id));
  eq(await open(), sorted(L1.map((l) => idOf(p, board, l.n))), "every page read");
  // The second read: a few taken down for real, a few added, served as the mode says.
  let L2 = L1.filter(() => r.chance(0.97));
  if (mode === "exact") L2 = L1.slice(0, size * r.int(1, Math.floor(n0 / size)));
  L2.push(...Array.from({ length: mode === "exact" ? 0 : r.int(0, 4) }, (_, i) => mk(5000 + i)));
  const srv: Srv = { list: L2, mode, lie: r.int(1, Math.max(1, Math.floor(L2.length / 3))) };
  if (mode === "skip") srv.skipAt = r.int(0, Math.min(size, L2.length) - 1);
  net.srv.set(key, srv);
  const before = await open();
  const st = await read(T0 + 7 * H);
  const o = outcomes.at(-1)!;
  const listedNow = new Set(srv.list.map((l) => idOf(p, board, l.n))), listedAtStart = new Set(L2.map((l) => idOf(p, board, l.n)));
  const after = await open();
  // Never: a posting the board still lists closed.
  for (const id of listedNow) if (before.includes(id)) ok(after.includes(id), `${mode}: ${id} is listed and was closed (total ${srv.list.length}${srv.lie ? `, lie ${srv.lie}` : ""})`);
  const complete = mode === "clean" || mode === "exact" || mode === "total_low";
  if (complete) {
    eq(o.status, "ok", `${mode}: the whole list was read`);
    eq(after, sorted(listedNow), `${mode}: the board's postings, exactly`);
  } else {
    ok(o.status === "partial" || (o.status === "ok" && mode === "skip" && srv.list.length === L2.length), `${mode}: not the whole list: a partial read (${o.status})`);
    eq(st.closed, 0, `${mode}: a partial read closes nothing`);
    for (const id of before) ok(after.includes(id), `${mode}: ${id} closed by a partial read`);
  }
  // A clean read again: exactly the board.
  net.srv.set(key, { list: srv.list });
  await read(T0 + 14 * H);
  eq(outcomes.at(-1)!.status, "ok", "clean again");
  eq(await open(), sorted(srv.list.map((l) => idOf(p, board, l.n))), "clean again: the board's postings, exactly");
}

// ------------------------------------------------------------------------------------------------ the scheduled handler
export const SECRET = () => ["s", "e", "c"].join("").repeat(14);
interface Runs { rows: (IngestRunRow & { id: number })[] }
function deps(o: { boards: Board[]; db: QDb; state: ReturnType<typeof memoryBoardState>; feed: FetchFeed; at: number; runs: Runs; env?: Record<string, string> }) {
  const env: Record<string, string> = { CAREER_INGEST_SECRET: SECRET(), INGEST_CONTACT_EMAIL: "ops@example.test", INGEST_EVERY_MIN: "15", INGEST_CONCURRENCY: "4", ...(o.env ?? {}) };
  const store = Object.assign(o.db, {
    async recordRun(_s: IngestStats, _at: string) {},
    async startLaneRun(x: { at: string; lane: number; lanes: number; window_min: number }) { const id = o.runs.rows.length + 1; o.runs.rows.push({ id, ...x } as any); return id; },
    async finishLaneRun(id: number, row: IngestRunRow) { Object.assign(o.runs.rows[id - 1], row); },
  });
  return { env: { get: (k: string) => env[k] }, boards: o.boards, now: () => o.at, db: () => store, state: () => o.state, fetchFeed: () => o.feed };
}
// One run a window: a lane run takes every board of these small directories (capacityPer), each due board read every run.
const post = () => new Request("https://fn.test/?lane=0&lanes=1&window_min=15", { method: "POST", headers: { "x-trainee-ingest-secret": SECRET() } });
const waitMs = (f: number) => (f < 2 ? 0 : Math.min(24 * H, 2 ** (f - 2) * H));

// ------------------------------------------------------------------------------------------------ empty
export async function runEmpty(s: S) {
  const r = rng(s.seed), net: Net = { srv: new Map(), calls: [] }, db = queueDb(), state = memoryBoardState(), runs: Runs = { rows: [] };
  const feed = feedOf(net, r, r.chance(0.5) ? 400 : 2_000_000);
  interface Wd { p: Provider; board: string; list: Listing[]; next: number; streak: number; fails: number; last: number | null; ans: string }
  const ws: Wd[] = [];
  for (let i = 0, k = r.int(1, 3); i < k; i++) {
    const p = i === 0 ? s.provider : r.pick(MARKUP_P), board = boardName(p, r, `e${i}`);
    if (ws.some((w) => w.p === p && w.board.toLowerCase() === board.toLowerCase())) continue;
    ws.push({ p, board, list: Array.from({ length: r.int(1, 25) }, (_, n) => ({ n, title: `${r.pick(ROLES.slice(0, 4))} ${n}`, loc: "Austin, TX", desc: "Plain.", dept: "Ops" })), next: 100, streak: 0, fails: 0, last: null, ans: "list" });
  }
  const boards: Board[] = ws.map((w) => ({ company: "Acme", provider: w.p, board: w.board }));
  const key = (w: Wd) => `${w.p}:${w.board.toLowerCase()}`;
  for (let run = 0, runsN = r.int(5, 10); run < runsN; run++) {
    const at = T0 + run * 61 * MIN;
    for (const w of ws) {
      w.ans = run === 0 ? "list" : r.pick(["list", "empty", "empty", "empty", "empty", "down", "bad", "change", "empty_then"] as const);
      if (w.ans === "change") { w.list = w.list.filter(() => r.chance(0.8)); w.list.push(...Array.from({ length: r.int(0, 3) }, () => ({ n: w.next++, title: `Barista ${w.next}`, loc: "Austin, TX", desc: "Plain.", dept: "Ops" }))); }
      const etag = r.chance(0.5);
      net.srv.set(key(w), w.ans === "empty" || w.ans === "empty_then" ? { list: [], etag } : w.ans === "down" ? { list: [], status: r.pick([503, 429, 500]) }
        : w.ans === "bad" ? { list: [], body: r.pick(["{}", "null", "<html>Maintenance</html>"]) } : { list: w.list, etag });
      // Someone queued an application to an open posting of this board.
      const openRows = (await db.open()).filter((x) => x.provider === w.p && x.board === w.board);
      if (openRows.length && r.chance(0.4)) { const x = r.pick(openRows); db.apps.push({ job_id: x.job_id, title: x.title, state: "queued" }); }
    }
    const before = new Map<string, string[]>();
    for (const w of ws) before.set(key(w), sorted((await db.open()).filter((x) => x.provider === w.p && x.board === w.board).map((x) => x.job_id)));
    const due = new Set(ws.filter((w) => w.last === null || at - w.last >= waitMs(w.fails)).map(key));
    net.calls.length = 0;
    const res = await handleIngest(post(), deps({ boards, db, state, feed, at, runs }) as any);
    ok(res.status === 200, `run ${run}: ${res.status} ${await res.clone().text()}`);
    const read = new Set(net.calls.map((c) => c.board));
    for (const w of ws) {
      const k = key(w), b4 = before.get(k)!, now = sorted((await db.open()).filter((x) => x.provider === w.p && x.board === w.board).map((x) => x.job_id));
      eq(read.has(k), due.has(k), `run ${run} ${k}: read when due`);
      if (!read.has(k)) { eq(now, b4, `run ${run} ${k}: not read, unchanged`); continue; }
      w.last = at;
      const row = state.rows.get(boardKey({ provider: w.p, board: w.board }))!;
      if (w.ans === "down" || w.ans === "bad") { w.fails++; w.streak = 0; eq(now, b4, `run ${run} ${k} ${w.ans}: a failed read closes nothing`); continue; }
      w.fails = 0;
      const listed = w.ans === "empty" || w.ans === "empty_then" ? [] : sorted(w.list.map((l) => idOf(w.p, w.board, l.n)));
      if (!listed.length && b4.length) {
        w.streak++;
        if (w.streak < EMPTY_AFTER) { eq(now, b4, `run ${run} ${k}: an empty list (${w.streak} in a row) closes nothing`); }
        else eq(now, [], `run ${run} ${k}: ${w.streak} empty lists in a row: closed`);
        eq(row.last_status, `ok [empty x${w.streak}]`, `run ${run} ${k}: the board's state counts the empty reads`);
        eq([row.etag, row.body_sha ?? null], w.streak < EMPTY_AFTER ? [null, null] : [row.etag, row.body_sha ?? null], `run ${run} ${k}: a held read keeps no validators`);
      } else {
        w.streak = 0;
        eq(now, listed, `run ${run} ${k} ${w.ans}: the board's postings, exactly`);
        ok(!/empty/.test(row.last_status ?? ""), `run ${run} ${k}: the count starts again: ${row.last_status}`);
      }
    }
    // Queued applications follow their posting: ended when it closed (never by a held read), never waiting on a closed
    // posting; one ended stays ended if the posting reopens (the person approves again).
    for (const a of db.apps) {
      const x = await db.get(a.job_id);
      if (x!.closed_at) eq(a.state, "not_submitted", `${a.job_id}: closed: its application ends`);
      if (a.state !== "queued") ok(db.closes.some((c) => c.id === a.job_id), `${a.job_id}: an application ended with no close of its posting`);
    }
    const log = runs.rows.at(-1)!;
    const closedNow = (await db.all()).filter((x) => x.closed_at === iso(at)).length;
    eq(log.postings_closed, closedNow, `run ${run}: closed in the log`);
  }
  eq(db.refused, [], "nothing refused");
}

// ------------------------------------------------------------------------------------------------ reuse
// Titles one job is edited to (same job) and titles of other jobs. Every edit keeps the words that say what the job is;
// every other job shares none with it.
const REUSE_ROLES = ["Registered Nurse - ICU", "Software Engineer", "Data Analyst", "Pharmacy Technician", "Forklift Operator", "Barista", "Tax Accountant",
  "Customer Success Manager", "Line Cook", "Warehouse Associate", "Dental Hygienist", "Paralegal", "Electrician Apprentice", "Graphic Designer", "Truck Driver CDL-A"];
const wordsOf = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
const disjoint = (a: string, b: string) => { const x = wordsOf(a); for (const w of wordsOf(b)) if (x.has(w)) return false; return true; };
function editOf(t: string, r: Rng): string {
  switch (r.int(0, 5)) {
    case 0: return `Senior ${t}`;
    case 1: return `${t}${r.pick([", Payments", " (Nights)", " - Remote", " II", " – Weekends"])}`;
    case 2: return t.toUpperCase();
    case 3: return `${t} `.replace(" ", "  ");
    case 4: return `<b>${t}</b>`;
    default: return t.replace(/ - /, " – ");
  }
}
export async function runReuse(s: S) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r), key = `${p}:${board.toLowerCase()}`;
  const net: Net = { srv: new Map(), calls: [] }, db = queueDb(), feed = feedOf(net, r);
  const B: Board = { company: "Acme", provider: p, board };
  const n0 = r.int(3, 12);
  const L1: Listing[] = Array.from({ length: n0 }, (_, n) => ({ n, title: r.pick(REUSE_ROLES), loc: "Austin, TX", desc: "Plain.", dept: "Ops" }));
  net.srv.set(key, { list: L1 });
  const at1 = T0, at2 = T0 + 7 * H, at3 = T0 + 14 * H;
  await ingestBoards({ boards: [B], db, now: at1, useCursor: false, fetchFeed: feed });
  const id = (n: number) => idOf(p, board, n);
  for (const l of L1) if (r.chance(0.6)) db.apps.push({ job_id: id(l.n), title: l.title, state: "queued" });
  // Read 2: each listing kept, edited, given to another job, or taken down.
  const fate = new Map<number, "keep" | "edit" | "other" | "down">();
  const L2: Listing[] = [];
  for (const l of L1) {
    const f = r.pick(["keep", "edit", "edit", "other", "other", "down"] as const);
    fate.set(l.n, f);
    if (f === "down") continue;
    const title = f === "edit" ? editOf(l.title, r) : f === "other" ? r.pick(REUSE_ROLES.filter((x) => disjoint(x, l.title))) : l.title;
    L2.push({ ...l, title });
  }
  net.srv.set(key, { list: L2 });
  const st2 = await ingestBoards({ boards: [B], db, now: at2, useCursor: false, fetchFeed: feed });
  const others = [...fate.values()].filter((f) => f === "other").length;
  eq(st2.replaced ?? 0, others, "every id given to another job is counted replaced");
  for (const l of L1) {
    const row = (await db.get(id(l.n)))!, f = fate.get(l.n)!;
    const apps = db.apps.filter((a) => a.job_id === id(l.n));
    if (f === "other") {
      eq([row.first_seen_at, row.closed_at], [iso(at2), null], `${row.job_id}: another job under the old id is new (first seen now), open`);
      ok(db.closes.some((c) => c.id === row.job_id && c.at === iso(at2)), `${row.job_id}: the old job was closed`);
      for (const a of apps) eq([a.state, a.reason], ["not_submitted", "posting_closed"], `${row.job_id}: the application queued for "${a.title}" is never sent to "${row.title}"`);
    } else if (f === "down") {
      ok(row.closed_at, `${row.job_id}: taken down: closed`);
      for (const a of apps) eq(a.state, "not_submitted", `${row.job_id}: closed: its application ends`);
    } else {
      eq([row.first_seen_at, row.closed_at], [iso(at1), null], `${row.job_id} ${f}: the same job: first seen kept, open`);
      for (const a of apps) eq(a.state, "queued", `${row.job_id} ${f}: the same job edited: its application still waits`);
    }
  }
  // Read 3: the taken-down ids come back, half as the same job (reopened), half as another (a closed id reused).
  const back = new Map<number, "same" | "other">();
  const L3 = [...L2];
  for (const l of L1) if (fate.get(l.n) === "down") { const b = r.chance(0.5) ? "same" : "other"; back.set(l.n, b); L3.push({ ...l, title: b === "same" ? l.title : r.pick(REUSE_ROLES.filter((x) => disjoint(x, l.title))) }); }
  net.srv.set(key, { list: L3 });
  const st3 = await ingestBoards({ boards: [B], db, now: at3, useCursor: false, fetchFeed: feed });
  eq(st3.reopened, [...back.values()].filter((b) => b === "same").length, "reopened: the same jobs back");
  eq(st3.replaced ?? 0, [...back.values()].filter((b) => b === "other").length, "a closed id given to another job: new, not reopened");
  for (const [n, b] of back) {
    const row = (await db.get(id(n)))!;
    eq([row.first_seen_at, row.closed_at], [b === "same" ? iso(at1) : iso(at3), null], `${row.job_id} back as ${b}: first seen ${b === "same" ? "kept" : "now"}`);
  }
  // Every application still queued is for the job its posting is now.
  for (const a of db.apps) if (a.state === "queued") {
    const row = (await db.get(a.job_id))!;
    ok(!row.closed_at && !disjoint(row.title, a.title.replace(/<\/?b>/g, "")), `${a.job_id}: queued for "${a.title}" while the posting is "${row.title}"`);
  }
}

// ------------------------------------------------------------------------------------------------ migrate
export async function runMigrate(s: S) {
  const r = rng(s.seed), from = s.provider, to: Provider = r.pick((["ashby", "lever", "greenhouse", "workday"] as Provider[]).filter((x) => x !== from));
  const b1 = boardName(from, r, "m"), b2 = boardName(to, r, "m");
  const net: Net = { srv: new Map(), calls: [] }, db = queueDb(), feed = feedOf(net, r);
  const list = Array.from({ length: r.int(1, 15) }, (_, n) => ({ n, title: `${r.pick(ROLES.slice(0, 6))} ${n}`, loc: r.pick(PLACES), desc: "Same job, both boards.", dept: "Ops" }));
  net.srv.set(`${from}:${b1.toLowerCase()}`, { list });
  net.srv.set(`${to}:${b2.toLowerCase()}`, { list: list.map((l) => ({ ...l })) });
  const boards: Board[] = [{ company: "Acme", provider: from, board: b1 }, { company: "Acme", provider: to, board: b2 }];
  const outcomes = new Map<string, BoardOutcome>();
  const run = (bs: Board[], at: number) => ingestBoards({ boards: bs, db, now: at, useCursor: false, fetchFeed: feed, concurrency: 2, onBoard: (b, o) => { outcomes.set(boardKey(b), o); } });
  await run(boards, T0);
  const all = await db.all();
  eq(all.length, list.length * 2, "both boards' postings, each its own row (never merged)");
  for (const x of all) {
    const own = x.provider === from ? b1 : b2;
    eq(x.board, own, `${x.job_id}: its own board`);
    eq(x.url, canonUrl(x.provider as Provider, own, Number(list.find((l) => atsId(x.provider as Provider, l.n) === x.ats_id)?.n)), `${x.job_id}: its own board's link`);
  }
  for (const l of list) if (r.chance(0.5)) db.apps.push({ job_id: idOf(to, b2, l.n), title: l.title, state: "queued" });
  // The old board empties (the migration done, or its API mid-switch): held for EMPTY_AFTER - 1 reads, then closed. The
  // new board's postings never move.
  net.srv.set(`${from}:${b1.toLowerCase()}`, { list: [] });
  for (let k = 1; k <= EMPTY_AFTER; k++) {
    const empty = outcomes.get(boardKey(boards[0]))?.empty_reads ?? 0;
    await run([{ ...boards[0], empty_reads: empty }, boards[1]], T0 + k * H);
    const old = (await db.open()).filter((x) => x.provider === from && x.board === b1).length;
    eq(old, k < EMPTY_AFTER ? list.length : 0, `empty read ${k}: the old board's postings ${k < EMPTY_AFTER ? "held" : "closed"}`);
    eq((await db.open()).filter((x) => x.provider === to && x.board === b2).length, list.length, "the new board's postings untouched");
  }
  for (const a of db.apps) eq(a.state, "queued", `${a.job_id}: an application on the new board is not ended by the old board's close`);
}

// ------------------------------------------------------------------------------------------------ large
export async function runLarge(s: S) {
  const r = rng(s.seed), p = s.provider, board = boardName(p, r, "L"), key = `${p}:${board.toLowerCase()}`;
  const n0 = s.kind === "huge" ? r.int(10000, 12000) : p === "workday" || p === "smartrecruiters" ? r.int(1001, 4000) : r.int(1000, 3000);
  const net: Net = { srv: new Map(), calls: [] }, db = queueDb(), wholeMax = r.pick([64_000, 300_000, 2_000_000]);
  const feed = feedOf(net, r, wholeMax);
  let list: Listing[] = Array.from({ length: n0 }, (_, n) => ({ n, title: `Store Associate ${n}`, loc: "Austin, TX", desc: `Stock shelves &amp; help customers. Job ${n}.`, dept: "Ops" }));
  net.srv.set(key, { list });
  const BUDGET = r.pick([1500, 2500, 4000]);
  // The scheduled loop: a run reads what its budget allows; a board stopped inside resumes at its next offset.
  async function pass(at0: number) {
    let b: Board = { company: "Acme", provider: p, board }, runs = 0;
    for (;;) {
      let o: BoardOutcome | null = null;
      streamProbe.maxHeldChars = 0;
      net.calls.length = 0;
      const st = await ingestBoards({ boards: [b], db, now: at0 + runs * 5 * MIN, useCursor: false, postingBudget: BUDGET, touchAfterMs: 6 * H, fetchFeed: feed, onBoard: (_b, x) => { o = x; } });
      runs++;
      ok(o && (o as BoardOutcome).status !== "failed", `run ${runs}: ${(o as BoardOutcome | null)?.error}`);
      ok((st.postings_read ?? 0) <= BUDGET + 1000 + INGEST_BATCH, `run ${runs}: parsed ${st.postings_read} of a budget of ${BUDGET}`);
      ok(net.calls.length <= 51, `run ${runs}: ${net.calls.length} requests (a part is at most 50 pages)`);
      ok(streamProbe.maxHeldChars <= Math.max(wholeMax, 200_000) + 70_000 + 5_000 || p === "workday" || p === "smartrecruiters", `run ${runs}: held ${streamProbe.maxHeldChars} characters`);
      const x = o as unknown as BoardOutcome;
      if (!x.next_offset) return runs;
      ok(runs < 60, "the pass ends");
      b = { ...b, offset: x.next_offset, pass_started_at: x.pass_started_at, pass_marked: !!x.pass_marked };
    }
  }
  await pass(T0);
  eq((await db.open()).length, n0, `every posting of a ${n0}-posting board, read in parts`);
  // Some taken down, some added; the next pass (7 hours on) closes exactly what is gone.
  const gone = new Set<number>();
  for (let i = 0, k = r.int(1, 20); i < k; i++) gone.add(r.int(0, n0 - 1));
  list = list.filter((l) => !gone.has(l.n));
  list.push(...Array.from({ length: r.int(0, 10) }, (_, i) => ({ n: 50000 + i, title: `Cashier ${i}`, loc: "Austin, TX", desc: "New.", dept: "Ops" })));
  net.srv.set(key, { list });
  const runs2 = await pass(T0 + 7 * H);
  const open = new Set((await db.open()).map((x) => x.job_id)), want = new Set(list.map((l) => idOf(p, board, l.n)));
  const ghost = [...open].filter((x) => !want.has(x)), lost = [...want].filter((x) => !open.has(x));
  eq([ghost.slice(0, 5), lost.slice(0, 5)], [[], []], `after the second pass (${runs2} runs, ${n0} postings, ${gone.size} taken down): the board's postings, exactly (ghosts, lost)`);
  eq(db.refused, [], "nothing refused");
}
