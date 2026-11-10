// New-person onboarding and resume confirmation, ROUND 4 (architect, 2026-11-05; rounds 1-3: scenarios-onboarding.test.ts,
// -r2, -r3). Owner rules (D-007): a fact about the person only from what they confirmed; never another person's data; no
// application without a confirmed resume; the person is never told "confirmed" unless it is, and is told what happened to
// their file. ~10,000 generated scenarios (scenarios/onboarding-r4-generator.ts, seeded) on the real pure code, a
// deterministic clock and no model. New categories only:
//   disown    the person says the resume shown is not theirs ("that's my friend's resume", "oops wrong file", "not mine"):
//             its entries leave the profile, the ask ends, and NO later yes (plain or "yes, that's my resume") confirms
//             them; a resume they confirmed earlier is untouched; said after the yes, nothing changes by itself and they
//             are told how to remove it. Controls that only look like one ("that's my resume, not my friend's", "is that
//             not my resume?", "that's not right", a correction) never discard anything
//   pair      two different resumes sent close together, then a yes (plain, naming the resume, or "yes, the first one"):
//             what is confirmed is exactly the resume shown last, never a mix; a yes for the older one confirms nothing;
//             a confirmed resume stays the one read back until the newer one is confirmed, then only the newer one
//   partial   a yes carrying a doubt ("yes but my GPA is wrong", "all good except #2", "yes for now") confirms nothing
//             and the drafts are unchanged; "yes, but my GPA is 3.9" changes exactly that GPA in the draft, confirms
//             nothing, and the next "yes, that's my resume" confirms it as corrected
//   told      whole sessions mixing both resumes, yeses for either, partial yeses, disowns, a pause and its lift, a stop,
//             read-backs, thanks and other asks; after EVERY turn: a reply opens "Confirmed" exactly when entries were
//             confirmed in that turn; the confirmed and the draft entries are each exactly one resume's, never a mix;
//             only a yes confirms; while a resume waits for the person's word no reply says nothing is waiting or asks
//             them to send a resume; a GPA read back is on a confirmed entry
//   files     resume files with hostile or odd names (an instruction, a path, a line break, a hidden dot, 250+ characters,
//             another type's extension, none) and long resumes (more text than the chat reads at once), through
//             channel_resume_upload.ts ingestResumeFile: a kept file's name passes the upload table's checks, has no path
//             or control character, carries the extension and type of its bytes; a cut file is said to be cut, with where
//             reading stopped, and every entry read is in the file in order; a refused file keeps nothing
//   notes     a cut file's note before an answer in parts: every part still fits the outbox (4,000 characters)
//   replace   a confirmed resume replaced while applications made with it are prepared, approved or being sent:
//             career_resume_replace.ts counts exactly what the database's stop (career_resume_stop_unbound) stops, and
//             the reply says only that (never a count of 0; the one being sent said as not stoppable)
// The end-to-end sample through the real Telegram webhook on real Postgres is flow-scenarios-onboarding-r4.test.ts.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { fileCutNote, ingestResumeFile, KIND_MIME, storedFilename } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { notesFirst } from "../../supabase/functions/_shared/channel_inbound.ts";
import { replacedResumeLines, replacedResumeStops } from "../../supabase/functions/_shared/career_resume_replace.ts";
import { DOCX, docxBytes, PDF, pdfBytes } from "./scenarios/onboarding-r2-generator.ts";
import { entriesOf, framed, linesOf, person, type Person, sig } from "./scenarios/onboarding-r3-generator.ts";
import { disownControl, disownPhrase, gpaYes, journey, nameCase, NOW, OLDER_YES, OWN_YES, partialYes, PLAIN_YES, rng } from "./scenarios/onboarding-r4-generator.ts";

// deno-lint-ignore no-explicit-any
const host = (CareerHost as any).createCareerHost(core);
const SEED = 20261105;
type Report = { name: string; total: number; fails: Map<string, string[]> };
const report = (name: string): Report => ({ name, total: 0, fails: new Map() });
function check(rep: Report, ok: boolean, kind: string, detail: () => string) {
  if (ok) return;
  if (!rep.fails.has(kind)) rep.fails.set(kind, []);
  rep.fails.get(kind)!.push(detail());
}
function done(rep: Report) {
  const n = [...rep.fails.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[onboarding-r4] ${rep.name}: ${rep.total} scenarios, ${n} failures`];
  for (const [k, xs] of rep.fails) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x.slice(0, 900)}`); }
  console.log(lines.join("\n"));
  assertNode.equal(n, 0, lines.join("\n"));
}
// deno-lint-ignore no-explicit-any
const titleOf = (f: any) => String(f.kind === "skill" ? (f.name ?? f.title) : f.title);
// deno-lint-ignore no-explicit-any
const factSig = (fs: any[]) => fs.map((f) => `${f.kind}|${titleOf(f)}`).sort();
const flat = (s: string) => String(s).replace(/\s+/g, " ");
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
// deno-lint-ignore no-explicit-any
type Turn = { out: any; ctx: any; conf: any[]; drafts: any[]; waiting: boolean };
function conversation(threadId: string) {
  let snap: unknown = null, t = NOW;
  return {
    say(text: string): Turn {
      // deno-lint-ignore no-explicit-any
      const ctx: any = host.createTurnCtx({ userId: "TEST-onb-r4", threadId, now: (t += 60_000), accountPersistence: true, snapshot: snap, account: { epoch: 0, version: 0, paused: false }, postings: [] });
      const out = host.runTurn(text, ctx);
      snap = host.extractSnapshot(ctx);
      // deno-lint-ignore no-explicit-any
      const facts = ((ctx.profile?.facts ?? []) as any[]).filter((f) => f && f.source === "resume-ingest");
      const drafts = facts.filter((f) => f.needs_confirmation === true);
      // deno-lint-ignore no-explicit-any
      const mir = (snap as any)?.stores?.threadMirror ?? (snap as any)?.threadMirror ?? null;
      return { out, ctx, conf: facts.filter((f) => f.needs_confirmation === false), drafts, waiting: drafts.length > 0 && !!(mir?.resumeIngest ?? true) };
    },
  };
}
// Two people whose resumes share no entry (so "exactly one resume's entries" is decidable).
function twoPeople(r: ReturnType<typeof rng>): [Person, Person] {
  const a = person(r);
  for (let k = 0; k < 40; k++) {
    const b = person(r);
    const sa = new Set(sig(entriesOf(a)));
    if (!sig(entriesOf(b)).some((x) => sa.has(x))) return [a, b];
  }
  // Fallback: the second person without skills the first has.
  const b = person(r);
  b.skills = b.skills.filter((s) => !a.skills.includes(s));
  if (!b.skills.length) b.skills = ["Rust"];
  return [a, b];
}
const CONFIRMED_HEAD = /^\s*Confirmed\b/;
// A fact about the person recorded from a reply word ("yes", "mostly", "though"): never something they stated.
const REPLY_WORD = /^(?:wrong|incorrect|yes|yeah|yep|yup|ok|okay|sure|mostly|kinda|almost|correct|all good|looks good|though|but|except|for now|yes though|yes but)$/i;
// deno-lint-ignore no-explicit-any
const statedJunk = (ctx: any) => ((ctx.statedFacts?.facts ?? []) as any[]).some((f) => f && typeof f.value === "string" && REPLY_WORD.test(f.value.trim()));

// ------------------------------------------------------------------------------------------------ disown
const DISOWN = Array.from({ length: 1500 }, (_, i) => i);
Deno.test(`disown: ${DISOWN.length} people say the resume shown is not theirs (or say something that only looks like it): its entries leave the profile, no later yes confirms them, a confirmed resume is untouched`, () => {
  const rep = report("disown");
  const fams: Record<string, number> = {};
  for (const i of DISOWN) {
    rep.total++;
    const r = rng(SEED + i);
    const [mine, other] = twoPeople(r);
    const c = conversation(`d-${i}`);
    const k = i % 10; // 0-1 confirmed own resume first; 2 disown after the yes; 3-4 controls; else a first resume disowned
    let base: string[] = [];
    if (k <= 1) { c.say(framed(linesOf(mine))); base = factSig(c.say("yes, that's my resume").conf); }
    if (k === 2) {
      c.say(framed(linesOf(other)));
      const y = c.say("yes");
      const before = factSig(y.conf);
      const d = disownPhrase(r);
      fams[`after-yes/${d.family}`] = (fams[`after-yes/${d.family}`] ?? 0) + 1;
      const t = c.say(d.text);
      const name = () => `${JSON.stringify(d.text)} after the yes -> ${t.out.intent}/${t.out.resultStatus}: ${flat(t.out.reply).slice(0, 300)}`;
      check(rep, same(factSig(t.conf), before) && t.drafts.length === 0, "a disown after the yes changed the record by itself", name);
      // With nothing waiting, only a sentence naming the resume (or whose it is) is about it; "not me", "wrong one" answer something else.
      const aboutIt = /resume|cv|file|document|pdf|friend|sister|brother|roommate|mom|dad|cousin|coworker|boyfriend|girlfriend|classmate|husband|wife|partner|colleague|some(?:one|body) else/i.test(d.text);
      if (aboutIt) check(rep, t.out.intent === "career_resume_disowned" && /still the one on file/.test(t.out.reply) && /delete my resume/.test(t.out.reply) && !CONFIRMED_HEAD.test(t.out.reply),
        "a disown after the yes was not told it is still on file and how to remove it", name);
      else check(rep, t.out.intent !== "career_resume_disowned", "a bare \"not me\" / \"wrong one\" with nothing waiting was read as about the resume", name);
      continue;
    }
    const up = c.say(framed(linesOf(other)));
    check(rep, up.drafts.length > 0 && same(factSig(up.conf), base), "the resume was not read for a yes", () => flat(up.out.reply).slice(0, 200));
    if (k === 3 || k === 4) {
      const ctl = disownControl(r);
      fams[`control/${ctl.family}`] = (fams[`control/${ctl.family}`] ?? 0) + 1;
      const t = c.say(ctl.text);
      const name = () => `${JSON.stringify(ctl.text)} -> ${t.out.intent}/${t.out.resultStatus}: ${flat(t.out.reply).slice(0, 300)}`;
      check(rep, t.out.intent !== "career_resume_disowned", "a control was read as a disown", name);
      if (ctl.kind !== "correction") check(rep, same(factSig([...t.drafts, ...t.conf.filter((f) => !base.includes(`${f.kind}|${titleOf(f)}`))]), sig(entriesOf(other))), "a control lost the resume's entries", name);
      continue;
    }
    const d = disownPhrase(r);
    fams[d.family] = (fams[d.family] ?? 0) + 1;
    const t = c.say(d.text);
    const name = () => `${JSON.stringify(d.text)} -> ${t.out.intent}/${t.out.resultStatus}: ${flat(t.out.reply).slice(0, 300)}`;
    check(rep, t.out.intent === "career_resume_disowned" && t.drafts.length === 0, "the disowned resume's entries are still drafts", name);
    check(rep, same(factSig(t.conf), base), "a disown changed what was confirmed", name);
    check(rep, /nothing from it is on your record/.test(t.out.reply) && !CONFIRMED_HEAD.test(t.out.reply), "the person was not told nothing from it is kept", name);
    if (base.length) check(rep, /confirmed earlier is unchanged/.test(t.out.reply), "the person was not told their confirmed resume stands", name);
    // No yes after it confirms the disowned resume: plain, naming the resume, or after another turn.
    const follow = [r.pick(PLAIN_YES), r.pick(OWN_YES)];
    if (r.next() < 0.3) follow.unshift(r.pick(["thx", "ok", "what can you do?"]));
    for (const f of follow) {
      const y = c.say(f);
      check(rep, same(factSig(y.conf), base) && y.drafts.length === 0, "a yes after the disown confirmed the disowned resume", () => `${name()}\n      then ${JSON.stringify(f)} -> ${y.out.intent}: ${flat(y.out.reply).slice(0, 200)}`);
      check(rep, !CONFIRMED_HEAD.test(y.out.reply), "a yes after the disown was told Confirmed", () => `${name()}\n      then ${JSON.stringify(f)} -> ${flat(y.out.reply).slice(0, 200)}`);
    }
    // Read-backs never carry the disowned resume.
    const rb = c.say("where have I worked?").out.reply;
    for (const j of other.jobs) check(rep, !rb.includes(`${j.title}, ${j.company}, ${j.dates}`), "a read-back carries the disowned resume", () => `${name()}\n      ${flat(rb).slice(0, 200)}`);
  }
  console.log(`[onboarding-r4] disown families: ${JSON.stringify(fams)}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ pair
const PAIR = Array.from({ length: 1200 }, (_, i) => i);
Deno.test(`pair: ${PAIR.length} people send two different resumes close together, then a yes (plain, naming it, or for the older one): exactly the resume shown last is confirmed, never a mix; a yes for the older one confirms nothing`, () => {
  const rep = report("pair");
  for (const i of PAIR) {
    rep.total++;
    const r = rng(SEED + 10_000 + i);
    const [a, b] = twoPeople(r);
    const c = conversation(`p-${i}`);
    const k = i % 6;
    if (k === 5) {
      // A confirmed; B shown; read-backs are A's until B's yes; then only B's.
      c.say(framed(linesOf(a)));
      c.say("yes, that's my resume");
      const up = c.say(framed(linesOf(b)));
      check(rep, /stays in use until you confirm this one/.test(up.out.reply) && same(factSig(up.conf), sig(entriesOf(a))), "a newer resume moved what is confirmed before its yes", () => flat(up.out.reply).slice(0, 300));
      const rb = c.say("where have I worked?").out.reply;
      for (const j of b.jobs) check(rep, !rb.includes(`${j.title}, ${j.company}, ${j.dates}`), "the unconfirmed newer resume is read back", () => flat(rb).slice(0, 300));
      const y = c.say(r.pick(OWN_YES));
      check(rep, same(factSig(y.conf), sig(entriesOf(b))) && y.drafts.length === 0, "the newer resume's yes did not leave exactly it", () => `${JSON.stringify(factSig(y.conf))}`);
      check(rep, CONFIRMED_HEAD.test(y.out.reply) && /replaces your earlier resume/.test(y.out.reply) && !/nothing from that one is used/.test(y.out.reply), "the replacement was not told plainly", () => flat(y.out.reply).slice(0, 300));
      continue;
    }
    c.say(framed(linesOf(a)));
    const order: Person[] = [a, b];
    const up = c.say(framed(linesOf(b)));
    check(rep, /replaces the resume you pasted before it/.test(up.out.reply), "the second resume did not say it replaces the first", () => flat(up.out.reply).slice(0, 300));
    if (k === 4) { c.say(framed(linesOf(a))); order.push(a); } // the first one sent again: it is the one shown last
    const last = order[order.length - 1];
    if (k === 3) {
      const o = r.pick(OLDER_YES);
      const t = c.say(o);
      check(rep, t.conf.length === 0 && !CONFIRMED_HEAD.test(t.out.reply), "a yes for the older resume confirmed something", () => `${JSON.stringify(o)} -> ${t.out.intent}: ${flat(t.out.reply).slice(0, 200)}`);
      check(rep, same(factSig(t.drafts), sig(entriesOf(last))) || t.drafts.length === 0, "a yes for the older resume brought it back", () => JSON.stringify(factSig(t.drafts)));
    }
    const yes = k % 2 ? r.pick(OWN_YES) : r.pick(PLAIN_YES);
    const y = c.say(yes);
    const name = () => `${k}: ${JSON.stringify(yes)} -> ${y.out.intent}: ${flat(y.out.reply).slice(0, 200)}`;
    if (k === 3 && y.conf.length === 0) {
      // After the older-one reply the ask is answered again; a plain yes may need to name the resume.
      check(rep, !CONFIRMED_HEAD.test(y.out.reply), "told Confirmed with nothing confirmed", name);
      continue;
    }
    check(rep, same(factSig(y.conf), sig(entriesOf(last))) && y.drafts.length === 0, "what was confirmed is not exactly the resume shown last", () => `${name()}\n      got ${JSON.stringify(factSig(y.conf))}\n      want ${JSON.stringify(sig(entriesOf(last)))}`);
    check(rep, CONFIRMED_HEAD.test(y.out.reply), "a confirmation was not told", name);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ partial
const PARTIAL = Array.from({ length: 2000 }, (_, i) => i);
const GPA = /\bGPA:?\s*([0-4]\.\d{1,2})\b|\b([0-4]\.\d{1,2})\s*GPA\b/i;
Deno.test(`partial: ${PARTIAL.length} yeses carrying a doubt or a GPA fix: nothing confirmed; a doubt leaves the drafts as shown; "yes, but my GPA is X" changes exactly that GPA, and the next yes confirms it as corrected`, () => {
  const rep = report("partial");
  for (const i of PARTIAL) {
    rep.total++;
    const r = rng(SEED + 20_000 + i);
    const p = person(r, { gpa: i % 3 !== 2 });
    const c = conversation(`q-${i}`);
    const up = c.say(framed(linesOf(p)));
    const shown = factSig(up.drafts);
    if (i % 4 === 3) {
      const to = r.pick(["3.95", "3.31", "3.07", "2.88"]);
      const said = gpaYes(r, to).text;
      const t = c.say(said);
      const name = () => `${JSON.stringify(said)} on ${JSON.stringify(p.edus[0].line)} -> ${t.out.intent}/${t.out.resultStatus}: ${flat(t.out.reply).slice(0, 300)}`;
      check(rep, t.conf.length === 0 && !CONFIRMED_HEAD.test(t.out.reply), "a yes with a GPA fix confirmed something", name);
      const m = GPA.exec(p.edus[0].line);
      const from = m ? (m[1] || m[2]) : null;
      const want = from && from !== to ? shown.map((x) => x === `education|${p.edus[0].line}` ? `education|${p.edus[0].line.replace(from, to)}` : x).sort() : shown;
      check(rep, same(factSig(t.drafts), want), "the drafts are not the shown ones with exactly that GPA changed", () => `${name()}\n      got  ${JSON.stringify(factSig(t.drafts))}\n      want ${JSON.stringify(want)}`);
      const y = c.say("yes, that's my resume");
      check(rep, same(factSig(y.conf), want), "the yes did not confirm the entries as corrected", () => `${name()}\n      got ${JSON.stringify(factSig(y.conf))}`);
      continue;
    }
    const said = partialYes(r).text;
    const t = c.say(said);
    const name = () => `${JSON.stringify(said)} -> ${t.out.intent}/${t.out.resultStatus}: ${flat(t.out.reply).slice(0, 300)}`;
    check(rep, t.conf.length === 0, "a partial yes confirmed something", name);
    check(rep, !CONFIRMED_HEAD.test(t.out.reply), "a partial yes was told Confirmed", name);
    check(rep, same(factSig(t.drafts), shown), "a partial yes changed the drafts", () => `${name()}\n      got ${JSON.stringify(factSig(t.drafts))}`);
    check(rep, !/nothing waiting on your answer|Want to start by sending me your resume/i.test(t.out.reply), "a partial yes was told nothing is waiting", name);
    // "yes though my major isn't right" stated no major (it recorded "you study yes").
    check(rep, !statedJunk(t.ctx), "a partial yes was recorded as a fact about the person", () => `${name()}\n      ${JSON.stringify(t.ctx.statedFacts?.facts ?? [])}`);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ told
const TOLD = Array.from({ length: 1000 }, (_, i) => i);
Deno.test(`told: ${TOLD.length} sessions mixing two resumes, yeses, partial yeses, disowns, a pause, a stop, read-backs and other asks: after every turn the reply says Confirmed exactly when it is, entries are one resume's, only a yes confirms, a waiting resume is never called nothing`, () => {
  const rep = report("told");
  let turns = 0;
  for (const i of TOLD) {
    rep.total++;
    const r = rng(SEED + 30_000 + i);
    const [a, b] = twoPeople(r);
    const sets = [sig(entriesOf(a)), sig(entriesOf(b))];
    const gpas = new Set([a, b].flatMap((p) => p.edus.map((e) => { const m = GPA.exec(e.line); return m ? (m[1] || m[2]) : ""; })).filter(Boolean));
    const j = journey(r, i);
    const c = conversation(`t-${i}`);
    let prevConf: string[] = [], log: string[] = [];
    for (const s of j.steps) {
      turns++;
      const text = s.t === "paste" ? framed(linesOf(s.who === "A" ? a : b)) : s.t === "lift" ? "resume career work" : s.text;
      const t = c.say(text);
      log.push(`${JSON.stringify(text.slice(0, 40))} -> ${t.out.intent}/${t.out.resultStatus}: ${flat(t.out.reply).slice(0, 120)}`);
      const name = () => `journey ${i}\n      ${log.join("\n      ")}`;
      const conf = factSig(t.conf), drafts = factSig(t.drafts);
      const newly = conf.filter((x) => !prevConf.includes(x));
      const confirmedNow = newly.length > 0 && t.out.intent === "career_resume_ingest" && t.out.resultStatus === "completed";
      check(rep, CONFIRMED_HEAD.test(t.out.reply) === confirmedNow, confirmedNow ? "entries were confirmed and the reply does not say so" : "the reply says Confirmed and nothing was confirmed", name);
      check(rep, !conf.length || sets.some((x) => same(x, conf)), "the confirmed entries are not exactly one resume's", () => `${name()}\n      ${JSON.stringify(conf)}`);
      check(rep, !drafts.length || sets.some((x) => same(x, drafts)), "the draft entries are not exactly one resume's", () => `${name()}\n      ${JSON.stringify(drafts)}`);
      if (newly.length) check(rep, s.t === "yes", "something was confirmed by a message that is not a yes", name);
      if (s.t === "disown") check(rep, drafts.length === 0, "a disown left drafts", name);
      check(rep, !statedJunk(t.ctx), "a reply word was recorded as a fact about the person", () => `${name()}\n      ${JSON.stringify(t.ctx.statedFacts?.facts ?? [])}`);
      if (s.t === "partial" || s.t === "older" || s.t === "pause" || s.t === "other" || s.t === "lift") check(rep, !newly.length, `a ${s.t} step confirmed something`, name);
      if (drafts.length && t.out.intent !== "career_resume_disowned") check(rep, !/nothing waiting on your answer|Want to start by sending me your resume/i.test(t.out.reply), "a resume waiting for a yes was called nothing waiting", name);
      if (s.t === "other" && /GPA/.test(text)) for (const g of String(t.out.reply).match(/\b[0-4]\.\d{1,2}\b/g) ?? []) check(rep, gpas.has(g) && t.conf.some((f) => String(f.title).includes(g)), "a GPA read back that no confirmed entry carries", name);
      prevConf = conf;
    }
  }
  console.log(`[onboarding-r4] told: ${turns} turns`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ files
const stack = (lines: string[]) => lines.filter((l) => l !== "").map((t, i) => ({ text: t, x: 72, y: 740 - i * 14 }));
const xmlEsc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const docxOf = (lines: string[]) => docxBytes(lines.filter(Boolean).map((t) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`).join(""));
// The upload table's own checks on a kept file (20261026210016 career_resume_uploads; 20261026120018 the record's name).
const nameOk = (n: string) => n.length >= 1 && n.length <= 200 && !/[\/\\]/.test(n) && !/^\./.test(n) && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(n);
const FILES = Array.from({ length: 2600 }, (_, i) => i);
Deno.test(`files: ${FILES.length} resume files with hostile or odd names and long resumes: a kept name passes the table's checks with its bytes' extension and type, a cut file is said cut with where reading stopped, entries read are in the file in order`, async () => {
  const rep = report("files");
  const fams: Record<string, number> = {};
  for (const i of FILES) {
    rep.total++;
    const r = rng(SEED + 40_000 + i);
    const p = person(r);
    const nc = nameCase(r);
    const long = i % 4 === 0;
    const lines = linesOf(p);
    if (long) {
      const at = lines.indexOf("EXPERIENCE") + 1, n = r.int(30, 110);
      for (let k = 0; k < n; k++) lines.splice(at + k * 2, 0, `Analyst ${k + 1}, Fixture Company ${k + 1} (TEST), Jan 2020 - Feb 2020`, `- Did task number ${k + 1} for the team, end to end`);
    }
    fams[`${nc.family}${long ? "+long" : ""}`] = (fams[`${nc.family}${long ? "+long" : ""}`] ?? 0) + 1;
    const bytes = nc.bytesKind === "pdf" ? pdfBytes(stack(lines)) : docxOf(lines);
    // deno-lint-ignore no-explicit-any
    const stored: any[] = [];
    const res = await ingestResumeFile({ userId: "TEST-onb-r4", channel: "telegram", doc: { fileId: "F", uniqueId: `U${i}`, name: nc.name, mime: nc.mime, size: bytes.length },
      fetchFile: async () => ({ ok: true, bytes }), record: async (row) => { stored.push(row); return "id"; } });
    const name = () => `${nc.family}${long ? "+long" : ""} ${JSON.stringify(nc.name).slice(0, 80)} (${nc.bytesKind}, ${JSON.stringify(nc.mime)}) -> ${JSON.stringify(res).slice(0, 300)}`;
    if (!res.ok) {
      check(rep, stored.length === 0, "a refused file was kept", name);
      // A docx's bytes under a name and type that say neither, or a PDF/Word file read whole: the only refusals expected.
      check(rep, res.why === "kind" && nc.bytesKind === "docx", "a readable resume file was refused", name);
      continue;
    }
    const row = stored[0];
    check(rep, stored.length === 1 && nameOk(row.filename), "the kept file's name fails the upload table's checks (or has a path or a control character)", () => `${name()}\n      ${JSON.stringify(row?.filename)}`);
    check(rep, row.filename.endsWith(nc.bytesKind === "pdf" ? ".pdf" : ".docx") && row.mime === KIND_MIME[nc.bytesKind], "the kept file's name or type is not what its bytes are", () => `${name()}\n      ${JSON.stringify(row.filename)} ${row.mime}`);
    check(rep, row.filename === storedFilename(nc.name, nc.bytesKind), "the kept name is not the sanitized name", name);
    const body = res.message.replace(/^here is my resume:\n/, "");
    const fileText = lines.filter(Boolean).join("\n");
    // Every line the chat reads is the file's, in the file's order (the message is the file's text from its start).
    const read = body.split("\n").filter(Boolean);
    let at = 0, inOrder = true;
    for (const l of read) { const k = fileText.indexOf(l, at); if (k < 0) { inOrder = false; break; } at = k + l.length; }
    check(rep, inOrder && res.message.length <= 4000, "the chat reads lines that are not the file's, in order", () => `${name()}\n      ${body.slice(0, 200)}`);
    const cut = "here is my resume:\n".length + fileText.length > 4000;
    check(rep, !!res.note === cut, cut ? "a file cut to what the chat reads was not said to be cut" : "a whole file was said to be cut", name);
    if (res.note) {
      const lastRead = read[read.length - 1];
      check(rep, res.note.includes(lastRead.slice(-40)) && /4,000 characters/.test(res.note) && /Nothing after that is on your record/.test(res.note), "the cut note does not say where reading stopped", () => `${name()}\n      ${res.note}`);
    }
  }
  console.log(`[onboarding-r4] files families: ${JSON.stringify(fams)}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ replace
const REPLACE = Array.from({ length: 2400 }, (_, i) => i);
Deno.test(`replace: ${REPLACE.length} confirmed resumes replaced while applications made with them are prepared, approved or being sent: what the reply says is exactly what the database's stop stops`, async () => {
  const rep = report("replace");
  const hex = (r: ReturnType<typeof rng>) => Array.from({ length: 64 }, () => "0123456789abcdef"[r.int(0, 15)]).join("");
  for (const i of REPLACE) {
    rep.total++;
    const r = rng(SEED + 50_000 + i);
    const old = hex(r), next = hex(r), other = hex(r);
    const kind: "file" | "paste" = r.next() < 0.75 ? "file" : "paste";
    const record = i % 13 === 0 ? null : { state: i % 17 === 0 ? "deleted" : "confirmed", sha256: i % 11 === 0 ? next : old };
    const carry = () => r.pick([old, old, other, next, ""]);
    const payload = (sha: string) => (r.next() < 0.8 ? { resume_sha256: sha } : { attachment: { sha256: sha } });
    const jobs = Array.from({ length: r.int(0, 5) }, (_, k) => ({ state: r.pick(["queued", "queued", "driving"]), attempts: r.pick([0, 0, 1]), company: `Company ${k} (TEST)`, payload: payload(carry()) }));
    const prepared = Array.from({ length: r.int(0, 4) }, () => ({ state: r.pick(["ready", "shown"]), payload: payload(carry()) }));
    // deno-lint-ignore no-explicit-any
    const admin: any = { from: (table: string) => {
      // deno-lint-ignore no-explicit-any
      const q: any = { select: () => q, eq: () => q, in: async () => ({ data: table === "career_apply_jobs" ? jobs : prepared, error: null }), limit: async () => ({ data: record ? [record] : [], error: null }) };
      return q;
    } };
    const got = await replacedResumeStops(admin, "TEST-onb-r4", { sha256: next, kind });
    // The model: career_resume_stop_unbound with p_before = the new confirmation (every row here was made before it).
    const keep = kind === "file" ? next : null;
    const sha = (p: { resume_sha256?: string; attachment?: { sha256: string } }) => (p.resume_sha256 || p.attachment?.sha256 || null);
    const staleJobs = jobs.filter((j) => sha(j.payload) !== keep);
    const want = !record || record.state !== "confirmed" || record.sha256 === next ? null : {
      cancelled: staleJobs.filter((j) => j.state === "queued" && j.attempts === 0).length,
      discarded: prepared.filter((p) => sha(p.payload) !== keep).length,
      being_sent: staleJobs.filter((j) => j.state === "driving").length,
    };
    const wantNull = !want || want.cancelled + want.discarded + want.being_sent === 0;
    const name = () => `record ${JSON.stringify(record)} kind ${kind} jobs ${JSON.stringify(jobs)} prepared ${JSON.stringify(prepared)} -> ${JSON.stringify(got)}`;
    check(rep, wantNull ? got === null : !!got && got.cancelled === want!.cancelled && got.discarded === want!.discarded && got.being_sent === want!.being_sent, "the counts are not what the database's stop stops", name);
    if (!got) continue;
    const lines = replacedResumeLines(got).join(" ");
    check(rep, !/(?:^|\. )0 /.test(lines), "a line says a count of 0", () => lines);
    check(rep, /being sent right now/.test(lines) === got.being_sent > 0 && /can't be stopped/.test(lines) === got.being_sent > 0, "an application being sent is not said as not stoppable (or said when there is none)", () => `${name()}\n      ${lines}`);
    check(rep, /cancelled/.test(lines) === got.cancelled > 0 && /discarded/.test(lines) === got.discarded > 0, "a line for something that did not happen (or none for what did)", () => lines);
    for (const co of got.companies) check(rep, lines.includes(co), "a cancelled company is not named", () => lines);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ notes
// The note a cut file gets goes before the answer (channel_inbound.ts notesFirst); a first part already near the outbox's
// 4,000 characters made a part the outbox refuses, and the person got "I couldn't answer that just now".
const NOTES = Array.from({ length: 700 }, (_, i) => i);
Deno.test(`notes: ${NOTES.length} answers in parts with a note (a file read only in part, a long message cut) before them: every part fits the outbox, in order, nothing lost`, () => {
  const rep = report("notes");
  for (const i of NOTES) {
    rep.total++;
    const r = rng(SEED + 60_000 + i);
    const para = () => Array.from({ length: r.int(3, 30) }, () => r.pick(["Data", "Analyst", "Intern", "—", "Brightline", "(TEST)", "built", "a", "dashboard", "résumé"])).join(" ");
    const head = Array.from({ length: r.int(1, 80) }, para).join("\n\n").slice(0, r.int(100, 4000)).trim() || "Head";
    const parts = [head, ...Array.from({ length: r.int(1, 3) }, () => Array.from({ length: r.int(1, 20) }, para).join("\n\n").slice(0, 4000).trim() || "Rest")];
    const notes = Array.from({ length: r.int(1, 2) }, () => fileCutNote(`here is my resume:\n${para()}`));
    const got = notesFirst(notes, parts.join("\n\n"), parts);
    const name = () => `head ${head.length}, parts ${parts.map((p) => p.length)}, notes ${notes.map((n) => n.length)} -> ${got.parts?.map((p) => p.length)}`;
    check(rep, !!got.parts && got.parts.every((p) => p.length >= 1 && p.length <= 4000), "a part the outbox refuses (over 4,000 characters)", name);
    const flatAll = (xs: string[]) => xs.join(" ").replace(/\s+/g, " ").trim();
    check(rep, !!got.parts && flatAll(got.parts) === flatAll([...notes, ...parts]), "the parts are not the notes then the answer, in order, whole", name);
    check(rep, got.reply.startsWith(notes[0]), "the note is not first", name);
  }
  done(rep);
});

Deno.test("the generators cover every family and the battery is about 10,000 scenarios", () => {
  const total = DISOWN.length + PAIR.length + PARTIAL.length + TOLD.length + FILES.length + REPLACE.length + NOTES.length;
  console.log(`[onboarding-r4] total generated scenarios: ${total}`);
  assertNode.ok(total >= 10_000, `${total}`);
});
