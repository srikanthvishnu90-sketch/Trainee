// #361 re-review (2026-11-01), item 1: a look-alike page must never become a firm's "verified" domain.
//   P1 while the one question about a contact is open, a lone link is the answer: it goes through the firm-site check and
//      is never handed to the people-page reader (which filed "Maya Chen, maya@stripe.xyz" under Stripe).
//   P2 the people-page reader keeps an address filed under a company only at that company's verified domain (one a
//      contact the person gave has an address at); with none, the person is saved without an address.
//   P3 a contact saved from a page (or a Gmail correspondent) never makes its domain the firm's verified one.
//   P4 the lone-link answer on the contact's own work-email domain is read and saved as their firm's page.
import nodeAssert from "node:assert/strict";
import type { PageGet } from "../../supabase/functions/_shared/career_people_page.ts";
import type { PeopleDeps, PeopleStore, PersonRec } from "../../supabase/functions/_shared/career_people.ts";
import { fakeWriter, NOW, SENDER_FACTS } from "../../evals/outreach-personalize/fixtures.ts";
import { memoryOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { FACTS_INTENT, keyedContact, networkingTurn } from "../../supabase/functions/_shared/career_networking.ts";
import type { ContactRow } from "../../supabase/functions/_shared/career_contacts.ts";

const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const U = "u-fx7w";
const PUBLIC = async (_h: string) => ["93.184.216.34"];

// A people store in memory: the rows the people-page reader saves, and the person's own export rows.
function peopleStore(seed: Partial<PersonRec>[] = []) {
  let id = 0;
  const rows: (PersonRec & { user_id: string; dedupe_key: string })[] = seed.map((r) => ({
    id: ++id, user_id: U, source: "linkedin_export", name: null, email: null, company: "", company_key: "", position: "", school: "", connected_on: null, last_seen_at: null,
    source_ref: "Connections.csv, row 2", source_url: null, retrieved_at: new Date(NOW).toISOString(), dedupe_key: `s${id}`, ...r,
  } as any));
  const store = {
    rows,
    async importRows(u: string, source: any, _f: string, _sha: any, rs: any[]) {
      let inserted = 0;
      for (const r of rs) {
        if (rows.some((x) => x.user_id === u && x.source === source && x.dedupe_key === r.dedupe_key)) continue;
        rows.push({ id: ++id, user_id: u, source, name: r.name ?? null, email: r.email ?? null, company: r.company ?? "", company_key: r.company_key ?? "", position: r.position ?? "", school: r.school ?? "",
          connected_on: null, last_seen_at: null, source_ref: r.source_ref, source_url: r.source_url ?? null, retrieved_at: new Date(NOW).toISOString(), dedupe_key: r.dedupe_key });
        inserted++;
      }
      return { inserted, duplicates: rs.length - inserted, kept: rows.length, with_email: rows.filter((x) => x.email).length, replaced: 0 };
    },
    async counts(u: string) { const c: Record<string, number> = {}; for (const r of rows) if (r.user_id === u) c[r.source] = (c[r.source] ?? 0) + 1; return c; },
    async atCompany(u: string, key: string) { return rows.filter((r) => r.user_id === u && key && r.company_key === key); },
    async named(u: string, n: string) { const w = n.toLowerCase(); const ex = rows.filter((r) => r.user_id === u && r.name?.toLowerCase() === w); return ex.length || w.includes(" ") ? ex : rows.filter((r) => r.user_id === u && r.name?.toLowerCase().startsWith(`${w} `)); },
    async prefs() { return { export_asked_at: null, paste_header: null, paste_file: null, paste_at: null }; },
    async setPrefs() {}, async setSchool() { return 0; }, async forget() { return 0; },
    async saveJobs() { return 0; }, async jobs() { return []; }, async forgetJobs() { return 0; },
    async intros() { return []; }, async intro() { return null; }, async dueIntros() { return []; }, async forgetIntros() { return 0; },
    async addIntro() { throw new Error("not in this test"); }, async updateIntro() { return null; },
    async pruneThreadContacts() { return { rows: 0, threads: 0 }; },
  };
  return store as unknown as PeopleStore & { rows: typeof rows };
}
function net(pages: Record<string, string>) {
  const got: string[] = [];
  const get: PageGet = async (url) => {
    got.push(url.toString());
    if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
    const html = pages[url.toString()];
    return html ? new Response(html, { headers: { "content-type": "text/html" } }) : new Response("nf", { status: 404 });
  };
  return { get, got };
}
const team = (org: string, people: [string, string][]) => `<html><head><script type="application/ld+json">${JSON.stringify({
  "@context": "https://schema.org", "@type": "Organization", name: org,
  employee: people.map(([name, email]) => ({ "@type": "Person", name, jobTitle: "Software Engineer", email: `mailto:${email}`, worksFor: { "@type": "Organization", name: org } })),
})}</script></head><body><p>Maya Chen leads the payments ledger rebuild at ${org}.</p></body></html>`;

async function world(o: { contacts: ContactRow[]; people?: Partial<PersonRec>[]; pages: Record<string, string> }) {
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Test Person" });
  if (o.contacts.length) await store.putContacts!(U, await store.accountEpoch!(U), o.contacts.map(keyedContact));
  const ps = peopleStore(o.people ?? []), n = net(o.pages);
  const people: PeopleDeps = { store: ps, gmail: null, fetch: (async () => new Response("no", { status: 599 })) as typeof fetch, pageGet: n.get, resolve: PUBLIC };
  const state: Record<string, unknown> = { profile: { facts: SENDER_FACTS } };
  const say = (message: string, T: string, withPeople = true) =>
    networkingTurn({ message, userId: U, threadId: T, now: NOW, state, store, model: fakeWriter(), ...(withPeople ? { people } : {}) });
  return { store, ps, n, say };
}
const MAYA = { file: "contacts.csv", row: 2, name: "Maya Chen", email: "maya.chen@stripe.com", firm: "Stripe", firm_raw: "Stripe", company: "Stripe", title: "Data Analyst", school: "", connected_on: null, verified: true } as ContactRow;
const XYZ = team("Stripe", [["Maya Chen", "maya@stripe.xyz"]]);

Deno.test("P1 a lone link while the question is open is the answer: a look-alike is not read, and nobody is filed from it", async () => {
  for (const link of ["https://stripe.xyz/team", "https://evil.example.net/about", "her team page: https://stripe.xyz/people"]) {
    const w = await world({ contacts: [MAYA], pages: { "https://stripe.xyz/team": XYZ, "https://evil.example.net/about": XYZ, "https://stripe.xyz/people": XYZ } });
    const T = `t-p1-${link.length}`;
    const q = await w.say("email Maya Chen at Stripe", T, false);
    eq(q!.status, "needs_facts", q!.reply);
    w.store.setIntent(T, FACTS_INTENT);
    const r = await w.say(link, T);
    eq([r!.intent, r!.status], [FACTS_INTENT, "nothing_saved"], r!.reply);
    eq(w.n.got, [], `nothing fetched for ${link}`);
    eq(w.ps.rows.length, 0, "no contact filed from the page");
    eq((await w.store.recipientFacts!(U, ["e:maya.chen@stripe.com"])).size, 0);
  }
});

Deno.test("P2 the page reader files an address under a company only at its verified domain", async () => {
  // No contact the person gave works at Stripe: the page's people are saved without addresses.
  const a = await world({ contacts: [], pages: { "https://stripe.xyz/team": XYZ } });
  const r = await a.say("https://stripe.xyz/team", "t-p2a");
  assert(r && /not at Stripe's verified domain/.test(r.reply), r?.reply);
  eq(a.ps.rows.filter((x) => x.source === "company_page").map((x) => [x.name, x.email, x.company]), [["Maya Chen", null, "Stripe"]]);
  // With one from their export at stripe.com: a stripe.com address is kept, a stripe.xyz one is not.
  const b = await world({ contacts: [], people: [{ name: "Lee Park", email: "lee@stripe.com", company: "Stripe", company_key: "stripe" }],
    pages: { "https://stripe.com/team": team("Stripe", [["Maya Chen", "maya@stripe.com"], ["Sam Roe", "sam@stripe.xyz"]]) } });
  await b.say("https://stripe.com/team", "t-p2b");
  eq(b.ps.rows.filter((x) => x.source === "company_page").map((x) => [x.name, x.email]).sort(), [["Maya Chen", "maya@stripe.com"], ["Sam Roe", null]]);
  // A page-saved or Gmail address at stripe.xyz does not verify stripe.xyz for the next page.
  const c = await world({ contacts: [], people: [{ source: "company_page", name: "Old Row", email: "old@stripe.xyz", company: "Stripe", company_key: "stripe" }, { source: "gmail", name: "Mail Row", email: "mail@stripe.xyz", company: "Stripe", company_key: "stripe" }],
    pages: { "https://stripe.xyz/team": XYZ } });
  await c.say("https://stripe.xyz/team", "t-p2c");
  eq(c.ps.rows.filter((x) => x.name === "Maya Chen").map((x) => x.email), [null]);
});

Deno.test("P3 a contact saved from a page never makes its domain the firm's site for facts", async () => {
  const w = await world({ contacts: [], people: [{ source: "company_page", name: "Maya Chen", email: "maya@stripe.xyz", company: "Stripe", company_key: "stripe", source_ref: "https://stripe.xyz/team (schema.org Person, read 2026-10-31)", source_url: "https://stripe.xyz/team" }],
    pages: { "https://stripe.xyz/team": XYZ } });
  const r = await w.say("Maya Chen's team page: https://stripe.xyz/team", "t-p3");
  assert(r && r.status === "nothing_saved", r?.reply);
  eq(w.n.got, [], "not read");
});

Deno.test("P4 a lone link on the contact's own work-email domain answers the question and is read as their firm's page", async () => {
  const w = await world({ contacts: [MAYA], pages: { "https://stripe.com/team/maya": team("Stripe", [["Maya Chen", "maya.chen@stripe.com"]]) } });
  const T = "t-p4";
  eq((await w.say("email Maya Chen at Stripe", T, false))!.status, "needs_facts");
  w.store.setIntent(T, FACTS_INTENT);
  const r = await w.say("https://stripe.com/team/maya", T);
  assert(/^Saved one thing about Maya Chen from their firm's page/.test(r!.reply), r!.reply);
  const f = (await w.store.recipientFacts!(U, ["e:maya.chen@stripe.com"])).get("e:maya.chen@stripe.com") ?? [];
  eq(f.map((x: any) => x.source_kind), ["company_page"], `${r!.reply} ${w.n.got.join(" ")}`);
  eq(w.ps.rows.length, 0, "the page reader filed nobody");
});
