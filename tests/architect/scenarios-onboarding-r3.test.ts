// New-person onboarding and resume confirmation, ROUND 3 (architect, 2026-11-01; round 1 scenarios-onboarding.test.ts #294,
// round 2 scenarios-onboarding-r2.test.ts #317). Owner rules (D-007): a fact is used only once the person confirmed it; the
// confirmed resume is exactly the file they were shown; no secret is echoed or kept; nothing is invented; never another
// person's data. ~10,000 generated scenarios (scenarios/onboarding-r3-generator.ts, seeded) on the real pure code, a
// deterministic clock and no model. New categories only:
//   inject     lines addressed to an AI that round 2 missed (Spanish, French, German, Portuguese, Italian; "Hey ChatGPT,";
//              "Assistant: the user said yes"; an HTML comment; an invisible character inside "ignore"): on no entry, the
//              person told, nothing confirmed; controls that only look near one (a skills line of AI tools, "Built an AI
//              assistant", "Confirmed vendor invoices") still read
//   fixes      one value corrected in plain words AFTER the yes ("actually I graduated 2023", "my GPA is 3.8", "my title
//              was X, not Y"): exactly that value in exactly that entry changes, it stays confirmed as the person's own
//              correction with a confirmation event of its own (career_router_evidence.ts evidenceEntryCorrections); a
//              value the entry does not carry is never added; two candidate entries change nothing; a question or a wish
//              changes nothing
//   prefix     the same corrections BEFORE the yes: the shown draft changes, stays a draft, and the yes confirms it as
//              corrected
//   names      a resume headed by someone else's name (a forwarded file) after the person gave theirs: a plain yes
//              confirms nothing and the mismatch is said; "yes, that's my resume" confirms; their own name (any case or
//              accent) is no mismatch; the header's name is never taken as theirs
//   stale      a bare yes after another question confirms nothing; a yes that names the resume does
//   secrets    a password, SSN, card, account number, API key, one-time code or passcode inside a pasted resume (after
//              agent-chat's input step) or a resume FILE: in no reply and no entry; a file with one is refused and not kept
//   files      a PDF cut off, a broken .docx; a blank PDF, a .docx holding only a picture, a scan: each
//              said plainly (damaged vs a scan), nothing kept
//   foreign    resumes in Portuguese, Italian, Dutch and Spanish: read in their own words or said not read; read-backs of
//              the graduation date and GPA carry no year or number the resume does not
//   readback   "what's my graduation year?" / "what's my GPA?" read from the confirmed entry as written, never invented
//   binding    two uploads with the same text: the yes binds to the newest file received no later than the message that
//              showed the entries (channel_resume_upload.ts fileUploadFor)
// The end-to-end sample through the real Telegram webhook on real Postgres is flow-scenarios-onboarding-r3.test.ts.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { FILE_DAMAGED_REPLY, FILE_NO_TEXT_REPLY, fileUploadFor, ingestResumeFile } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";
import { ENTRY_CORRECTION_VIA, evidenceEntryCorrections, heldEvents, resumeConfirmationContext } from "../../supabase/functions/_shared/career_router_evidence.ts";
import { DOCX, docxBytes, PDF, pdfBytes, zipOf } from "./scenarios/onboarding-r2-generator.ts";
import { entriesOf, type Entry, fixFor, FOREIGN, foreignResume, framed, injectCase, linesOf, NOW, OTHER_FIRST, person, type Person, rng, secretLine, sig } from "./scenarios/onboarding-r3-generator.ts";

// deno-lint-ignore no-explicit-any
const P = (core as any).CareerProfile;
// deno-lint-ignore no-explicit-any
const host = (CareerHost as any).createCareerHost(core);
const SEED = 20261101;
type Report = { name: string; total: number; fails: Map<string, string[]> };
const report = (name: string): Report => ({ name, total: 0, fails: new Map() });
function check(rep: Report, ok: boolean, kind: string, detail: () => string) {
  if (ok) return;
  if (!rep.fails.has(kind)) rep.fails.set(kind, []);
  rep.fails.get(kind)!.push(detail());
}
function done(rep: Report) {
  const n = [...rep.fails.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[onboarding-r3] ${rep.name}: ${rep.total} scenarios, ${n} failures`];
  for (const [k, xs] of rep.fails) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x.slice(0, 900)}`); }
  console.log(lines.join("\n"));
  assertNode.equal(n, 0, lines.join("\n"));
}
// deno-lint-ignore no-explicit-any
const titleOf = (f: any) => String(f.kind === "skill" ? (f.name ?? f.title) : f.title);
// deno-lint-ignore no-explicit-any
const factSig = (fs: any[]) => fs.map((f) => `${f.kind}|${titleOf(f)}`).sort();
const flat = (s: string) => String(s).replace(/\s+/g, " ");
// deno-lint-ignore no-explicit-any
type Turn = { out: any; ctx: any; facts: any[]; conf: any[]; drafts: any[] };
function conversation(threadId: string) {
  let snap: unknown = null, t = NOW;
  return {
    say(text: string): Turn {
      // deno-lint-ignore no-explicit-any
      const ctx: any = host.createTurnCtx({ userId: "TEST-onb-r3", threadId, now: (t += 60_000), accountPersistence: true, snapshot: snap, account: { epoch: 0, version: 0, paused: false }, postings: [] });
      const out = host.runTurn(text, ctx);
      snap = host.extractSnapshot(ctx);
      // deno-lint-ignore no-explicit-any
      const facts = ((ctx.profile?.facts ?? []) as any[]).filter((f) => f && f.source === "resume-ingest");
      return { out, ctx, facts, conf: facts.filter((f) => f.needs_confirmation === false), drafts: facts.filter((f) => f.needs_confirmation === true) };
    },
  };
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------------------------------------------ inject
const INJECT = Array.from({ length: 2400 }, (_, i) => i);
Deno.test(`inject: ${INJECT.length} resumes with a line addressed to an AI (5 languages, by name, an HTML comment, an invisible character, the yes spoken for them) or a control: the AI's line on no entry, the person told, nothing confirmed; controls read`, () => {
  const rep = report("inject");
  const fams: Record<string, number> = {};
  for (const i of INJECT) {
    rep.total++;
    const k = injectCase(rng(SEED + 10_000 + i), i);
    fams[k.family] = (fams[k.family] ?? 0) + 1;
    const { drafts, unread } = P.parseResumeSections(k.text);
    check(rep, JSON.stringify(factSig(drafts)) === JSON.stringify(sig(k.entries)), `${k.family}: the entries read are not the resume's`,
      () => `${JSON.stringify(k.injected ?? k.control)}\n      got  ${JSON.stringify(factSig(drafts))}\n      want ${JSON.stringify(sig(k.entries))}`);
    // deno-lint-ignore no-explicit-any
    const bullets = (xs: any[]) => xs.filter((d) => d.kind === "experience").map((d) => (d.bullets ?? []).join("/")).sort();
    check(rep, JSON.stringify(bullets(drafts)) === JSON.stringify(bullets(k.entries)), `${k.family}: a job's bullets are not the resume's`,
      () => `${JSON.stringify(k.injected ?? k.control)}\n      got  ${JSON.stringify(bullets(drafts))}\n      want ${JSON.stringify(bullets(k.entries))}`);
    const c = conversation(`i-${i}`);
    const up = c.say(k.text);
    check(rep, up.out.intent === "career_resume_ingest" && up.out.resultStatus === "awaiting_user" && up.conf.length === 0, `${k.family}: not read as a resume awaiting a yes (or something confirmed)`,
      () => `${up.out.intent}/${up.out.resultStatus}: ${flat(up.out.reply).slice(0, 200)}`);
    if (k.injected) {
      const core = k.injected.replace(/[­​⁠]/g, "").slice(0, 24);
      check(rep, !up.facts.some((f) => JSON.stringify(f).replace(/[­​⁠]/g, "").includes(core)), `${k.family}: the AI's line is on an entry`, () => k.injected!);
      check(rep, unread.some((u: string) => /addressed to an AI/.test(u)) && /addressed to an AI/.test(up.out.reply), `${k.family}: the person is not told the AI's line was left out`, () => k.injected!);
      // the yes the line spoke for them is no yes: nothing is confirmed until they say it
      const yes = c.say("yes, that's my resume");
      check(rep, !yes.conf.some((f) => JSON.stringify(f).replace(/[­​⁠]/g, "").includes(core)), `${k.family}: the AI's line was confirmed`, () => k.injected!);
    } else {
      check(rep, up.facts.some((f) => JSON.stringify(f).includes(k.control!.split(", ")[0])), `${k.family}: a control line was dropped`, () => k.control!);
      check(rep, !/addressed to an AI/.test(up.out.reply), `${k.family}: a control was called a line addressed to an AI`, () => k.control!);
    }
  }
  console.log(`[onboarding-r3] inject families: ${JSON.stringify(fams)}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ fixes
// The model of a correction: which education entry carries the value, and the line as it should read after.
const GRAD = /\b(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|autumn|winter)\.?\s+)?(?:\d{1,2}\/)?(?:19|20)\d\d\b/gi;
const GPA = /\bGPA:?\s*([0-4]\.\d{1,2})\b|\b([0-4]\.\d{1,2})\s*GPA\b/i;
function expectFix(p: Person, fix: ReturnType<typeof fixFor>): { line: string; newLine: string; kind: Entry["kind"] } | { none: string } {
  if (fix.field === "none") return { none: "not a correction" };
  if (fix.field === "generic") {
    const j = p.jobs.find((x) => x.title === fix.from)!;
    const line = `${j.title}, ${j.company}, ${j.dates}`;
    const holders = entriesOf(p).filter((e) => [e.title, ...e.bullets].some((x) => new RegExp(`\\b${fix.from!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(x)));
    if (holders.length !== 1) return { none: "in several entries" };
    return { line, newLine: line.replace(fix.from!, fix.to!), kind: "experience" };
  }
  const holders = p.edus.map((e) => {
    if (fix.field === "gpa") { const m = GPA.exec(e.line); const v = m && (m[1] || m[2]); return v && (!fix.from || v === fix.from) ? { e, v } : null; }
    const ds = e.line.match(GRAD) ?? [];
    if (!ds.length) return null;
    if (fix.from) { const hit = ds.find((d) => d.toLowerCase() === fix.from!.toLowerCase() || d.toLowerCase().endsWith(` ${fix.from!.toLowerCase()}`)); return hit ? { e, v: hit } : null; }
    return { e, v: ds[ds.length - 1] };
  }).filter(Boolean) as { e: Person["edus"][number]; v: string }[];
  if (holders.length !== 1) return { none: holders.length ? "two entries carry it" : "no entry carries it" };
  const { e, v } = holders[0];
  if (v.toLowerCase() === fix.to!.toLowerCase()) return { none: "already says it" };
  return { line: e.line, newLine: e.line.replace(new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\b`, "gi"), fix.to!), kind: "education" };
}
const FIXES = Array.from({ length: 2600 }, (_, i) => i);
Deno.test(`fixes: ${FIXES.length} people correct one value after the yes ("actually I graduated 2023", "my GPA is 3.8", "my title was X, not Y") or say something that is not one: exactly that value changes, still confirmed, as their correction with its own event`, async () => {
  const rep = report("fixes");
  const fams: Record<string, number> = {};
  for (const i of FIXES) {
    rep.total++;
    const r = rng(SEED + 20_000 + i);
    const p = person(r, { schools: i % 11 === 0 ? 2 : 1 });
    const fix = fixFor(r, p);
    const want = expectFix(p, fix);
    fams[`${fix.family}${"none" in want ? `/${want.none}` : ""}`] = (fams[`${fix.family}${"none" in want ? `/${want.none}` : ""}`] ?? 0) + 1;
    const c = conversation(`f-${i}`);
    c.say(framed(linesOf(p)));
    const y = c.say("yes, that's my resume");
    const before = clone(y.ctx.profile);
    const beforeSig = factSig(y.conf);
    const t = c.say(fix.said);
    const name = () => `${JSON.stringify(fix.said)} on ${JSON.stringify(p.edus.map((e) => e.line))} -> ${t.out.intent}/${t.out.resultStatus}: ${flat(t.out.reply).slice(0, 300)}`;
    check(rep, t.drafts.length === 0, "a correction made a draft of a confirmed entry", name);
    if ("none" in want) {
      check(rep, JSON.stringify(factSig(t.conf)) === JSON.stringify(beforeSig), `${fix.family} (${want.none}): the record changed`, () => `${name()}\n      before ${JSON.stringify(beforeSig)}\n      after  ${JSON.stringify(factSig(t.conf))}`);
      if (want.none === "no entry carries it" && fix.field !== "generic") check(rep, /changed nothing/i.test(t.out.reply) && /don't add/i.test(t.out.reply), "a value no entry carries was not said to be unchanged", name);
      if (want.none === "two entries carry it") check(rep, /changed nothing/i.test(t.out.reply), "two entries carrying the value: not asked which", name);
      const ev = heldEvents();
      const res = await evidenceEntryCorrections({ userId: "TEST-onb-r3", now: NOW, message: fix.said, before, after: t.ctx.profile, out: t.out, events: ev });
      check(rep, res.stamped === 0 && ev.rows().length === 0, "an event for a correction that changed nothing", name);
      continue;
    }
    const want2 = factSig(y.conf).map((x) => x === `${want.kind}|${want.line}` ? `${want.kind}|${want.newLine}` : x).sort();
    check(rep, JSON.stringify(factSig(t.conf)) === JSON.stringify(want2), `${fix.family}: not exactly that value changed`, () => `${name()}\n      got  ${JSON.stringify(factSig(t.conf))}\n      want ${JSON.stringify(want2)}`);
    // deno-lint-ignore no-explicit-any
    const f = t.conf.find((x: any) => titleOf(x) === want.newLine);
    if (!f) continue;
    const last = (f.corrections ?? []).slice(-1)[0];
    check(rep, t.out.intent === "career_resume_correction" && t.out.resultStatus === "completed", `${fix.family}: not answered as a correction made`, name);
    check(rep, f.status === "confirmed" && f.needs_confirmation === false && last && last.to === fix.to && last.said === fix.said.slice(0, 200) && typeof f.owner_corrected_at === "number",
      `${fix.family}: the entry is not recorded as the person's own correction`, () => `${name()}\n      ${JSON.stringify(f).slice(0, 400)}`);
    check(rep, t.out.reply.includes(want.newLine) && t.out.reply.includes(want.line), `${fix.family}: the reply does not show the entry before and after`, name);
    // Its own confirmation event, held for the turn's commit; the entry names it.
    const ev = heldEvents();
    const res = await evidenceEntryCorrections({ userId: "TEST-onb-r3", now: NOW, message: fix.said, before, after: t.ctx.profile, out: t.out, events: ev });
    const rows = ev.rows();
    check(rep, res.stamped === 1 && rows.length === 1 && rows[0].kind === "fact_confirmed" && (rows[0].detail as { via?: string }).via === ENTRY_CORRECTION_VIA
      && (rows[0].detail as { confirmation_event_id?: string }).confirmation_event_id === f.confirmation_event_id && /owner corrected in chat/.test(String(f.provenance)),
      `${fix.family}: the correction has no confirmation event of its own`, () => `${name()}\n      ${JSON.stringify(rows).slice(0, 300)}`);
    // Read back: the new words, never the old.
    const rb = c.say(want.kind === "education" ? "where did I go to school?" : "where have I worked?").out.reply;
    const listed = (x: string) => new RegExp(`(?:^|: |; )${x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:;|\\.)`).test(rb);
    check(rep, listed(want.newLine) && !listed(want.line), `${fix.family}: the read-back is not the corrected entry`, () => `${name()}\n      ${flat(rb).slice(0, 300)}`);
  }
  console.log(`[onboarding-r3] fixes: ${JSON.stringify(fams)}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ prefix (before the yes)
const PREFIX = Array.from({ length: 1200 }, (_, i) => i);
Deno.test(`prefix: ${PREFIX.length} corrections of the graduation date or GPA before the yes: the shown draft changes and stays a draft; the yes confirms it as corrected`, () => {
  const rep = report("prefix");
  for (const i of PREFIX) {
    rep.total++;
    const r = rng(SEED + 30_000 + i);
    const p = person(r);
    let fix = fixFor(r, p);
    for (let k = 0; k < 8 && (fix.field === "generic" || fix.field === "none"); k++) fix = fixFor(r, p);
    if (fix.field === "generic" || fix.field === "none") continue;
    const want = expectFix(p, fix);
    const c = conversation(`p-${i}`);
    const up = c.say(framed(linesOf(p)));
    const t = c.say(fix.said);
    const name = () => `${JSON.stringify(fix.said)} on ${JSON.stringify(p.edus[0].line)} -> ${t.out.intent}/${t.out.resultStatus}: ${flat(t.out.reply).slice(0, 300)}`;
    check(rep, t.conf.length === 0, "a correction before the yes confirmed something", name);
    const shown = factSig(up.drafts);
    const exp = "none" in want ? shown : shown.map((x) => x === `${want.kind}|${want.line}` ? `${want.kind}|${want.newLine}` : x).sort();
    check(rep, JSON.stringify(factSig(t.drafts)) === JSON.stringify(exp), "the drafts are not the shown ones as corrected", () => `${name()}\n      got  ${JSON.stringify(factSig(t.drafts))}\n      want ${JSON.stringify(exp)}`);
    if (!("none" in want)) check(rep, t.out.intent === "career_resume_ingest" && t.out.reply.includes(want.newLine), "the corrected draft was not shown again for the yes", name);
    const y = c.say("yes, that's my resume");
    check(rep, JSON.stringify(factSig(y.conf)) === JSON.stringify(exp) && y.drafts.length === 0, "the yes did not confirm the entries as corrected", () => `${name()}\n      got  ${JSON.stringify(factSig(y.conf))}\n      want ${JSON.stringify(exp)}`);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ names
const NAMES = Array.from({ length: 1500 }, (_, i) => i);
Deno.test(`names: ${NAMES.length} people who gave their name, then a resume headed by someone else's (a forwarded file) or their own: a plain yes confirms someone else's nothing; "yes, that's my resume" does; the header's name is never theirs`, () => {
  const rep = report("names");
  for (const i of NAMES) {
    rep.total++;
    const r = rng(SEED + 40_000 + i);
    const p = person(r);
    const kind = i % 5; // 0,1 another's; 2 theirs; 3 theirs with an accent / different case; 4 no name given
    const other = `${r.pick(OTHER_FIRST)} ${r.pick(["Otherperson", "Forwarded", "Notme"])}`;
    const header = kind <= 1 ? other : kind === 3 ? p.name.replace(/^Ines/, "Inés").toUpperCase() : p.name;
    const c = conversation(`n-${i}`);
    if (kind !== 4) c.say(r.pick([`my name is ${p.name}`, `my name is ${p.first}`, `call me ${p.first}`]));
    const up = c.say(framed(linesOf(p, header)));
    const mismatch = kind <= 1;
    const name = () => `[${kind}] header ${header}, person ${p.name} -> ${flat(up.out.reply).slice(0, 300)}`;
    check(rep, up.out.intent === "career_resume_ingest" && up.conf.length === 0, "the resume was not read for a yes", name);
    check(rep, mismatch === /The name at the top of this resume is/.test(up.out.reply), mismatch ? "someone else's name at the top was not said" : "their own name was called someone else's", name);
    const yes = c.say(r.pick(["yes", "yep", "looks good", "correct"]));
    if (mismatch) {
      check(rep, yes.conf.length === 0 && /The name at the top of this resume is/.test(yes.out.reply), "a plain yes confirmed a resume headed by someone else's name", () => `${name()}\n      yes -> ${flat(yes.out.reply).slice(0, 200)}`);
      const own = c.say(r.pick(["yes, that's my resume", "yes it's my resume", "that's my resume"]));
      check(rep, JSON.stringify(factSig(own.conf)) === JSON.stringify(sig(entriesOf(p))), "a yes that says it is theirs did not confirm", () => `${name()}\n      -> ${flat(own.out.reply).slice(0, 200)}`);
    } else {
      check(rep, JSON.stringify(factSig(yes.conf)) === JSON.stringify(sig(entriesOf(p))), "a plain yes to their own resume did not confirm", () => `${name()}\n      yes -> ${flat(yes.out.reply).slice(0, 200)}`);
    }
    const who = c.say("what's my name?").out.reply;
    check(rep, !(kind <= 1 && who.includes(other.split(" ")[0])) && !who.includes("Otherperson"), "the name at the top of someone else's resume became theirs", () => `${name()}\n      ${who}`);
    // Contact lines from the header are never read onto the record.
    check(rep, !c.say("what's on my resume?").out.reply.includes("@example.test"), "an email from the resume's header is on the record", name);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ stale
const STALE = Array.from({ length: 800 }, (_, i) => i);
const BETWEEN = ["find me data analyst internships in Chicago", "can you set an alert for analyst roles?", "what's on my resume?", "remind me to follow up with Brightline Analytics (TEST) tomorrow",
  "how do I prep for a case interview?", "what's my GPA?", "do you want my LinkedIn?", "track my application at Orchard Health (TEST)"];
Deno.test(`stale: ${STALE.length} bare yeses after another question: nothing confirmed; a yes that names the resume confirms`, () => {
  const rep = report("stale");
  for (const i of STALE) {
    rep.total++;
    const r = rng(SEED + 50_000 + i);
    const p = person(r);
    const c = conversation(`s-${i}`);
    c.say(framed(linesOf(p)));
    const mid = r.pick(BETWEEN);
    c.say(mid);
    const bare = c.say(r.pick(["yes", "yeah", "sure", "ok", "yes please", "yep"]));
    check(rep, bare.conf.length === 0, "a yes after another question confirmed the resume", () => `${JSON.stringify(mid)} then a bare yes -> ${bare.out.intent}: ${flat(bare.out.reply).slice(0, 200)}`);
    const own = c.say("yes, that's my resume");
    check(rep, JSON.stringify(factSig(own.conf)) === JSON.stringify(sig(entriesOf(p))), "a yes naming the resume did not confirm it", () => `${JSON.stringify(mid)} -> ${flat(own.out.reply).slice(0, 200)}`);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ secrets
const stack = (lines: string[]) => lines.filter((l) => l !== "").map((t, i) => ({ text: t, x: 72, y: 740 - i * 16 }));
const xmlEsc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const docxOf = (lines: string[]) => docxBytes(lines.filter(Boolean).map((t) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r></w:p>`).join(""));
const digits = (s: string) => s.replace(/[^0-9a-z]/gi, "").toLowerCase();
const SECRETS = Array.from({ length: 1400 }, (_, i) => i);
Deno.test(`secrets: ${SECRETS.length} resumes with a password, SSN, card, account number, key, one-time code or passcode inside, pasted or sent as a file: never in a reply or an entry; a file with one is not kept`, async () => {
  const rep = report("secrets");
  for (const i of SECRETS) {
    rep.total++;
    const r = rng(SEED + 60_000 + i);
    const p = person(r);
    const s = secretLine(r);
    const lines = linesOf(p);
    lines.splice(lines.findIndex((l) => l.startsWith("- ")) + 1, 0, s.line);
    const name = () => `${s.kind}: ${s.line}`;
    if (i % 3 === 2) {
      const bytes = i % 2 ? pdfBytes(stack(lines)) : docxOf(lines);
      const stored: unknown[] = [];
      const res = await ingestResumeFile({ userId: "TEST-onb-r3", channel: "telegram", doc: { fileId: "F", uniqueId: `U${i}`, name: i % 2 ? "resume.pdf" : "resume.docx", mime: i % 2 ? PDF : DOCX, size: bytes.length },
        fetchFile: async () => ({ ok: true, bytes }), record: async (row) => { stored.push(row); return "x"; } });
      check(rep, !res.ok && res.why === "secret" && stored.length === 0, "a file with a secret in it was kept or read", () => `${name()} -> ${JSON.stringify(res).slice(0, 200)}`);
      check(rep, !digits(JSON.stringify(res)).includes(digits(s.value)), "the secret is in the file's reply", name);
      continue;
    }
    // A paste: what the chat receives is the message after agent-chat's input step (identity_redact.ts).
    const msg = redactIdentity(framed(lines)).text;
    const t = conversation(`x-${i}`).say(msg);
    check(rep, !digits(t.out.reply).includes(digits(s.value)), "the secret is in the reply", () => `${name()} -> ${flat(t.out.reply).slice(0, 300)}`);
    check(rep, !t.facts.some((f) => digits(JSON.stringify(f)).includes(digits(s.value))), "the secret is in an entry", name);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ files
const FILES = Array.from({ length: 600 }, (_, i) => i);
Deno.test(`files: ${FILES.length} damaged files (a PDF cut off, a broken .docx) and whole files with no text (a blank PDF, a .docx holding only a picture, a scanned PDF): each said for what it is, nothing kept`, async () => {
  const rep = report("files");
  for (const i of FILES) {
    rep.total++;
    const r = rng(SEED + 70_000 + i);
    const p = person(r);
    const k = i % 5;
    const full = pdfBytes(stack(linesOf(p)));
    const fullDocx = docxOf(linesOf(p));
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, () => r.int(0, 255))]);
    const [bytes, nm, mime, want, label] =
      k === 0 ? [full.subarray(0, r.int(40, Math.floor(full.length / 3))), "resume.pdf", PDF, FILE_DAMAGED_REPLY, "pdf cut off"]
      : k === 1 ? [pdfBytes([]), "resume.pdf", PDF, FILE_NO_TEXT_REPLY, "a whole pdf with no text"]
      : k === 2 ? [fullDocx.subarray(0, r.int(30, Math.floor(fullDocx.length / 2))), "resume.docx", DOCX, FILE_DAMAGED_REPLY, "docx cut off"]
      : k === 3 ? [zipOf([{ name: "[Content_Types].xml", data: new TextEncoder().encode("<Types/>") }, { name: "word/document.xml", data: new TextEncoder().encode('<w:document xmlns:w="w"><w:body><w:p/></w:body></w:document>') }, { name: "word/media/image1.png", data: png }]), "resume.docx", DOCX, FILE_NO_TEXT_REPLY, "docx holding only a picture"]
      : [pdfBytes([], { image: true }), "scan.pdf", PDF, FILE_NO_TEXT_REPLY, "scanned pdf"];
    const stored: unknown[] = [];
    const res = await ingestResumeFile({ userId: "TEST-onb-r3", channel: "telegram", doc: { fileId: "F", uniqueId: `U${i}`, name: nm as string, mime: mime as string, size: (bytes as Uint8Array).length },
      fetchFile: async () => ({ ok: true, bytes: bytes as Uint8Array }), record: async (row) => { stored.push(row); return "x"; } });
    check(rep, !res.ok && res.reply === want && stored.length === 0, `${label}: not said for what it is (or kept)`, () => `${label} -> ${JSON.stringify(res).slice(0, 240)}`);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ foreign + readback
const FOREIGN_N = Array.from({ length: 800 }, (_, i) => i);
const yearsIn = (s: string) => new Set(String(s).match(/\b(?:19|20)\d\d\b/g) ?? []);
const gpasIn = (s: string) => new Set(String(s).match(/\b[0-4]\.\d{1,2}\b/g) ?? []);
Deno.test(`foreign + readback: ${FOREIGN_N.length} resumes in Portuguese, Italian, Dutch, Spanish, and English resumes with or without a GPA or a date: read in their own words or said not read; read-backs carry no year or GPA the resume does not`, () => {
  const rep = report("foreign");
  const langs = Object.keys(FOREIGN) as (keyof typeof FOREIGN)[];
  for (const i of FOREIGN_N) {
    rep.total++;
    const r = rng(SEED + 80_000 + i);
    let text: string, eduLines: string[];
    if (i % 2) { const f = foreignResume(r, langs[i % langs.length]); text = f.text; eduLines = [f.values[0]]; }
    else { const p = person(r, { gpa: r.next() < 0.5, date: r.next() < 0.5 }); text = framed(linesOf(p)); eduLines = p.edus.map((e) => e.line); }
    const c = conversation(`g-${i}`);
    const up = c.say(text);
    const name = () => `${JSON.stringify(text.slice(0, 260))} -> ${up.out.intent}: ${flat(up.out.reply).slice(0, 200)}`;
    if (up.out.intent !== "career_resume_ingest") {
      check(rep, up.out.intent === "career_resume_not_read" && up.facts.length === 0, "a resume neither read nor said not read (or something saved)", name);
      continue;
    }
    // Every entry in the person's own words (no word added, nothing normalized).
    for (const f of up.facts) for (const part of [f.title, ...(f.bullets ?? [])].filter(Boolean)) check(rep, text.includes(String(part)), "an entry carries words the resume does not", () => `${name()}\n      ${part}`);
    c.say("yes, that's my resume");
    const grad = c.say("what's my graduation year?").out.reply, gpa = c.say("what's my GPA?").out.reply;
    const inEdu = new Set(eduLines.flatMap((l) => [...yearsIn(l)])), gpaEdu = new Set(eduLines.flatMap((l) => [...gpasIn(l)]));
    for (const y of yearsIn(grad)) check(rep, inEdu.has(y), "a graduation year read back that no education entry carries", () => `${name()}\n      ${grad}`);
    for (const g of gpasIn(gpa)) check(rep, gpaEdu.has(g), "a GPA read back that no education entry carries", () => `${name()}\n      ${gpa}`);
    // A dated entry (one school) is read back with its own last date, as written.
    if (i % 2 === 0 && eduLines.length === 1) {
      const ds = eduLines[0].match(GRAD) ?? [];
      if (ds.length) check(rep, grad.includes(ds[ds.length - 1]), "the confirmed entry's date was not read back", () => `${name()}\n      ${grad}`);
      else check(rep, !yearsIn(grad).size, "a year read back for an undated entry", () => `${name()}\n      ${grad}`);
    }
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ binding
const BIND = Array.from({ length: 500 }, (_, i) => i);
Deno.test(`binding: ${BIND.length} pairs of files with the same text: the yes binds to the newest file received no later than the message that showed the entries`, async () => {
  const rep = report("binding");
  for (const i of BIND) {
    rep.total++;
    const r = rng(SEED + 90_000 + i);
    const msgSha = "a".repeat(64);
    const t0 = Date.parse("2026-11-01T15:00:00Z");
    // uploads A, B (and sometimes A again) seconds apart; the message that showed the entries lands between some of them
    const ups = [{ id: "A", at: t0 }, { id: "B", at: t0 + r.int(2, 20) * 1000 }];
    if (r.next() < 0.4) ups[0].at = ups[1].at + r.int(2, 20) * 1000; // A sent again after B (a resend is stamped as received again)
    const msgAt = Math.min(...ups.map((u) => u.at)) + r.int(1, 60) * 1000;
    const want = ups.filter((u) => u.at <= msgAt).sort((a, b) => b.at - a.at)[0]?.id ?? null;
    // deno-lint-ignore no-explicit-any
    const admin: any = { from: () => {
      // deno-lint-ignore no-explicit-any
      const f: any[] = []; const q: any = { select: () => q, eq: () => q, lte: (_c: string, v: string) => { f.push((u: { at: number }) => u.at <= Date.parse(v)); return q; },
        order: () => q, limit: async () => ({ data: ups.filter((u) => f.every((g) => g(u))).sort((a, b) => b.at - a.at).slice(0, 1).map((u) => ({ id: `0000000${u.id}`, provider_ref: `telegram:${u.id}`, sha256: (u.id === "A" ? "1" : "2").repeat(64) })), error: null }) };
      return q;
    } };
    const ctx = await resumeConfirmationContext([{ id: 9, role: "user", content: "yes, that's my resume", created_at: new Date(msgAt + 5000).toISOString() },
      { id: 8, role: "assistant", content: "1. Data Analyst Intern, Brightline Analytics (TEST)", created_at: new Date(msgAt + 1).toISOString() },
      { id: 7, role: "user", content: "here is my resume:\nData Analyst Intern, Brightline Analytics (TEST)", created_at: new Date(msgAt).toISOString() }],
      { facts: [{ title: "Data Analyst Intern, Brightline Analytics (TEST)" }] });
    const got = await fileUploadFor(admin, "TEST-onb-r3", ctx.upload ? { ...ctx.upload, sha256: msgSha } : null);
    const gotId = got && got.kind === "file" ? got.ref.replace(/^telegram:(\w).*$/, "$1") : null;
    check(rep, gotId === want, "the yes bound to a file the message did not come from", () => `uploads ${JSON.stringify(ups)} message at ${msgAt}: got ${gotId} want ${want}`);
  }
  done(rep);
});

Deno.test("the generators cover every family and the battery is about 10,000 scenarios", () => {
  const total = INJECT.length + FIXES.length + PREFIX.length + NAMES.length + STALE.length + SECRETS.length + FILES.length + FOREIGN_N.length + BIND.length;
  console.log(`[onboarding-r3] total generated scenarios: ${total}`);
  assertNode.ok(total >= 10_000, `${total}`);
});
