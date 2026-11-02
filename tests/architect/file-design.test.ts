// Trainee's File design system (owner brief P3 and P6; owner colour ruling 2026-11-01 18:27 CT): the shared parts every hosted
// File is drawn from (supabase/functions/_shared/file_design.ts), their tokens (brand.ts), and the hosted File shell the trainee-file
// handler serves. Strings and the handler only; the pixels are file-design-browser.test.ts. Synthetic people and companies only.
import assertNode from "node:assert/strict";
import { contrast, DARK, LIGHT, PLUM, readablePairs, TOKENS_CSS } from "../../supabase/functions/_shared/brand.ts";
import {
  caveatHtml, esc as escDesign, evidenceHtml, fileShellHtml, firstNameOf, freshnessStamp, jobCardHtml, madeForLine, rowsHtml, sectionHtml, stampHtml, stateHtml,
  stated, UNKNOWN, unknown, valueHtml, valueOf, verified,
} from "../../supabase/functions/_shared/file_design.ts";
import { esc as escPage, renderFeed } from "../../supabase/functions/_shared/file_page.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { validateKind } from "../../supabase/functions/_shared/file_kinds.ts";
import { feedUrlsFor } from "../../supabase/functions/_shared/file_link.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { signedIn } from "./file-session-fakes.ts";

const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const CHI = "America/Chicago";
// Nov 1, 2026 is the day US clocks fall back (2:00 AM CDT -> 1:00 AM CST). 21:08Z is 3:08 PM CST.
const NOW = Date.parse("2026-11-01T23:00:00Z");

// ================================================================== tokens (owner ruling: the current colours, no new hue)
Deno.test("tokens: plum and every existing token keep their values; the tint and the verified shade are derived from the plum; no teal", () => {
  eq(PLUM, "#5C2751");
  // The existing tokens, value for value (D-DESIGN-1 and the ruling): nothing here moved.
  const before = { bg: "#FAF8F4", ink: "#141414", mute: "#4F4F57", line: "#E6E3DD", accent: PLUM, accentHover: "#6E3462", accentInk: "#FFFFFF", link: PLUM, good: "#1B6B3A", bad: "#B42318", warn: "#8A5300", panel: "#F1EEE8", disabledBg: "#E6E3DD", disabledInk: "#4F4F57" };
  for (const [k, v] of Object.entries(before)) eq((LIGHT as unknown as Record<string, string>)[k], v, `light ${k}`);
  const beforeDark = { bg: "#000000", ink: "#EDEDF0", mute: "#A6A6B0", accent: "#D4C2E2", link: "#D4C2E2", panel: "#16161A" };
  for (const [k, v] of Object.entries(beforeDark)) eq((DARK as unknown as Record<string, string>)[k], v, `dark ${k}`);
  // Derived from the plum: each new colour lies on the line between the plum and white (or black) within rounding.
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const onLine = (c: string, end: number) => {
    const p = rgb(PLUM), x = rgb(c), a = (x[0] - end) / (p[0] - end);
    return a > 0 && a <= 1 && x.every((v, i) => Math.abs(v - (p[i] * a + end * (1 - a))) <= 1.5);
  };
  ok(onLine(LIGHT.tint, 255), `light tint ${LIGHT.tint} is a lighter tint of the plum`);
  ok(onLine(DARK.tint, 0), `dark tint ${DARK.tint} is a shade of the plum`);
  ok(onLine(LIGHT.verified, 0), `light verified ${LIGHT.verified} is a darker shade of the plum`);
  ok(onLine(DARK.verified, 255), `dark verified ${DARK.verified} is a tint of the plum`);
  ok(!/teal|#4A244D/i.test(TOKENS_CSS), "no teal and not the brief's proposed plum");
  for (const k of ["--card:", "--tint:", "--verified:"]) ok(TOKENS_CSS.split(k).length === 3, `${k} in both schemes`);
});

Deno.test("contrast: every File pair is AA in light and dark (computed, WCAG relative luminance)", () => {
  for (const [scheme, t] of [["light", LIGHT], ["dark", DARK]] as const) {
    const pairs = readablePairs(t);
    for (const need of ["ink on card", "metadata on card", "verified value on card", "verified value on ground", "ink on caveat tint", "metadata on caveat tint", "verified value on caveat tint", "link on card", "link on caveat tint"]) {
      ok(pairs.some((p) => p[0] === need), `${scheme}: ${need} is measured`);
    }
    for (const [what, fg, bg, min] of pairs) ok(contrast(fg, bg) >= min, `${scheme}: ${what} ${contrast(fg, bg).toFixed(2)}:1`);
    // The verified shade is never mistaken for the action plum (the browser test's plum checks use a 3-unit tolerance).
    ok(t.verified !== t.accent && t.tint !== t.accent && t.card !== t.accent);
  }
});

// ================================================================== the freshness stamp: computed, never invented
Deno.test("freshness: the earliest and latest real timestamps, in the person's zone, as the brief writes it", () => {
  const a = "2026-11-01T21:08:10Z", b = "2026-11-01T21:25:59Z";
  eq(freshnessStamp("Postings checked", [b, a], { now: NOW, tz: CHI }), "Postings checked Nov 1, 2026, 3:08–3:25 PM CT");
  eq(freshnessStamp("Postings checked", [a], { now: NOW, tz: CHI }), "Postings checked Nov 1, 2026, 3:08 PM CT");
  eq(freshnessStamp("Postings checked", [a, b], { now: NOW, tz: "America/New_York" }), "Postings checked Nov 1, 2026, 4:08–4:25 PM ET");
  eq(freshnessStamp("Postings checked", [a, b], { now: NOW, tz: "Asia/Tokyo" }), "Postings checked Nov 2, 2026, 6:08–6:25 AM GMT+9");
  // Across noon, across midnight.
  eq(freshnessStamp("Checked", ["2026-10-31T16:50:00Z", "2026-10-31T17:10:00Z"], { now: NOW, tz: CHI }), "Checked Oct 31, 2026, 11:50 AM–12:10 PM CT");
  eq(freshnessStamp("Checked", ["2026-11-01T04:50:00Z", "2026-11-01T05:10:00Z"], { now: NOW, tz: CHI }), "Checked Oct 31, 2026, 11:50 PM – Nov 1, 2026, 12:10 AM CT");
  // Across the clock change: 1:30 AM CDT then 1:30 AM CST. "1:30–1:30 AM CT" would read as no time passing.
  eq(freshnessStamp("Checked", ["2026-11-01T06:30:00Z", "2026-11-01T07:30:00Z"], { now: NOW, tz: CHI }), "Checked Nov 1, 2026, 1:30 AM CDT–1:30 AM CST");
});

Deno.test("freshness: unreadable and future timestamps are not checks; none left is no stamp; an unknown zone is Chicago's, said", () => {
  eq(freshnessStamp("Postings checked", [], { now: NOW, tz: CHI }), null);
  eq(freshnessStamp("Postings checked", [null, undefined, "", "not a date", NaN, 0], { now: NOW, tz: CHI }), null);
  eq(freshnessStamp("Postings checked", ["2026-11-03T12:00:00Z"], { now: NOW, tz: CHI }), null, "a time ahead of our clock is not a check that happened");
  eq(freshnessStamp("Postings checked", ["2026-11-03T12:00:00Z", "2026-11-01T21:08:00Z"], { now: NOW, tz: CHI }), "Postings checked Nov 1, 2026, 3:08 PM CT");
  eq(freshnessStamp("Postings checked", ["2026-11-01T21:08:00Z"], { now: NOW, tz: null }), "Postings checked Nov 1, 2026, 3:08 PM CT (Chicago time; your time zone isn't on file)");
  eq(freshnessStamp("Postings checked", ["2026-11-01T21:08:00Z"], { now: NOW, tz: "Not/AZone" }), "Postings checked Nov 1, 2026, 3:08 PM CT (Chicago time; your time zone isn't on file)");
  // A different timestamp gives a different stamp: the line is the data's, not a constant.
  ok(freshnessStamp("x", ["2026-11-01T21:09:00Z"], { now: NOW, tz: CHI }) !== freshnessStamp("x", ["2026-11-01T21:08:00Z"], { now: NOW, tz: CHI }));
  ok(stampHtml(null).includes(`data-stamp="unknown"`) && stampHtml(null).includes(UNKNOWN.checkUnknown), "no stamp is said as a value");
  ok(stampHtml("Postings checked Nov 1, 2026, 3:08 PM CT").includes(`data-stamp="known"`));
});

// ================================================================== unknowns are values; verified is labelled, never colour alone
Deno.test("values: blank is the named unknown, never an empty cell; verified carries the word Verified; stated is plain", () => {
  for (const b of [null, undefined, "", "   ", "‮"]) eq(valueOf(b as string, { verified: true, missing: UNKNOWN.payNotListed, source: "From the posting" }), unknown(UNKNOWN.payNotListed));
  eq(valueOf("$90k", { verified: true, missing: "x", source: "From the posting" }), verified("$90k", "From the posting"));
  eq(valueOf("$90k", { verified: false, missing: "x", source: "From the posting" }), stated("$90k", "From the posting"));
  ok(/class="v v-verified" data-v="verified">\$90k <span class="vtag">Verified<\/span><span class="fsrc">From the posting<\/span><\/span>/.test(valueHtml(verified("$90k", "From the posting"))));
  ok(!valueHtml(stated("$90k", "From the posting")).includes("Verified") && !valueHtml(unknown("Closed")).includes("vtag"));
  eq(valueHtml(unknown("")), `<span class="v v-unknown" data-v="unknown">Unverified</span>`, "an unknown with no words still says Unverified");
  ok(valueHtml(stated("<b>", "From the posting")).includes("&lt;b&gt;"));
  for (const s of ["a‮b<x>'\"&", "\uD800z", "plain"]) eq(escDesign(s), escPage(s), "the design module escapes exactly as file_page.ts");
});

Deno.test("rows: numbered, bold name, gray detail, the value at the right; unknowns sit in the value slot", () => {
  const h = rowsHtml([{ name: "Acme", detail: "Data Analyst", value: verified("$95k", "From the posting") }, { name: "Globex", detail: null, value: unknown(UNKNOWN.payNotListed) }, { name: "Initech", value: unknown(UNKNOWN.closed) }]);
  eq((h.match(/<li class="nrow">/g) ?? []).length, 3);
  ok(/<span class="nnum" aria-hidden="true">1<\/span>.*<span class="nname">Acme<\/span><span class="ndetail">Data Analyst<\/span>.*data-v="verified">\$95k/.test(h));
  ok(/nname">Globex<\/span><\/span><span class="v v-unknown" data-v="unknown">Pay not listed<\/span>/.test(h), "no empty detail, the unknown is the value");
  ok(h.includes(">Closed</span>"));
  ok(!/<span class="v[^"]*"[^>]*><\/span>/.test(h), "no empty value cell");
  ok(!rowsHtml([{ name: "x", value: stated("y", "From the posting"), href: "javascript:alert(1)" }]).includes("javascript:"), "a row link is https only");
});

Deno.test("caveat: inside the section it qualifies, directly above the rows, never a footer", () => {
  const rows = rowsHtml([{ name: "Charge", value: unknown(UNKNOWN.amountUnknown) }]);
  const s = sectionHtml("Failed payments", rows, { caveat: { title: "These attempts failed.", text: "No money moved." } });
  const label = s.indexOf(`<h2 class="flabel">Failed payments</h2>`), cav = s.indexOf(`<aside class="caveat" role="note">`), list = s.indexOf(`<ol class="nrows">`);
  ok(label >= 0 && cav > label && list > cav, "label, then caveat, then the rows it qualifies");
  ok(s.startsWith(`<section class="fsec">`) && s.endsWith("</section>"));
  eq(sectionHtml("Empty", ""), "", "a section with nothing in it is left out");
  ok(caveatHtml("<x>").includes("&lt;x&gt;"));
});

Deno.test("evidence: the snippet, its source and its time in the person's zone, the receipt link; https only", () => {
  const e = evidenceHtml({ quote: "Confirmation ID: GH-4471", source: "From Trainee's records", at: "2026-10-30T15:04:00Z", href: "https://boards.greenhouse.io/acme/confirmation/4471", hrefLabel: "Open the confirmation" }, CHI);
  ok(/<figure class="evidence"><blockquote class="ev-q">Confirmation ID: GH-4471<\/blockquote><figcaption class="ev-c">From Trainee&#39;s records · Oct 30, 2026, 10:04 AM CT <a class="ev-link" href="https:\/\/boards\.greenhouse\.io\/acme\/confirmation\/4471"/.test(e), e);
  const bad = evidenceHtml({ quote: "q", source: "s", href: "javascript:x", image: "http://evil.example/x.png" });
  ok(!bad.includes("javascript:") && !bad.includes("<img"), "no non-https link or image");
  ok(evidenceHtml({ quote: "q", source: "s", image: "https://proj.supabase.co/storage/v1/x.png" }).includes(`<img class="ev-img" src="https://proj.supabase.co/storage/v1/x.png"`));
});

Deno.test("job card: logo or lettermark, role, company, the three deciding facts as values, one fit line, ONE action at the bottom", () => {
  const c = jobCardHtml({ company: "Acme Analytics", title: "Data Analyst Intern", logo: null, pay: unknown(UNKNOWN.payNotListed), location: stated("Chicago, IL", "From the posting"), posted: verified("Oct 30", "From the posting"),
    fit: "You asked for SQL-heavy roles in Chicago.", action: { href: "https://boards.greenhouse.io/acme/jobs/1", label: "Apply" } });
  ok(c.includes(`<span class="lettermark" aria-hidden="true">A</span>`) && !c.includes("<img"), "no logo source: the lettermark, no hotlink");
  const order = ["jlogo", "jrole\">Data Analyst Intern", "jco\">Acme Analytics", ">Pay</dt>", ">Location</dt>", ">Posted</dt>", "jfit", "jact"].map((k) => c.indexOf(k));
  ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), `anatomy order ${order}`);
  ok(c.includes(">Pay not listed</span>") && c.includes(`data-v="verified">Oct 30`));
  eq((c.match(/class="apply/g) ?? []).length, 1, "one primary action");
  ok(c.trimEnd().endsWith(`</a></div></article>`), "the action is the last thing on the card");
  ok(!jobCardHtml({ company: "X", title: "Y", pay: unknown(), location: unknown(), posted: unknown(), action: { href: "javascript:alert(1)", label: "Apply" } }).includes("javascript:"));
  ok(jobCardHtml({ company: "X", title: "Y", logo: "/f?logo=x.com", pay: unknown(), location: unknown(), posted: unknown(), action: null }).includes(`referrerpolicy="no-referrer"`));
});

Deno.test("states: empty, loading and error each say what, why, what happens next; an error offers a retry", () => {
  for (const kind of ["empty", "loading", "error"] as const) {
    const s = stateHtml({ kind, title: "No matching roles yet", reason: "Nothing posted this week matches $30/hr in Chicago.", next: "I check again tonight and message you.", retry: kind === "error" ? { href: "/f", label: "Try again" } : undefined });
    ok(s.includes(`fstate-${kind}`) && s.includes("No matching roles yet") && s.includes("Nothing posted this week") && s.includes("What happens next:</strong> I check again tonight"), kind);
    ok(s.includes(kind === "error" ? `role="alert"` : `role="status"`));
    if (kind === "error") ok(s.includes(`<a class="apply" href="/f">Try again</a>`));
    if (kind === "loading") ok(s.includes(`aria-busy="true"`) && s.includes(`class="fbar"`));
  }
  ok(stateHtml({ kind: "error", title: "t", reason: "r", next: "n", retry: { token: "tok", action: "refresh" } }).includes(`<input type="hidden" name="action" value="refresh">`));
  ok(!stateHtml({ kind: "error", title: "t", reason: "r", next: "n", retry: { href: "javascript:x" } }).includes("javascript:"));
});

// ================================================================== "Made for <first name>": confirmed facts only
Deno.test("made for: a CONFIRMED preferred or first name only, else 'you'; the date is the person's day", () => {
  eq(firstNameOf([{ kind: "first_name", value: "Ada" }, { kind: "preferred_name", value: "Addie" }]), "Addie");
  eq(firstNameOf([{ kind: "first_name", value: "Ada Lovelace" }]), "Ada");
  eq(firstNameOf([{ kind: "first_name", value: "Ada", stated: true }]), null, "said in chat, not confirmed");
  eq(firstNameOf([{ kind: "first_name", value: "Ada", status: "draft" }]), null);
  eq(firstNameOf([{ kind: "full_name", value: "Ada Lovelace" }]), null, "never derived from another fact");
  eq(firstNameOf([{ kind: "first_name", value: "<script>" }]), null);
  eq(firstNameOf(null), null);
  eq(madeForLine("Ada", Date.parse("2026-11-02T03:00:00Z"), CHI), "Made for Ada · Nov 1, 2026", "the evening of Nov 1 in Chicago");
  eq(madeForLine(null, Date.parse("2026-11-02T03:00:00Z"), "Asia/Tokyo"), "Made for you · Nov 2, 2026");
  const shell = fileShellHtml({ made: "Made for Ada · Nov 1, 2026", eyebrow: "application proof", title: "Application to Acme", stamp: "Application record read Nov 1, 2026, 3:08 PM CT", body: "<p>x</p>" });
  ok(shell.indexOf(`<p class="made">Made for Ada · Nov 1, 2026</p></header>`) < shell.indexOf(`<div class="fcard">`), "the personal line sits above the card");
  ok(/<h1 class="ftitle">Application to Acme<\/h1><p class="stamp" data-stamp="known">/.test(shell), "the stamp is directly under the title");
});

// ================================================================== the hosted Files: shell, stamp, evidence, private by default
const SECRET = "file-link-secret-0123456789-abcdef";
const U = "11111111-1111-4111-8111-111111111111";
const ENV: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_BOT_URL: "https://t.me/TraineeBot", SUPABASE_URL: "https://proj.supabase.co" };
const PROOF = { from_record: true, title: "Application to Acme", company: "Acme", role: "Data Analyst", destination: "boards.greenhouse.io", status: "confirmed", prepared_at: "2026-10-30T14:00:00Z", submitted_at: "2026-10-30T15:04:00Z",
  as_of: "2026-10-30T15:05:00Z", confirmation: { id: "GH-4471", url: "https://boards.greenhouse.io/acme/confirmation/4471", screenshot_url: "https://proj.supabase.co/storage/v1/object/sign/proofs/gh-4471.png" }, resume: "resume.pdf", answers: [], problems: [] };
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
function world(o: { tz?: string | null; facts?: unknown[] } = {}) {
  const A = signedIn(), at = { t: Date.parse("2026-11-01T21:08:00Z") };
  const store = memoryFileStore(), svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => at.t });
  const stub = (): FileStore => ({ async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { return "saved"; }, async prepared() { return null; },
    async applied() { return false; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async wanted() { return false; } }) as FileStore;
  const deps = (): FileDeps => ({ ...A.deps, store: stub(), now: () => at.t, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } }, tap: {} as never, files: svc,
    ...(o.tz === undefined ? {} : { timeZone: async () => o.tz! }), ...(o.facts ? { facts: async () => o.facts! } : {}) }) as FileDeps;
  return { A, svc, deps, at, store };
}
async function proofFile(w: ReturnType<typeof world>, conf: Record<string, string> = {}) {
  // An application proof is built by code from the application record (file_service.ts proofFromRow, then validated as trusted);
  // the record is put in the store as that path stores it, and the link is the one the service would send.
  const id = "0a1b2c3d4e", v = validateKind("application_proof", { ...PROOF, confirmation: { ...PROOF.confirmation, ...conf } }, { trusted: true, now: w.at.t });
  ok(v.ok, JSON.stringify(v));
  await w.store.put({ id, userId: U, kind: "application_proof", data: (v as { data: unknown }).data, state: {}, tag: null, created_at: w.at.t, expires_at: w.at.t + 3600_000, revoked_at: null });
  return { id, url: (await feedUrlsFor({ get: (k) => ENV[k] }, U, id, w.at.t)).url! };
}

Deno.test("hosted File: Made for <first name> above one card, the title, its stamp in the person's zone, evidence with the claim", async () => {
  const w = world({ tz: CHI, facts: [{ kind: "first_name", value: "Ada" }] });
  const m = await proofFile(w) as { id: string };
  const r = await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${await w.A.tok(U, m.id, w.at.t)}` } }), w.deps());
  eq(r.status, 200);
  const h = await r.text();
  ok(h.includes(`<p class="made">Made for Ada · Nov 1, 2026</p></header><div class="fcard">`), "personal line above the card");
  ok(/<h1 class="ftitle">Application to Acme<\/h1><p class="stamp" data-stamp="known">Application record read Nov 1, 2026, 3:08 PM CT<\/p>/.test(h), "stamp from the File's own build time, Chicago");
  const conf = h.indexOf(">Confirmation</h2>"), fig = h.indexOf(`<figure class="evidence">`, conf);
  ok(conf > 0 && fig > conf && fig < h.indexOf("</section>", conf), "the receipt sits inside the Confirmation section");
  ok(h.includes("Confirmation ID: GH-4471") && h.includes("Oct 30, 2026, 10:04 AM CT") && h.includes("Open the confirmation"));
  ok(h.includes(`<img class="ev-img" src="https://proj.supabase.co/storage/v1/object/sign/proofs/gh-4471.png"`), "the screenshot from the project's own storage is shown inline");
  ok(/img-src [^;]*https:\/\/proj\.supabase\.co/.test(r.headers.get("content-security-policy")!), "and the CSP allows exactly that origin");
  eq((h.match(/<h1[ >]/g) ?? []).length, 1);
});

Deno.test("hosted File: no confirmed name is 'you'; a screenshot from elsewhere is a link, never an inline image", async () => {
  const w = world({ tz: null });
  const m = await proofFile(w, { screenshot_url: "https://cdn.elsewhere.example/gh-4471.png" });
  const r = await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${await w.A.tok(U, m.id, w.at.t)}` } }), w.deps());
  const h = await r.text();
  ok(h.includes(`<p class="made">Made for you · Nov 1, 2026</p>`), "no confirmed name");
  ok(h.includes("Application record read Nov 1, 2026, 3:08 PM CT (Chicago time; your time zone isn&#39;t on file)"), "unknown zone said");
  ok(!h.includes("<img class=\"ev-img\"") && h.includes(`href="https://cdn.elsewhere.example/gh-4471.png" rel="noopener noreferrer">Open the screenshot</a>`), "a link, not an image");
  ok(!/img-src [^;]*elsewhere/.test(r.headers.get("content-security-policy")!));
});

Deno.test("private by default: a hosted File opens only for its owner, after a phone sign-in; nothing of it shows before", async () => {
  const w = world({ tz: CHI, facts: [{ kind: "first_name", value: "Ada" }] });
  const m = await proofFile(w) as { id: string; url: string };
  const leaks = (h: string) => ["Acme", "GH-4471", "Data Analyst", "Ada", "resume.pdf"].filter((x) => plain(h).includes(x));
  // No session at all: nothing opens.
  const bare = await handleFile(new Request("https://x.example/f"), w.deps());
  eq(bare.status, 403); eq(leaks(await bare.text()), []);
  // The bot's link: a sign-in, never the File.
  const link = await handleFile(new Request(m.url, { headers: { "user-agent": "Mozilla/5.0" } }), w.deps());
  eq(link.status, 303);
  const cookie = (link.headers.get("set-cookie") ?? "").split(";")[0];
  const signIn = await handleFile(new Request("https://x.example/f", { headers: { cookie } }), w.deps());
  const sh = await signIn.text();
  eq(signIn.status, 200); ok(sh.includes(`name="phone"`) && sh.includes("never asks for this code in chat"), "the phone sign-in, asking nothing in chat");
  ok(!/type="password"/.test(sh), "never a password");
  eq(leaks(sh), []);
  // A link-preview crawler: the kind's name only.
  const crawl = await handleFile(new Request(m.url, { headers: { "user-agent": "TelegramBot (like TwitterBot)" } }), w.deps());
  eq(leaks(await crawl.text()), []);
  // Someone else's session never opens it.
  const other = "22222222-2222-4222-8222-222222222222";
  const theirs = await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${await w.A.tok(other, m.id, w.at.t)}` } }), w.deps());
  eq(leaks(await theirs.text()), []);
  // Every File response says do not cache, do not index, send no referrer.
  for (const r of [bare, link, signIn]) {
    eq(r.headers.get("cache-control"), "no-store"); ok(/noindex/.test(r.headers.get("x-robots-tag") ?? "")); eq(r.headers.get("referrer-policy"), "no-referrer");
  }
});

Deno.test("error state: a store that throws gets the designed error page: what, why, next, a retry to this same page", async () => {
  const w = world();
  const boom = { ...w.deps(), files: { get() { throw new Error("down"); } } } as unknown as FileDeps;
  const r = await handleFile(new Request("https://x.example/file/abc", { headers: { cookie: `tf_s=${await w.A.tok(U, "0123456789", w.at.t)}` } }), boom);
  eq(r.status, 503);
  const h = await r.text();
  ok(h.includes(`fstate-error" role="alert"`) && h.includes("Couldn&#39;t open this just now") && h.includes("Nothing was opened and nothing was sent.") && h.includes("What happens next:</strong> Try again in a minute."), h.slice(-900));
  ok(h.includes(`<a class="apply" href="/file/abc">Try again</a>`), "the retry reopens this page");
  const odd = await handleFile(new Request("https://x.example//evil.example/x", { headers: { cookie: `tf_s=${await w.A.tok(U, "0123456789", w.at.t)}` } }), boom);
  ok((await odd.text()).includes(`href="/evil.example/x"`), "the retry never points at another host");
});

// ================================================================== the jobs list File: the same shell, "Postings checked"
Deno.test("jobs list: the File shell; the stamp from the postings' own check times; none known is said as a value", async () => {
  const feed = (o: Record<string, unknown>) => renderFeed({ token: "t", rows: [], setHash: null, setSize: 0, ...o });
  const h = feed({ made: "Made for Ada · Nov 1, 2026", stamp: "Postings checked Nov 1, 2026, 3:08–3:25 PM CT" });
  ok(h.includes(`<p class="made">Made for Ada · Nov 1, 2026</p></header><div class="fcard"><h1 class="ftitle">Your jobs</h1><p class="stamp" data-stamp="known">Postings checked Nov 1, 2026, 3:08–3:25 PM CT</p>`));
  ok(feed({}).includes(`data-stamp="unknown"`) && feed({}).includes("Check time unknown"));
  // Through the handler: last_seen_at of the postings on the page, in the person's zone.
  const { signedIn: si } = await import("./file-session-fakes.ts");
  const A = si(), LIST = "0123456789", now = Date.parse("2026-11-01T22:00:00Z");
  const { refOf, jobViewOf } = await import("../../supabase/functions/_shared/telegram_jobs.ts");
  const kv = new Map<string, unknown>();
  const post = (n: number) => ({ job_id: `greenhouse:acme:${n}`, provider: "greenhouse", company: `Acme ${n}`, title: "Data Analyst", location: "Chicago, IL", url: `https://boards.greenhouse.io/acme/jobs/${n}`, description: "<p>Build dashboards.</p>",
    pay: "$30/hr", closed_at: null, first_seen_at: "2026-10-30T10:00:00Z", posted_at: "2026-10-30T10:00:00Z", last_seen_at: n === 1 ? "2026-11-01T21:25:00Z" : "2026-11-01T21:08:00Z" });
  const store = { async remember(u: string, ref: string, job: unknown) { kv.set(`${u}|${ref}`, { job }); }, async recall(u: string, ref: string) { return kv.get(`${u}|${ref}`) ?? null; }, async rememberList(u: string, id: string, refs: string[]) { kv.set(`${u}|l|${id}`, refs); },
    async recallList(u: string, id: string) { return kv.get(`${u}|l|${id}`) ?? null; }, async postings(ids: string[]) { return ids.map((id) => post(Number(id.split(":").pop()))); }, async save() { return "saved"; }, async prepared() { return null; },
    async applied() { return false; }, async want() { return { result: "queued" }; }, async appRow() { return null; }, async wanted() { return false; } } as unknown as FileStore;
  const refs: string[] = [];
  for (const n of [1, 2]) { const ref = await refOf(U, `greenhouse:acme:${n}`); refs.push(ref); await store.remember(U, ref, jobViewOf({ job_id: `greenhouse:acme:${n}`, company: `Acme ${n}`, title: "Data Analyst", url: `https://boards.greenhouse.io/acme/jobs/${n}` } as never, post(n) as never), "text"); }
  await store.rememberList(U, LIST, refs);
  const d = { ...A.deps, store, now: () => now, env: { get: (k: string) => ENV[k] }, cards: { async open() { return null; } }, tap: {} as never, timeZone: async () => CHI, facts: async () => [{ kind: "preferred_name", value: "Ada" }] } as unknown as FileDeps;
  const page = await (await handleFile(new Request("https://x.example/f", { headers: { cookie: `tf_s=${await A.tok(U, LIST, now)}` } }), d)).text();
  ok(page.includes(`<p class="made">Made for Ada · Nov 1, 2026</p>`), "made for, from the confirmed name");
  ok(page.includes(`data-stamp="known">Postings checked Nov 1, 2026, 3:08–3:25 PM CT</p>`), plain(page).slice(0, 400));
});
