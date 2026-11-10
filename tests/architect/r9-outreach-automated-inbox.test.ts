// R9 OUTREACH SAFETY (2026-11-08): outreach is written to a person, never to an application system's no-reply sender, a
// no-reply or notification inbox, a role inbox, or any address on an ATS's or a job board's domain. The 1,000-task eval's
// adversarial set (evals/career/e2e, guard.ats_domain) sent "email the recruiter at <employer>" to
// notifications@hire.lever.co, the only address the person's list had for that employer.
// Checked at every place an address is chosen or goes: the people connector's selection (a published page), drafting
// (networkingTurn), approval ("send 1"), the sending rail's hand-off (queueApproved) and its last check before Gmail
// (runSendWorker, for a row queued without the hand-off). Only product functions; no eval prompt appears here.
// Run: deno test -A --no-check tests/architect/r9-outreach-automated-inbox.test.ts (the rail step needs Postgres 16)
import assertNode from "node:assert/strict";
import { networkingTurn } from "../../supabase/functions/_shared/career_networking.ts";
import { memoryOutreachStore, messageOf, OUTREACH_INTENT, outreachTurn, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import type { ContactRow } from "../../supabase/functions/_shared/career_contacts.ts";
import { queueApproved, queueApprovedOutreach, runSendWorker } from "../../supabase/functions/_shared/career_send_rail.ts";
import { automatedInbox } from "../../supabase/functions/_shared/automated_inbox.ts";
import { peopleOnPage } from "../../supabase/functions/_shared/career_people_page.ts";
import { approvedDrafts, CI, draftsReader, FakeGmail, haveDb, person, railDb, railDeps, rows, uid as uidOf } from "../flow/send-rail-fixture.ts";
import { serviceRpc } from "../flow/pgwire.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const U = "u-r9-ats", NOW = Date.parse("2026-11-08T15:00:00Z");
const FACTS = [
  { id: "f1", kind: "education", school: "TEST University", degree: "B.S. Statistics", status: "confirmed" },
  { id: "f2", kind: "experience", title: "Data Intern", company: "TEST Systems Inc", status: "confirmed" },
];
// The addresses no person reads, or that are not the employer's person. Every one passed the address checks before.
const NOT_A_PERSON = [
  "notifications@hire.lever.co", "no-reply@us.greenhouse-mail.io", "no-reply@ashbyhq.com", "jobs@smartrecruiters.com",
  "maya.chen@hire.lever.co", "do-not-reply@acmeanalytics.com", "noreply@acmeanalytics.com", "notifications@acmeanalytics.com",
  "donotreply+jobs@acmeanalytics.com", "recruiter@linkedin.com",
];
const row = (email: string, name = "Maya Chen", firm = "Acme Analytics"): ContactRow =>
  ({ file: "contacts.csv", row: 1, name, email, firm, firm_raw: firm, company: firm, title: "Recruiting", school: "", connected_on: null, verified: true }) as ContactRow;

Deno.test("R9 outreach safety: drafting holds a no-reply, ATS or job-board address and says why; a real person is still drafted", async () => {
  for (const email of NOT_A_PERSON) {
    const store = memoryOutreachStore();
    await store.setPrefs(U, { signature: "Jordan Lee" });
    const state: Record<string, unknown> = { profile: { facts: FACTS }, contacts: [row(email)] };
    const r = await networkingTurn({ message: "email Maya at Acme Analytics about the data analyst role", userId: U, threadId: "t1", now: NOW, state, store, model: null });
    eq(r?.status, "held", `${email}: ${r?.reply}`);
    ok(r!.reply.includes(email) && /not a person/.test(r!.reply), r!.reply);
    eq(store.dump().drafts.length, 0, `${email}: nothing drafted`);
  }
  // The same ask with the employer's own person on file reaches drafting (model off here: "drafting_off", not held).
  const store = memoryOutreachStore();
  await store.setPrefs(U, { signature: "Jordan Lee" });
  const state: Record<string, unknown> = { profile: { facts: FACTS }, contacts: [row("maya.chen@acmeanalytics.com")] };
  const r = await networkingTurn({ message: "email Maya at Acme Analytics about the data analyst role", userId: U, threadId: "t1", now: NOW, state, store, model: null });
  eq(r?.status, "drafting_off", r?.reply);
});

Deno.test("R9 outreach safety: someone who works AT LinkedIn, Workday or Greenhouse is a person at their employer's own domain", async () => {
  // The predicate: an ATS or job-board domain is refused unless it is the contact's own employer's domain; a no-reply or
  // role inbox is refused everywhere; no employer known, the domain is refused (fail closed).
  eq(automatedInbox("maya@linkedin.com", "LinkedIn"), null);
  eq(automatedInbox("dana.ruiz@workday.com", "Workday"), null);
  eq(automatedInbox("lee@greenhouse.io", "Greenhouse"), null);
  eq(automatedInbox("notifications@hire.lever.co", "Acme Analytics"), "no_reply");
  eq(automatedInbox("maya.chen@hire.lever.co", "Acme Analytics"), "ats_domain");
  eq(automatedInbox("no-reply@linkedin.com", "LinkedIn"), "no_reply");
  eq(automatedInbox("careers@linkedin.com", "LinkedIn"), "role_inbox");
  eq(automatedInbox("dana@myworkdayjobs.com", "Workday"), "ats_domain", "the system's candidate-mail domain is not the employer's own");
  eq(automatedInbox("maya@linkedin.com"), "ats_domain", "no employer known: refused");
  eq(automatedInbox("maya@linkedin.com", "Acme Analytics"), "ats_domain");
  // Drafting (a chat ask that names LinkedIn is never a draft, by the LinkedIn rule; Workday stands in): a Workday contact at
  // workday.com reaches drafting (model off here: "drafting_off"); no-reply@ there is held.
  for (const [email, want] of [["maya@workday.com", "drafting_off"], ["no-reply@workday.com", "held"]] as const) {
    const store = memoryOutreachStore();
    await store.setPrefs(U, { signature: "Jordan Lee" });
    const state: Record<string, unknown> = { profile: { facts: FACTS }, contacts: [row(email, "Maya Chen", "Workday")] };
    const r = await networkingTurn({ message: "email Maya at Workday about the data analyst role", userId: U, threadId: "t-wd", now: NOW, state, store, model: null });
    eq(r?.status, want, `${email}: ${r?.reply}`);
  }
});

Deno.test("R9 outreach safety: a shown draft to an ATS no-reply address is never approved by \"send 1\"", async () => {
  const store = memoryOutreachStore();
  const d = { n: 1, recipient: { name: "Acme Recruiting", firm: "Acme Analytics", title: "Recruiting", school: "", email: "notifications@hire.lever.co", source: "contacts.csv, row 1" },
    subject: "The data analyst role", body: "Hi,\n\nI applied for the data analyst role.", footer: "Jordan Lee", shared: [], status: "shown" as const, hash: "",
    approved_hash: null, approved_at: null, sent_at: null, gmail_id: null, gmail_thread: null, result: null, created_at: new Date(NOW).toISOString() };
  d.hash = await payloadHash(messageOf(d));
  await store.saveBatch(U, "t2", [d], NOW);
  store.setIntent("t2", OUTREACH_INTENT);
  const handed: unknown[] = [];
  const r = await outreachTurn({ message: "send 1", userId: U, threadId: "t2", now: NOW + 1000, store, onApproved: async (_u, items) => { handed.push(...items); } });
  ok(r, "the answer is outreach's");
  eq(r!.status, "none_approved", r!.reply);
  eq(handed, [], "nothing handed to the sending rail");
  eq(store.dump().drafts.map((x) => x.status), ["shown"], "the draft stays unapproved");
});

Deno.test("R9 outreach safety: the people connector never takes an ATS or no-reply address from a page as a person's", () => {
  const html = `<script type="application/ld+json">${JSON.stringify([
    { "@type": "Person", name: "Maya Chen", jobTitle: "Recruiter", email: "notifications@hire.lever.co", worksFor: { "@type": "Organization", name: "Acme Analytics" } },
    { "@type": "Person", name: "Lee Park", jobTitle: "Recruiter", email: "mailto:no-reply@acmeanalytics.com", worksFor: { "@type": "Organization", name: "Acme Analytics" } },
  ])}</script>`;
  const { people } = peopleOnPage(html);
  eq(people.length, 2, "both people are kept, without the address");
  for (const p of people) ok(!p.email, `${p.name}: ${p.email}`);
});

Deno.test({ name: "R9 outreach safety: the sending rail refuses a no-reply or ATS address at hand-off and at its last check", sanitizeResources: false, sanitizeOps: false, async fn(t) {
  if (!haveDb()) { if (CI) throw new Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const db = await railDb();
  const RUN = crypto.randomUUID().slice(0, 3);
  try {
    const rpc = serviceRpc(await db.conn());
    await t.step("queueApproved: refused as not a person, nothing queued", async () => {
      const u = uidOf(1, RUN);
      await person(db, u);
      const items = [];
      for (const to of NOT_A_PERSON) {
        const m = { to, subject: "The data analyst role", text: "Hi,\n\nI applied." };
        items.push({ kind: "outreach" as const, sourceId: crypto.randomUUID(), approvalHash: await payloadHash(m), ...m });
      }
      const q = await queueApproved(rpc, u, items);
      eq(q.map((x) => x.status), NOT_A_PERSON.map(() => "refused"), JSON.stringify(q));
      eq(q.map((x) => x.reason), NOT_A_PERSON.map(() => "not_a_person"));
      eq(await rows(db, `select id from public.career_send_queue where user_id = '${u}'`), []);
    });
    await t.step("a LinkedIn contact at linkedin.com is queued and sent; no-reply@linkedin.com and hire.lever.co for Acme are not", async () => {
      const u = uidOf(3, RUN);
      await person(db, u);
      const li = await approvedDrafts(db, u, ["maya.r9@linkedin.com", "no-reply@linkedin.com"], { recipient: { firm: "LinkedIn" } });
      const acme = await approvedDrafts(db, u, ["notifications@hire.lever.co"], { recipient: { firm: "Acme Analytics" } });
      const q = await queueApprovedOutreach({ ...rpc, drafts: draftsReader(db) }, u, [...li, ...acme]);
      eq(q.map((x) => [x.status, x.reason ?? null]), [["queued", null], ["refused", "not_a_person"], ["refused", "not_a_person"]], JSON.stringify(q));
      const gmail = new FakeGmail();
      await runSendWorker(railDeps(db, await db.conn(), gmail), { worker: "w-r9-li", accounts: 5, perAccount: 5 });
      eq(gmail.sent.filter((m) => m.account === u).map((m) => m.to), ["maya.r9@linkedin.com"]);
    });
    await t.step("runSendWorker: a row queued without the hand-off still never reaches Gmail", async () => {
      const u = uidOf(2, RUN);
      await person(db, u);
      const ds = await approvedDrafts(db, u, ["notifications@hire.lever.co", "no-reply@us.greenhouse-mail.io"]);
      const dr = await rows(db, `select id, subject, body, footer, recipient_email from public.career_outreach_drafts where user_id = '${u}' order by n`);
      const items = dr.map((x: any, i: number) => {
        const m = messageOf({ recipient: { email: x.recipient_email }, subject: x.subject, body: x.body, footer: x.footer } as any);
        return { kind: "outreach", source_id: x.id, approval_hash: ds[i].approvalHash, to: m.to, subject: m.subject, body: m.text, provider: "gmail" };
      });
      const { data, error } = await rpc.rpc("career_send_enqueue", { p: { user: u, items } });
      ok(!error, error?.message);
      eq((data as any[]).map((x) => x.status), ["queued", "queued"], JSON.stringify(data));
      const gmail = new FakeGmail();
      const s = await runSendWorker(railDeps(db, await db.conn(), gmail), { worker: "w-r9", accounts: 5, perAccount: 5 });
      eq(gmail.sent.length, 0, "nothing reached Gmail");
      eq(s.sent, 0, JSON.stringify(s));
      ok(s.refused >= 2, JSON.stringify(s));
    });
  } finally {
    await db.stop();
  }
} });
