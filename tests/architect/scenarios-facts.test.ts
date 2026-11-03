// D-007 at scale (never invent a fact about the person): generated profiles x generated question phrasings, through the
// same CareerHost chain the handler runs (130 onboarding's profile recall, then the 142 router: eligibility read-back,
// record recall, stated-fact read-back), scripted, no model, as eligibility-no-invented-verdict.test.ts does.
// Profiles vary: no resume, a resume left as a draft, a confirmed resume (school and GPA vary); a saved GPA; a saved
// location and target roles; saved work authorization and sponsorship answers; facts stated in chat (school, location,
// target role, sponsorship, citizenship). Questions: school, GPA, sponsorship, citizenship, visa status, work
// authorization, location, target roles, in many phrasings, casings and common typos.
// Invariants for every turn:
//   - every school, GPA, city, role or work-authorization value in the reply is one on this person's record (confirmed
//     resume, saved answer or stated fact); a draft resume's values are never read back
//   - when the asked fact is on record, the reply carries it; when it is not, the reply says it is not on record (or not
//     stored) and asks for it
//   - never a verdict, and never a sponsorship or citizenship answer that is not on record
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { rng, type R } from "./scenarios-fixture.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const RESUME = await Deno.readTextFile(`${ROOT}packages/career-data/fixtures/test-resume.txt`);
const P = (core as any).CareerProfile;
const host = (CareerHost as any).createCareerHost(core);

const SCHOOLS = ["TEST University", "Northbridge University (TEST)", "Lakeview College (TEST)", "Riverside Tech (TEST)", "Ashford State (TEST)"];
const GPAS = ["3.7", "3.2", "3.95", "2.9", "3.45"];
const SAVED_GPA = ["3.61", "3.88"];
const CITIES = ["Austin, TX", "Denver, CO", "Boston, MA", "Seattle, WA"];
const STATED_CITIES = ["Pittsburgh", "Atlanta", "Minneapolis"];
const ROLES = ["Product Manager (TEST)", "UX Researcher (TEST)", "Quant Analyst (TEST)"];
const STATED_ROLES = ["Product Designer", "Data Scientist"];
const STATED_SCHOOLS = ["Hollis College", "Crestview University"];
const WORK_AUTH = ["US citizen (TEST)", "F-1 OPT (TEST)", "Green card holder (TEST)", "H-1B (TEST)"];

type Profile = {
  resume: "none" | "draft" | "confirmed"; school: string; gpa: string; savedGpa: string | null; location: string | null; roles: string[];
  workAuth: string | null; needsSponsorship: boolean | null; stated: { kind: string; value: string; evidence: string }[];
  noProfile?: boolean; // no profile record at all (a person who has given nothing yet)
};
function genProfile(r: R): Profile {
  const stated: Profile["stated"] = [];
  if (r.next() < 0.25) { const v = r.pick(STATED_SCHOOLS); stated.push({ kind: "school", value: v, evidence: `I go to ${v}` }); }
  if (r.next() < 0.25) { const v = r.pick(STATED_CITIES); stated.push({ kind: "geography", value: v, evidence: `I'm in ${v}` }); }
  if (r.next() < 0.2) { const v = r.pick(STATED_ROLES); stated.push({ kind: "target_role", value: v, evidence: `my dream role is ${v}` }); }
  if (r.next() < 0.2) { const v = r.pick(["needs sponsorship", "does not need sponsorship"]); stated.push({ kind: "sponsorship", value: v, evidence: v }); }
  if (r.next() < 0.15) { const v = r.pick(["US citizen", "not a US citizen"]); stated.push({ kind: "citizenship", value: v, evidence: v }); }
  if (r.next() < 0.1) return { resume: "none", school: r.pick(SCHOOLS), gpa: r.pick(GPAS), savedGpa: null, location: null, roles: [], workAuth: null, needsSponsorship: null, stated, noProfile: true };
  return {
    resume: r.pick(["none", "draft", "confirmed", "confirmed"] as const), school: r.pick(SCHOOLS), gpa: r.pick(GPAS),
    savedGpa: r.next() < 0.15 ? r.pick(SAVED_GPA) : null, location: r.next() < 0.35 ? r.pick(CITIES) : null, roles: r.next() < 0.35 ? [r.pick(ROLES)] : [],
    workAuth: r.next() < 0.3 ? r.pick(WORK_AUTH) : null, needsSponsorship: r.pick([null, null, true, false]), stated,
  };
}

type Topic = "school" | "gpa" | "wa" | "location" | "roles";
const QUESTIONS: [Topic, string][] = [
  ["school", "where did I go to school?"], ["school", "where do I go to school"], ["school", "what school do I go to?"], ["school", "what's my school?"],
  ["school", "what college did I go to?"], ["school", "what university do I attend?"], ["school", "wher did i go to school"], ["school", "whats my school"],
  ["gpa", "what's my GPA?"], ["gpa", "what is my gpa"], ["gpa", "whats my gpa?"], ["gpa", "what GPA do I have?"], ["gpa", "my gpa?"], ["gpa", "waht is my gpa"],
  ["wa", "do I need sponsorship?"], ["wa", "do i need visa sponsorship"], ["wa", "will I need sponsorship?"], ["wa", "am I a citizen?"], ["wa", "am i a us citizen"],
  ["wa", "what's my visa status?"], ["wa", "what is my work authorization?"], ["wa", "am I authorized to work in the US?"], ["wa", "do I have a green card?"],
  ["wa", "do i need a visa?"],
  ["location", "where do I live?"], ["location", "where am I based?"], ["location", "what's my location?"], ["location", "what city am I in?"],
  ["location", "where am i located"], ["location", "whats my city"],
  ["roles", "what roles am I looking for?"], ["roles", "what roles do i want"], ["roles", "what jobs am I targeting?"], ["roles", "what am I looking for?"],
  ["roles", "what kind of roles am I after?"],
];
function vary(r: R, q: string) {
  let out = q;
  const c = r.int(0, 5);
  if (c === 0) out = out.toUpperCase();
  else if (c === 1) out = out.charAt(0).toUpperCase() + out.slice(1);
  else if (c === 2) out = out.replace(/\?$/, "") + "??";
  else if (c === 3) out = out.replace(/\?$/, "");
  return out;
}

function turn(p: Profile, text: string) {
  const ctx = host.createTurnCtx({ userId: "TEST-facts", threadId: "t-facts", now: Date.parse("2026-10-29T15:00:00Z"), accountPersistence: true,
    snapshot: null, account: { epoch: 0, version: 0, paused: false }, postings: [] });
  const prof = P.createProfile({ id: "TEST-facts", basics: { location: p.location }, preferences: { roles: p.roles },
    constraints: { workAuthorization: p.workAuth, needsSponsorship: p.needsSponsorship }, defaults: { gpa: p.savedGpa } });
  if (p.resume !== "none") {
    P.ingestResume(prof, RESUME.replaceAll("TEST University", p.school).replace("GPA 3.7", `GPA ${p.gpa}`));
    if (p.resume === "confirmed") for (const f of prof.facts) P.confirmFact(prof, f.id);
  }
  ctx.profile = p.noProfile ? null : prof;
  if (p.stated.length) ctx.statedFacts = { facts: p.stated.map((f) => ({ ...f })) };
  const r = host.runTurn(text, ctx);
  return { intent: String(r.intent ?? ""), reply: String(r.reply ?? "") };
}

const NOT_ON_RECORD = /not on your record|do not have your|don't have your|have not told me|haven't told me|not stored|you have not stated/i;
const ASKS = /\?|\bstate (?:it|a|an)\b|\btell me\b/i;
const statedOf = (p: Profile, kind: string) => p.stated.filter((f) => f.kind === kind).map((f) => f.value);

// What the record holds for a topic: the values that may appear, and whether anything is on record.
function record(p: Profile, topic: Topic) {
  const confirmed = p.resume === "confirmed";
  switch (topic) {
    case "school": { const v = [...(confirmed ? [p.school] : []), ...statedOf(p, "school")]; return { allowed: v, on: v.length > 0, must: v }; }
    case "gpa": { const v = [...(p.savedGpa ? [p.savedGpa] : []), ...(confirmed ? [p.gpa] : [])]; return { allowed: v, on: v.length > 0, must: p.savedGpa ? [p.savedGpa] : v }; }
    case "location": { const v = [...(p.location ? [p.location] : []), ...statedOf(p, "geography")]; return { allowed: v, on: v.length > 0, must: v.slice(0, 1) }; }
    case "roles": { const v = [...p.roles, ...statedOf(p, "target_role")]; return { allowed: v, on: v.length > 0, must: v.slice(0, 1) }; }
    case "wa": {
      const v = [...(p.workAuth ? [p.workAuth] : []), ...statedOf(p, "sponsorship"), ...statedOf(p, "citizenship")];
      return { allowed: v, on: v.length > 0 || p.needsSponsorship !== null, must: [] };
    }
  }
}
// Every value of every kind this generator can put on a record: none may appear unless this record holds it.
const UNIVERSE: string[] = [...SCHOOLS.filter((s) => s !== "TEST University"), ...STATED_SCHOOLS, ...CITIES, ...STATED_CITIES, ...ROLES, ...STATED_ROLES, ...WORK_AUTH];

function check(p: Profile, topic: Topic, q: string): string | null {
  const { intent, reply } = turn(p, q);
  const rec = record(p, topic);
  const where = `${JSON.stringify(q)} [${topic}] profile ${JSON.stringify({ ...p, stated: p.stated.map((f) => `${f.kind}=${f.value}`) })}\n    -> ${intent}: ${reply.slice(0, 320)}`;
  if (/\bverdict\b|evidences every/i.test(reply)) return `a verdict: ${where}`;
  // Values from the whole record are allowed anywhere (a school answer may carry the confirmed resume line); none other.
  const held = new Set([...(["school", "gpa", "location", "roles", "wa"] as Topic[]).flatMap((t) => record(p, t).allowed)]);
  for (const v of UNIVERSE) if (reply.includes(v) && !held.has(v)) return `"${v}" is not on this record: ${where}`;
  if (p.resume !== "confirmed" && p.school !== "TEST University" && reply.includes(p.school) && !held.has(p.school)) return `a draft's school read back: ${where}`;
  if (topic === "gpa" || topic === "school") {
    const gpas = (reply.match(/\b[0-4]\.\d{1,2}\b/g) ?? []).filter((g) => !held.has(g) && !(p.resume === "confirmed" && g === p.gpa));
    if (gpas.length) return `GPA ${gpas.join(",")} not on record: ${where}`;
  }
  if (topic === "wa") {
    const sp = p.needsSponsorship === true || statedOf(p, "sponsorship").includes("needs sponsorship");
    const noSp = p.needsSponsorship === false || statedOf(p, "sponsorship").includes("does not need sponsorship");
    if (/(?<!\b(?:whether|if)\s)\byou (?:do not|don't) need (?:visa )?sponsorship\b/i.test(reply) && !noSp) return `a "no sponsorship" answer not on record: ${where}`;
    if (/(?<!\b(?:do|whether|if)\s)\byou need (?:visa )?sponsorship\b/i.test(reply) && !sp) return `a "needs sponsorship" answer not on record: ${where}`;
    if (/\byou(?:'re| are) a (?:us |u\.s\. )?citizen\b/i.test(reply) && !statedOf(p, "citizenship").includes("US citizen")) return `a citizenship answer not on record: ${where}`;
    if (/H-1B route|lottery|cap-subject/i.test(reply)) return `a generic essay, not the record: ${where}`;
  }
  if (rec.on) {
    if (topic === "wa" ? !/On record|saved work authorization/i.test(reply) : !rec.must.some((v) => reply.includes(v))) return `on record but not read back: ${where}`;
  } else if (!NOT_ON_RECORD.test(reply) || !ASKS.test(reply)) return `not on record, but not said so and asked: ${where}`;
  return null;
}

const r = rng(130142);
const PROFILES = Array.from({ length: 110 }, () => genProfile(r));
const CASES: { p: Profile; topic: Topic; q: string }[] = [];
for (const p of PROFILES) for (const [topic, q] of QUESTIONS) CASES.push({ p, topic, q: vary(r, q) });

Deno.test(`${CASES.length} generated profile x question turns answer only from confirmed facts, or say it is not on record and ask`, () => {
  const fails: string[] = [];
  for (const c of CASES) { const f = check(c.p, c.topic, c.q); if (f) fails.push(f); }
  if (fails.length) throw new Error(`${fails.length} of ${CASES.length} turns failed:\n${fails.slice(0, 25).join("\n")}`);
});

Deno.test("the generator covers every record shape (drafts, confirmed resumes, saved answers, stated facts, empty)", () => {
  assertNode.ok(PROFILES.some((p) => p.resume === "draft") && PROFILES.some((p) => p.resume === "confirmed") && PROFILES.some((p) => p.resume === "none"));
  assertNode.ok(PROFILES.some((p) => p.stated.length === 0 && !p.workAuth && p.needsSponsorship === null && !p.location && !p.roles.length));
  for (const kind of ["school", "geography", "target_role", "sponsorship", "citizenship"]) assertNode.ok(PROFILES.some((p) => statedOf(p, kind).length), kind);
  assertNode.ok(PROFILES.some((p) => p.noProfile) && PROFILES.some((p) => p.savedGpa) && PROFILES.some((p) => p.workAuth) && PROFILES.some((p) => p.needsSponsorship === false));
});
