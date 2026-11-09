// WO-G (R10 fixes 12 and 13; spec APP-LAYER-15-FIXES B.3, C.11, C.21, C.23 item 10, E.3): the application review is the
// exact approval artifact, and the states the person sees match what happened. Fake model only: no model call here at all.
// Fail-first: on trunk 5cb45c83 "Apply to the top three from that list." searched for a role named "from that list"
// instead of the numbered shortlist; application_review.ts did not exist; the proof File said "Prepared" for an application
// being sent and gave no File for one the employer confirmed by email; a card carried no review of what its yes covers.
import assertNode from "node:assert/strict";
import { applyManyAsk, applyTurn, type ShortlistEntry } from "../../supabase/functions/_shared/career_apply_chat.ts";
import { memoryWantStore } from "../../supabase/functions/_shared/career_apply_want.ts";
import { closeoutLine, closeoutText, narrowQuestion, reviewLinksFor, reviewOf, reviewText, SENSITIVE, sensitiveOf, stageOf } from "../../supabase/functions/_shared/application_review.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { bodyHtml, textOf } from "../../supabase/functions/_shared/file_kinds.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { cardTurn } from "../../supabase/functions/_shared/career_apply_cards.ts";
import { db, U as CARD_U } from "./mass-submit-fixture.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const U = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-09T16:00:00Z");
const ENV: Record<string, string> = { TRAINEE_FILE_LINK_SECRET: "file-link-secret-0123456789-abcdef", TRAINEE_FILE_BASE_URL: "https://trainee.example/file" };
const SHA = "b".repeat(64);
// A fictional employer (spec C.21's Lakefront specimen): one answer the person gave, two facts they have not.
const payload = (why = "I want to use Python and SQL to answer operational questions that lead to concrete decisions.") => ({
  version: 1, user_id: U, job_id: "greenhouse:lakefront:101", company: "TEST Lakefront Transit Analytics", url: "https://boards.greenhouse.io/lakefront/jobs/101",
  destination: "https://boards.greenhouse.io/lakefront/jobs/101", resume_sha256: SHA, page_field_names: [],
  fields: [
    { name: "first_name", label: "First Name", value: "Ada" },
    { name: "q1", label: "Why this role?", value: why },
    { name: "q2", label: "Expected graduation date", value: "" },
    { name: "q3", label: "Are you legally authorized to work in the United States?", value: "" },
    { name: "cv", label: "Resume/CV", type: "input_file", value: SHA },
  ],
});
const CARD_LINES = ["TEST Lakefront Transit Analytics", "First Name: Ada", `Resume: DataAnalyst_Review_v3.pdf (${SHA.slice(0, 12)})`];
const OPEN = [{ label: "Can you work onsite in Chicago on Tuesdays and Thursdays during the internship?" }, { label: "Will you continue an outside business while employed?" }];

Deno.test("WO-G 12: 'Apply to the top three from that list.' is the numbered shortlist, the three are named by number, nothing is sent", async () => {
  eq(applyManyAsk("Apply to the top three from that list."), { kind: "first", n: 3 });
  eq(applyManyAsk("apply to the first three on that list"), { kind: "first", n: 3 });
  const LIST: ShortlistEntry[] = [1, 2, 3, 4].map((i) => ({ id: `greenhouse:wog${i}:${i}`, title: `TEST Analyst ${i}`, company: `TEST Employer ${i}`, location: "Chicago, IL", url: `https://boards.greenhouse.io/wog${i}/jobs/${i}` }));
  const wants = memoryWantStore();
  const r = await applyTurn({ message: "Apply to the top three from that list.", userId: "u1", now: NOW, postings: { search: async () => [] }, wants, apps: async () => [], facts: [], shortlist: LIST });
  eq(r?.status, "queued", r?.reply);
  eq((await wants.list("u1")).map((w) => w.posting_key).sort(), ["greenhouse:wog1:1", "greenhouse:wog2:2", "greenhouse:wog3:3"]);
  assert(/#1 TEST Analyst 1[^#]*#2 TEST Analyst 2[^#]*#3 TEST Analyst 3/.test(r!.reply), `names the three by their numbers: ${r!.reply}`);
  assert(!/#4|TEST Employer 4/.test(r!.reply) && !/\bsubmitted\b|\bapplied\b/i.test(r!.reply), r!.reply);
});

Deno.test("WO-G 12: the review shows the role, page, resume, every answer word for word and every unresolved fact; it is not approvable until answered", async () => {
  const p = payload(), h = await hashApplyPayload(p);
  const r = reviewOf({ id: "P1", payload: p, payload_hash: h, card_lines: CARD_LINES, title: "TEST Data Analyst Intern", open: OPEN });
  eq([r.employer, r.role, r.url, r.resume], ["TEST Lakefront Transit Analytics", "TEST Data Analyst Intern", "https://boards.greenhouse.io/lakefront/jobs/101", { label: "DataAnalyst_Review_v3.pdf", sha12: SHA.slice(0, 12) }]);
  eq(r.answers.map((a) => [a.question, a.answer]), [["First Name", "Ada"], ["Why this role?", p.fields[1].value]], "every answer exactly as it will be sent; the resume is a file, not an answer");
  eq(r.unresolved.map((u) => u.fact), ["graduation_date", "work_authorization", "availability", "outside_business"], "blank or open required facts stay unresolved, never defaulted");
  eq(r.approvable, false);
  const t = reviewText([r]);
  assert(/Not submitted\./.test(t) && /Expected graduation date: not entered\./.test(t) && /Not ready to approve: 4 required answers still unresolved/.test(t), t);
  assert(t.includes(`For TEST Lakefront Transit Analytics, the form asks: "Will you continue an outside business while employed?". I don't have your answer, and I won't pick one for you. What should I enter?`), t);
  assert(!/\bSubmitted\b|\bconfirmed\b/.test(t), `no success word on a review: ${t}`);
  // "Use that." approves wording only: the new answer shows, the unknown facts stay unresolved, the approval hash moves.
  const p2 = payload("I like work where data helps someone make a concrete decision."), h2 = await hashApplyPayload(p2);
  const r2 = reviewOf({ id: "P1", payload: p2, payload_hash: h2, card_lines: CARD_LINES, title: "TEST Data Analyst Intern", open: OPEN });
  eq(r2.answers[1].answer, "I like work where data helps someone make a concrete decision.");
  eq([r2.unresolved.length, r2.approvable, r2.hash12 === r.hash12], [4, false, false], "a correction changes the answer and the hash; it answers no unknown fact");
  // Every fact answered by the person: approvable, and the review says what the yes covers, by hash.
  const p3 = { ...p2, fields: p2.fields.map((f) => f.name === "q2" ? { ...f, value: "May 2027" } : f.name === "q3" ? { ...f, value: "Yes" } : f) }, h3 = await hashApplyPayload(p3);
  const r3 = reviewOf({ id: "P1", payload: p3, payload_hash: h3, card_lines: CARD_LINES, title: "TEST Data Analyst Intern" });
  eq([r3.approvable, r3.unresolved.length, r3.answers.find((a) => a.question === "Expected graduation date")?.sensitive], [true, 0, "graduation_date"]);
  const t3 = reviewText([r3]);
  assert(t3.includes(`approval ${h3.slice(0, 12)}`) && /the role: TEST Data Analyst Intern/.test(t3) && /the application page: https:\/\/boards\.greenhouse\.io\/lakefront\/jobs\/101/.test(t3) && t3.includes(`the resume file ${SHA.slice(0, 12)}`) && /4 answers, word for word/.test(t3), t3);
  assert(/A different employer, role, resume, answer or a bigger batch needs a new review/.test(t3), t3);
});

Deno.test("WO-G 12: each of the seven facts only the person can give is recognised and asked as one narrow question", () => {
  const LABELS: Record<string, string> = {
    graduation_date: "Expected graduation date", availability: "When can you start?", work_authorization: "Are you legally authorized to work in the United States?",
    sponsorship: "Will you now or in the future require visa sponsorship?", gpa: "What is your cumulative GPA?",
    outside_business: "Will you continue any outside business activity while employed?", conflicts: "Do you have any conflicts of interest?",
  };
  eq(Object.keys(LABELS).sort(), [...SENSITIVE].sort());
  for (const [fact, label] of Object.entries(LABELS)) {
    eq(sensitiveOf(label), fact, label);
    const q = narrowQuestion({ label, company: "TEST Acme", options: ["Yes", "No"] });
    eq(q, `For TEST Acme, the form asks: "${label}". I don't have your answer, and I won't pick one for you. What should I enter? The form's choices: Yes / No.`);
  }
  eq(sensitiveOf("First Name"), null);
  eq(sensitiveOf("Why this role?"), null);
});

Deno.test("WO-G 12: the card shows a review link per application; the review File holds the exact payload, the unresolved facts and a proof panel with no confirmation", async () => {
  const store = memoryFileStore(), files = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const p = payload(), h = await hashApplyPayload(p);
  const w = db({ n: 2 });
  const prepared = new Map([["P1", { id: "P1", job_id: p.job_id, payload: p, payload_hash: h, card_lines: CARD_LINES }]]);
  const shown = await cardTurn({ message: "show my applications", userId: CARD_U, threadId: "TH", now: NOW, store: w.store,
    review: (s) => reviewLinksFor(s, { prepared: async (ids) => ids.map((id) => prepared.get(id)).filter(Boolean) as never, titles: async () => new Map([[p.job_id, "TEST Data Analyst Intern"]]),
      open: async () => OPEN.map((q) => ({ ...q, job_ids: [p.job_id] })), create: async (item) => { const r = await files.createReview!(U, item); return r.ok ? { url: r.url } : null; } }) });
  eq(shown?.status, "shown");
  assert(/The full review of each, with the application page, the resume file and exactly what your yes covers:\n1\. TEST Lakefront Transit Analytics, TEST Data Analyst Intern: https:\/\/trainee\.example\/file/.test(shown!.reply), shown!.reply);
  const plain = await cardTurn({ message: "show my applications", userId: CARD_U, threadId: "TH", now: NOW, store: db({ n: 2 }).store });
  assert(!/full review/.test(plain!.reply), "without the review reader the card is as before");
  const rec = store.all()[0];
  eq([store.size(), rec.kind, rec.data.status, rec.data.stage, rec.data.review.approvable], [1, "application_proof", "prepared", "prepared", false]);
  const html = bodyHtml(rec, "tok"), text = textOf(rec, { now: NOW });
  for (const s of ["Prepared, not submitted", "Application page", "DataAnalyst_Review_v3.pdf", "Exact answers that will be sent", "Expected graduation date: not entered.", "Will you continue an outside business while employed?: not entered.", "Not ready to approve", "No submission confirmation", "Nothing was submitted."]) {
    assert(html.includes(s.replace("?:", "?:")) || html.includes(s.replace(/: not entered\./, ": not entered.</strong>")), `html: ${s}`);
    assert(text.includes(s), `text: ${s}\n${text}`);
  }
  assert(!/state confirmed|state submitted/.test(html), "no green success state on a review");
});

Deno.test("WO-G 13: the proof File keeps prepared, approved, sending, uncertain, sent-not-confirmed and employer-confirmed apart; confirmed needs the employer's own evidence", async () => {
  const ROW = (o: Record<string, unknown>) => ({ state: "confirmed", reason: null, confirmation_id: null, created_at: "2026-11-09T15:00:00Z", updated_at: "2026-11-09T15:30:00Z", company: "TEST Acme", url: "https://boards.greenhouse.io/acme/jobs/1", payload: { fields: [] }, ...o });
  const rows: Record<string, unknown> = { q: ROW({ state: "queued" }), d: ROW({ state: "driving" }), s: ROW({ state: "submitted_unconfirmed" }), e: ROW({ state: "confirmed", email_confirmed_at: "2026-11-09T15:20:00Z" }), i: ROW({ state: "confirmed", confirmation_id: "GH-acme-1-7" }) };
  const store = memoryFileStore(), svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW, records: { application: async (u, id) => (u === U ? rows[id] as never : null) } });
  const seen: Record<string, string> = {};
  for (const id of Object.keys(rows)) {
    const r = await svc.create(U, "application_proof", { application_id: id });
    assert(r.ok, `${id}: ${JSON.stringify(r)}`);
    const rec = store.all().find((x) => x.id === (r as { id: string }).id)!;
    seen[id] = textOf(rec, { now: NOW }).split("\n").find((l) => l.startsWith("Status: "))!;
    const html = bodyHtml(rec, "tok");
    if (id !== "e" && id !== "i") assert(!/class="state (confirmed|submitted)"/.test(html), `${id}: green only with the employer's evidence`);
  }
  assert(seen.q.startsWith("Status: Approved, not sent yet."), seen.q);
  assert(seen.d.startsWith("Status: Sending, not confirmed."), seen.d);
  assert(seen.s.startsWith("Status: Sent, not confirmed by the employer."), seen.s);
  assert(seen.e.startsWith("Status: Confirmed by the employer."), seen.e);
  assert(seen.i.startsWith("Status: Confirmed by the employer."), seen.i);
  eq([stageOf({ state: "unknown_outcome" }), stageOf({ state: "confirmed" }), stageOf({ state: "confirmed", confirmation_id: "security" }), stageOf({ state: "confirmed", confirmation_id: "AB-12345" })],
    ["uncertain", "submitted_unconfirmed", "submitted_unconfirmed", "employer_confirmed"], "a word is never a receipt; no evidence is never confirmed");
});

Deno.test("WO-G 13: the closeout has spec B.3's shape from the real outcome only, and never mixes sent and queued", () => {
  const sent = "2026-11-09T16:17:00Z";
  eq(closeoutLine({ state: "confirmed", company: "TEST Acme", title: "TEST Operations Analyst", confirmation_id: "GH-acme-1-7", sent_at: sent }, "America/Chicago"),
    "Submitted TEST Operations Analyst at TEST Acme at Nov 9, 10:17 AM CST. Confirmation: GH-acme-1-7.");
  eq(closeoutLine({ state: "confirmed", company: "TEST Acme", title: "TEST Operations Analyst", email_confirmed_at: "2026-11-09T16:40:00Z", sent_at: sent }, "America/Chicago"),
    "Submitted TEST Operations Analyst at TEST Acme at Nov 9, 10:17 AM CST. Confirmation: TEST Acme's confirmation email (Nov 9, 10:40 AM CST).");
  const unc = closeoutLine({ state: "unknown_outcome", company: "TEST Beta", title: "TEST Analyst" });
  assert(/may have landed/.test(unc) && /won't send it again/.test(unc) && !/^Submitted/.test(unc) && !/Confirmation:/.test(unc), unc);
  const noEv = closeoutLine({ state: "confirmed", company: "TEST Gamma", title: "TEST Analyst", sent_at: sent }, "UTC");
  assert(/^Sent TEST Analyst at TEST Gamma/.test(noEv) && /not confirmed/.test(noEv) && !/Confirmation:/.test(noEv), `no evidence, no confirmation: ${noEv}`);
  const held = reviewOf({ id: "P2", payload: payload(), payload_hash: "c".repeat(64), card_lines: CARD_LINES, title: "TEST Data Analyst Intern" });
  const all = closeoutText([{ state: "queued", company: "TEST Delta", title: "TEST Analyst" }, { state: "confirmed", company: "TEST Acme", title: "TEST Operations Analyst", confirmation_id: "GH-acme-1-7", sent_at: sent }], { tz: "America/Chicago", held: [held] }).split("\n");
  eq(all[0], "Submitted TEST Operations Analyst at TEST Acme at Nov 9, 10:17 AM CST. Confirmation: GH-acme-1-7.");
  eq(all[1], "TEST Analyst at TEST Delta: approved, not sent yet.");
  assert(all[2].startsWith(`TEST Data Analyst Intern at TEST Lakefront Transit Analytics is ready but not submitted because "Expected graduation date" is unanswered.`), all[2]);
});
