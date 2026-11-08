// R9 OUTREACH COMPLETION (2026-11-08): the e2e set's outreach turns that delivered nothing, by root cause.
//   1. The agent brain's draft_outreach read only the chat's own contact list. Contacts are the account's (architect ruling
//      R1, career_account_contacts): a person who had sent their contacts was told they had none.
//   2. Two draft_outreach calls in one turn saved two batches, each numbered from 1, so "send all" approved only the newer
//      and "send 1" could mean either. One turn makes one batch, numbered 1..N, each draft with the hash it was shown with.
//   3. Asks the networking turn could not read went to the router's keyword replies: "send Rosa at X a note about ...",
//      "find the hiring manager at X and reach out" (read as a search for a company named "X and reach out"), a typo in the
//      verb or the role word. Code reads the English forms; an ask it cannot read is recognised as outreach (outreach_ask.ts)
//      so the staged route gives it to the brain, never to the timeline or company-intel recipe.
// In-memory stores, synthetic people. Run: deno test -A --no-check tests/architect/r9-outreach-completion.test.ts
import nodeAssert from "node:assert/strict";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { memoryEventStore } from "../../supabase/functions/_shared/agent/timeline.ts";
import { networkingTurn, parseNetworkingAsk } from "../../supabase/functions/_shared/career_networking.ts";
import { memoryOutreachStore, messageOf, OUTREACH_INTENT, outreachTurn, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import { parseTargetAsk } from "../../supabase/functions/_shared/career_people_provider.ts";
import { outreachAsk } from "../../supabase/functions/_shared/outreach_ask.ts";

const eq = (a: unknown, b: unknown, m?: string) => nodeAssert.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => nodeAssert.ok(v, m);
const U = "u-r9-out", NOW = Date.parse("2026-11-08T15:00:00Z");
const FACTS = [{ id: "f1", kind: "education", text: "B.S. Statistics, TEST University, Class of 2027", status: "confirmed", needs_confirmation: false }];
const CSV = ["Name,Company,Title,Email", "Maya Chen,Acme Analytics,Talent Partner,maya.chen@acmeanalytics.example", "Lee Park,Borealis Foods,Hiring Manager,lee.park@borealisfoods.example",
  "Dana Ruiz,Corvid Labs,Engineering Manager,dana.ruiz@corvidlabs.example"].join("\n") + "\n";
// A writer that uses only the recipient row and the topic (nothing about the person it was not given).
const model = async (p: any) => {
  const t = String(p.messages[0].content);
  const first = /- name: (.+)/.exec(t)![1].split(" ")[0];
  return { stop_reason: "end_turn", content: [{ type: "text", text: `Subject: A quick question\n\nHi ${first},\n\nWould you have 15 minutes next week for a short call?` }] };
};
const byName = (tools: any[]) => Object.fromEntries(tools.map((t) => [t.name, t]));

async function withContacts() {
  const store = memoryOutreachStore();
  const imp = await networkingTurn({ message: "here are my contacts", userId: U, threadId: "t-import", now: NOW, state: {}, store, model: null, attachments: [{ name: "contacts.csv", mime: "text/csv", text: CSV }] });
  eq(imp?.status, "imported", imp?.reply);
  await store.setPrefs(U, { signature: "Jordan Lee" });
  return store;
}

Deno.test("R9 outreach completion: the brain's draft_outreach drafts from the account's contacts, by firm and by name", async () => {
  const store = await withContacts();
  const tools = byName(careerTools({ postings: async () => [], events: memoryEventStore(), outreach: { store, model }, tz: "America/New_York" }));
  // A new chat: its own state holds no contact list; the account does.
  const state: Record<string, unknown> = { profile: { facts: FACTS } };
  const c = { userId: U, threadId: "t-brain", now: NOW, state, turn: { message: "write to Maya from Acme Analytics", added: [] as string[] } as any };
  const out = await tools.draft_outreach.run({ firm: "Acme Analytics", name: "Maya" }, c);
  eq(out.drafted, 1, JSON.stringify(out));
  eq(c.turn.show?.intent, OUTREACH_INTENT);
  ok(/1\. To: Maya Chen, Talent Partner, Acme Analytics <maya\.chen@acmeanalytics\.example>/.test(c.turn.show.text), c.turn.show.text);
  eq((await store.latestBatch(U)).map((d) => [d.n, d.recipient.email]), [[1, "maya.chen@acmeanalytics.example"]]);
  // A name that is not the one on file at that firm drafts no one.
  const c2 = { ...c, threadId: "t-brain-2", turn: { message: "email Mayan at Acme Analytics", added: [] as string[] } as any };
  eq((await tools.draft_outreach.run({ firm: "Acme Analytics", name: "Mayan" }, c2)).drafted, 0);
});

Deno.test("R9 outreach completion: two drafts in one turn are one batch, numbered 1 and 2; \"send all\" approves exactly both", async () => {
  const store = await withContacts();
  const tools = byName(careerTools({ postings: async () => [], events: memoryEventStore(), outreach: { store, model }, tz: "America/New_York" }));
  const state: Record<string, unknown> = { profile: { facts: FACTS } };
  const c = { userId: U, threadId: "t-two", now: NOW, state, turn: { message: "email Maya at Acme Analytics and Lee at Borealis Foods", added: [] as string[] } as any };
  await tools.draft_outreach.run({ firm: "Acme Analytics", name: "Maya", count: 1 }, c);
  await tools.draft_outreach.run({ firm: "Borealis Foods", name: "Lee", count: 1 }, c);
  const batch = await store.latestBatch(U);
  eq(batch.map((d) => [d.n, d.recipient.email, d.status]), [[1, "maya.chen@acmeanalytics.example", "shown"], [2, "lee.park@borealisfoods.example", "shown"]]);
  for (const d of batch) eq(d.hash, await payloadHash(messageOf(d)), "each draft carries the hash of the message shown");
  ok(/1\. To: Maya Chen/.test(c.turn.show.text) && /2\. To: Lee Park/.test(c.turn.show.text), c.turn.show.text);
  store.setIntent("t-two", OUTREACH_INTENT);
  const handed: { to: string }[] = [];
  const r = await outreachTurn({ message: "send all", userId: U, threadId: "t-two", now: NOW + 1000, store, onApproved: async (_u, items) => { handed.push(...items); } });
  eq(r?.status, "approved", r?.reply);
  eq(handed.map((x) => x.to).sort(), ["lee.park@borealisfoods.example", "maya.chen@acmeanalytics.example"]);
});

Deno.test("R9 outreach completion: the networking turn reads 'send X a note', 'find the role at X and reach out', and typos in the verb or role", async () => {
  const draft = (m: string) => { const a = parseNetworkingAsk(m); return a?.kind === "draft" ? a : null; };
  eq(draft("can you send Rosa at Corvid Labs a note about the data analyst role")?.target, { by: "name", name: "Rosa", firm: "Corvid Labs" });
  eq(draft("can you send Rosa at Corvid Labs a note about the data analyst role")?.topic, "the data analyst role");
  eq(draft("find the hiring manager at Borealis Foods and reach out thx")?.target, { by: "group", firm: "Borealis Foods", count: 1, role: "hiring manager" });
  eq(draft("ngl email Maya at Acme Analytics about what the team works on lmk")?.target, { by: "name", name: "Maya", firm: "Acme Analytics" });
  eq(draft("ngl email Maya at Acme Analytics about what the team works on lmk")?.topic, "what the team works on");
  eq(draft("emaiil the recruiter at Acme Analytics about the new grad program")?.target, { by: "group", firm: "Acme Analytics", count: 1, role: "recruiter" });
  eq(draft("eail the recruiter at Acme Analytics abot the new grad program")?.target, { by: "group", firm: "Acme Analytics", count: 1, role: "recruiter" });
  eq(draft("eail the recruiter at Acme Analytics abot the new grad program")?.topic, "the new grad program");
  eq(draft("Acme Analytics ke recruiter ko the new grad program ke baare mein email karo")?.target, { by: "group", firm: "Acme Analytics", count: 1, role: "recruiter" });
  eq(draft("Corvid Labs wale Dana ko the internship timeline ke baare mein email bhejo")?.target, { by: "name", name: "Dana", firm: "Corvid Labs" });
  eq(draft("escríbele un email a Maya de Acme Analytics sobre how they got started")?.target, { by: "name", name: "Maya", firm: "Acme Analytics" });
  eq(draft("manda un email al reclutador de Acme Analytics sobre the new grad program")?.target, { by: "group", firm: "Acme Analytics", count: 1, role: "recruiter" });
  for (const m of ["email status", "emails from Acme Analytics", "email me the file"]) eq(draft(m), null, m);
  // ... and a search for people is never a company named "X and reach out".
  eq(parseTargetAsk("find the hiring manager at Borealis Foods and reach out"), null);
  // A typo in the role word still finds the manager on file there.
  const store = await withContacts();
  const r = await networkingTurn({ message: "find and email the hirign mangaer at Borealis Foods", userId: U, threadId: "t-role", now: NOW, state: { profile: { facts: FACTS } }, store, model: null });
  eq(r?.status, "drafting_off", r?.reply); // reached drafting (the writer is off here), not "no hirign mangaer at Borealis Foods"
  ok(/Lee Park/.test(r!.reply), r!.reply);
});

Deno.test("R9 outreach completion: an ask to write to someone is recognised in a typo, Spanish or Hindi; an email to oneself is not", () => {
  for (const m of [
    "can you sedn Amara at Prairie Logistics a note abut how they got started",
    "wite to Kofi frrom Willow Energy and ask about the internship timeline",
    "escríbele un email a Sara de Onyx Foods sobre how they got started",
    "manda un email al reclutador de Lumina Systems sobre the new grad program",
    "Truecourse Analytics wale Zain ko the internship timeline ke baare mein email bhejo",
    "fiind the hiring mangaer at Delta Bay Systems and reach out",
  ]) ok(outreachAsk(m), m);
  for (const m of ["email me the file when it's ready", "what is the internship timeline at Stripe?", "send me jobs in Chicago", "how did Stripe get started?", "find data analyst jobs at Acme Analytics"]) ok(!outreachAsk(m), m);
});
