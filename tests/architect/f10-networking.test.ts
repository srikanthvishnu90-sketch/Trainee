// FEATURE 10: networking from chat (supabase/functions/_shared/career_networking.ts), unit level. The phrasings a person
// types, the import's coverage fraction, the answer from their own contacts (and the plain "none" with how to add them),
// drafts through draftFor onto the outreach batch, the drafting-off fallback, the signature answer, and never an address
// that is not on the person's own row. Synthetic data, a scripted model, the in-memory outreach store.
// Run: deno test -A --no-check tests/architect/f10-networking.test.ts
import { engineAware, seedFacts } from "./personal-fixture.ts";
import nodeAssert from "node:assert/strict";
const assert = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const assertEquals = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const assertMatch = (s: string, re: RegExp) => nodeAssert.match(s, re);
import { networkingTurn, parseNetworkingAsk, pastedCsv, SIGNATURE_INTENT } from "../../supabase/functions/_shared/career_networking.ts";
import { memoryOutreachStore, messageOf, OUTREACH_INTENT, outreachLock, outreachTurn, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { contactsOf } from "../../supabase/functions/_shared/career_contacts.ts";
import { memoryEventStore } from "../../supabase/functions/_shared/agent/timeline.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const LINKEDIN = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/Connections.csv`);
const CONTACTS = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/contacts.csv`);
const U = "u-1", T = "t-1", NOW = Date.parse("2026-10-25T15:00:00Z");
const FACTS = [
  { id: "f1", kind: "education", school: "TEST University", degree: "B.S. Computer Science", status: "confirmed" },
  { id: "f2", kind: "experience", title: "Software Engineering Intern", company: "TEST Systems Inc", status: "confirmed" },
];
// The scripted model: writes from the recipient row and the ask it was given; "Sam" gets a claim that is not on record.
const said = (payload: any) => String(payload.messages?.[0]?.content ?? "");
// PERSONALIZED OUTREACH (2026-10-31): a first email's payload is the engine's (personal-fixture.ts engineAware); Sam's
// invented claim is kept there too.
const model = engineAware(async (payload: any) => {
  const p = said(payload), first = /- name: (\S+)/.exec(p)![1], topic = /ASK ABOUT[^\n]*\n- (.+)/.exec(p)?.[1];
  const ask = topic ? `ask about ${topic}` : "hear how you got started";
  const extra = first === "Sam" ? " I worked at Google for two years." : "";
  return { content: [{ type: "text", text: `Subject: A quick question\n\nHi ${first},\n\nI'd be grateful for 15 minutes to ${ask}.${extra} Would you be open to a short call?` }], stop_reason: "end_turn" };
}, (first) => (first === "Sam" ? "I worked at Google for two years." : ""));

Deno.test("F10 parse: the phrasings people type", () => {
  for (const m of ["who do I know at Stripe?", "find my connections at Stripe", "do I know anyone at Stripe", "find me someone at Stripe", "show me my contacts at Stripe", "Who in my network works at Stripe?"]) {
    assertEquals(parseNetworkingAsk(m), { kind: "who", firm: "Stripe" }, m);
  }
  assertEquals(parseNetworkingAsk("email Maya at Stripe about the data analyst role"), { kind: "draft", topic: "the data analyst role", target: { by: "name", name: "Maya", firm: "Stripe" } });
  assertEquals(parseNetworkingAsk("draft intros to my 3 contacts at Stripe"), { kind: "draft", topic: null, target: { by: "group", firm: "Stripe", count: 3, role: null } });
  assertEquals(parseNetworkingAsk("email a recruiter at Stripe"), { kind: "draft", topic: null, target: { by: "group", firm: "Stripe", count: 1, role: "recruiter" } });
  assertEquals(parseNetworkingAsk("can you write an email to Maya Chen for a referral"), { kind: "draft", topic: "a referral", target: { by: "name", name: "Maya Chen", firm: null } });
  assertEquals(parseNetworkingAsk("draft 2 emails to people at Ramp regarding product roles"), { kind: "draft", topic: "product roles", target: { by: "group", firm: "Ramp", count: 2, role: null } });
  // Not networking: the rest of the chain answers these.
  for (const m of ["apply by email to Acme", "draft a cover letter for Stripe", "email my resume to them", "find data analyst jobs in Chicago", "who emailed me?", "any news from Stripe?", "where do I stand with Stripe", "draft a coffee-chat email to a recruiter at Stripe"]) {
    assertEquals(parseNetworkingAsk(m), null, m);
  }
  assert(pastedCsv(`here are mine\nName,Company,Email\nDana Lopez,Plaid,dana@plaid.example`));
  assertEquals(pastedCsv("I applied to Stripe, Ramp and Plaid\nand heard back from none"), null);
});

Deno.test("F10 import: a LinkedIn export and a contacts CSV, with coverage fractions and nothing guessed", async () => {
  const state: Record<string, unknown> = {}, store = memoryOutreachStore();
  const r = await networkingTurn({ message: "here are my connections", userId: U, threadId: T, now: NOW, state, store, model: null, attachments: [{ name: "Connections.csv", mime: "text/csv", text: LINKEDIN }] });
  assertEquals([r!.intent, r!.status], ["career_contacts_import", "imported"]);
  assertMatch(r!.reply, /Connections\.csv: imported 6\/8 rows into your contacts \(left out: 1 duplicate; row 7: no name\)/);
  assertMatch(r!.reply, /4\/6 have an email address; the other 2 can be looked up by firm but not written to, since I never guess an address/);
  assertMatch(r!.reply, /Most contacts: Stripe 4/);
  // Architect ruling R1 (2026-10-27): the rows are the account's (career_account_contacts), and no chat keeps a copy
  // (the per-chat copy had to be capped by the chat state's size). So the count is read from the account, and the chat
  // state holds none. Was: contactsOf(state).length === 6, then 8.
  assertEquals((await store.contactsSummary!(U)).total, 6);
  assertEquals(contactsOf(state).length, 0, "no per-chat copy");
  // No profile URL is kept from the export.
  assert(!JSON.stringify(state).includes("linkedin.com/in/"));
  assert(!JSON.stringify(await store.contactsAtFirm!(U, "stripe")).includes("linkedin.com/in/"));
  const pasted = await networkingTurn({ message: `add these\n${CONTACTS}`, userId: U, threadId: T, now: NOW, state, store, model: null });
  assertMatch(pasted!.reply, /pasted list 2026-10-25 15:00 UTC: imported 2\/2 rows/);
  assertEquals((await store.contactsSummary!(U)).total, 8);
  const bad = await networkingTurn({ message: "my resume", userId: U, threadId: T, now: NOW, state, store, model: null, attachments: [{ name: "resume.pdf", mime: "application/pdf", text: null }] });
  assertEquals(bad!.status, "not_imported");
  assertMatch(bad!.reply, /resume\.pdf: not read/);
});

Deno.test("F10 who: from their own contacts, one person once; none says so and how to add people", async () => {
  const store = memoryOutreachStore(), empty: Record<string, unknown> = {};
  const none = await networkingTurn({ message: "who do I know at Stripe?", userId: U, threadId: T, now: NOW, state: empty, store, model: null });
  assertEquals(none!.status, "no_contacts");
  assertMatch(none!.reply, /haven't sent me any contacts yet.*don't have a people database or an email finder.*LinkedIn: Settings, Data privacy, Get a copy of your data, Connections/s);
  const state: Record<string, unknown> = {};
  await networkingTurn({ message: "x", userId: U, threadId: T, now: NOW, state, store, model: null, attachments: [{ name: "Connections.csv", text: LINKEDIN }, { name: "contacts.csv", text: CONTACTS }] });
  const who = await networkingTurn({ message: "find my connections at Stripe", userId: U, threadId: T, now: NOW, state, store, model: null });
  assertEquals(who!.status, "listed");
  assertMatch(who!.reply, /You have 4 contacts at Stripe \(from 2 lists\), 4 with an email address:/);
  assertEquals((who!.reply.match(/Lee Park/g) ?? []).length, 1, who!.reply);
  assertMatch(who!.reply, /- Lee Park, Software Engineer \(lee\.park@stripe\.example\)/);
  const notThere = await networkingTurn({ message: "do I know anyone at Plaid Technologies", userId: U, threadId: T, now: NOW, state, store, model: null });
  assertEquals(notThere!.status, "none_at_firm");
  assertMatch(notThere!.reply, /None of your 8 contacts .* is at Plaid Technologies\. I don't have a people database/);
  // People the router kept from an earlier export count too, with the same checks.
  const older: Record<string, unknown> = { profile: { connections: [{ name: "Robin Old", company: "Stripe", position: "Analyst", email: "robin.old@stripe.example" }] } };
  // Architect ruling R1 (2026-10-27): contacts are the account's, not the thread's. `older` is another thread of the same
  // person U, whose account already holds the 4 Stripe contacts imported above; so the answer there is those 4 plus the
  // router's legacy row, each once (it was 1, the legacy row alone, while contacts were per thread).
  const legacy = await networkingTurn({ message: "who do I know at Stripe", userId: U, threadId: T, now: NOW, state: older, store, model: null });
  assertMatch(legacy!.reply, /^You have 5 contacts at Stripe \(from 3 lists\), 5 with an email address:/);
  assertMatch(legacy!.reply, /\n- Robin Old, Analyst \(robin\.old@stripe\.example\)/);
  assertEquals((legacy!.reply.match(/Lee Park/g) ?? []).length, 1, legacy!.reply);
  // A person with no contacts on their account still gets the legacy row alone, exactly as before.
  const alone = await networkingTurn({ message: "who do I know at Stripe", userId: "u-legacy-only", threadId: "t-legacy", now: NOW, state: { profile: structuredClone(older.profile) }, store, model: null });
  assertMatch(alone!.reply, /You have 1 contact at Stripe \(from LinkedIn connections \(imported earlier\)\), 1 with an email address:\n- Robin Old, Analyst \(robin\.old@stripe\.example\)/);
});

Deno.test("F10 draft: onto the outreach batch; one approval per exact message; held and failed ones counted with reasons", async () => {
  const store = memoryOutreachStore(), events = memoryEventStore(), state: Record<string, unknown> = { profile: { facts: FACTS } };
  await networkingTurn({ message: "x", userId: U, threadId: T, now: NOW, state, store, model: null, attachments: [{ name: "Connections.csv", text: LINKEDIN }] });
  // PERSONALIZED OUTREACH (2026-10-31): Maya and Sam each carry one sourced fact (what the person told Trainee).
  await seedFacts(store, U, ["maya.chen@stripe.example", "sam.rivera@stripe.example"]);
  // Drafting off: who would be written to, nothing written, no model call.
  const off = await networkingTurn({ message: "email Maya at Stripe about the data analyst role", userId: U, threadId: T, now: NOW, state, store, model: null });
  assertEquals(off!.status, "drafting_off");
  assertMatch(off!.reply, /nothing was written or sent.*Maya Chen, Data Analyst at Stripe <maya\.chen@stripe\.example>/);
  // No signature yet: asked once; the answer saves it and the ask that needed it runs.
  const sig = await networkingTurn({ message: "email Maya at Stripe about the data analyst role", userId: U, threadId: T, now: NOW, state, store, model });
  assertEquals(sig!.intent, SIGNATURE_INTENT);
  store.setIntent(T, SIGNATURE_INTENT);
  const one = await networkingTurn({ message: "Alex Testcase\nTEST University", userId: U, threadId: T, now: NOW, state, store, events, model,
    previousAsk: async () => "email Maya at Stripe about the data analyst role" });
  assertEquals([one!.intent, one!.status], [OUTREACH_INTENT, "drafted"]);
  assertMatch(one!.reply, /^Saved your signature\.\n\nDrafted 1\/1\./);
  assertMatch(one!.reply, /To: Maya Chen, Data Analyst, Stripe <maya\.chen@stripe\.example>/);
  // PERSONALIZED OUTREACH (2026-10-31): was /to ask about the data analyst role/, the generic body; the email now names
  // the sourced fact about Maya.
  assertMatch(one!.reply, /TEST meetup talk about data pipelines/);
  assertMatch(one!.reply, /Alex Testcase\nTEST University/);
  const batch = await store.latestBatch(U);
  assertEquals(batch.length, 1);
  assertEquals(batch[0].hash, await payloadHash(messageOf(batch[0])));
  assertEquals((await events.recall(U, { limit: 10 })).map((e) => e.kind), ["outreach_drafted"]);
  // A group: the role inbox and the address-less row are held with reasons; the one whose draft claims something not on
  // record is not shown; the fraction says so.
  store.setIntent(T, null);
  const group = await networkingTurn({ message: "draft intros to my contacts at Stripe", userId: U, threadId: T, now: NOW, state, store, model });
  assertMatch(group!.reply, /^Drafted 0\/4|Nothing was drafted \(0\/4\)/);
  assertMatch(group!.reply, /Maya Chen \(you already have a draft or email to them\)/);
  assertMatch(group!.reply, /Lee Park \(no email address in your contacts, and I never guess one\)/);
  assertMatch(group!.reply, /Stripe Careers \(careers@stripe\.example is a shared inbox, not a person\)/);
  assertMatch(group!.reply, /Sam Rivera \(I couldn't write it without saying something not on record/);
  // The approval: "send 1" approves exactly the message shown.
  store.setIntent(T, OUTREACH_INTENT);
  const yes = await outreachTurn({ message: "send 1", userId: U, threadId: T, now: NOW + 60_000, store });
  assertEquals(yes!.status, "approved");
  assertEquals((await store.latestBatch(U))[0].approved_hash, batch[0].hash);
});

Deno.test("F10 never an invented address or person; the topic is the ask, never a fact", async () => {
  const store = memoryOutreachStore(), state: Record<string, unknown> = { profile: { facts: FACTS } };
  await store.setPrefs(U, { signature: "Alex" });
  await networkingTurn({ message: "x", userId: U, threadId: T, now: NOW, state, store, model: null, attachments: [{ name: "Connections.csv", text: LINKEDIN }] });
  let calls = 0;
  const counting = async (p: any) => { calls++; return await model(p); };
  const nobody = await networkingTurn({ message: "email Jamie at Stripe about a referral", userId: U, threadId: T, now: NOW, state, store, model: counting });
  assertEquals(nobody!.status, "not_in_contacts");
  assertMatch(nobody!.reply, /No one named Jamie at Stripe is in your contacts \(your contacts there: Maya Chen, Lee Park, Sam Rivera, Stripe Careers\)/);
  const noAddr = await networkingTurn({ message: "email Lee Park", userId: U, threadId: T, now: NOW, state, store, model: counting });
  assertEquals(noAddr!.status, "held");
  assertMatch(noAddr!.reply, /Lee Park: no email address in your contacts, and I never guess one/);
  const recruiter = await networkingTurn({ message: "email a recruiter at Goldman", userId: U, threadId: T, now: NOW, state, store, model: counting });
  assertEquals(recruiter!.status, "none_at_firm");
  assertMatch(recruiter!.reply, /No recruiter at Goldman Sachs is in your 6 contacts\. Your contacts at Goldman Sachs: Jordan Example/);
  assertEquals(calls, 0, "no model call for anyone not on the person's own list");
  assertEquals(await store.latestBatch(U), []);
  // The topic may be named, but "I ... at X" still needs X in the person's facts.
  const r = { name: "Maya Chen", firm: "Stripe", title: "Data Analyst", school: "", email: "maya.chen@stripe.example", source: "x" };
  assert(outreachLock("Hi Maya, could I ask about the Payments Analyst role?", { facts: [], recipient: r, shared: [], topic: "the Payments Analyst role" }).pass);
  assert(!outreachLock("Hi Maya, I worked at Payments Corp.", { facts: [], recipient: r, shared: [], topic: "my time at Payments Corp" }).pass);
});
