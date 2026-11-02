// #361 takeover (2026-11-01):
//   H  the firm-site allowlist matches the firm's registrable domain exactly (eTLD+1 is the firm's domain, the host is it
//      or a subdomain of it); lookalikes (stripe.attacker.io, stripe.com.evil.net, stripeinc-careers.xyz) and IDN/punycode
//      homographs are refused. A domain known from the contact's work email counts as the firm's.
//   R  every redirect hop of a fact page is checked against the same allowlist (and the private-address block), at most
//      MAX_REDIRECTS hops; an off-list hop is never fetched.
//   L  a LinkedIn link sent as a fact source is answered with the LinkedIn note, never opened.
import nodeAssert from "node:assert/strict";
import { factHost } from "../../supabase/functions/_shared/career_outreach_personalize.ts";
import { fetchHtml, MAX_REDIRECTS, type PageGet } from "../../supabase/functions/_shared/career_people_page.ts";
import { fakeWriter, NOW, SENDER_FACTS } from "../../evals/outreach-personalize/fixtures.ts";
import { memoryOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { keyedContact, networkingTurn } from "../../supabase/functions/_shared/career_networking.ts";
import type { ContactRow } from "../../supabase/functions/_shared/career_contacts.ts";

const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const assert = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const PUBLIC_IP = "93.184.216.34";

Deno.test("H1 lookalike hosts are not the firm's site", () => {
  for (const u of [
    "https://stripe.attacker.io/team", "https://stripe.com.evil.net/team", "https://stripeinc-careers.xyz/team",
    "https://www.stripe.com.evil.net/", "https://stripe-careers.com/", "https://careers-stripe.com/", "https://stripes.com/",
    "https://stripe.attacker.co.uk/", "https://stripe.github.io/", "https://stripe.vercel.app/",
  ]) eq(factHost(u, "Stripe, Inc.", ["maya@stripe.com"]), null, u);
  for (const u of ["https://www.sec.gov.evil.net/x", "https://evilsec.gov.io/x", "https://arxiv.org.evil.net/abs/1"]) eq(factHost(u, "Acme"), null, u);
});

Deno.test("H2 IDN and punycode homographs are refused", () => {
  for (const u of [
    "https://xn--strpe-z5a.com/team", // 'strípe'
    "https://strіpe.com/team", // Cyrillic i
    "https://ѕtripe.com/", // Cyrillic s
    "https://xn--stripe-0ta.com/",
    "https://stripe.xn--80ak6aa92e.com/", // a stripe label under someone else's IDN domain
  ]) eq(factHost(u, "Stripe", ["maya@stripe.com"]), null, u);
});

Deno.test("H3 only a verified domain is the firm's site: its registrable domain and subdomains, never one guessed from the name", () => {
  const known = ["maya.chen@stripe.com"];
  for (const u of ["https://stripe.com/about", "https://www.stripe.com/about", "https://jobs.stripe.com/x", "https://STRIPE.COM./a"]) {
    eq(factHost(u, "Stripe, Inc.", known), "company_page", u);
  }
  for (const u of ["https://stripe.com/about", "https://stripe.xyz/", "https://stripe.ai/", "https://stripe.com.de/", "https://stripe.co.uk/team", "https://janestreet.com/"]) {
    eq(factHost(u, u.includes("jane") ? "Jane Street" : "Stripe", []), null, `no verified domain: ${u}`);
  }
  for (const u of ["https://stripe.xyz/", "https://stripe.ai/", "https://stripe.com.de/", "https://stripe.co.uk/team"]) eq(factHost(u, "Stripe", known), null, `not the verified domain: ${u}`);
  eq(factHost("https://plaidfixture.com/team", "Plaidfixture", ["dana@plaidfixture.com"]), "company_page");
});

Deno.test("H4 a domain known from the contact's work email is the firm's; freemail never is", () => {
  eq(factHost("https://careers.google.com/team", "Alphabet", ["google.com"]), "company_page");
  eq(factHost("https://google.com.evil.net/team", "Alphabet", ["google.com"]), null);
  eq(factHost("https://gmail.com/x", "Acme", ["gmail.com"]), null, "a freemail domain is no firm's site");
  eq(factHost("https://evil.net/x", "Acme", ["evil.net.example"]), null);
  eq(factHost("https://anyone.vercel.app/x", "Vercel", ["ops@anyone.vercel.app"]), null, "a shared-hosting subdomain is no firm's site");
  eq(factHost("https://anyone.github.io/x", "Acme", ["github.io"]), null, "nor is a shared-hosting domain from an email");
  eq(factHost("https://vercel.com/about", "Vercel", ["rauch@vercel.com"]), "company_page");
  eq(factHost("https://stripe/team", "Stripe"), null, "a single-label host is no one's site");
});

// A fake network: a map of URL -> response; every GET recorded.
function net(routes: Record<string, { status: number; location?: string; html?: string }>) {
  const got: string[] = [];
  const get: PageGet = async (url) => {
    got.push(url.toString());
    if (url.pathname === "/robots.txt") return new Response("", { status: 404 });
    const r = routes[url.toString()];
    if (!r) return new Response("nope", { status: 404 });
    if (r.location) return new Response(null, { status: r.status, headers: { location: r.location } });
    return new Response(r.html ?? "<p>x</p>", { status: r.status, headers: { "content-type": "text/html" } });
  };
  return { get, got };
}
const resolveAll = (ips: Record<string, string> = {}) => async (h: string) => [ips[h] ?? PUBLIC_IP];
const allowStripe = (u: URL) => factHost(u.toString(), "Stripe", ["stripe.com"]) === "company_page";

Deno.test("R1 a redirect to an off-list host is refused before it is resolved or fetched", async () => {
  const n = net({ "https://stripe.com/team": { status: 302, location: "https://stripe.attacker.io/team" }, "https://stripe.attacker.io/team": { status: 200 } });
  const resolved: string[] = [];
  const r = await fetchHtml(n.get, "https://stripe.com/team", async (h) => { resolved.push(h); return [PUBLIC_IP]; }, allowStripe);
  eq(r.ok, false);
  eq((r as { why: string }).why, "not_allowed");
  assert(!n.got.some((u) => /attacker/.test(u)) && !resolved.some((h) => /attacker/.test(h)), JSON.stringify({ got: n.got, resolved }));
});

Deno.test("R2 the first URL itself must pass the allowlist", async () => {
  const n = net({ "https://stripe.com.evil.net/team": { status: 200 } });
  const r = await fetchHtml(n.get, "https://stripe.com.evil.net/team", resolveAll(), allowStripe);
  eq((r as { why: string }).why, "not_allowed");
  eq(n.got, []);
});

Deno.test("R3 an on-list hop that resolves to a private address is refused", async () => {
  const n = net({ "https://stripe.com/team": { status: 301, location: "https://internal.stripe.com/team" }, "https://internal.stripe.com/team": { status: 200 } });
  const r = await fetchHtml(n.get, "https://stripe.com/team", resolveAll({ "internal.stripe.com": "10.0.0.5" }), allowStripe);
  eq((r as { why: string }).why, "private_host");
  assert(!n.got.some((u) => /internal/.test(u)), n.got.join(" "));
});

Deno.test("R4 on-list redirects are followed up to MAX_REDIRECTS hops, and one more is refused", async () => {
  const chain = (n: number) => {
    const routes: Record<string, { status: number; location?: string; html?: string }> = {};
    for (let i = 0; i < n; i++) routes[`https://${i % 2 ? "www." : ""}stripe.com/h${i}`] = { status: 302, location: `https://${(i + 1) % 2 ? "www." : ""}stripe.com/h${i + 1}` };
    routes[`https://${n % 2 ? "www." : ""}stripe.com/h${n}`] = { status: 200, html: "<p>team</p>" };
    return routes;
  };
  eq(MAX_REDIRECTS, 3);
  const ok = await fetchHtml(net(chain(MAX_REDIRECTS)).get, "https://stripe.com/h0", resolveAll(), allowStripe);
  eq(ok.ok, true, JSON.stringify(ok));
  const over = await fetchHtml(net(chain(MAX_REDIRECTS + 1)).get, "https://stripe.com/h0", resolveAll(), allowStripe);
  eq((over as { why: string }).why, "redirects");
});

Deno.test("R5 in chat: a firm page that redirects off the firm's domain saves nothing and the other host is never read", async () => {
  const U = "u-fx7", T = "t-fx7";
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Test Person" });
  const row = { file: "contacts.csv", row: 2, name: "Maya Chen", email: "maya.chen@stripe.com", firm: "Stripe", firm_raw: "Stripe", company: "Stripe", title: "Data Analyst", school: "", connected_on: null, verified: true } as ContactRow;
  await store.putContacts!(U, await store.accountEpoch!(U), [keyedContact(row)]);
  const state: Record<string, unknown> = { profile: { facts: SENDER_FACTS } };
  const n = net({
    "https://stripe.com/team/maya": { status: 302, location: "https://stripe.com.evil.net/maya" },
    "https://stripe.com.evil.net/maya": { status: 200, html: "<p>Maya Chen leads the payments ledger rebuild at Stripe and spoke at Strange Loop.</p>" },
  });
  const people = { pageGet: n.get, resolve: resolveAll() } as any;
  const r = await networkingTurn({ message: "Maya Chen's team page: https://stripe.com/team/maya", userId: U, threadId: T, now: NOW, state, store, model: fakeWriter(), people });
  assert(r && r.status === "nothing_saved", r?.reply);
  assert(!n.got.some((u) => /evil/.test(u)), n.got.join(" "));
  eq((await store.recipientFacts!(U, ["e:maya.chen@stripe.com"])).size, 0);

  // A firm page that redirects to another allowlisted kind (SEC EDGAR) is not read as the firm's page either.
  const n2 = net({ "https://stripe.com/team/maya2": { status: 302, location: "https://www.sec.gov/maya" }, "https://www.sec.gov/maya": { status: 200, html: "<p>Maya Chen signed the filing.</p>" } });
  const r2 = await networkingTurn({ message: "Maya Chen's team page: https://stripe.com/team/maya2", userId: U, threadId: T, now: NOW, state, store, model: fakeWriter(), people: { pageGet: n2.get, resolve: resolveAll() } as any });
  assert(r2 && r2.status === "nothing_saved", r2?.reply);
  assert(!n2.got.some((u) => /sec\.gov\/maya/.test(u)), n2.got.join(" "));
});

Deno.test("R6 in chat: the contact's work-email domain is the firm's site when the firm's name is not its domain", async () => {
  const U = "u-fx7k", T = "t-fx7k";
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Test Person" });
  const row = { file: "contacts.csv", row: 2, name: "Ravi Iyer", email: "ravi.iyer@google.com", firm: "Alphabet", firm_raw: "Alphabet", company: "Alphabet", title: "Software Engineer", school: "", connected_on: null, verified: true } as ContactRow;
  await store.putContacts!(U, await store.accountEpoch!(U), [keyedContact(row)]);
  const state: Record<string, unknown> = { profile: { facts: SENDER_FACTS } };
  const n = net({ "https://careers.google.com/team/ravi": { status: 200, html: "<p>Ravi Iyer leads the storage reliability rebuild for the ledger pipeline team.</p>" } });
  const r = await networkingTurn({ message: "Ravi Iyer's team page: https://careers.google.com/team/ravi", userId: U, threadId: T, now: NOW, state, store, model: fakeWriter(), people: { pageGet: n.get, resolve: resolveAll() } as any });
  assert(r && r.status === "saved", r?.reply);
  const f = (await store.recipientFacts!(U, ["e:ravi.iyer@google.com"])).get("e:ravi.iyer@google.com") ?? [];
  eq(f.map((x: any) => x.source_kind), ["company_page"], JSON.stringify(f));
});

Deno.test("L1 in chat: a LinkedIn link sent about a contact gets the LinkedIn note and is never opened", async () => {
  const U = "u-fx7l", T = "t-fx7l";
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Test Person" });
  const row = { file: "contacts.csv", row: 2, name: "Maya Chen", email: "maya.chen@stripe.com", firm: "Stripe", firm_raw: "Stripe", company: "Stripe", title: "Data Analyst", school: "", connected_on: null, verified: true } as ContactRow;
  await store.putContacts!(U, await store.accountEpoch!(U), [keyedContact(row)]);
  const state: Record<string, unknown> = { profile: { facts: SENDER_FACTS } };
  const n = net({});
  const people = { pageGet: n.get, resolve: resolveAll() } as any;
  const li = await networkingTurn({ message: "Maya Chen's profile: https://www.linkedin.com/in/maya-chen-test", userId: U, threadId: T, now: NOW, state, store, model: fakeWriter(), people });
  assert(li && /I never open LinkedIn/.test(li.reply), li?.reply);
  assert(!/I read only/.test(li!.reply), li!.reply);
  assert(!n.got.some((u) => /linkedin/.test(u)), n.got.join(" "));
});

Deno.test("R8 in chat: with no work email on record, the firm's site is never guessed and the note says why", async () => {
  const U = "u-fx7n", T = "t-fx7n";
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Test Person" });
  const row = { file: "contacts.csv", row: 2, name: "Lee Park", email: null, firm: "Stripe", firm_raw: "Stripe", company: "Stripe", title: "Engineer", school: "", connected_on: null, verified: true } as ContactRow;
  await store.putContacts!(U, await store.accountEpoch!(U), [keyedContact(row)]);
  const state: Record<string, unknown> = { profile: { facts: SENDER_FACTS } };
  const n = net({ "https://stripe.com/team/lee": { status: 200, html: "<p>Lee Park leads the payments ledger rebuild.</p>" } });
  const r = await networkingTurn({ message: "Lee Park's team page: https://stripe.com/team/lee", userId: U, threadId: T, now: NOW, state, store, model: fakeWriter(), people: { pageGet: n.get, resolve: resolveAll() } as any });
  assert(r && /a firm's own site only at the domain of a work email I have for them \(I have none for Lee\)/.test(r.reply), r?.reply);
  eq(n.got, []);
});
