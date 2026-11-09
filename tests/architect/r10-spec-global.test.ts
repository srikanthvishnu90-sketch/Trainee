// R10 WO-E: the spec's global rules (APP-LAYER-15-FIXES.md D.1, D.4) and the chat-entry and all-Files criteria (E-79, E-80), each
// tested as behaviour over every File family (file_family_specimens.ts FILE_FAMILIES, F-01 to F-15 and F-14n). Test names carry the
// spec id. Fictional specimens only; the clock and zone are inputs.
import assert from "node:assert/strict";
import { DOMParser } from "jsr:@b-fuze/deno-dom@0.1.48";
import * as BRAND from "../../supabase/functions/_shared/brand.ts";
import * as DESIGN from "../../supabase/functions/_shared/results_design.ts";
import { FAMILIES, FAMILY_CSS, familyStatePage, type FamilyId } from "../../supabase/functions/_shared/file_family.ts";
import { LIVE_CSS } from "../../supabase/functions/_shared/file_family_live.ts";
import { chatFileCard, chatFileCards } from "../../supabase/functions/_shared/file_family_card.ts";
import { FILE_FAMILIES } from "../../supabase/functions/_shared/file_family_specimens.ts";
import type { ResultRow } from "../../supabase/functions/_shared/results_page.ts";
import { CTX, role } from "./r10-files-fixtures.ts";

// deno-lint-ignore no-explicit-any
const doc = (html: string): any => new DOMParser().parseFromString(html, "text/html");
// deno-lint-ignore no-explicit-any
const all = (d: any, sel: string): any[] => [...d.querySelectorAll(sel)];
const PAGES = FILE_FAMILIES.map((f) => ({ id: f.id, html: f.page() }));
const hex = (h: string) => (h.length === 4 ? `#${[...h.slice(1)].map((x) => x + x).join("")}` : h).toUpperCase();

Deno.test("D.1 palette: every colour a File page uses is a brand.ts or results_design.ts token; plum is #5C2751; Inter and Brygada 1918", () => {
  const tokens = new Set<string>();
  const walk = (o: unknown): void => { if (typeof o === "string") { for (const m of o.matchAll(/#[0-9a-f]{6}\b/gi)) tokens.add(m[0].toUpperCase()); } else if (o && typeof o === "object") Object.values(o).forEach(walk); };
  walk(BRAND); walk(DESIGN);
  const used = [...`${FAMILY_CSS}${LIVE_CSS}`.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => hex(m[0]));
  assert.ok(used.length > 10);
  assert.deepEqual([...new Set(used.filter((h) => !tokens.has(h)))], [], "a colour outside the brand tokens");
  assert.equal(BRAND.PLUM, "#5C2751");
  assert.ok(FAMILY_CSS.includes(`--ff-hero-a:${BRAND.DARK.tint};--ff-hero-b:${BRAND.PLUM};`), "hero: brand tint into brand plum");
  assert.match(FAMILY_CSS, /linear-gradient\(135deg,var\(--ff-hero-a\),var\(--ff-hero-b\)\)/);
  for (const p of PAGES) { assert.match(p.html, /'Inter'/, p.id); assert.match(p.html, /'Brygada 1918'/, p.id); }
});

Deno.test("D.4-1 freshness: every File header (hero, or the line under a heroless header) shows an actual time and its source basis", () => {
  for (const p of PAGES) {
    const d = doc(p.html), head = d.querySelector(".ff-hero") ?? d.querySelector(".ff-fresh");
    assert.ok(head, `${p.id}: no header summary`);
    const t = head.innerHTML as string;
    assert.match(t, /(Updated|Checked|Generated|Destination verified)\s*<b><time datetime="[^"]+">/, `${p.id}: freshness with a time`);
    assert.match(t, /(Source:|Sources checked:|Based on|from actual documents)/i, `${p.id}: source basis`);
  }
});

Deno.test("D.4-2 sources: every value carries its source or is marked; nothing is blank, a dash or N/A; the source-silent says unknown", () => {
  for (const p of PAGES) {
    for (const dd of all(doc(p.html), ".ff-kvr dd")) {
      const text = (dd.textContent as string).trim(), html = dd.innerHTML as string;
      assert.ok(text && !/^(-|–|—|n\/a|tbd|null|undefined)$/i.test(text), `${p.id}: empty value "${text}"`);
      assert.ok(/class="ff-src"|data-unconfirmed="1"|data-src="unconfirmed"|ff-id/.test(html), `${p.id}: value without a source: ${text}`);
    }
  }
  // The roles File writes the source-silent fields as "unknown", in words.
  const f05 = PAGES.find((p) => p.id === "F-05")!.html;
  assert.match(f05, /pay not listed \(marked unknown\)/);
  assert.match(FILE_FAMILIES.find((f) => f.id === "F-15")!.page(), /Unknown - summary only/);
});

Deno.test("D.4-5 actions: at most one primary in each page's action bar, named; download is never filled; submit, send and approve always are", () => {
  for (const p of PAGES) {
    const d = doc(p.html);
    const bar = d.querySelector(".ff-bar");
    if (bar) assert.ok(all(bar, ".ff-pri").length <= 1, `${p.id}: more than one primary`);
    for (const el of all(d, "[data-effect]")) {
      const eff = el.getAttribute("data-effect"), cls = el.getAttribute("class") ?? "", name = (el.getAttribute("aria-label") ?? el.textContent).trim();
      assert.ok(name, `${p.id}: unlabelled ${eff}`);
      if (eff === "download") { assert.doesNotMatch(cls, /ff-pri/, `${p.id}: download styled as submit`); assert.ok(el.tagName === "A" ? el.hasAttribute("download") : el.hasAttribute("disabled"), `${p.id}: download that does not download`); }
      if (["submit", "send", "approve"].includes(eff)) assert.match(cls, /ff-pri/, `${p.id}: ${eff} styled as a preview`);
    }
  }
});

Deno.test("D.4-12 charts: no File draws a chart or decorative image; the only graphics are labelled icons", () => {
  for (const p of PAGES) {
    const d = doc(p.html);
    assert.equal(all(d, "canvas, img, picture, video").length, 0, p.id);
    for (const svg of all(d, "svg")) assert.ok(svg.closest('[aria-hidden="true"]') || svg.getAttribute("role") === "img", `${p.id}: unlabelled graphic`);
    for (const svg of all(d, "svg")) assert.equal(all(svg, "rect, polyline, circle").length <= 2, true, `${p.id}: chart-like svg`);
  }
});

const rows = (): ResultRow[] => [
  role(1, { rid: "R-01" }), role(2, { rid: "R-02" }), role(3, { rid: "R-03", openQs: 1, guide: "1 question needs your answer first" }),
  role(4, { rid: "R-04", blocked: "the posting closed Nov 8" }), role(5, { rid: "R-05", status: { word: "queued", detail: "Approved and queued." }, inApps: true }),
] as ResultRow[];

Deno.test("E-79 chat entry: one card per result, no raw links in the words, counts from real states that sum, a deep link to the role", () => {
  const link = "https://trainee.example/file/fs1.abc";
  const card = chatFileCard({ kicker: "Roles File - batch B-01", title: "Climate operations roles https://evil.example/x", updatedAt: "2026-11-09T15:40:00Z", link, rows: rows(),
    decision: { text: "One role needs one answer from you. See https://boards.example/job", ref: "ref3" } }, CTX);
  assert.doesNotMatch(card.text, /https?:\/\/|www\./, "a link travels only as the button");
  assert.match(card.text, /^ROLES FILE - BATCH B-01\nClimate operations roles\nUpdated Today 9:40 AM CT - /);
  const nums = [...card.text.split("\n")[2].matchAll(/ - (\d+) /g)].map((m) => +m[1]);
  assert.equal(nums.reduce((a, b) => a + b, 0), rows().length, "counts sum to the roles held");
  assert.match(card.text, /1 need eligibility check|1 closed/); assert.doesNotMatch(card.text, /5 ready/);
  assert.equal(card.button.url, `${link}#r-ref3`); assert.equal(card.button.label, "Review this role");
  assert.match(card.text, /nothing is submitted from chat/);
  // A decision about a role the File does not hold never deep-links; several results are several cards.
  assert.equal(chatFileCard({ kicker: "k", title: "t", updatedAt: null, link, rows: rows(), decision: { text: "x", ref: "nope" } }, CTX).button.url, link);
  assert.match(chatFileCard({ kicker: "k", title: "t", updatedAt: null, link, rows: [] }, CTX).text, /Update time unknown/);
  assert.equal(chatFileCards([{ kicker: "a", title: "a", updatedAt: null, link, rows: rows() }, { kicker: "b", title: "b", updatedAt: null, link, rows: [] }], CTX).length, 2);
});

Deno.test("E-80 all Files: each family has loading, empty and error states with its own header and a way on; desktop is one centred column", () => {
  for (const id of Object.keys(FAMILIES) as FamilyId[]) {
    for (const state of ["loading", "empty", "error"] as const) {
      const h = familyStatePage({ state, family: id, recover: { label: "Try again", effect: "decide", href: "?" } }, CTX);
      assert.match(h, new RegExp(`<p class="ff-ht">${FAMILIES[id].header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`), `${id} ${state}: header`);
      assert.match(h, /role="(status|alert)"/, `${id} ${state}: a stated state`);
    }
  }
  // Desktop: every family page sits in the shared layout's one centred column (file_page.ts .wrap), the File inside it.
  for (const p of PAGES) { assert.match(p.html, /\.wrap\{max-width:\d+px;margin:0 auto/, p.id); assert.match(p.html, /<div class="wrap"><div class="ff"/, p.id); }
});
