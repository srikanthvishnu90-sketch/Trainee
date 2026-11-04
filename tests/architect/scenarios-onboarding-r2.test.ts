// New-person onboarding and resume confirmation, ROUND 2 (architect, 2026-10-30; round 1: scenarios-onboarding.test.ts,
// #294). Owner rules (D-007): facts about the person only from what they confirmed, in their exact words; an unconfirmed,
// disputed or replaced entry is used nowhere; a newer resume supersedes cleanly; a secret or an ID is never kept; nothing
// is invented; every reply about their record is true. ~10,000 generated scenarios (scenarios/onboarding-r2-generator.ts,
// seeded) on the real pure code, a deterministic clock and no model:
//   files     resume FILES as Telegram sends them, through channel_resume_upload.ts ingestResumeFile with a fake download
//             and a fake store: real PDF and Word bytes in the layouts people send (TJ arrays, runs, dates on the right, two
//             columns, T* lines, Word tabs, list bullets, line breaks, tables, text boxes, untyped and mislabelled files,
//             Spanish / French / German), each read into exactly the resume's entries (kind and words) and shown word for
//             word; bad files (a scan, a locked PDF, over 10 MB, 0 bytes, a photo, a .doc, a zip named .pdf, an SSN or a
//             card number inside) refused with the reason, nothing stored; a cover letter or a transcript said not to be a
//             resume, nothing saved, nothing applied
//   pastes    a LinkedIn profile pasted (a role over four lines, skills between "·") read as whole entries; a resume with
//             lines addressed to an AI ("ignore all previous instructions") read without them, and the person told
//   replies   partial yeses ("yes except the GPA", "all good but #2") confirm nothing; corrections of dates (03/04/2025) and
//             amounts ($85,000, 1,200) carry exactly what they change
//   journeys  whole first sessions through the career host (the text a file's reader gives, framed as the chat gets it):
//             upload, partial yes, correction, /start, days of silence, a search or an apply ask in between, a newer resume
//             before the yes, a not-a-resume document, the yes, a dispute ("actually I never worked at X"), a newer resume
//             after; after every turn the profile holds exactly what the person confirmed (as corrected, minus what they
//             disowned) and read-backs carry nothing else
//   disputes  every way of disowning an entry after the yes removes exactly it; a name in two entries, or a sentence that
//             is not a dispute, removes nothing
// The end-to-end sample through the real Telegram webhook on real Postgres is flow-scenarios-onboarding-r2.test.ts.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { FILE_EMPTY_REPLY, FILE_KIND_REPLY, FILE_LOCKED_REPLY, FILE_NO_TEXT_REPLY, FILE_TOO_BIG_REPLY, fileNotResumeReply, fileSecretReply, ingestResumeFile, resumeMessage, sha256Bytes } from "../../supabase/functions/_shared/channel_resume_upload.ts";
import { type Entry, FILE_FAMILIES, type FileFamily, fileFor, framed, injectedText, INJECTIONS, inputFor, type Journey, journeys, linkedinPaste, modelStep, newModel, NOW, person, replies, resumeFile, type ResumeFile, rng, sig, type Step } from "./scenarios/onboarding-r2-generator.ts";

// deno-lint-ignore no-explicit-any
const P = (core as any).CareerProfile;
// deno-lint-ignore no-explicit-any
const host = (CareerHost as any).createCareerHost(core);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261030;

type Report = { name: string; total: number; fails: Map<string, string[]> };
const report = (name: string): Report => ({ name, total: 0, fails: new Map() });
function check(rep: Report, ok: boolean, kind: string, detail: () => string) {
  if (ok) return;
  if (!rep.fails.has(kind)) rep.fails.set(kind, []);
  rep.fails.get(kind)!.push(detail());
}
function done(rep: Report) {
  const n = [...rep.fails.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[onboarding-r2] ${rep.name}: ${rep.total} scenarios, ${n} failures`];
  for (const [k, xs] of rep.fails) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x.slice(0, 900)}`); }
  console.log(lines.join("\n"));
  eq(n, 0, lines.join("\n"));
}
// deno-lint-ignore no-explicit-any
const titleOf = (f: any) => String(f.kind === "skill" ? (f.name ?? f.title) : f.title);
// deno-lint-ignore no-explicit-any
const factSig = (fs: any[]) => fs.map((f) => `${f.kind}|${titleOf(f)}`).sort();
const flat = (s: string) => String(s).replace(/\s+/g, " ");
// A fresh conversation on the career host, on a clock that only moves when told.
function conversation(threadId: string) {
  let snap: unknown = null, t = NOW;
  return {
    advance: (ms: number) => { t += ms; },
    say(text: string) {
      // deno-lint-ignore no-explicit-any
      const ctx: any = host.createTurnCtx({ userId: "TEST-onb-r2", threadId, now: (t += 60_000), accountPersistence: true, snapshot: snap, account: { epoch: 0, version: 0, paused: false }, postings: [] });
      const out = host.runTurn(text, ctx);
      snap = host.extractSnapshot(ctx);
      // deno-lint-ignore no-explicit-any
      const facts = ((ctx.profile?.facts ?? []) as any[]).filter((f) => f && f.source === "resume-ingest");
      return { out, ctx, facts, conf: facts.filter((f) => f.needs_confirmation === false), drafts: facts.filter((f) => f.needs_confirmation === true) };
    },
  };
}
// A fake Telegram download and a fake upload store (what ingestResumeFile is given in trainee-telegram).
async function upload(f: ResumeFile) {
  const fetched: string[] = [], stored: { sha256: string; content_b64: string; message_sha256: string; bytes: number }[] = [];
  const res = await ingestResumeFile({
    userId: "TEST-onb-r2", channel: "telegram", doc: { fileId: `F-${f.family}`, uniqueId: `U-${f.family}`, name: f.name, mime: f.mime, size: f.declared },
    fetchFile: async (id) => { fetched.push(id); return f.family === "bad-huge-unsaid" ? { ok: false, error: "too_large" } : { ok: true, bytes: f.bytes }; },
    record: async (row) => { stored.push(row); return `upload-${stored.length}`; },
  });
  return { res, fetched, stored };
}
const REFUSAL: Record<string, (f: ResumeFile) => string> = {
  kind: () => FILE_KIND_REPLY, too_large: () => FILE_TOO_BIG_REPLY, empty: () => FILE_EMPTY_REPLY, no_text: () => FILE_NO_TEXT_REPLY, locked: () => FILE_LOCKED_REPLY,
  secret: (f) => fileSecretReply([f.family === "bad-ssn" ? "a Social Security number" : "a card number"]),
};

// ------------------------------------------------------------------------------------------------ files
const FILES: ResumeFile[] = [];
for (let i = 0; i < 3080; i++) FILES.push(resumeFile(rng(SEED + 10_000 + i), FILE_FAMILIES[i % FILE_FAMILIES.length], (i % 2) as 0 | 1));
Deno.test(`files: ${FILES.length} resume files sent on Telegram (${FILE_FAMILIES.length} layouts and failures): read into exactly the resume's entries, or refused with the reason and nothing kept`, async () => {
  const rep = report("files");
  for (const f of FILES) {
    rep.total++;
    const name = () => `${f.family} (${f.name}, ${f.mime || "no type"}, ${f.bytes.length} bytes)`;
    const { res, fetched, stored } = await upload(f);
    if ("refusal" in f.expect) {
      const want = REFUSAL[f.expect.refusal](f);
      check(rep, !res.ok && res.reply === want, `${f.family}: not refused with its reason`, () => `${name()}\n      got  ${JSON.stringify(res).slice(0, 300)}\n      want ${want}`);
      check(rep, stored.length === 0, `${f.family}: a refused file was stored`, () => name());
      if (f.expect.refusal === "kind" && f.family !== "bad-zip-as-pdf") check(rep, fetched.length === 0, "a file of another type was downloaded", () => name());
      if (f.expect.refusal === "too_large" && f.declared !== null) check(rep, fetched.length === 0, "a file said to be over 10 MB was downloaded", () => name());
      if (f.expect.secret) {
        const v = f.expect.secret.replace(/\D/g, "");
        check(rep, !JSON.stringify(res).replace(/\D/g, "").includes(v), "the secret is in the reply", () => name());
      }
      continue;
    }
    if ("notResume" in f.expect) {
      // A document that is not a resume: said so (what it looks like), not kept, no turn; the same text pasted is said so
      // by the chat, with nothing saved and no application started.
      check(rep, !res.ok && res.reply === fileNotResumeReply(f.text!) && /cover letter|transcript/.test(res.reply), `${f.family}: not said not to be a resume`, () => `${name()} -> ${JSON.stringify(res).slice(0, 300)}`);
      check(rep, stored.length === 0, `${f.family}: a document that is not a resume was stored`, () => name());
      const { out, facts } = conversation(`n-${rep.total}`).say(framed(f.text!));
      check(rep, out.intent === "career_resume_not_read" && facts.length === 0, `${f.family}: pasted, a document that is not a resume was not said so (or something was saved from it)`,
        () => `${name()} -> ${out.intent}/${out.resultStatus}: ${flat(out.reply).slice(0, 300)}`);
      check(rep, !/\b(?:applications? (?:is |are )?(?:ready|queued|sent|submitted)|i applied|submitted)\b/i.test(out.reply) && !out.batchRun, "a document that is not a resume started an application", () => `${name()} -> ${flat(out.reply).slice(0, 300)}`);
      continue;
    }
    check(rep, res.ok, `${f.family}: a readable file was refused`, () => `${name()} -> ${JSON.stringify(res).slice(0, 300)}`);
    if (!res.ok) continue;
    check(rep, stored.length === 1 && stored[0].sha256 === await sha256Bytes(f.bytes) && stored[0].bytes === f.bytes.length && atob(stored[0].content_b64).length === f.bytes.length,
      "the file was not stored once, as received, by its sha256", () => name());
    // The chat's message is the file's text, framed as a pasted resume.
    check(rep, res.message.startsWith("here is my resume:\n"), "the file's text is not framed as a resume", () => name());
    const c = conversation(`f-${rep.total}`);
    const { out, facts, conf } = c.say(res.message);
    const want = f.expect.entries;
    // What a correct reader takes from the file: every entry, under its own kind, in the resume's exact words.
    const { drafts } = P.parseResumeSections(res.message);
    check(rep, JSON.stringify(factSig(drafts)) === JSON.stringify(sig(want)), `${f.family}: the entries read are not the resume's`,
      () => `${name()}\n      got  ${JSON.stringify(factSig(drafts))}\n      want ${JSON.stringify(sig(want))}\n      text ${JSON.stringify(res.message.slice(0, 700))}`);
    // deno-lint-ignore no-explicit-any
    const bullets = (xs: any[]) => xs.filter((d) => d.kind !== "skill").map((d) => `${d.kind}|${titleOf(d)}|${(d.bullets ?? []).join("/")}`).sort();
    check(rep, JSON.stringify(bullets(drafts)) === JSON.stringify(bullets(want)), `${f.family}: an entry's bullets are not the resume's`,
      () => `${name()}\n      got  ${JSON.stringify(bullets(drafts))}\n      want ${JSON.stringify(bullets(want))}`);
    // The router reads it as a resume, confirms nothing, and shows every entry word for word.
    check(rep, out.intent === "career_resume_ingest" && out.resultStatus === "awaiting_user" && conf.length === 0, `${f.family}: the file's text was not read as a resume awaiting a yes`,
      () => `${name()} -> ${out.intent}/${out.resultStatus}: ${flat(out.reply).slice(0, 300)}`);
    for (const d of facts) check(rep, flat(out.reply).includes(flat(d.text)), "an entry was not shown word for word", () => `${name()}: ${d.text}`);
    // Nothing from the file names the person (the header is not read): their name is not taken from someone's resume.
    check(rep, !c.say("what's my name?").out.reply.includes(f.person!.name), "a name on the resume became the person's name", () => name());
  }
  const by = (k: string) => FILES.filter((f) => f.family === k).length;
  console.log(`[onboarding-r2] files by family: ${FILE_FAMILIES.map((k) => `${k} ${by(k)}`).join(", ")}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ pastes
const PASTES = Array.from({ length: 900 }, (_, i) => i);
Deno.test(`pastes: ${PASTES.length} LinkedIn profiles pasted and resumes carrying lines addressed to an AI: whole entries, the AI's lines on none, the person told`, () => {
  const rep = report("pastes");
  for (const i of PASTES) {
    rep.total++;
    const r = rng(SEED + 20_000 + i), p = person(r, (i % 2) as 0 | 1);
    if (i % 2 === 0) {
      const { text, entries } = linkedinPaste(p);
      const { drafts } = P.parseResumeSections(text);
      check(rep, JSON.stringify(factSig(drafts)) === JSON.stringify(sig(entries)), "a LinkedIn profile was not read as whole entries", () => `got  ${JSON.stringify(factSig(drafts))}\n      want ${JSON.stringify(sig(entries))}`);
      const { out, conf } = conversation(`l-${i}`).say(text);
      check(rep, out.intent === "career_resume_ingest" && out.resultStatus === "awaiting_user" && conf.length === 0, "a pasted LinkedIn profile was not read for a yes", () => `${out.intent}/${out.resultStatus}: ${flat(out.reply).slice(0, 200)}`);
      // A resume the person framed as theirs whose job lines say "Responsibilities:" or "Qualifications:" is still a resume.
      const f = resumeFile(r, "pdf-lines", p.set, p);
      const lines = f.text!.split("\n");
      lines.splice(lines.findIndex((l) => l.startsWith("- ")), 0, `- ${r.pick(["Responsibilities", "Key responsibilities", "Qualifications"])}: scheduled 40 trucks a day`);
      const framedOut = conversation(`r-${i}`).say(framed(lines.join("\n"))).out;
      check(rep, framedOut.intent === "career_resume_ingest" && framedOut.resultStatus === "awaiting_user", "a framed resume with a \"Responsibilities:\" line was not read as a resume", () => `${framedOut.intent}: ${flat(framedOut.reply).slice(0, 200)}`);
    } else {
      const { text, entries, injected } = injectedText(r, p);
      const { drafts, unread } = P.parseResumeSections(text);
      check(rep, JSON.stringify(factSig(drafts)) === JSON.stringify(sig(entries)), "an AI-directed line changed the entries read", () => `${injected}\n      got  ${JSON.stringify(factSig(drafts))}\n      want ${JSON.stringify(sig(entries))}`);
      // deno-lint-ignore no-explicit-any
      check(rep, !drafts.some((d: any) => JSON.stringify(d).includes(injected.replace(/^- /, "").slice(0, 30))), "an AI-directed line is on an entry", () => injected);
      check(rep, unread.some((u: string) => /addressed to an AI/.test(u)), "the person is not told the AI-directed lines were left out", () => injected);
      const { out, conf } = conversation(`i-${i}`).say(framed(text));
      check(rep, conf.length === 0 && /addressed to an AI/.test(out.reply), "the reply does not say the AI-directed lines were left out (or something was confirmed)", () => flat(out.reply).slice(0, 300));
    }
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ replies
const REPLIES = replies(rng(SEED + 1), 2400);
Deno.test(`replies: ${REPLIES.length} partial yeses and corrections of dates and amounts: a partial yes confirms nothing; a correction carries exactly what it changes`, () => {
  const rep = report("replies");
  for (const c of REPLIES) {
    rep.total++;
    const got = P.confirmationReply(c.input);
    if (c.kind === "unclear") check(rep, got.kind === "unclear", `a partial yes read as ${got.kind}`, () => `${JSON.stringify(c.input)} -> ${JSON.stringify(got)}`);
    else check(rep, got.kind === "correction" && got.from === c.from && got.to === c.to, `${c.family}: read with the wrong values`, () => `${JSON.stringify(c.input)} -> ${JSON.stringify(got)} want ${c.from} -> ${c.to}`);
  }
  console.log(`[onboarding-r2] replies: ${["partial", "correction/date", "correction/money", "correction/count"].map((k) => `${k} ${REPLIES.filter((c) => c.family === k).length}`).join(", ")}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ journeys
const JOURNEYS = journeys(rng(SEED + 2), 1800);
const valuesOf = (j: Journey) => [j.a, j.b].flatMap((p) => [p.school, p.gpa, ...p.jobs.map((x) => x.company)]);
Deno.test(`journeys: ${JOURNEYS.length} first sessions (${JOURNEYS.reduce((a, j) => a + j.steps.length, 0)} turns) through the career host: the profile holds exactly what the person confirmed, minus what they disowned`, () => {
  const rep = report("journeys");
  let turns = 0;
  for (const j of JOURNEYS) {
    rep.total++;
    const c = conversation(`j-${j.id}`);
    const m = newModel();
    const log: string[] = [];
    const name = () => `journey ${j.id} [${j.family}] A=${j.aFamily} B=${j.bFamily}\n      ${log.join("\n      ")}`;
    for (const s of j.steps) {
      if (s.t === "silence") { c.advance(s.days * 86_400_000); log.push(`(${s.days} days of silence)`); continue; }
      const input = inputFor(j, s);
      const { out, conf, drafts } = c.say(input);
      turns++;
      log.push(`${JSON.stringify(input.slice(0, 60))} -> ${out.intent}/${out.resultStatus}: ${flat(out.reply).slice(0, 150)}`);
      modelStep(m, j, s);
      check(rep, JSON.stringify(factSig(conf)) === JSON.stringify(sig(m.confirmed)), `${s.t}: the confirmed entries are not what the person confirmed`,
        () => `${name()}\n      confirmed ${JSON.stringify(factSig(conf))}\n      model     ${JSON.stringify(sig(m.confirmed))}`);
      check(rep, JSON.stringify(factSig(drafts)) === JSON.stringify(sig(m.pending)), `${s.t}: the drafts are not the latest resume's (as corrected, minus what was disowned)`,
        () => `${name()}\n      drafts ${JSON.stringify(factSig(drafts))}\n      model  ${JSON.stringify(sig(m.pending))}`);
      // A disowned entry is gone (unless a later resume carries it again, as its own entry).
      const now = [...sig(m.confirmed), ...sig(m.pending)];
      for (const x of m.removed) if (!now.includes(x)) check(rep, !factSig([...conf, ...drafts]).includes(x), "a disowned entry is still on the record", () => `${name()}\n      ${x}`);
      if (s.t !== "yes" && s.t !== "upload" && s.t !== "linkedin") check(rep, !(out.intent === "career_resume_ingest" && out.resultStatus === "completed"), `${s.t} reported a confirmation`, () => name());
      // Nothing is applied for (or claimed applied) before a confirmed resume, and the reply never says it was.
      if (s.t === "ask" && !m.confirmed) {
        check(rep, !out.batchRun || !(out.batchRun.items ?? []).some((x: { state?: string }) => /queued|prepared|submitted|sent/.test(String(x?.state))), "an apply ask before a confirmed resume prepared an application", () => name());
        check(rep, !/\b(?:i (?:applied|submitted)|application (?:is )?(?:sent|submitted|queued))\b/i.test(out.reply), "the reply claims an application before a confirmed resume", () => name());
        if (/\bapply\b/i.test(s.input)) check(rep, /resume/i.test(out.reply), "an apply ask before a confirmed resume does not say the resume is why", () => name());
      }
      if (s.t === "document") check(rep, out.intent === "career_resume_not_read", "a document that is not a resume was not said so", () => name());
      if (s.t === "start" && m.pending) check(rep, out.intent === "career_resume_ingest" && m.pending.every((e) => flat(out.reply).includes(flat(e.title))), "/start while the entries wait did not show them again for the yes", () => name());
      if (s.t === "dispute" && m.removed.length && out.intent === "career_resume_dispute") check(rep, out.reply.includes(m.removed[m.removed.length - 1].split("|").slice(1).join("|")), "a dispute does not name what was taken off", () => name());
      // A read-back carries only what is confirmed now: no draft's, replaced resume's or disowned entry's value.
      if (s.t === "readback") {
        const held = (m.confirmed ?? []).map((e) => e.title).join(" ");
        for (const v of valuesOf(j)) check(rep, !out.reply.includes(v) || held.includes(v), "a value not on the confirmed record was read back", () => `${name()}\n      ${JSON.stringify(v)} is not confirmed`);
        const exp = (m.confirmed ?? []).filter((e) => e.kind === "experience");
        if (/where have i worked/.test(s.input)) {
          if (exp.length) check(rep, exp.every((e) => out.reply.includes(e.title)), "the confirmed jobs were not read back", () => `${name()}`);
          else check(rep, !/from your confirmed resume/i.test(out.reply), "jobs read back with none confirmed", () => name());
        }
        if (/on my resume/.test(s.input)) {
          if (m.confirmed?.length) check(rep, m.confirmed.filter((e) => e.kind !== "skill").every((e) => out.reply.includes(e.title)), "the confirmed resume was not read back whole", () => name());
          else check(rep, /nothing from your resume is confirmed|no resume of yours is confirmed/i.test(out.reply), "\"what's on my resume\" with nothing confirmed was not said so", () => name());
        }
      }
    }
  }
  console.log(`[onboarding-r2] journeys: ${JOURNEYS.length} people, ${turns} turns; shapes ${JSON.stringify(Object.fromEntries([...new Set(JOURNEYS.map((j) => j.family))].sort().map((k) => [k, JOURNEYS.filter((j) => j.family === k).length])))}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ disputes
const DISPUTES = Array.from({ length: 1400 }, (_, i) => i);
Deno.test(`disputes: ${DISPUTES.length} ways to disown a confirmed entry (and sentences that are not): exactly that entry leaves the record and every read of it; nothing else moves`, () => {
  const rep = report("disputes");
  for (const i of DISPUTES) {
    rep.total++;
    const r = rng(SEED + 50_000 + i), p = person(r, (i % 2) as 0 | 1);
    const f = resumeFile(r, "pdf-lines", p.set, p);
    const c = conversation(`d-${i}`);
    c.say(framed(f.text!));
    const before = c.say("yes, that's my resume").conf;
    const entries = (f.expect as { entries: Entry[] }).entries;
    const job = r.pick(p.jobs), skill = r.pick(p.skills);
    const k = r.int(0, 9);
    // [what they say, the entry it disowns (kind|title) or null for none]
    const jobSig = `experience|${job.title}, ${job.company}, ${job.dates}`;
    const cases: [string, string | null][] = [
      [`actually I never worked at ${job.company}`, jobSig], [`I didn't work for ${job.company}`, jobSig], [`remove ${job.company} from my resume`, jobSig],
      [`delete the ${job.company} entry, I never worked there`, jobSig], [`${job.company} is not mine`, jobSig], [`I never used ${skill}`, `skill|${skill}`],
      [`remove ${skill} from my skills`, `skill|${skill}`], [`I didn't go to ${p.school}`, `education|${entries[0].title}`],
      // Not a dispute of one entry: a word in every job title ("Intern" or the TEST tag), and sentences about other things.
      [r.pick([`I never heard back from ${job.company}`, "remove the watch for analyst roles", `I didn't get the job at ${job.company} yet`, "delete my alerts", `I never worked at Globex (TEST)`]), null],
      [`remove (TEST) from my resume`, null],
    ];
    const [said, gone] = cases[k];
    const { out, conf } = c.say(said);
    const want = factSig(before).filter((x) => x !== gone);
    check(rep, JSON.stringify(factSig(conf)) === JSON.stringify(want), gone ? "the disowned entry (exactly it) did not leave the record" : "a sentence that disowns no one entry changed the record",
      () => `${JSON.stringify(said)} -> ${out.intent}: ${flat(out.reply).slice(0, 200)}\n      before ${JSON.stringify(factSig(before))}\n      after  ${JSON.stringify(factSig(conf))}`);
    if (gone) {
      const rb = c.say(gone.startsWith("skill") ? "what's on my resume?" : gone.startsWith("education") ? "where did I go to school?" : "where have I worked?").out.reply;
      const v = gone.startsWith("skill") ? skill : gone.startsWith("education") ? p.school : job.company;
      const still = gone.startsWith("skill") ? (/skills: ([^.]*)/.exec(rb)?.[1] ?? "").split(", ").includes(v) : rb.includes(v);
      check(rep, !still, "a disowned entry is still read back", () => `${JSON.stringify(said)} -> ${flat(rb).slice(0, 200)}`);
    }
  }
  done(rep);
});

Deno.test("the generators cover every shape (file layouts and failures, reply families, journey steps)", () => {
  for (const k of FILE_FAMILIES) assertNode.ok(FILES.filter((f) => f.family === k).length >= 50, k);
  const steps = new Set(JOURNEYS.flatMap((j) => j.steps.map((s: Step) => s.t)));
  for (const s of ["upload", "document", "linkedin", "partial", "correct", "yes", "start", "silence", "ask", "dispute", "readback"]) assertNode.ok(steps.has(s as Step["t"]), s);
  const fams = new Set(JOURNEYS.flatMap((j) => j.steps.filter((s) => s.t === "upload").map((s) => (s as { family: FileFamily }).family)));
  assertNode.ok(fams.size >= 10, `${fams.size} upload layouts in journeys`);
  assertNode.ok(INJECTIONS.length >= 5);
  void fileFor; void resumeMessage;
  const total = FILES.length + PASTES.length + REPLIES.length + JOURNEYS.length + DISPUTES.length;
  console.log(`[onboarding-r2] total generated scenarios: ${total} (journey turns: ${JOURNEYS.reduce((a, j) => a + j.steps.length, 0)})`);
  assertNode.ok(total >= 9000, `${total}`);
});
