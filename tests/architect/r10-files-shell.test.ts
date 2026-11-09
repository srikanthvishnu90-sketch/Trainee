// R10 WO-E part 1 (spec C.1, C.7, C.24, D.4): the File family shell and F-05 as strings. Fails on trunk: file_family.ts and
// file_family_roles.ts do not exist there. Fictional content only (r10-files-fixtures.ts).
import assert from "node:assert/strict";
import { actHtml, claimHtml, FAMILIES, familyStateHtml, familyBodyHtml, STATE_TITLE, UNCONFIRMED, type StateId } from "../../supabase/functions/_shared/file_family.ts";
import { rolesShortlistFile, rolesShortlistPage } from "../../supabase/functions/_shared/file_family_roles.ts";
import { stateCountsOf } from "../../supabase/functions/_shared/results_spec.ts";
import { CTX, NOW, role, shortlist, TOKEN } from "./r10-files-fixtures.ts";

const posting = { label: "From the posting", href: "https://boards.greenhouse.io/examplesolar/jobs/4001", at: "2026-11-09T15:12:00Z" };
const articles = (html: string) => [...html.matchAll(/<article class="ff-card ff-role" id="r-(ref\d+)">([\s\S]*?)<\/article>/g)].map((m) => ({ ref: m[1], html: m[2] }));

Deno.test("R10 WO-E 1: fifteen families, each with its header and an effect boundary, each mapped to the File kind or renderer it extends", () => {
  const ids = Object.keys(FAMILIES);
  assert.equal(ids.length, 15);
  assert.deepEqual(ids, Array.from({ length: 15 }, (_, i) => `F-${String(i + 1).padStart(2, "0")}`));
  for (const [id, f] of Object.entries(FAMILIES)) { assert.ok(f.header && f.boundary && f.extends, id); assert.doesNotMatch(f.boundary, /linkedin/i, id); }
});

Deno.test("R10 WO-E 1: a sourced claim carries its link and a time in the person's zone; without either it is Unconfirmed, never a fact", () => {
  const ok = claimHtml("$85-98k", posting, CTX);
  assert.match(ok, /data-src="external"/);
  assert.match(ok, /href="https:\/\/boards\.greenhouse\.io\/examplesolar\/jobs\/4001"/);
  assert.match(ok, /\$85-98k<span class="ff-src"> - From the posting <time datetime="2026-11-09T15:12:00\.000Z">9:12 AM today<\/time>/);
  assert.match(claimHtml("$85-98k", posting, { now: NOW, tz: "America/Los_Angeles" }), /7:12 AM today/);
  for (const broken of [{ ...posting, href: null, external: true }, { ...posting, at: null }, { ...posting, at: "2026-11-10T15:00:00Z" }, { ...posting, href: "http://insecure.example.com/x" }]) {
    const h = claimHtml("$85-98k", broken, CTX);
    assert.match(h, /data-src="unconfirmed"/); assert.match(h, new RegExp(UNCONFIRMED)); assert.doesNotMatch(h, /<time/);
  }
  assert.match(claimHtml(null, posting, CTX), /data-unconfirmed="1">Unconfirmed</);
  assert.match(claimHtml("", { label: "You confirmed" }, CTX, { missing: "Pay unknown" }), />Pay unknown</);
  assert.match(claimHtml("<b>x</b>", { label: "You confirmed" }, CTX), /&lt;b&gt;x&lt;\/b&gt;/);
});

Deno.test("R10 WO-E 1: a download retrieves and never looks like submit; a submit is a filled button and never a preview link", () => {
  const dl = actHtml({ label: "Download resume", effect: "download", href: "/files/resume-v3.pdf" }, true);
  assert.match(dl, /^<a class="ff-btn ff-sec ff-dl" href="\/files\/resume-v3\.pdf" download/); assert.doesNotMatch(dl, /ff-pri/);
  assert.match(actHtml({ label: "Download resume", effect: "download" }), /disabled[\s\S]*Not available: no link is on file\./);
  const sub = actHtml({ label: "Approve submission", effect: "submit", post: { token: TOKEN, action: "approve" } });
  assert.match(sub, /<form method="post"[\s\S]*<button type="submit" class="ff-btn ff-pri"/);
  assert.match(actHtml({ label: "Approve submission", effect: "submit", off: "2 required answers are not entered." }), /<button type="button" class="ff-btn ff-pri" disabled[\s\S]*2 required answers are not entered\./);
  assert.match(actHtml({ label: "View posting", effect: "open", href: "javascript:alert(1)" }), /disabled/);
});

Deno.test("R10 WO-E 1: F-05 counts come from results_spec states, are exclusive and sum to the roles; targets never count and never offer Apply", () => {
  const f = shortlist(), file = rolesShortlistFile(f);
  const counts = file.hero.counts ?? [];
  assert.equal(counts.reduce((a, x) => a + x.n, 0), f.rows.length);
  assert.deepEqual(counts.map((x) => x.n), stateCountsOf(f.rows).filter((x) => x.n > 0).map((x) => x.n));
  assert.deepEqual(counts.map((x) => x.label), ["ready to prepare", "ready for review", "need you", "need eligibility check"]);
  const html = rolesShortlistPage(f, CTX), tgt = html.slice(html.indexOf("Targets - companies"));
  assert.ok(tgt.includes("Example Climate Lab") && tgt.includes("not counted as an opportunity") && !/ready to prepare/.test(tgt.slice(0, 400)));
  assert.doesNotMatch(tgt.slice(0, tgt.indexOf("ff-bar")), /data-effect="(prepare|submit|approve)"|>Apply</);
  assert.match(html, /Updated <b><time datetime="2026-11-09T15:40:00\.000Z">Today 9:40 AM CT<\/time><\/b>/);
  assert.match(html, /Sources checked: <b>9 boards \+ employer pages<\/b>/);
});

Deno.test("R10 WO-E 1: F-05 posts only existing handler actions, prepares without sending, and keeps each restriction inside its role", () => {
  const html = rolesShortlistPage(shortlist(), CTX), arts = articles(html);
  assert.equal(arts.length, 5);
  // Every pick and every single Prepare carries tag "none": the handler's gate prepares those and never sends (handler.ts gate()).
  for (const m of html.matchAll(/name="pick" value="([^"]+)"/g)) assert.match(m[1], /^ref\d+:none$/);
  assert.doesNotMatch(html, /0123456789abcdef/); // the prepared role's real tag never reaches a form here
  for (const m of html.matchAll(/name="action" value="([^"]+)"/g)) assert.ok(["apply", "applysel", "dismiss", "pause"].includes(m[1]), m[1]);
  const [r1, r2, r3, r4, r5] = arts;
  assert.match(r1.html, /name="ref" value="ref1"><input type="hidden" name="tag" value="none"><button type="submit" class="ff-btn ff-pri"[^>]*data-effect="prepare">Prepare application/);
  assert.match(r2.html, /Location restriction:<\/strong> your state may be excluded - this must resolve before any preparation\./); assert.doesNotMatch(r2.html, /data-effect="prepare"/); assert.doesNotMatch(r2.html, /name="action" value="apply"/);
  assert.match(r3.html, /<summary class="ff-btn ff-sec">Review application<\/summary>[\s\S]*Earliest start[\s\S]*Needs you/); assert.doesNotMatch(r3.html, /name="action" value="apply"/);
  assert.match(r4.html, /Student window:<\/strong>[\s\S]*Enrolled undergraduate graduating Dec 2027 to June 2028/);
  assert.match(r4.html, /data-src="unconfirmed"[\s\S]*time read not on file/); // no check time on file: not shown as a sourced fact
  assert.match(r4.html, /Uncertain:<\/strong> The posting does not say/);
  assert.match(r5.html, /Apply yourself on example-grid\.com/); assert.doesNotMatch(r5.html, /data-effect="prepare"/);
  assert.match(r1.html, /\$85-98k employer-stated/); assert.match(r2.html, /pay not listed \(marked unknown\)/);
});

Deno.test("R10 WO-E 1: the nine shared states say what is true; uncertain stops a blind retry; confirmed needs employer evidence; expired shows nothing private", () => {
  const all = Object.keys(STATE_TITLE) as StateId[];
  assert.deepEqual(all, ["loading", "empty", "needs_input", "prepared", "in_progress", "uncertain", "confirmed", "error", "expired"]);
  for (const s of all) assert.match(familyStateHtml({ state: s, family: "F-09" }, CTX), new RegExp(STATE_TITLE[s]));
  assert.match(familyStateHtml({ state: "uncertain", family: "F-09" }, CTX), /disabled data-effect="submit">Submit again[\s\S]*first attempt may have landed/);
  const noEv = familyStateHtml({ state: "confirmed", family: "F-09" }, CTX);
  assert.match(noEv, /Not confirmed yet/); assert.doesNotMatch(noEv, /Submitted - confirmed/);
  assert.match(familyStateHtml({ state: "confirmed", family: "F-09", evidence: { quote: "Thanks for applying.", src: posting } }, CTX), /Submitted - confirmed[\s\S]*data-src="external"/);
  assert.match(familyStateHtml({ state: "in_progress", family: "F-09" }, CTX), /The step reached isn't on file\./);
  assert.doesNotMatch(familyStateHtml({ state: "in_progress", family: "F-09" }, CTX), /t-confirmed|ff-c-confirmed/);
  const exp = familyStateHtml({ state: "expired", family: "F-05" }, CTX);
  assert.doesNotMatch(exp, /ff-hero|ff-card|ff-role/); assert.match(exp, /Ask Trainee for a new link to the same task\./);
  assert.match(rolesShortlistPage({ ...shortlist(), rows: [] }, CTX), /No verified roles matched this search[\s\S]*Checked: 9 boards \+ employer pages/);
  assert.match(familyStateHtml({ state: "empty", family: "F-05" }, CTX), /The scope checked isn&#39;t on file\./);
});

Deno.test("R10 WO-E 1: untrusted text is escaped everywhere in the shell", () => {
  const evil = `<img src=x onerror=alert(1)>`;
  const f = rolesShortlistFile({ ...shortlist(), title: evil, rows: [role(9, { company: evil, title: evil })] });
  const html = familyBodyHtml(f, CTX);
  assert.ok(!html.includes(evil));
});
