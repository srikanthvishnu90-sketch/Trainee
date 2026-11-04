// FEATURE 10 follow-up (PR #214, L7; reworked in #225 for architect ruling R1): contacts are the ACCOUNT's, not the
// chat's. What one chat imports, another chat of the same person answers and drafts from; an import in a second chat
// grows the same list; a list a chat held before contacts moved to the account (a saved chat state's `contacts`) joins
// the account once and leaves the chat; another account sees none of it. No chat keeps a copy (career_account_contacts,
// read by indexed queries). In-memory stores, synthetic data.
// Run: deno test -A --no-check tests/architect/f10-networking-account-contacts.test.ts
import nodeAssert from "node:assert/strict";
const assertEquals = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const assertMatch = (s: string, re: RegExp) => nodeAssert.match(s, re);
import { networkingTurn } from "../../supabase/functions/_shared/career_networking.ts";
import { memoryOutreachStore } from "../../supabase/functions/_shared/career_outreach.ts";
import { contactsOf, type ContactRow } from "../../supabase/functions/_shared/career_contacts.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const LINKEDIN = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/Connections.csv`);
const CONTACTS = await Deno.readTextFile(`${ROOT}tests/fixtures/f10/contacts.csv`);
const U = "u-1", U2 = "u-2", NOW = Date.parse("2026-10-25T15:00:00Z");
const FACTS = [
  { id: "f1", kind: "education", school: "TEST University", degree: "B.S. Computer Science", status: "confirmed" },
  { id: "f2", kind: "experience", title: "Software Engineering Intern", company: "TEST Systems Inc", status: "confirmed" },
];

Deno.test("F10 account contacts: imported in one thread, answered from in another thread of the same account", async () => {
  const store = memoryOutreachStore();
  const stateA: Record<string, unknown> = {};
  const imp = await networkingTurn({ message: "here are my connections", userId: U, threadId: "t-a", now: NOW, state: stateA, store, model: null, attachments: [{ name: "Connections.csv", mime: "text/csv", text: LINKEDIN }] });
  assertEquals(imp!.status, "imported");
  assertEquals((await store.contactsSummary!(U)).total, 6, "the account holds the imported contacts");
  assertEquals(contactsOf(stateA).length, 0, "the chat keeps no copy");
  const stateB: Record<string, unknown> = { profile: { facts: FACTS } };
  const who = await networkingTurn({ message: "who do I know at Stripe?", userId: U, threadId: "t-b", now: NOW, state: stateB, store, model: null });
  assertEquals(who!.status, "listed", who!.reply);
  assertMatch(who!.reply, /You have 4 contacts at Stripe/);
  assertMatch(who!.reply, /Lee Park/);
  assertEquals(contactsOf(stateB).length, 0, "answered from the account, not a copy");
  await store.setPrefs(U, { signature: "Jordan Lee\nDePaul University" });
  const draft = await networkingTurn({ message: "email Maya at Stripe about the data analyst role", userId: U, threadId: "t-b", now: NOW, state: stateB, store, model: null });
  assertEquals(draft!.status, "drafting_off", draft!.reply);
  assertMatch(draft!.reply, /Maya Chen/);
});

Deno.test("F10 account contacts: an import in the second thread grows the same account list", async () => {
  const store = memoryOutreachStore();
  const stateA: Record<string, unknown> = {}, stateB: Record<string, unknown> = {};
  await networkingTurn({ message: "here are my connections", userId: U, threadId: "t-a", now: NOW, state: stateA, store, model: null, attachments: [{ name: "Connections.csv", mime: "text/csv", text: LINKEDIN }] });
  const imp = await networkingTurn({ message: `add these\n${CONTACTS}`, userId: U, threadId: "t-b", now: NOW, state: stateB, store, model: null });
  assertEquals(imp!.status, "imported");
  assertEquals((await store.contactsSummary!(U)).total, 8, "both threads' imports are one account list");
  const who = await networkingTurn({ message: "who do I know at Plaid?", userId: U, threadId: "t-a", now: NOW, state: stateA, store, model: null });
  assertEquals(who!.status, "listed", who!.reply);
  assertMatch(who!.reply, /Dana Lopez/);
});

Deno.test("F10 account contacts: a row a chat held before joins the account and leaves the chat; another account sees none", async () => {
  const store = memoryOutreachStore();
  const legacy: ContactRow = { file: "what you typed in chat", row: 1, name: "Maya Chen", email: "maya@stripe.example", firm: "Stripe", firm_raw: "Stripe", company: "Stripe", title: "", school: "", connected_on: null, verified: true };
  const state: Record<string, unknown> = { contacts: [legacy] };
  const who = await networkingTurn({ message: "who do I know at Stripe?", userId: U, threadId: "t-a", now: NOW, state, store, model: null });
  assertEquals(who!.status, "listed", who!.reply);
  const held = await store.contactsAtFirm!(U, "stripe");
  assertEquals(held.map((r) => r.email), ["maya@stripe.example"], "the chat's row joined the account");
  assertEquals("contacts" in state, false, "and left the chat");
  const other: Record<string, unknown> = {};
  const none = await networkingTurn({ message: "who do I know at Stripe?", userId: U2, threadId: "t-c", now: NOW, state: other, store, model: null });
  assertEquals(none!.status, "no_contacts");
  assertEquals((await store.contactsSummary!(U2)).total, 0);
});
