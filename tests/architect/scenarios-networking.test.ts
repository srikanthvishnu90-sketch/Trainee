// NETWORKING AND PEOPLE-FINDING AT SCALE (owner rules, 2026-10-27/29): ~10,000 seeded scenarios
// (tests/architect/scenarios/networking-generator.ts) through the product's own functions, no database, no network, no model.
//   asks     each ask reaches the right turn with the right reading: "who do I know at X" the person's own contacts,
//            "find recruiters at X" / "people in data at X" a discovery for those roles at exactly X, "alumni from my school
//            at X" their confirmed school, "<school> alumni at X" that school, "reach out to engineers at X" a group draft
//            for engineers at X, "email <name> at X" that person; a control (apply, withdraw, status, small talk) is none of
//            them. The company is always the one typed (punctuation, Inc/LLC, &, accents; Meta and Apple stay as typed).
//   csv      every contacts file, through both importers (career_people_import.ts parseExport for the LinkedIn export,
//            career_contacts.ts importContactsCsv for any list): no cell a spreadsheet would run and no instruction-like
//            text is kept as written; no name, firm or address is invented; long fields are bounded; every row is
//            accounted for (kept, duplicate or skipped with a reason); a BOM, CRLF, quoted commas and non-UTF-8 bytes read.
//   pages    a public page's people (career_people_page.ts peopleOnPage, the provider's person rule): a role inbox
//            (careers@, info@ ...) is never a person's address and never a person.
//   drafts   the fact-lock (career_outreach.ts outreachLock and draftFor) passes a sentence only when what it says is on
//            record: the recipient's school or title only from their row, the person's only from confirmed facts.
// Email inference (published / known / inferred formats per domain, bounces, role inboxes, webmail) runs on the database's
// own functions: tests/architect/flow-scenarios-networking.test.ts.
import assertNode from "node:assert/strict";
import { asks, type AskCase, COMPANIES, csvCases, DEPTS, draftCases, FORMULAS, INSTRUCTIONS, nonUtf8Case, rng, ROLE_INBOXES, ROLES } from "./scenarios/networking-generator.ts";
import { parseNetworkingAsk } from "../../supabase/functions/_shared/career_networking.ts";
import { parsePeopleAsk, targetAskOf } from "../../supabase/functions/_shared/career_people.ts";
import { companyKey, isFormula, parseExport, readsAsInstruction } from "../../supabase/functions/_shared/career_people_import.ts";
import { importContactsCsv, isRoleAddress } from "../../supabase/functions/_shared/career_contacts.ts";
import { peopleOnPage } from "../../supabase/functions/_shared/career_people_page.ts";
import { webProvider } from "../../supabase/functions/_shared/career_people_provider.ts";
import { draftFor, outreachLock, sharedFacts } from "../../supabase/functions/_shared/career_outreach.ts";
import { pureRoute } from "./routing-scenarios.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const plain = (s: unknown) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const words = (s: string) => plain(s).split(" ").filter((w) => w.length > 1).map((w) => w.replace(/s$/, ""));

type Fails = Map<string, string[]>;
function fail(f: Fails, family: string, line: string) { if (!f.has(family)) f.set(family, []); f.get(family)!.push(line); }
function report(f: Fails, total: number, what: string) {
  const n = [...f.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[networking] ${what}: ${total} scenarios, ${n} failures`];
  for (const [k, xs] of f) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 4)) lines.push(`    ${x}`); }
  console.log(lines.join("\n"));
  eq(n, 0, `${what}: ${n} of ${total} failed (see the report above)`);
}

// ------------------------------------------------------------------------------------------------ asks
// The networking turn's reading, in its own order (career_networking.ts networkingTurnInner -> career_people.ts peopleTurn):
// a discovery ask (web search on), else the people turn's ask, else the networking turn's who / draft.
export function netRoute(m: string): { route: string | null; company?: string; titles?: string[]; school?: string | null; role?: string | null; name?: string } {
  const t = targetAskOf(m);
  if (t) return { route: `targets:${t.kind}`, company: t.kind === "applied" ? undefined : t.company, titles: t.kind === "alumni" ? [] : t.titles, school: t.kind === "alumni" ? t.school : undefined };
  const p = parsePeopleAsk(m);
  if (p) return { route: `people:${p.kind}`, company: "firm" in p ? (p.firm ?? undefined) : undefined, school: p.kind === "alumni" ? p.school : undefined, name: p.kind === "intro" ? p.name ?? undefined : undefined };
  const n = parseNetworkingAsk(m);
  if (n?.kind === "who") return { route: "net:who", company: n.firm };
  if (n?.kind === "draft") return n.target.by === "group" ? { route: "draft:group", company: n.target.firm, role: n.target.role } : { route: "draft:name", company: n.target.firm ?? undefined, name: n.target.name };
  return { route: null };
}
const sameCo = (got: string | undefined, c: AskCase) => !!got && companyKey(got) === companyKey(c.typed);
const expectedRoute = (c: AskCase) => ({ who: "people:who", role_at: "targets:role_at", dept_at: "targets:role_at", alumni_mine: "people:alumni", alumni_named: "targets:alumni", reach_out: "draft:group", draft_named: "draft:name", control: "" })[c.kind];
// null when the reading is right; else why not.
export function askViolation(c: AskCase): string | null {
  const r = netRoute(c.text), route = pureRoute(c.text);
  const got = `${r.route}${r.company !== undefined ? ` company=${JSON.stringify(r.company)}` : ""}${r.titles ? ` titles=${JSON.stringify(r.titles)}` : ""}${r.school !== undefined ? ` school=${JSON.stringify(r.school)}` : ""}${r.role !== undefined ? ` role=${JSON.stringify(r.role)}` : ""}${r.name ? ` name=${JSON.stringify(r.name)}` : ""}; turn=${route}`;
  if (c.kind === "control") return r.route === null && route !== "networking" ? null : `a control must be no people ask: ${got}`;
  const right = (() => {
    if (route !== "networking") return false;
    switch (c.kind) {
      case "who": return (r.route === "people:who" || r.route === "net:who") && sameCo(r.company, c);
      case "role_at": return r.route === "targets:role_at" && sameCo(r.company, c) && r.titles!.length === 1 && words(r.titles![0]).join(" ") === words(c.role!.one).join(" ");
      case "dept_at": return r.route === "targets:role_at" && sameCo(r.company, c) && r.titles!.length >= 1 && r.titles!.every((x) => words(x).length > 0 && words(x).every((w) => words(c.dept!).includes(w)));
      case "alumni_mine": return r.route === "people:alumni" && sameCo(r.company, c) && r.school === null;
      case "alumni_named": return (r.route === "targets:alumni" || r.route === "people:alumni") && sameCo(r.company, c) && plain(r.school) === plain(c.school);
      case "reach_out": return r.route === "draft:group" && sameCo(r.company, c) && (c.contacts ? r.role === null : plain(r.role) === plain(c.role!.one));
      case "draft_named": return r.route === "draft:name" && sameCo(r.company, c) && plain(r.name) === plain(c.name);
    }
  })();
  if (right) return null;
  // A soft variant (a typo, an emoji) may leave the grammar: no reading at all (the router asks) is safe. A typo inside a
  // role or verb may degrade the reading to a read-only lookup (a search, or who they know) or a title spelled as typed,
  // but only at exactly the company typed. Never a different company, never another turn, never a draft not asked for.
  if (!c.strict && r.route === null && route === "router") return null;
  // (A typo'd role read as a name, "message engineres at Stripe", drafts only to a contact of that name at that firm: none.)
  const lookup = ["targets:role_at", "people:who", "net:who", ...(c.kind === "reach_out" ? ["draft:name"] : []), ...(c.kind === "alumni_mine" ? ["targets:alumni"] : [])];
  if (!c.strict && /typo/.test(c.family) && route === "networking" && sameCo(r.company, c) &&
    (r.route === expectedRoute(c) || lookup.includes(r.route ?? ""))) return null;
  return `expected ${c.kind}${c.role ? ` (${c.role.one})` : c.dept ? ` (${c.dept})` : c.school ? ` (${c.school})` : ""} at ${c.typed}; got ${got}`;
}

const ASKS = asks(20261029, 7000);

Deno.test(`${ASKS.length} generated people asks reach the right turn with the right company, roles, school or name (controls reach none)`, () => {
  const f: Fails = new Map();
  const by: Record<string, number> = {};
  for (const c of ASKS) {
    by[c.kind] = (by[c.kind] ?? 0) + 1;
    const why = askViolation(c);
    if (why) fail(f, c.family, `${JSON.stringify(c.text)}: ${why}`);
  }
  console.log(`[networking] asks by kind: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  report(f, ASKS.length, "asks");
});

Deno.test("ambiguous and punctuated companies stay exactly the company typed (no expansion, no guess)", () => {
  const f: Fails = new Map();
  let n = 0;
  for (const co of COMPANIES) for (const typed of co.typed) for (const t of ["find recruiters at {C}", "who do I know at {C}", "email the engineers at {C}", "DePaul alumni at {C}"]) {
    n++;
    const r = netRoute(t.replace("{C}", typed));
    if (!r.company || companyKey(r.company) !== companyKey(typed)) fail(f, co.ambiguous ? "ambiguous" : "punctuated", `${JSON.stringify(t.replace("{C}", typed))}: company ${JSON.stringify(r.company)}`);
  }
  report(f, n, "companies");
});

// ------------------------------------------------------------------------------------------------ CSV imports
const CSV = csvCases(4242, 450);
const hostileText = (v: string) => isFormula(v) || readsAsInstruction(v);
// What a kept field may never be: a formula a spreadsheet would run, an instruction, markup, a control character, unbounded.
function fieldWhy(field: string, v: string, max: number): string | null {
  if (v === "") return null;
  if (isFormula(v)) return `${field} is a spreadsheet formula: ${JSON.stringify(v.slice(0, 60))}`;
  if (readsAsInstruction(v)) return `${field} reads as an instruction: ${JSON.stringify(v.slice(0, 60))}`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/.test(v)) return `${field} keeps a control character or markup`;
  if (v.length > max) return `${field} is ${v.length} characters (bound ${max})`;
  return null;
}

Deno.test(`${CSV.length} hostile and odd contacts files through both importers: neutralized, nothing invented, every row accounted for`, () => {
  const f: Fails = new Map();
  let rowsSeen = 0;
  for (const c of CSV) {
    // 1. the LinkedIn export / people import
    const p = parseExport(c.file, c.text);
    if (!p.ok) { fail(f, `${c.family}/people`, `${c.file}: not read (${p.why})`); continue; }
    const truthByRow = new Map(c.rows.map((r) => [r.row, r]));
    eq(p.read, c.rows.length, `${c.family}: every data row read`);
    if (p.rows.length + p.duplicates + p.skipped.length !== p.read) fail(f, `${c.family}/people`, `${c.file}: ${p.rows.length} kept + ${p.duplicates} duplicates + ${p.skipped.length} skipped != ${p.read} read`);
    for (const r of p.rows) {
      rowsSeen++;
      const n = Number(/row (\d+)$/.exec(r.source_ref)?.[1]);
      const t = truthByRow.get(n);
      if (!t) { fail(f, `${c.family}/people`, `${c.file}: a row that isn't in the file: ${JSON.stringify(r)}`); continue; }
      for (const [k, v, max] of [["name", r.name, 200], ["company", r.company, 200], ["position", r.position, 300], ["school", r.school, 200]] as [string, string, number][]) {
        const why = fieldWhy(k, v, max); if (why) fail(f, `${c.family}/people`, `${c.file} row ${n}: ${why}`);
      }
      if (t.hostile.includes("name")) fail(f, `${c.family}/people`, `${c.file} row ${n}: a hostile name was kept as a person: ${JSON.stringify(r.name.slice(0, 60))}`);
      if (r.email && r.email !== String(t.email ?? "").trim().toLowerCase()) fail(f, `${c.family}/people`, `${c.file} row ${n}: an address not in the row: ${r.email}`);
      if (r.email && !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(r.email)) fail(f, `${c.family}/people`, `${c.file} row ${n}: an address that isn't one: ${r.email}`);
      if (!t.name) fail(f, `${c.family}/people`, `${c.file} row ${n}: a person kept with no name in the row`);
    }
    // (A name past 200 characters is bounded, so two such may read as one person: a duplicate, counted.)
    for (const t of c.rows) if (t.name && t.name.length <= 200 && !hostileText(t.name) && /\p{L}/u.test(t.name) && !t.dupOf && !p.rows.some((r) => r.source_ref.endsWith(`row ${t.row}`)) && !p.skipped.some((s) => s.row === t.row))
      fail(f, `${c.family}/people`, `${c.file} row ${t.row}: a plain person (${JSON.stringify(t.name.slice(0, 40))}) was dropped without a reason`);
    // 2. any contacts list (the networking turn's importer)
    const l = importContactsCsv(c.file, c.text);
    if (l.error) { fail(f, `${c.family}/list`, `${c.file}: not read (${l.error})`); continue; }
    if (l.rows.length + l.duplicates + l.skipped.length !== c.rows.length) fail(f, `${c.family}/list`, `${c.file}: ${l.rows.length} kept + ${l.duplicates} duplicates + ${l.skipped.length} skipped != ${c.rows.length} rows`);
    for (const r of l.rows) {
      rowsSeen++;
      const t = truthByRow.get(r.row);
      if (!t) { fail(f, `${c.family}/list`, `${c.file}: a row that isn't in the file: row ${r.row}`); continue; }
      for (const [k, v, max] of [["name", r.name, 200], ["firm", r.firm, 200], ["firm_raw", r.firm_raw, 200], ["title", r.title, 300], ["school", r.school, 200]] as [string, string, number][]) {
        const why = fieldWhy(k, v, max); if (why) fail(f, `${c.family}/list`, `${c.file} row ${r.row}: ${why}`);
      }
      if (t.hostile.includes("name")) fail(f, `${c.family}/list`, `${c.file} row ${r.row}: a hostile name was kept as a person: ${JSON.stringify(r.name.slice(0, 60))}`);
      // The list keeps the address cell as written (lowercased, "mailto:" dropped) so the checks can say why one is unusable
      // ("not a valid address", "a shared inbox"); a formula is never kept, and nothing that isn't in the row.
      if (r.email && isFormula(r.email)) fail(f, `${c.family}/list`, `${c.file} row ${r.row}: an address cell kept as a formula: ${JSON.stringify(r.email)}`);
      if (r.email && r.email !== String(t.email ?? "").trim().toLowerCase().replace(/^mailto:/, "")) fail(f, `${c.family}/list`, `${c.file} row ${r.row}: an address not in the row: ${r.email}`);
    }
  }
  console.log(`[networking] csv: ${CSV.length} files, ${rowsSeen} kept rows checked`);
  report(f, CSV.length, "csv files");
});

Deno.test("odd files: a BOM, CRLF, quoted commas, non-UTF-8 bytes, a 5,000-row file, an emoji-only name, formula-only rows", () => {
  const r = rng(5);
  // quoted commas and doubled quotes stay inside their cell
  const q = parseExport("Connections.csv", `First Name,Last Name,URL,Email Address,Company,Position,Connected On\r\n"Jane","Doe, Jr.",,jane@stripe.com,"Stripe, Inc.","Head of ""Data""",01 Oct 2025\r\n`);
  assertNode.ok(q.ok);
  eq([q.rows[0].name, q.rows[0].company, q.rows[0].company_key, q.rows[0].position], ["Jane Doe, Jr.", "Stripe, Inc.", "stripe", `Head of "Data"`]);
  const ql = importContactsCsv("list.csv", `﻿Name,Email,Company\r\n"Doe, Jane",jane@stripe.com,"Stripe, Inc."\r\n`);
  eq([ql.rows[0].name, ql.rows[0].firm, ql.rows[0].email], ["Doe, Jane", "Stripe", "jane@stripe.com"]);
  // non-UTF-8 bytes: read, the replacement character never becomes an address or a firm
  for (let i = 0; i < 20; i++) {
    const t = nonUtf8Case(r);
    const a = parseExport("x.csv", t), b = importContactsCsv("x.csv", t);
    assertNode.ok(a.ok && a.rows.length === 6, "non-UTF-8 read");
    assertNode.ok(b.rows.length === 6 && b.rows.every((x) => /^x\d@stripe\.com$/.test(x.email!)), "non-UTF-8 read by the list importer");
  }
  // no row cap of Trainee's own: 5,000 rows all kept
  const big = ["Name,Email,Company", ...Array.from({ length: 5000 }, (_, i) => `Person ${i},p${i}@stripe.com,Stripe`)].join("\n");
  const pb = parseExport("big.csv", big);
  assertNode.ok(pb.ok);
  eq(pb.rows.length, 5000);
  // an emoji-only name is no name; a row of formulas is skipped or blanked, never kept as written
  const e = parseExport("e.csv", "Name,Email,Company\n🚀,rocket@stripe.com,Stripe\n=1+1,x@stripe.com,=cmd|' /C calc'!A0\n");
  assertNode.ok(e.ok);
  eq(e.rows.length, 0);
  eq(e.skipped.map((s) => s.why), ["no name", "a name that is a spreadsheet formula"]);
  const el = importContactsCsv("e.csv", "Name,Email,Company\n🚀,rocket@stripe.com,Stripe\n=1+1,x@stripe.com,=cmd|' /C calc'!A0\nAda,ada@stripe.com,=HYPERLINK(\"http://x\")\n");
  eq(el.rows.map((x) => [x.name, x.firm, x.firm_raw]), [["Ada", "", ""]]);
});

// ------------------------------------------------------------------------------------------------ role inboxes
Deno.test("a role inbox (careers@, info@, recruiting-team@ ...) is never a person's address, on a page or from the provider", async () => {
  const f: Fails = new Map();
  let n = 0;
  const r = rng(99);
  for (let i = 0; i < 400; i++) {
    const loc = r.pick(ROLE_INBOXES), dom = r.pick(["stripe.com", "ramp.com", "acme.io"]);
    const addr = `${loc}@${dom}`;
    n++;
    if (!isRoleAddress(addr)) fail(f, "isRoleAddress", `${addr} is not read as a role inbox`);
    // a named mailto link and a schema.org Person carrying it
    const label = r.pick(["Careers Team", "Talent Acquisition", "Jane Recruiter", "Press Office", "Ada Lovelace"]);
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "Organization", name: "Stripe", employee: [{ "@type": "Person", name: "Grace Hopper", jobTitle: "Recruiter", email: `mailto:${addr}` }] })}</script></head>
      <body><a href="mailto:${addr}">${label}</a></body></html>`;
    const { people } = peopleOnPage(html);
    for (const p of people) {
      if (p.email === addr && p.name) fail(f, "page", `${addr} kept as ${JSON.stringify(p.name)}'s address (${p.how})`);
    }
    if (!people.some((p) => p.name === "Grace Hopper")) fail(f, "page", `Grace Hopper (named on the page) was dropped because of ${addr}`);
    // the provider's person rule over the same page
    const prov = webProvider({
      search: async () => ({ status: "ok", urls: [{ url: `https://${dom}/team`, title: "" }], cost_usd: 0 }),
      fetch: (async () => { throw new Error("no network"); }) as typeof fetch, mx: async () => ({ status: "ok", hosts: ["mx"] }),
      read: async (_f, url) => ({ ok: true, url, people: peopleOnPage(html).people, org: "Stripe" }),
    });
    const got = await prov.findPeople({ company: dom.split(".")[0] });
    if (got.status !== "ok") { fail(f, "provider", `${addr}: ${got.status}`); continue; }
    for (const p of got.people) if (p.email && isRoleAddress(p.email)) fail(f, "provider", `${addr} kept as ${p.name}'s address`);
  }
  // a team marked up as a Person ("Talent Acquisition") is no person: never stored, never given an address
  for (const team of ["Talent Acquisition", "Careers Team", "Recruiting", "University Recruiting", "Press Office", "People Ops"]) {
    n++;
    const { people } = peopleOnPage(`<script type="application/ld+json">${JSON.stringify({ "@type": "Person", name: team, jobTitle: "Recruiter" })}</script>`);
    if (people.length) fail(f, "team", `${team} kept as a person`);
  }
  // a person's own address is never mistaken for an inbox
  for (const a of ["ada.lovelace@stripe.com", "hi.nguyen@stripe.com", "jobson@ramp.com", "info.li@acme.io", "teamlead.sam@acme.io", "pressley@stripe.com", "careerson@x.com", "ana@stripe.com",
    "hina@stripe.com", "hiren.shah@ramp.com", "irina@acme.io", "prius@x.com", "sam+jobs@gmail.com", "nadia@ramp.com", "ushma@stripe.com"]) {
    n++;
    if (isRoleAddress(a)) fail(f, "person", `${a} read as a role inbox`);
  }
  report(f, n, "role inboxes");
});

// ------------------------------------------------------------------------------------------------ drafts
const DRAFTS = draftCases(3131, 1500);
Deno.test(`${DRAFTS.length} draft sentences about partial rows: the fact-lock passes exactly what is on record`, async () => {
  const f: Fails = new Map();
  for (const c of DRAFTS) {
    const facts = c.facts.filter((x) => x.status === "confirmed");
    const shared = sharedFacts(c.facts, c.recipient);
    const lock = outreachLock(`A quick question\n${c.sentence}`, { facts: facts.map((x) => x.text), recipient: c.recipient, shared });
    if (lock.pass !== c.onRecord) fail(f, c.family, `${JSON.stringify(c.sentence)} (row: title ${JSON.stringify(c.recipient.title)}, school ${JSON.stringify(c.recipient.school)}; facts: ${facts.map((x) => x.text).join(" | ")}): ${lock.pass ? "passed, but it is not on record" : `refused (${[...lock.untraced, ...lock.misattributed].join("; ")}), but it is on record`}`);
  }
  // draftFor with a model that writes the sentence: shown only when on record; the payload never offers a missing field
  for (const c of DRAFTS.slice(0, 300)) {
    let payload = "";
    // the first call's payload: what the drafter offers the model (a retry also quotes the model's own words back to it)
    const model = async (p: any) => { payload ||= String(p.messages[0].content); return { content: [{ type: "text", text: `Subject: A quick question\n\nHi ${c.recipient.name.split(" ")[0]},\n\n${c.sentence} Would you be open to a short call?` }], stop_reason: "end_turn" }; };
    // PERSONALIZED OUTREACH (2026-10-31): this battery is the fact-lock writer (still the follow-up writer); first emails go
    // through the engine (outreach-personalize.test.ts). Was draftFor without personal: false, a generic first email.
    const d = await draftFor({ model, facts: c.facts, r: c.recipient, personal: false });
    if (d.ok !== c.onRecord) fail(f, `draftFor/${c.family}`, `${JSON.stringify(c.sentence)}: ${d.ok ? "drafted, but it is not on record" : `not drafted (${d.ok ? "" : d.detail.join("; ")}), but it is on record`}`);
    if (!c.recipient.school && !/- school: \(not given\)/.test(payload)) fail(f, "payload", "a missing school is not said to be missing");
    if (!c.recipient.title && !/- title: \(not given\)/.test(payload)) fail(f, "payload", "a missing title is not said to be missing");
    if (/Goldman Sachs/.test(payload)) fail(f, "payload", "an unconfirmed fact reached the model");
  }
  report(f, DRAFTS.length + 300, "drafts");
});
