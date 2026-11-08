// CONTACT OUTREACH (proposal D-042), reproduced defects in PR #590's pipeline. Each test fails on the code before its fix:
//   1. a GitHub profile's email is the recipient only when it is on the company's own domain: a profile that copies the
//      name and puts "@Acme" in its company field cannot choose where the email goes;
//   2. the never-sources refuse on every public suffix (scholar.google.co.uk, glassdoor.co.uk, ziprecruiter.co.uk, ...),
//      in neverSource and in ContactGate.admit;
//   3. private facts (parents and children, a partner or spouse, political parties and campaigns, religious terms) are
//      dropped, while professional names that share a word (Church & Dwight, Temple University, Parish Medical Center)
//      are kept.
// The fourth #590 defect (forget resets the send limits) is in the database: tests/db/career_contact_outreach.check.sql.
import assertNode from "node:assert/strict";
import type { Fetcher } from "../../supabase/functions/_shared/contact_sources/web_gate.ts";
import { contactGate, contactUserAgent, githubFacts, neverSource, PoliteApi } from "../../supabase/functions/_shared/career_contact_sources.ts";
import { findEmail } from "../../supabase/functions/_shared/career_contact_email.ts";
import { keepFacts } from "../../supabase/functions/_shared/career_contact_facts.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const NOW = Date.parse("2026-11-07T15:00:00Z");
const UA = contactUserAgent("owner@trainee.dev");
const mx = (hosts: Record<string, string[]>) => (d: string) => Promise.resolve(hosts[d] ? { status: "ok" as const, hosts: hosts[d] } : { status: "none" as const });

Deno.test("contact defect 1: a GitHub email off the company's domain is never the recipient; the company field alone vouches for nothing", async () => {
  const github = async (user: Record<string, unknown>) => {
    const json: Record<string, unknown> = {
      "https://api.github.com/search/users?q=Jane%20Doe%20in%3Aname&per_page=3": { items: [{ login: "janedoe" }] },
      "https://api.github.com/users/janedoe": { login: "janedoe", name: "Jane Doe", blog: "", bio: "Engineer", ...user },
      "https://api.github.com/users/janedoe/repos?sort=pushed&per_page=5": [],
    };
    const fetcher: Fetcher = (url) => Promise.resolve(url in json ? { status: 200, url, text: JSON.stringify(json[url]) } : { status: 404, url, text: "" });
    return await githubFacts(new PoliteApi({ fetcher, userAgent: UA, now: () => NOW, sleep: async () => {} }), "Jane Doe", "Acme", "acme.io");
  };
  const attacker = await github({ company: "@Acme", email: "jane@attacker.example" });
  eq(attacker.email, null, "a profile that only names the company never supplies the address");
  eq((await github({ company: "@Acme", email: "jane@acme.io" })).email, { email: "jane@acme.io", source_url: "https://github.com/janedoe" }, "an email on the company's domain is kept");
  eq((await github({ company: "@Acme", email: "jane@eng.acme.io" })).email?.email, "jane@eng.acme.io", "a subdomain of the company's domain is on it");
  eq((await github({ company: null, email: "jane@acme.io.attacker.example" })).email, null, "a domain that merely contains acme.io is not on it");

  // findEmail on its own (any caller): the GitHub address must be on the company's domain to count at all.
  const off = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, github: { email: "jane@attacker.example", source_url: "https://github.com/janedoe" },
    mx: mx({ "acme.io": ["mx.other.example"], "attacker.example": ["mx.attacker.example"] }) });
  ok(off.method !== "github_public" && off.email !== "jane@attacker.example", `an off-domain GitHub email is never used: ${JSON.stringify(off)}`);
  eq(off.approvable, false, "and nothing approvable comes of it (the fallback is a guess)");
  const on = await findEmail({ name: "Jane Doe", domain: "acme.io", now: NOW, github: { email: "jane@acme.io", source_url: "https://github.com/janedoe" }, mx: mx({ "acme.io": ["mx.other.example"] }) });
  eq([on.email, on.method, on.score, on.approvable], ["jane@acme.io", "github_public", 90, true], "on the company's domain it counts, at 90");
});

Deno.test("contact defect 2: never-sources refuse on every country domain and TLD, in neverSource and in the gate", () => {
  const never = [
    "https://scholar.google.co.uk/citations?user=x", "https://scholar.google.de/citations?user=x", "https://scholar.google.com.au/x",
    "https://www.glassdoor.co.uk/Reviews/x", "https://glassdoor.de/x", "https://www.ziprecruiter.co.uk/jobs/x", "https://ziprecruiter.ca/x",
    "https://www.crunchbase.co/person/x", "https://data.commoncrawl.net/x",
    "https://linkedin.de/in/x", "https://www.linkedin.co.uk/in/x", "https://indeed.fr/x", "https://www.indeed.co.uk/x", "https://indeed.jobs/x",
    "https://uk.joinhandshake.co.uk/x",
  ];
  for (const u of never) ok(neverSource(u), u);
  for (const u of ["https://acme.io/team", "https://news.example.org/a", "https://www.google.co.uk/x", "https://scholarships.example.org/x", "https://glassdoorway.example.com/x"]) ok(!neverSource(u), `not a never-source: ${u}`);

  const fetcher: Fetcher = (url) => Promise.resolve({ status: 404, url, text: "" });
  const gate = contactGate({ fetcher, userAgent: UA, domain: "acme.io", org: "Acme", now: () => NOW, resolver: () => Promise.resolve(["93.184.216.34"]) });
  eq(gate.admit(["https://scholar.google.co.uk/citations?user=x", "https://www.glassdoor.co.uk/x", "https://www.ziprecruiter.co.uk/x", "https://www.linkedin.co.uk/x", "https://news.example.org/a"]),
    ["news.example.org"], "the gate admits only the ordinary page");
});

Deno.test("contact defect 3: family, partners, politics and religion are dropped; professional names that share a word are kept", () => {
  const raw = (claim: string) => ({ claim, source_url: "https://acme.io/x", source_type: "company_page" as const, published_at: null, quote: claim, method: "t", confidence: 0.8 });
  const priv = ["Father of two", "Proud mom of three", "Jane and her partner Alex live nearby", "Volunteers with the DNC", "Sings in the choir at St. Mary's parish",
    "A dad and a cyclist", "Mother of a toddler", "Lives with his wife and kids", "Canvassed for the Republican Party", "Volunteered on a presidential campaign",
    "Their pastor spoke at the event", "Attends the mosque on Fridays", "Member of Temple Beth El", "Active at the synagogue", "Organizes the church picnic",
    "Married to Sam", "Donated to the GOP", "Her spouse works at Acme"];
  const k = keepFacts(priv.map(raw), { now: NOW });
  eq(k.facts.map((f) => f.claim), [], `none of these is kept: ${JSON.stringify(k.facts.map((f) => f.claim))}`);
  ok(k.dropped.every((d) => d.why === "private"), JSON.stringify(k.dropped));

  const pro = ["Led supply chain at Church & Dwight", "Studied computer science at Temple University", "CTO of Parish Medical Center", "Partner at Sequoia Capital",
    "Managing partner of the firm", "Ran the Q3 marketing campaign", "Integrated the parent company's billing", "Partnered with Stripe on payments"];
  eq(keepFacts(pro.map(raw), { now: NOW }).facts.map((f) => f.claim).sort(), [...pro].sort(), "professional facts that share a word stay");
  eq(keepFacts([raw("Proud mom; CTO of Parish Medical Center")], { now: NOW }).facts, [], "an allowlisted name never shields a private fact beside it");
  eq(keepFacts([raw("Joined Grace Church as a deacon")], { now: NOW }).facts, [], "a church that is not on the list is religion");
  eq(keepFacts([raw("Director of IT at Grace Church")], { now: NOW, employers: ["Grace Church"] }).facts.length, 1, "the contact's own employer is professional");
});
