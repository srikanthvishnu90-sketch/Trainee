// New-person onboarding and resume confirmation at scale (owner rules, D-007): facts about the person come only from what
// they confirmed; an unconfirmed, partly read or replaced resume never feeds an answer, a draft or an application; only a
// plain yes confirms (a question, a hedge, a pause, an emoji, a yes carrying more confirms nothing); a correction changes
// exactly the entry it names and asks again; a yes binds only to the question asked last; a resume given again is the
// whole resume (the same one changes nothing, a different one replaces the old once confirmed); secrets typed into a
// resume are never kept. ~10,000 generated scenarios (tests/architect/scenarios/onboarding-generator.ts, seeded) on the
// real pure code:
//   resumes   122's parseResumeSections and ingestResume over generated resumes (heading spellings, sections with no
//             entries): every entry read under its own kind, no heading read as an entry, every unread section named
//   replies   122's confirmationReply: yes only for a plain yes; a correction carries exactly what it changes
//   journeys  whole first conversations through the career host (120 -> 130 -> 142 -> 141, as the handler runs it), turn
//             by turn, against a model of what the person confirmed: the profile's confirmed and draft entries after every
//             turn, read-backs (school, GPA) only from the confirmed resume, no entry twice, the replaced resume gone
//   evidence  the handler's evidence step (career_router_evidence.ts) for entries corrected before the yes: traced to the
//             person's own upload and correction, never to words they did not give
//   secrets   an SSN, password or card number typed into a pasted resume: removed at the chat's input (identity_redact.ts)
//             and on no fact
//   brain     the agent brain's confirm_profile_fact (career_tools.ts) refuses every reply that is not a plain yes
// The end-to-end sample on real Postgres is flow-scenarios-onboarding.test.ts. No network, no model.
import assertNode from "node:assert/strict";
import * as core from "../../supabase/functions/_shared/router_core.career.js";
import { CareerHost } from "../../supabase/functions/_shared/career_host.js";
import { redactIdentity } from "../../supabase/functions/_shared/identity_redact.ts";
import { evidenceResumeConfirmation, resumeConfirmationContext } from "../../supabase/functions/_shared/career_router_evidence.ts";
import { careerTools } from "../../supabase/functions/_shared/agent/career_tools.ts";
import { type Journey, journeys, modelStep, newModel, NOW, pasted, replies, resume, rng, sig } from "./scenarios/onboarding-generator.ts";

// deno-lint-ignore no-explicit-any
const P = (core as any).CareerProfile;
// deno-lint-ignore no-explicit-any
const host = (CareerHost as any).createCareerHost(core);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SEED = 20261029;

type Report = { name: string; total: number; fails: Map<string, string[]> };
const report = (name: string): Report => ({ name, total: 0, fails: new Map() });
function check(rep: Report, ok: boolean, kind: string, detail: () => string) {
  if (ok) return;
  if (!rep.fails.has(kind)) rep.fails.set(kind, []);
  rep.fails.get(kind)!.push(detail());
}
function done(rep: Report) {
  const n = [...rep.fails.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[onboarding] ${rep.name}: ${rep.total} scenarios, ${n} failures`];
  for (const [k, xs] of rep.fails) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x.slice(0, 600)}`); }
  console.log(lines.join("\n"));
  eq(n, 0, lines.join("\n"));
}
// deno-lint-ignore no-explicit-any
const titleOf = (f: any) => String(f.kind === "skill" ? (f.name ?? f.title) : f.title);

// ------------------------------------------------------------------------------------------------ resumes
const RESUMES = Array.from({ length: 2400 }, (_, i) => resume(rng(SEED + 10_000 + i), (i % 2) as 0 | 1));
Deno.test(`resumes: ${RESUMES.length} generated resumes (heading spellings, sections with no entries): every entry under its own kind, no heading an entry, unread sections named`, () => {
  const rep = report("resumes");
  for (const rs of RESUMES) {
    rep.total++;
    const name = () => `${rs.family}: ${JSON.stringify(rs.text.slice(0, 500))}`;
    const { drafts, unread } = P.parseResumeSections(rs.text);
    // deno-lint-ignore no-explicit-any
    const got = drafts.map((d: any) => `${d.kind}|${titleOf(d)}`).sort();
    const want = rs.entries.map((e) => `${e.kind}|${e.title}`).sort();
    check(rep, JSON.stringify(got) === JSON.stringify(want), "entries read are not the resume's entries (a heading read as an entry, or an entry under the wrong kind)",
      () => `${name()}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
    check(rep, JSON.stringify(unread) === JSON.stringify(rs.unread), "unread sections not named exactly", () => `${name()} -> ${JSON.stringify(unread)} want ${JSON.stringify(rs.unread)}`);
    // The router's ingest names the unread sections and presents every entry, word for word.
    let snap: unknown = null;
    const ctx = host.createTurnCtx({ userId: "TEST-onb", threadId: "t", now: NOW, accountPersistence: true, snapshot: snap, account: { epoch: 0, version: 0, paused: false }, postings: [] });
    const out = host.runTurn(pasted(rs), ctx);
    snap = host.extractSnapshot(ctx);
    check(rep, out.intent === "career_resume_ingest" && out.resultStatus === "awaiting_user", "a resume paste was not read as a resume", () => `${name()} -> ${out.intent}/${out.resultStatus}: ${out.reply.slice(0, 200)}`);
    // deno-lint-ignore no-explicit-any
    const facts = (ctx.profile?.facts ?? []) as any[];
    check(rep, facts.length === rs.entries.length && facts.every((f) => f.needs_confirmation === true && f.status === "draft"), "a paste confirmed something, or lost an entry", () => `${name()} -> ${facts.map((f) => `${f.status}:${f.kind}|${titleOf(f)}`).join("; ")}`);
    for (const f of facts) check(rep, out.reply.replace(/\s+/g, " ").includes(String(f.text).replace(/\s+/g, " ")), "an entry was not shown word for word", () => `${name()} -> ${f.text}`);
    for (const u of rs.unread) check(rep, out.reply.includes(u), "an unread section was not named to the person", () => `${name()} -> ${u}: ${out.reply.slice(0, 300)}`);
  }
  console.log(`[onboarding] resumes by family: ${JSON.stringify(Object.fromEntries([...new Set(RESUMES.map((r) => r.family))].sort().map((k) => [k, RESUMES.filter((r) => r.family === k).length])))}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ replies
const REPLIES = replies(rng(SEED + 1), 3500);
Deno.test(`replies: ${REPLIES.length} generated replies to the entries shown: only a plain yes confirms; a correction carries exactly what it changes`, () => {
  const rep = report("replies");
  for (const c of REPLIES) {
    rep.total++;
    const got = P.confirmationReply(c.input);
    check(rep, got.kind === c.kind, `${c.kind} read as ${got.kind}`, () => `${c.family}: ${JSON.stringify(c.input)} -> ${JSON.stringify(got)}`);
    if (c.kind === "correction" && got.kind === "correction") {
      check(rep, got.from === c.from && got.to === c.to, "a correction read with the wrong values", () => `${JSON.stringify(c.input)} -> ${JSON.stringify(got)} want ${c.from} -> ${c.to}`);
    }
  }
  const by = (k: string) => REPLIES.filter((c) => c.kind === k).length;
  console.log(`[onboarding] replies: yes ${by("yes")}, unclear ${by("unclear")}, no ${by("no")}, correction ${by("correction")}, other ${by("other")}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ journeys
const JOURNEYS = journeys(rng(SEED + 2), 1500);
Deno.test(`journeys: ${JOURNEYS.length} generated first conversations (${JOURNEYS.reduce((a, j) => a + j.steps.length, 0)} turns) through the career host: the profile holds exactly what the person confirmed`, () => {
  const rep = report("journeys");
  let turns = 0;
  for (const j of JOURNEYS) {
    rep.total++;
    let snap: unknown = null, t = NOW;
    const say = (text: string) => {
      const ctx = host.createTurnCtx({ userId: "TEST-onb", threadId: `t-${j.id}`, now: (t += 60_000), accountPersistence: true, snapshot: snap, account: { epoch: 0, version: 0, paused: false }, postings: [] });
      const out = host.runTurn(text, ctx);
      snap = host.extractSnapshot(ctx);
      turns++;
      // deno-lint-ignore no-explicit-any
      return { out, facts: ((ctx.profile?.facts ?? []) as any[]).filter((f) => f && f.source === "resume-ingest") };
    };
    const m = newModel();
    const log: string[] = [];
    const name = () => `journey ${j.id} [${j.family}]\n      ${log.join("\n      ")}`;
    for (const s of j.steps) {
      const input = s.t === "paste" ? pasted(s.which === "B" ? j.b : j.a, s.lead) : s.input;
      const { out, facts } = say(input);
      log.push(`${JSON.stringify(input.slice(0, 70))} -> ${out.intent}/${out.resultStatus}: ${String(out.reply).slice(0, 140).replace(/\n/g, " | ")}`);
      modelStep(m, s, j);
      // The product's state against the model.
      const conf = facts.filter((f) => f.needs_confirmation === false), drafts = facts.filter((f) => f.needs_confirmation === true);
      const got = (xs: typeof facts) => xs.map((f) => `${f.kind}|${titleOf(f)}`).sort();
      check(rep, JSON.stringify(got(conf)) === JSON.stringify(sig(m.confirmed)), `${s.t}: the confirmed entries are not what the person confirmed`,
        () => `${name()}\n      confirmed ${JSON.stringify(got(conf))}\n      model     ${JSON.stringify(sig(m.confirmed))}`);
      check(rep, JSON.stringify(got(drafts)) === JSON.stringify(sig(m.pending ? m.pending.entries : null)), `${s.t}: the draft entries are not the latest paste's (as corrected)`,
        () => `${name()}\n      drafts ${JSON.stringify(got(drafts))}\n      model  ${JSON.stringify(sig(m.pending ? m.pending.entries : null))}`);
      check(rep, new Set(got(conf)).size === conf.length, "an entry confirmed twice", () => name());
      if (s.t === "yes" && out.intent === "career_resume_ingest" && out.resultStatus === "completed") check(rep, m.confirmed !== null && m.pending === null, "the reply says confirmed, the model does not", () => name());
      if (s.t !== "yes" && s.t !== "paste") check(rep, out.resultStatus !== "completed" || out.intent !== "career_resume_ingest", `${s.t} reported a confirmation`, () => name());
      // A read-back carries only the confirmed resume's school and GPA, never a draft's or the replaced resume's.
      if (s.t === "question") {
        const held = (m.confirmed ?? []).map((e) => e.title).join(" ");
        for (const v of [j.a.school, j.a.gpa, j.b.school, j.b.gpa, ...(m.pending?.entries ?? []).filter((e) => e.kind === "education").map((e) => e.title)]) {
          check(rep, !String(out.reply).includes(v) || held.includes(v), "a value not on the confirmed resume was read back", () => `${name()}\n      ${JSON.stringify(v)} is not confirmed`);
        }
      }
    }
    // The end: what they asked about their school is the confirmed resume's, or not on record.
    const { out } = say("where did I go to school?");
    const edu = (m.confirmed ?? []).find((e) => e.kind === "education");
    if (edu) check(rep, String(out.reply).includes(edu.title.split(/ - |, | \| /)[0]), "the confirmed school is not read back", () => `${name()}\n      -> ${out.reply.slice(0, 200)}`);
    else check(rep, /not on your record|have not stated|not stored|don't have|do not have/i.test(String(out.reply)), "no confirmed school, but not said so", () => `${name()}\n      -> ${out.reply.slice(0, 200)}`);
    for (const v of [j.a.school, j.b.school]) if (!edu || !edu.title.includes(v)) check(rep, !String(out.reply).includes(v), "an unconfirmed or replaced school read back", () => `${name()}\n      ${v} -> ${out.reply.slice(0, 200)}`);
  }
  console.log(`[onboarding] journeys: ${JOURNEYS.length} people, ${turns} turns; families ${new Set(JOURNEYS.map((j) => j.family)).size}`);
  done(rep);
});

// ------------------------------------------------------------------------------------------------ evidence
// The handler's evidence step after a correction: rows newest first, as the handler reads them.
const memEvents = () => { const rows: any[] = []; return { rows, store: { add: async (e: any) => void rows.push(e) } }; };
const EVIDENCE = Array.from({ length: 1000 }, (_, i) => i);
Deno.test(`evidence: ${EVIDENCE.length} corrected confirmations through the evidence step: a corrected entry is traced to the upload and the correction, never to words the person did not give`, async () => {
  const rep = report("evidence");
  for (const i of EVIDENCE) {
    rep.total++;
    const r = rng(SEED + 30_000 + i);
    const rs = resume(r, 0, { skipSections: false });
    const prof = P.createProfile({});
    const upload = pasted(rs);
    P.ingestResume(prof, upload);
    const before = structuredClone(prof);
    // A correction of one entry's value, shown again; then the yes.
    const pick = r.pick([...rs.titles, ...rs.companies, rs.gpa]);
    const to = r.pick(["Senior Analyst (TEST)", "Globex (TEST)", "3.99", "Data Engineer"]);
    const said = r.int(0, 3); // 0: the correction is in their messages; 1: it is not (a value they never typed); 2: two corrections; 3: no correction at all
    // deno-lint-ignore no-explicit-any
    const f = prof.facts.find((x: any) => [x.title, ...(x.bullets ?? [])].some((y: string) => y.includes(pick)));
    if (said !== 3) {
      for (const k of ["title", "text"]) f[k] = f[k].split(pick).join(to);
      f.bullets = (f.bullets ?? []).map((b: string) => b.split(pick).join(to));
      f.corrections = [{ from: pick, to }];
    }
    for (const x of prof.facts) { x.needs_confirmation = false; x.status = "confirmed"; }
    const correction = said === 0 || said === 2 ? `my title was ${to} not ${pick}` : "ok";
    // deno-lint-ignore no-explicit-any
    const shownText = prof.facts.map((x: any, k: number) => `${k + 1}. ${x.text}`).join("\n");
    const rows = [
      { id: 6, role: "user", content: "yes" },
      { id: 5, role: "assistant", content: `Changed.\n${shownText}` },
      { id: 4, role: "user", content: correction },
      { id: 3, role: "assistant", content: shownText },
      { id: 2, role: "user", content: upload },
      { id: 1, role: "assistant", content: "hi" },
    ];
    const ctxs = await resumeConfirmationContext(rows, prof);
    const ev = memEvents();
    const res = await evidenceResumeConfirmation({ userId: "TEST-u", now: NOW, message: "yes", before, after: prof, out: { intent: "career_resume_ingest", resultStatus: "completed" },
      shown: ctxs.shown, upload: ctxs.upload, said: ctxs.said, events: ev.store as any });
    const name = () => `${rs.family} said=${said} ${pick} -> ${to}: ${JSON.stringify(res)}`;
    check(rep, !!ctxs.upload && ctxs.upload.ref === "agent_messages:2", "the upload was not found", () => `${name()} ${JSON.stringify(ctxs.upload?.ref)}`);
    if (said === 1) check(rep, res.held.includes(f.id) && res.stamped === prof.facts.length - 1, "a value the person never typed was evidenced", () => name());
    else check(rep, res.held.length === 0 && res.stamped === prof.facts.length, "a corrected (or plain) entry the person gave was not evidenced", () => name());
    // Every stamped fact names a recorded event; a held one is a draft again.
    // deno-lint-ignore no-explicit-any
    for (const x of prof.facts as any[]) check(rep, res.held.includes(x.id) ? x.needs_confirmation === true && !x.confirmation_event_id : ev.rows.some((e) => e.detail.confirmation_event_id === x.confirmation_event_id), "stamp and event disagree", () => `${name()} ${x.id}`);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ secrets
const SECRETS = Array.from({ length: 600 }, (_, i) => resume(rng(SEED + 40_000 + i), 0, { secret: true }));
Deno.test(`secrets: ${SECRETS.length} resumes with an SSN, password or card number typed in: removed at the input, on no fact, the rest still read`, () => {
  const rep = report("secrets");
  for (const rs of SECRETS) {
    rep.total++;
    const red = redactIdentity(pasted(rs));
    const v = rs.secret!.value;
    const joined = (s: string) => s.replace(/(\d)[ -](?=\d)/g, "$1");
    check(rep, !joined(red.text).includes(joined(v)), "the secret survived the input step", () => `${rs.family}: ${v} in ${red.text.slice(0, 300)}`);
    check(rep, red.removed.length > 0, "the person is not told what was removed", () => `${rs.family}: ${v}`);
    const ctx = host.createTurnCtx({ userId: "TEST-onb", threadId: "t", now: NOW, accountPersistence: true, snapshot: null, account: { epoch: 0, version: 0, paused: false }, postings: [] });
    const out = host.runTurn(red.text, ctx);
    // deno-lint-ignore no-explicit-any
    const facts = (ctx.profile?.facts ?? []) as any[];
    check(rep, out.intent === "career_resume_ingest" && facts.length === rs.entries.length, "the rest of the resume was not read", () => `${rs.family}: ${out.intent} ${facts.length}/${rs.entries.length}`);
    check(rep, !facts.some((f) => joined(JSON.stringify(f)).includes(joined(v))) && !joined(String(out.reply)).includes(joined(v)), "a secret is on a fact or in the reply", () => `${rs.family}: ${v}`);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ brain
const BRAIN = replies(rng(SEED + 3), 1000).filter((c) => c.kind !== "correction");
Deno.test(`brain: ${BRAIN.length} replies to a fact shown: the agent's confirm_profile_fact confirms only on a plain yes`, async () => {
  const rep = report("brain");
  // deno-lint-ignore no-explicit-any
  const tool = careerTools({ postings: async () => [] } as any).find((t) => t.name === "confirm_profile_fact")!;
  for (const c of BRAIN) {
    rep.total++;
    const profile = P.createProfile({ facts: [{ id: "F-001", kind: "education", text: "BS Statistics at Lakeview College (TEST)", status: "draft", needs_confirmation: true }] });
    let refused = false;
    // deno-lint-ignore no-explicit-any
    try { await tool.run({ id: "F-001" }, { userId: "TEST-U", threadId: "TEST-T", now: NOW, state: { profile }, turn: { message: c.input, added: [] } } as any); } catch { refused = true; }
    const confirmed = profile.facts[0].needs_confirmation === false;
    // The brain's own reader may refuse a yes it does not know (it never confirms more than the shared reader allows).
    check(rep, c.kind === "yes" || (!confirmed && refused), `a ${c.kind} reply confirmed the fact`, () => `${c.family}: ${JSON.stringify(c.input)}`);
  }
  done(rep);
});

Deno.test("the generators cover every shape (resume families, reply kinds, journey steps)", () => {
  for (const f of ["first", "second", "first+unread", "second+unread"]) assertNode.ok(RESUMES.some((r) => r.family === f), f);
  for (const k of ["ssn", "password", "card"]) assertNode.ok(SECRETS.some((r) => r.secret?.kind === k), k);
  for (const k of ["yes", "unclear", "no", "correction", "other"]) assertNode.ok(REPLIES.filter((c) => c.kind === k).length >= 50, k);
  const steps = new Set(JOURNEYS.flatMap((j: Journey) => j.steps.map((s) => s.t === "paste" ? `paste:${s.which}` : s.t === "correct" ? `correct:${s.target}` : s.t)));
  for (const s of ["paste:A", "paste:B", "paste:A-again", "yes", "unclear", "no", "correct:unique", "correct:missing", "question", "other"]) assertNode.ok(steps.has(s), s);
  const total = RESUMES.length + REPLIES.length + JOURNEYS.length + EVIDENCE.length + SECRETS.length + BRAIN.length;
  console.log(`[onboarding] total generated scenarios: ${total} (journey turns: ${JOURNEYS.reduce((a, j) => a + j.steps.length + 1, 0)})`);
  assertNode.ok(total >= 8000, `${total}`);
});
