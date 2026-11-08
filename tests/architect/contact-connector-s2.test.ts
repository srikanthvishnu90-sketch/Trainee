// CONTACT OUTREACH (proposal D-043), the S2 review of #590 and #594. Each test fails on trunk 75ef2a24, before its fix:
//   2. a published address counts only on the company's own domain: jane.doe@gmail.com on acme.io's /team page is
//      refused with its reason, never first_party_published at 95;
//   3. the daily new-contact cap counts UTC days on the server, so switching the caller's time zone never re-opens it;
//   4. approval re-checks the switch: a card shown before CAREER_CONTACT_OUTREACH went off is refused;
//   5. the contact File page shows every mail the card's hash approves (the first email and each follow-up, D-MS-1);
//   6. a job board's address is refused on any public suffix (indeed.de, ziprecruiter.co.uk, glassdoor.co.uk).
// The first finding ("forget everything" resets the caps) is in the database: tests/db/career_contact_erase_keeps_sends.check.sql.
import assertNode from "node:assert/strict";
import { findEmail } from "../../supabase/functions/_shared/career_contact_email.ts";
import { approveContactCard, contactCard, memorySendLimits, sendConfig } from "../../supabase/functions/_shared/career_contact_send.ts";
import { contactPageHtml } from "../../supabase/functions/_shared/career_contact_page.ts";
import type { ContactDraft, ContactIn } from "../../supabase/functions/_shared/career_contact_draft.ts";
import { automatedInbox, isAtsOrBoardDomain } from "../../supabase/functions/_shared/automated_inbox.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-08T15:00:00Z");
const mx = (hosts: Record<string, string[]>) => (d: string) => Promise.resolve(hosts[d] ? { status: "ok" as const, hosts: hosts[d] } : { status: "none" as const });
const POSTAL = "Trainee test sender, 100 Main St, Chicago, IL 60601";
const env = (m: Record<string, string>) => (k: string) => m[k];
const none = async () => new Set<string>();
const contact = (email = "jane.doe@acme.io"): ContactIn => ({
  person: { name: "Jane Doe", title: "VP Engineering", company: "Acme", domain: "acme.io", source_url: "https://acme.io/team" },
  facts: [{ claim: "VP Engineering at Acme", source_url: "https://acme.io/team", source_type: "company_page", published_at: null, retrieved_at: "2026-11-08T15:00:00.000Z", quote_snippet: "Jane Doe, VP Engineering", confidence: 0.95, method: "stub" }] as never,
  email: { email, method: "pattern_rcpt_valid", score: 80, approvable: true, why: "the company's address format (seen 2+ times), accepted by its mail server", provider: "other" },
  expires_at: "2027-02-06T15:00:00.000Z",
});
const draft = { subject: "Your rate-limiter repository", body: "Hi Jane,\n\nI read your rate-limiter repository.\n\nWould you share how you pick defaults?", hook: 1, hook_fact: { claim: "VP Engineering at Acme" }, checks: [] } as unknown as ContactDraft;
const FUS = ["Hi Jane, following up on my note below in case it got buried.", "Hi Jane, one last note: thanks either way."];
const fakeStore = () => { let n = 0; return { n: () => n, store: { saveBatch: async (_u: string, _t: unknown, ds: any[]) => ds.map((d, i) => ({ ...d, id: `d${n++}-${i}` })), update: async () => true } as never }; };
const okRail = () => ({ rpc: async (_f: string, a: any) => ({ data: (a?.p?.items ?? a?.items ?? [{}]).map(() => ({ status: "queued", id: crypto.randomUUID() })), error: null }) }) as never;

Deno.test("contact S2 2: a published address off the company's domain is refused with its reason, never 95", async () => {
  const gmail = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, published: [{ email: "jane.doe@gmail.com", source_url: "https://acme.io/team" }],
    mx: mx({ "acme.io": ["mx.other.example"], "gmail.com": ["gmail-smtp-in.l.google.com"] }) });
  eq([gmail.method, gmail.score, gmail.approvable], [null, 0, false], `refused, never first_party_published at 95: ${JSON.stringify(gmail)}`);
  ok(/not on acme\.io, so it is not used/.test(gmail.why), `refused with its reason: ${gmail.why}`);
  // Something approvable on the company's own domain still wins over the refusal (a verified finder result here).
  const found = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, published: [{ email: "jane.doe@gmail.com", source_url: "https://acme.io/team" }],
    mx: mx({ "acme.io": ["mx.other.example"] }), finder: { name: "hunter", find: async () => ({ email: "jdoe@acme.io", verified: true }) } });
  eq([found.email, found.method, found.approvable], ["jdoe@acme.io", "finder_verified", true], "the work address found another way is used");
  ok(/published address is not on acme\.io/.test(found.why), `and the refusal is noted: ${found.why}`);
  const both = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, mx: mx({ "acme.io": ["mx.other.example"] }),
    published: [{ email: "jane.doe@gmail.com", source_url: "https://acme.io/team" }, { email: "jane@acme.io", source_url: "https://acme.io/team" }] });
  eq([both.email, both.method, both.score, both.approvable], ["jane@acme.io", "first_party_published", 95, true], "the on-domain one of several is used");
  const sub = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, published: [{ email: "jane@eng.acme.io", source_url: "https://acme.io/team" }], mx: mx({ "acme.io": ["mx.other.example"], "eng.acme.io": ["mx.other.example"] }) });
  eq([sub.email, sub.method, sub.approvable], ["jane@eng.acme.io", "first_party_published", true], "a subdomain of the company's domain is on it");
  const look = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, published: [{ email: "jane@acme.io.evil.example", source_url: "https://acme.io/team" }], mx: mx({ "acme.io": ["mx.other.example"], "acme.io.evil.example": ["mx.evil.example"] }) });
  eq([look.method, look.approvable], [null, false], "a domain that merely contains acme.io is not on it");
});

Deno.test("contact S2 3: the daily cap counts UTC days on the server; the caller's time zone never re-opens it", async () => {
  const cfg = { ...sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL }), true), dailyNew: 2 };
  const limits = memorySendLimits();
  const results: string[] = [];
  // 15:00 UTC: the same day in UTC, but "tomorrow" in Asia and "yesterday" at the date line west.
  for (const [who, tz] of [["a", "America/New_York"], ["b", "America/New_York"], ["c", "Pacific/Kiritimati"], ["d", "Pacific/Pago_Pago"], ["e", "Asia/Tokyo"]] as const) {
    const cc = contact(`${who}.person@acme.io`);
    const k = await contactCard({ contact: cc, draft, signature: "Sam Lee", config: cfg, suppressed: none });
    if (!k.ok) throw new Error("card");
    const r = await approveContactCard({ userId: "u-tz", card: k, yesHash: k.hash, contact: cc, now: NOW, tz, config: cfg, limits, suppressed: none, rail: okRail(), ...fakeStore() } as never);
    results.push(!r.ok && r.why === "daily_limit" ? "daily_limit" : "within the cap"); // the stub rail's answer is not the point
  }
  eq(results, ["within the cap", "within the cap", "daily_limit", "daily_limit", "daily_limit"], "2 a day, whatever time zone the caller passes");
});

Deno.test("contact S2 4: approval re-checks the switch; a card shown before outreach went off is refused", async () => {
  const on = sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL }), true);
  const k = await contactCard({ contact: contact(), draft, signature: "Sam Lee", config: on, suppressed: none });
  if (!k.ok) throw new Error("card");
  const s = fakeStore();
  const r = await approveContactCard({ userId: "u-off", card: k, yesHash: k.hash, contact: contact(), now: NOW, config: { ...on, on: false }, limits: memorySendLimits(), suppressed: none, rail: okRail(), store: s.store });
  eq([r.ok, !r.ok && r.why, s.n()], [false, "off", 0], "switched off: refused before anything is stored");
});

Deno.test("contact S2 5: the File page shows every mail the card's hash approves", async () => {
  const cfg = sendConfig(env({ CAREER_SENDER_POSTAL_ADDRESS: POSTAL }), true);
  const k = await contactCard({ contact: contact(), draft, signature: "Sam Lee", followups: FUS, config: cfg, suppressed: none });
  if (!k.ok) throw new Error("card");
  const html = contactPageHtml({ contact: contact(), draft, card: k, firstName: "Sam", now: NOW, expiresAt: contact().expires_at });
  for (const f of FUS) ok(html.includes(f), `follow-up shown: ${f}`);
  ok(/5 days after/.test(html) && /10 days after/.test(html), "and when each follow-up goes");
  eq((html.match(/class="draft"/g) ?? []).length, 3, "three mails, three blocks");
});

Deno.test("contact S2 6: a job board's address is refused on any public suffix", () => {
  for (const d of ["indeed.de", "uk.indeed.com", "www.indeed.co.uk", "indeed.fr", "ziprecruiter.co.uk", "ziprecruiter.ca", "glassdoor.co.uk", "glassdoor.de", "linkedin.cn", "monster.de", "monster.co.uk", "dice.co.uk", "simplyhired.ca", "upwork.co.uk", "joinhandshake.co.uk"]) {
    ok(isAtsOrBoardDomain(d), d);
    eq(automatedInbox(`jane@${d}`), "ats_domain", `jane@${d}`);
  }
  for (const d of ["acme.io", "dice.cs.uni.edu", "hired.example.org", "monsterenergy.com", "angelfish.co"]) ok(!isAtsOrBoardDomain(d), `not a board: ${d}`);
  eq(automatedInbox("jane@glassdoor.co.uk", "Glassdoor"), null, "the board's own employee, at their employer");
});
