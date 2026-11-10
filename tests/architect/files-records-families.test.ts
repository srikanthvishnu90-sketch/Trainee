// Item 6, S5 (task f-s5): F-01, F-02, F-03, F-08, F-13, F-14, F-15 drawn from the person's records (file_family_records.ts) through
// each family's own builder and the one visual system (file_family.ts familyPage). Two worlds: a person with records, and a person
// with none. For each page every control is inventoried from the drawn HTML and classified:
//   chat      a ?<key>=1 link whose key is a decision that needs the person's words (the File server opens the chat with it filled in)
//   post      a POST form carrying the page token, with an action the File server answers (briefpause / briefresume)
//   source    an https page
//   unserved  anything else (a GET the server does not read, a post it does not answer, a link with no target)
//   dead      a control drawn off with no reason beside it
// Printed: FILES RECORDS: pages P, controls C, chat Q, posts T, sources S, off-with-reason O, unserved U, dead D
// Asserted: unserved 0, dead 0; every value drawn on F-02 is in the records or written "Unknown"; F-13 says "not booked" when the
// invite offers several times; F-15 says "Nothing accepted" and adds no total; F-14's pause is a token POST.
import assert from "node:assert/strict";
import { familyPage, type FamilyFile, familyStatePage } from "../../supabase/functions/_shared/file_family.ts";
import { answerLibraryFile, careerBriefFile, pathComparisonFile, profileFactsFile } from "../../supabase/functions/_shared/file_family_plan.ts";
import { interviewHubFile, offerComparisonFile, weeklyBriefFile } from "../../supabase/functions/_shared/file_family_apply.ts";
import { LIVE_FAMILIES, type LiveFamily, viewOf } from "../../supabase/functions/_shared/file_family_records.ts";

import { FULL, NONE, NOW } from "./files-records-fixtures.ts";
const TOKEN = "page-token-abc";
// The decisions the File server turns into a prefilled chat (file_family_serve.ts ASK_KEYS, #676).
const ASK = new Set(["answer", "edit", "correct", "propose", "decide", "followup", "prefer", "priorities", "recipient", "questions", "negotiate", "decision", "plan", "add", "tighten", "adjacent", "widen", "find", "practice", "start"]);
// deno-lint-ignore no-explicit-any
const BUILD: Record<LiveFamily, (v: any) => FamilyFile> = { "F-01": careerBriefFile, "F-02": profileFactsFile, "F-03": pathComparisonFile, "F-08": answerLibraryFile, "F-13": interviewHubFile, "F-14": weeklyBriefFile, "F-15": offerComparisonFile };

function draw(family: LiveFamily, r: Records): string {
  const v = viewOf(family, r, { token: TOKEN });
  return "view" in v ? familyPage(BUILD[family](v.view), { now: NOW, tz: r.tz }) : familyStatePage(v.state, { now: NOW, tz: r.tz });
}
type Kind = "chat" | "post" | "source" | "off" | "unserved" | "dead";
function controls(html: string): { kind: Kind; what: string }[] {
  const out: { kind: Kind; what: string }[] = [];
  for (const m of html.matchAll(/<form method="post"[^>]*>(.*?)<\/form>/gs)) {
    const t = /name="t" value="([^"]*)"/.exec(m[1])?.[1], action = /name="action" value="([^"]*)"/.exec(m[1])?.[1] ?? "";
    const served = t === TOKEN && /^brief(pause|resume)$/.test(action); // the posts file_family_actions.ts answers (part 2)
    out.push({ kind: served ? "post" : "unserved", what: `POST ${action}` });
  }
  const rest = html.replace(/<form method="post".*?<\/form>/gs, "");
  for (const m of rest.matchAll(/<a [^>]*href="([^"]*)"[^>]*>/g)) {
    const h = m[1].replace(/&amp;/g, "&");
    if (/^https:\/\//.test(h)) out.push({ kind: "source", what: h });
    else if (h.startsWith("#")) continue; // skip link / in-page anchor
    else if (/^\?[a-z]+=1$/.test(h) && ASK.has(h.slice(1, -2))) out.push({ kind: "chat", what: h });
    else out.push({ kind: "unserved", what: h });
  }
  for (const m of rest.matchAll(/<button[^>]*disabled[^>]*>.*?<\/button>(<span class="ff-off">([^<]*)<\/span>)?/gs)) out.push({ kind: m[2]?.trim() ? "off" : "dead", what: m[2] ?? "disabled with no reason" });
  return out;
}

Deno.test("FILES RECORDS: the seven families drawn from records, full and empty: every control served, none dead", () => {
  const all: { family: string; world: string; kind: Kind; what: string }[] = [];
  let pages = 0;
  for (const [world, r] of [["records", FULL], ["none", NONE]] as const) for (const f of LIVE_FAMILIES) {
    const html = draw(f, r); pages++;
    assert.match(html, new RegExp(`data-family="${f}"`), `${f} (${world}): drawn as its family`);
    for (const c of controls(html)) all.push({ family: f, world, ...c });
  }
  const n = (k: Kind) => all.filter((x) => x.kind === k).length;
  console.log(`FILES RECORDS: pages ${pages}, controls ${all.length}, chat ${n("chat")}, posts ${n("post")}, sources ${n("source")}, off-with-reason ${n("off")}, unserved ${n("unserved")}, dead ${n("dead")}`);
  for (const x of all.filter((x) => x.kind === "unserved" || x.kind === "dead")) console.log(`  ${x.kind.toUpperCase()} ${x.family} (${x.world}): ${x.what}`);
  assert.equal(n("unserved"), 0, "unserved controls");
  assert.equal(n("dead"), 0, "dead controls");
  for (const f of LIVE_FAMILIES) assert.ok(all.some((x) => x.family === f && x.world === "none" && x.kind === "chat"), `${f} with no records: the page still opens the chat`);
});

Deno.test("F-02: every value is the person's own, with its source; what they haven't said is written Unknown; sensitive facts are not listed", () => {
  const html = draw("F-02", FULL);
  for (const v of ["Analyst", "New York", "Evercore", "BS Economics, Rutgers University", "No staffing agencies", "You said in chat", "Your resume, confirmed by you"]) assert.ok(html.includes(v), v);
  assert.match(html, /School[\s\S]{0,400}Unknown - not confirmed by you/, "School the person never gave: Unknown");
  assert.match(html, /never used until you confirm it/, "the draft is marked as never used");
  assert.ok(!html.includes("needs sponsorship"), "a sensitive fact is not listed for reuse");
  const empty = draw("F-02", NONE);
  assert.equal((empty.match(/Unknown - not confirmed by you/g) ?? []).length, 5, "with no records, every standing field is Unknown");
});

Deno.test("F-01 and F-03: nothing assumed; no comparison is invented", () => {
  const html = draw("F-01", FULL);
  assert.match(html, /Analyst roles at Evercore/); assert.match(html, /In New York/);
  assert.doesNotMatch(draw("F-01", NONE), /Analyst|New York/);
  assert.match(draw("F-01", NONE), /Not set yet/);
  assert.match(draw("F-03", FULL), /No path comparison on record/, "no store of directions: said, not invented");
});

Deno.test("F-08: answers reused with their source; essays scoped to their employer; the declaration blocks; sensitive answers never listed", () => {
  const html = draw("F-08", FULL);
  assert.match(html, /Preferred phone type[\s\S]{0,300}Mobile/);
  assert.match(html, /Why Evercore\?/); assert.match(html, /Evercore/);
  assert.match(html, /New declaration on Lazard/);
  assert.doesNotMatch(html, /authorized to work/, "a work-authorization answer is answered per application, never listed");
  assert.match(draw("F-08", NONE), /No saved answers yet/);
});

Deno.test("F-13: an invite offering several times is not booked; the interviewer is named only as the invite named them", () => {
  const html = draw("F-13", FULL);
  assert.match(html, /Suggested time - not booked/);
  assert.match(html, /Dana Park/); assert.match(html, /Not verified/); assert.match(html, /Calendar not checked/);
  assert.doesNotMatch(html, /\b0 min\b/, "no length invented");
  const one = draw("F-13", { ...FULL, interviews: [{ ...FULL.interviews[0], when_said: ["Tue 2pm"] }] });
  assert.match(one, /Confirmed logistics/);
  assert.match(draw("F-13", { ...FULL, interviews: [{ ...FULL.interviews[0], starts_at: null }] }), /no time on record[\s\S]*Suggested is not booked/);
  assert.match(draw("F-13", NONE), /No upcoming interview on record/);
});

Deno.test("F-15: the person's terms with their source, no total, nothing accepted", () => {
  const html = draw("F-15", FULL);
  assert.match(html, /\$110,000/); assert.match(html, /\$15,000/); assert.match(html, /from your words in chat/);
  assert.match(html, /Nothing accepted/); assert.doesNotMatch(html, /from actual documents/);
  assert.doesNotMatch(html, />\s*Total/i);
  assert.match(draw("F-15", NONE), /No offer on record[\s\S]*Nothing accepted/);
});

Deno.test("F-14: a quiet week says so; the pause is drawn as a POST form carrying the page token", () => {
  assert.match(draw("F-14", FULL), /2 applications? approved|1 application approved/);
  assert.match(draw("F-14", NONE), /Quiet week/);
  const html = draw("F-14", FULL);
  assert.match(html, /<form method="post"[^>]*><input type="hidden" name="t" value="page-token-abc"><input type="hidden" name="action" value="briefpause">/);
  assert.match(draw("F-14", { ...FULL, digest: { ...FULL.digest!, enabled: false } }), /name="action" value="briefresume"/);
});
