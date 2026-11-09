// R10 WO-E part 3 (spec C.11-C.18, D.4): F-09 application review, F-10 batch File, F-11 pipeline, F-12 people and messages, F-13
// interview hub, F-14 weekly brief and its negotiation variant, F-15 offer comparison. Strings first, then the visual checker at 390
// and 1280 px (r10-files-check.ts). Fails on trunk: file_family_apply.ts does not exist there.
import assert from "node:assert/strict";
import { familyBodyHtml, familyPage, type FamilyFile } from "../../supabase/functions/_shared/file_family.ts";
import { applicationReviewFile, batchFile, interviewHubFile, messageReviewFile, negotiationFile, offerComparisonFile, pipelineFile, weeklyBriefFile } from "../../supabase/functions/_shared/file_family_apply.ts";
import { checkPages } from "./r10-files-check.ts";
import { CTX } from "./r10-files-fixtures.ts";
import { batch, hub, message, negotiation, offers, pipeline, review, weekly } from "./r10-files-fixtures-3.ts";

// Every File page has the header's back and overflow controls (C.1 item 2; p-67 to p-86); F-10's is its pause control.
const nav = (f: FamilyFile): FamilyFile => ({ ...f, back: "/f", menu: f.menu ?? [{ label: "Export", effect: "download", href: "/files/export.json" }, { label: "Close this File", effect: "navigate", href: "/f" }] });
const FILES = { "F-09-application-review": () => nav(applicationReviewFile(review())), "F-10-batch": () => nav(batchFile(batch())), "F-11-pipeline": () => nav(pipelineFile(pipeline())),
  "F-12-message-review": () => nav(messageReviewFile(message())), "F-13-interview-hub": () => nav(interviewHubFile(hub())), "F-14-weekly-brief": () => nav(weeklyBriefFile(weekly())),
  "F-14-negotiation-plan": () => nav(negotiationFile(negotiation())), "F-15-offer-comparison": () => nav(offerComparisonFile(offers())) };
const html = (k: keyof typeof FILES) => familyBodyHtml(FILES[k](), CTX);

Deno.test("R10 WO-E 3: application review shows every answer verbatim; an unresolved required fact keeps Approve off; Approve is a filled submit", () => {
  const ok = html("F-09-application-review");
  assert.match(ok, /I want to use process work to make grid operations calmer\. At Northwind I led a scheduling rollout across 4 teams\./);
  assert.match(ok, /<button type="submit" class="ff-btn ff-pri" data-effect="submit">Approve submission<\/button>/);
  assert.match(ok, /Pronouns<\/dt><dd><span class="ff-v ff-unk" data-unconfirmed="1">Not entered - optional/);
  assert.match(ok, /Destination<\/dt><dd><span class="ff-v" data-claim="1" data-src="external">Employer application page<span class="ff-src"> - verified <time datetime="2026-11-09T15:31:00.000Z">9:31 AM today<\/time>/);
  const blocked = familyBodyHtml(applicationReviewFile(review(false)), CTX);
  assert.match(blocked, /Work authorization<\/dt><dd><span class="ff-v ff-unk" data-unconfirmed="1">Not entered - required/);
  assert.match(blocked, /disabled data-effect="submit">Approve submission<\/button><span class="ff-off">1 required answer not entered\./);
  assert.doesNotMatch(blocked, /<button type="submit"[^>]*data-effect="submit"/);
  assert.match(ok, /class="ff-btn ff-sec ff-danger" href="\?cancel=A-014"/);
});

Deno.test("R10 WO-E 3: the batch counts every role once, a confirmed row needs employer evidence, an uncertain row stops a blind retry", () => {
  const f = batchFile(batch());
  assert.equal(f.hero!.counts!.reduce((a, x) => a + x.n, 0), batch().rows.length);
  assert.deepEqual(f.hero!.counts, [{ n: 1, label: "confirmed" }, { n: 2, label: "in progress" }, { n: 1, label: "uncertain" }, { n: 1, label: "needs answer" }, { n: 1, label: "not approved" }]);
  const h = html("F-10-batch");
  assert.match(h, /R-11 - submission uncertain\.[\s\S]*will not resubmit blindly/);
  assert.match(h, /R-03<\/span><span class="ff-chip ff-c-confirmed">Submitted - confirmed[\s\S]*?data-src="external"/);
  assert.match(h, /R-04<\/span><span class="ff-chip ff-c-info">Checking<\/span>[\s\S]*?no employer confirmation with a link and time is on file/);
  assert.match(h, /6 roles - 5 approved/); assert.match(h, /The 1 unapproved row stays visible - it never inherits/);
  assert.match(h, /Expires <b><time datetime="2026-11-13T23:00:00.000Z">Fri Nov 13, 5:00 PM CT<\/time>/);
  assert.match(h, /aria-label="Pause remaining"[^>]*>❚❚/);
});

Deno.test("R10 WO-E 3: a message goes by email or a copy the person sends, never LinkedIn; an unresolved recipient keeps Approve send off", () => {
  const h = html("F-12-message-review");
  assert.doesNotMatch(h, /linkedin/i);
  assert.match(h, /Email from your connected account/); assert.match(h, /data-effect="send">Approve send/);
  const amb = familyBodyHtml(messageReviewFile(message(false)), CTX);
  assert.match(amb, /Maya at Example Carbon Co - recipient not resolved/); assert.match(amb, /disabled data-effect="send">Approve send[\s\S]*No address is guessed\./);
  assert.match(amb, /To<\/dt><dd><span class="ff-v ff-unk" data-unconfirmed="1">Not resolved/);
});

Deno.test("R10 WO-E 3: the hub shows one absolute time in the person's zone and says when it is not booked", () => {
  const h = html("F-13-interview-hub");
  assert.match(h, /Confirmed logistics[\s\S]*Tue Nov 10 - 2:00 PM CST/); assert.match(h, /For the interviewer: <b>12:00 PM PST/);
  assert.match(h, /<strong>Likely topics:<\/strong> grid operations/);
  const s = familyBodyHtml(interviewHubFile(hub(false)), CTX);
  assert.match(s, /Suggested time - not booked/); assert.match(s, /Calendar not checked/);
});

Deno.test("R10 WO-E 3: a quiet week says so; negotiation keeps verbal claims separate; offers never show a cash-plus-equity total", () => {
  assert.match(familyBodyHtml(weeklyBriefFile(weekly(true)), CTX), /Quiet week\./);
  assert.match(html("F-14-weekly-brief"), /class="ff-btn ff-sec ff-danger"[^>]*>Pause search/);
  const n = html("F-14-negotiation-plan");
  assert.match(n, /Negotiation plan[\s\S]*nothing sent to any employer/); assert.match(n, /not treated as a term[\s\S]*?Verbal/);
  assert.match(n, /Deadline <b><time datetime="2026-11-13T23:00:00.000Z">/);
  const o = html("F-15-offer-comparison");
  assert.doesNotMatch(o, /Total compensation|\$101,200/); assert.match(o, /Benefits<\/dt><dd><span class="ff-v ff-unk" data-unconfirmed="1">Unknown - summary only/);
  assert.match(o, /ff-t-bad" data-claim="1" data-src="external">Non-solicit/);
});

const PAGES = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, () => familyPage(f(), CTX)]));
Deno.test({ name: "R10 WO-E 3: F-09 to F-15 pass the visual checker at 390 and 1280 px", sanitizeResources: false, sanitizeOps: false,
  async fn(t) { await checkPages(t, PAGES); } });
