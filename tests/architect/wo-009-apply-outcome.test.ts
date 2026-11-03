// WO-009 acceptance tests (architect-authored; builders make them pass, never edit them).
// Genuine submissions only: an application counts as SUBMITTED only on the employer's own confirmation, and
// admission enforces the person's approval, caps and duplicates before any browser opens.
// The real cases come from the 2026-10-15 armed run (BUG-207/208/209): a posting's word "security" was taken as a
// confirmation id while the form was still open, and empty required fields went out.
// Contract: docs/architect/work-orders/WO-009-real-submissions.md. Run: deno test -A --no-check tests/architect/
import { classifyOutcome, admitApplication, type Observation } from "../../supabase/functions/_shared/career_apply.ts";

function assert(v: unknown, m = "assertion failed"): asserts v { if (!v) throw new Error(m); }
function eq(a: unknown, b: unknown, m = "") { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`); }
const obs = (o: Partial<Observation>): Observation => ({ url_before: "https://job-boards.greenhouse.io/acme/jobs/1", url_after: "https://job-boards.greenhouse.io/acme/jobs/1", form_present_after: true, required_empty_after: 0, validation_errors: [], captcha: false, email_code_prompt: false, page_text: "", ...o });

Deno.test("WO-009/1 the employer's confirmation, with the form gone, is the only CONFIRMED", () => {
  const r = classifyOutcome(obs({ url_after: "https://job-boards.greenhouse.io/acme/jobs/1/confirmation", form_present_after: false, page_text: "Thank you for applying to Acme! Your application has been received. Confirmation number: GH-48213." }));
  eq(r.state, "confirmed");
  eq(r.confirmation_id, "GH-48213");
});

Deno.test("WO-009/2 the BUG-208 case: posting text with 'security' and the form still open is NOT submitted, no id minted", () => {
  const r = classifyOutcome(obs({ page_text: "Labelbox — Security Engineer. We take security seriously. Application reference: security. Submit application", form_present_after: true, required_empty_after: 2 }));
  eq(r.state, "not_submitted");
  eq(r.confirmation_id, null);
});

Deno.test("WO-009/3 success words never count while the form is still on the page", () => {
  const r = classifyOutcome(obs({ page_text: "Thank you for applying! (shown in the posting's FAQ)", form_present_after: true }));
  assert(r.state !== "confirmed", "a form still present means not confirmed");
});

Deno.test("WO-009/4 a captcha or an emailed code is a handoff to the person, never a failure or a success", () => {
  eq(classifyOutcome(obs({ captcha: true })).state, "needs_user");
  eq(classifyOutcome(obs({ captcha: true })).reason, "captcha");
  eq(classifyOutcome(obs({ email_code_prompt: true, form_present_after: false })).state, "needs_user");
  eq(classifyOutcome(obs({ email_code_prompt: true, form_present_after: false })).reason, "email_code");
});

Deno.test("WO-009/5 validation errors are a failure that names the fields", () => {
  const r = classifyOutcome(obs({ validation_errors: ["Email is required", "Resume is required"] }));
  eq(r.state, "failed");
  assert(r.reason.includes("Email is required") && r.reason.includes("Resume is required"), "names each error");
});

Deno.test("WO-009/6 the page moved and the form is gone but no confirmation words: submitted_unconfirmed (proven later by email)", () => {
  const r = classifyOutcome(obs({ url_after: "https://acme.com/careers/thanks", form_present_after: false, page_text: "Acme careers" }));
  eq(r.state, "submitted_unconfirmed");
  eq(r.confirmation_id, null);
});

Deno.test("WO-009/7 a confirmation id is only a token with a digit after an id label", () => {
  const ok = classifyOutcome(obs({ form_present_after: false, url_after: "https://x/confirm", page_text: "Application submitted. Reference #A7Q2-9931" }));
  eq(ok.confirmation_id, "A7Q2-9931");
  const words = classifyOutcome(obs({ form_present_after: false, url_after: "https://x/confirm", page_text: "Application submitted. Reference: pending review" }));
  eq(words.confirmation_id, null, "a word is never an id");
});

const T0 = Date.UTC(2026, 9, 20, 15), DAY = 86400000;
const app = (job_id: string, company: string, extra: Record<string, unknown> = {}) => ({ user_id: "u1", job_id, company, approval_hash: "h1", payload_hash: "h1", ...extra });

Deno.test("WO-009/8 admission: no approval of this exact payload, no browser", () => {
  eq(admitApplication([], app("gh:acme:1", "Acme", { payload_hash: "h2" }), T0), { ok: false, reason: "not_approved" });
  eq(admitApplication([], app("gh:acme:1", "Acme"), T0), { ok: true, reason: null });
});

Deno.test("WO-009/9 admission: never the same posting twice; another role at the same company goes (D-MS-3, owner 2026-10-27)", () => {
  const log = [{ user_id: "u1", job_id: "gh:acme:1", company: "Acme Inc.", at: T0 - 5 * DAY, state: "confirmed", url: "https://boards.greenhouse.io/acme/jobs/1" }];
  eq(admitApplication(log, app("gh:acme:1", "Acme"), T0).reason, "duplicate_job");
  eq(admitApplication(log, app("gh:acme:1-copy", "Acme", { url: "https://job-boards.greenhouse.io/embed/job_app?for=acme&gh_jid=1" }), T0).reason, "duplicate_job",
    "the same posting under another id (its Greenhouse job number)");
  eq(admitApplication(log, app("gh:acme:2", "ACME"), T0).ok, true, "another role at the same company, the same week");
  const failed = [{ user_id: "u1", job_id: "gh:acme:1", company: "Acme", at: T0 - DAY, state: "failed" }];
  eq(admitApplication(failed, app("gh:acme:1", "Acme"), T0).ok, true, "a failed attempt can be retried");
});

Deno.test("WO-009/10 admission: no product daily ceiling (owner, 2026-10-22; CAPS-1390); a pace the person set holds over any 24 hours with no maximum; other people are not counted", () => {
  const log = Array.from({ length: 25 }, (_, i) => ({ user_id: "u1", job_id: `gh:co${i}:1`, company: `Co${i}`, at: T0 - i * 600000, state: "confirmed" }));
  eq(admitApplication(log, app("gh:new:1", "New"), T0).ok, true, "25 today and no pace set: the 26th is admitted");
  eq(admitApplication(log, app("gh:new:1", "New"), T0, { daily: 25 }).reason, "daily_cap", "a pace of 25 they set themselves holds");
  eq(admitApplication(log.slice(1), app("gh:new:1", "New"), T0, { daily: 25 }).ok, true, "24 in 24 hours leaves room for one");
  eq(admitApplication(log, app("gh:new:1", "New"), T0, { daily: 40 }).ok, true, "their own higher pace");
  const fifty = Array.from({ length: 50 }, (_, i) => ({ user_id: "u1", job_id: `gh:co${i}:1`, company: `Co${i}`, at: T0 - i * 60000, state: "confirmed" }));
  eq(admitApplication(fifty, app("gh:new:1", "New"), T0, { daily: 500 }).ok, true, "their own pace has no maximum: 500 is 500");
  eq(admitApplication(fifty, app("gh:new:1", "New"), T0).ok, true, "and with none set, 50 today caps nothing");
  eq(admitApplication(log, { ...app("gh:new:1", "New"), user_id: "u2" }, T0, { daily: 25 }).ok, true);
  eq(admitApplication(log, app("gh:new:1", "New"), T0 + DAY, { daily: 25 }).ok, true, "a rolling 24 hours");
});
