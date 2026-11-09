// R10 WO-E: the independent review's findings (N1-N3 and the family gaps) and the WO-I specimen interface, each as behaviour.
import assert from "node:assert/strict";
import { familyBodyHtml, familyStateHtml } from "../../supabase/functions/_shared/file_family.ts";
import { materialsFile, profileFactsFile } from "../../supabase/functions/_shared/file_family_plan.ts";
import { applicationReviewFile, batchFile, interviewHubFile, messageReviewFile } from "../../supabase/functions/_shared/file_family_apply.ts";
import * as S from "../../supabase/functions/_shared/file_family_specimens.ts";
import { CTX } from "./r10-files-fixtures.ts";

Deno.test("N1 F-09: before approval an answer is your draft; \"you approved this wording\" only after approval", () => {
  const before = familyBodyHtml(applicationReviewFile(S.review()), CTX);
  assert.doesNotMatch(before, /You approved this wording/); assert.match(before, /Your draft answer - not approved yet/);
  assert.match(familyBodyHtml(applicationReviewFile({ ...S.review(), after: { state: "approved" } }), CTX), /You approved this wording/);
});

Deno.test("N2 F-10: blocked, closed and needs-you rows have their own buckets; only queued and started work is in progress", () => {
  const b = S.batch(), row = (rid: string, key: "blocked" | "closed" | "user_step" | "queued") => ({ rid, title: rid, key, detail: "x", approved: true });
  const f = batchFile({ ...b, rows: [row("R-1", "blocked"), row("R-2", "closed"), row("R-3", "user_step"), row("R-4", "queued")] });
  assert.deepEqual(f.hero!.counts, [{ n: 1, label: "in progress" }, { n: 1, label: "needs you" }, { n: 1, label: "blocked" }, { n: 1, label: "closed" }]);
});

Deno.test("N3 states: an error says nothing was sent only when the caller proves it", () => {
  const plain = familyStateHtml({ state: "error", family: "F-09" }, CTX);
  assert.doesNotMatch(plain, /Nothing was changed and nothing was sent/); assert.match(plain, /It is not known yet whether anything changed\. Check the status before trying again/);
  assert.match(familyStateHtml({ state: "error", family: "F-09", nothingSent: true }, CTX), /Nothing was changed and nothing was sent\./);
});

Deno.test("F-02 gaps: an external category, estimates outside Confirmed, review items listed with Confirm and Correct", () => {
  const go = (label: string, href: string) => ({ label, effect: "decide" as const, href });
  const h = familyBodyHtml(profileFactsFile({ ...S.profile(), facts: [...S.profile().facts.map((f) => f.kind === "review" ? { ...f, confirm: go("Confirm", "?c"), correct: go("Correct", "?x") } : f),
    { k: "Employer size", v: "1,200 people", kind: "external", src: { label: "company page", href: "https://example.com/about", at: "2026-11-08T12:00:00Z" } }] }), CTX);
  assert.match(h, /External <b>1<\/b>/); assert.match(h, /External facts - from their source[\s\S]*data-src="external">1,200 people/);
  const confirmed = h.slice(h.indexOf("Confirmed facts - sample"), h.indexOf("</section>", h.indexOf("Confirmed facts - sample")));
  assert.doesNotMatch(confirmed, /your estimate/); assert.match(h, /Your estimates - not confirmed facts[\s\S]*Cut onboarding time/);
  assert.match(h, /Needs review - not used until you confirm[\s\S]*Northwind Logistics end date[\s\S]*Confirm[\s\S]*Correct/);
  assert.doesNotMatch(h, /Expected graduation/, "a sensitive field is never listed as a reusable fact");
});

Deno.test("F-07 gap: a download names its version; a draft download says it is not the one used", () => {
  assert.match(familyBodyHtml(materialsFile({ ...S.materials(), downloadVersion: "v3" }), CTX), /Download v3 \(draft - not the one used\)/);
  assert.match(familyBodyHtml(materialsFile({ ...S.materials(), downloadVersion: "v2" }), CTX), /Download v2 \(approved\)/);
});

Deno.test("F-10 gap: \"Approve these N\" approves exactly the reviewed, ready rows, bound to the set's hash", () => {
  const b = S.batch(), hash = "0123456789abcdef";
  const rows = [...b.rows, { rid: "R-30", title: "A", key: "ready" as const, detail: "Prepared.", approved: true }, { rid: "R-31", title: "B", key: "ready" as const, detail: "Prepared.", approved: true, reviewed: false }];
  const h = familyBodyHtml(batchFile({ ...b, rows, approveAll: { hash, token: "t" } }), CTX);
  assert.match(h, /name="action" value="applyall"><input type="hidden" name="set" value="0123456789abcdef"><button type="submit" class="ff-btn ff-pri"[^>]*data-effect="approve">Approve these 1<\/button>/);
  assert.match(h, /Approves only 1 reviewed row shown; if the set changes, nothing is approved/);
  assert.doesNotMatch(familyBodyHtml(batchFile(b), CTX), /Approve these/);
});

Deno.test("F-12 gap: Decline and Stop follow-ups are the person's own controls; an opt-out leaves nothing to stop", () => {
  const go = (label: string) => ({ label, effect: "decide" as const, href: `?${label}` });
  const h = familyBodyHtml(messageReviewFile({ ...S.message(), decline: go("Decline"), stopFollowUps: go("Stop follow-ups") }), CTX);
  assert.match(h, />Decline</); assert.match(h, /class="ff-btn ff-sec ff-danger"[^>]*>Stop follow-ups</);
  assert.doesNotMatch(familyBodyHtml(messageReviewFile({ ...S.message(), optedOut: true, stopFollowUps: go("Stop follow-ups") }), CTX), /Stop follow-ups/);
});

Deno.test("F-13 gap: the mock interview offers no link to a page that does nothing; its control comes from data", () => {
  const h = familyBodyHtml(interviewHubFile(S.hub()), CTX);
  assert.doesNotMatch(h, /\?practice=1/); assert.match(h, /Mock interview/);
  assert.match(familyBodyHtml(interviewHubFile({ ...S.hub(), practice: { label: "Practice", effect: "navigate", href: "/practice" } }), CTX), /href="\/practice"[^>]*>Practice/);
});

Deno.test("WO-I interface: page({ state, width, theme }) draws all 16 families in every state at both widths, light or dark", () => {
  assert.equal(S.FILE_FAMILIES.length, 16);
  for (const f of S.FILE_FAMILIES) for (const state of ["loading", "empty", "error", "ready"] as const) for (const width of [390, 1280] as const) for (const theme of ["light", "dark"] as const) {
    const h = f.page({ state, width, theme });
    assert.match(h, /^<!doctype html>/i, `${f.id} ${state}`); assert.match(h, new RegExp(`data-theme="${theme}"`));
    assert.match(h, state === "ready" ? /class="ff-head"/ : new RegExp(`data-state="${state}"`), `${f.id} ${state}`);
    if (theme === "dark") { assert.doesNotMatch(h, /prefers-color-scheme:dark\)\{/); assert.match(h, /@media all\{/); }
    else assert.match(h, /@media not all\{/);
  }
  assert.equal(S.FILE_FAMILIES[0].page(), S.FILE_FAMILIES[0].page(undefined), "no view: the ready File, as before");
});
