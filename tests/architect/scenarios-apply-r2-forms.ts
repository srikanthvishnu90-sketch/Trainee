// Round 2, hostile employer forms through the REAL apply stack (owner rules, binding: exactly the approved payload; each
// posting submitted at most once per person, ever; never without a confirmed resume; a verification check stops and goes
// to the person, never solved; never LinkedIn, Indeed or Handshake; every state shown honestly). ~2,400 generated forms
// (tests/architect/scenarios/apply-r2-generator.ts formCases, seeded) each prepared and approved the way the person's
// card is (approve-first.ts prepare: the engine's dry run, the payload and its hash), the world then turned against it,
// and the approved application driven by the person's own computer (approve-first.ts runApproved) or the cloud worker
// (career-cloud/worker.ts runCloudJob), each running the real engine (scripts/apply.ts runApply) in this process over a
// fake browser (scenarios/apply-r2-browser.ts) whose in-page functions are the engine's own. The employer's site records
// every application body it receives; the tests judge by that record:
//   - at most one application body per posting, ever, across the prepare, the drive and a second drive of the same job;
//   - a body only for an approved card, carrying exactly its answers and its resume (by hash) and, beside them, only the
//     page's own hidden fields with the values the page set; never an identity number, a password, a honeypot, a birth
//     date, demographics or salary history the person never gave for that question;
//   - nothing sent when the form changed after the yes (a field renamed, added or given another name, an option removed),
//     when it asks for a password or an identity number, when a hidden field consents for the person, when a check shows
//     at open, after Next or at the click, when the posting redirects to LinkedIn, Indeed or Handshake, when the site
//     refuses for load, when the page's script changes an answer, adds a field or swaps the file at the click, when an
//     answer does not fit the box (maxlength) or the page rewrites it, when the resume's bytes changed after the yes;
//   - the state is the truth: never "not submitted" (which may be sent again) once the employer took the body; "unknown"
//     for a page that does not say (the same page, the form again, a check or a redirect after the send, "you already
//     applied", an error in thank-you words, a 500); "confirmed" only on the employer's own thank-you; never a hand-back
//     ("finish it yourself at the link") after the application went; an identity question is never asked by text.
import assertNode from "node:assert/strict";
import { type FormCase, formCases, NOW, SEED } from "./scenarios/apply-r2-generator.ts";
import { chosen, factsFile, inProcessEngine, type World, world } from "./scenarios/apply-r2-world.ts";
import { type Job, prepare, questionsToStore, runApproved } from "../../workers/career-browser/approve-first.ts";
import { type CloudJob, type CloudQueue, runCloudJob, settle } from "../../workers/career-cloud/worker.ts";
import { handBack, isBotCheck, retryAfterSeconds } from "../../workers/career-browser/mass-run.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { NEVER_BY_TEXT } from "../../supabase/functions/_shared/question_map.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
export const FORMS = Number(Deno.env.get("R2_FORMS") ?? 2400);
export const FORM_PARTS = 2;
const ONLY = Deno.env.get("R2_ONLY");

// The twists that must stop before anything is sent, whatever the page says after.
const STOPS = new Set(["rename_label", "add_required", "remove_option", "rename_name", "password", "identity", "hidden_consent", "captcha_open", "captcha_next", "captcha_click",
  "redirect_open", "refuse_open", "click_rewrite", "click_add_field", "click_swap_file", "maxlength", "reformat", "resume_swap", "fact_edit", "other_approval"]);
// What the employer's page after the one body means: the only honest states.
export function expectedAfterSend(c: FormCase): string[] {
  if (c.twist === "captcha_after" || c.twist === "redirect_after") return ["unknown_outcome"];
  const moved = c.action === "other";
  switch (c.after) {
    case "thanks": case "thanks_id": return ["confirmed"];
    case "moved_silent": return ["submitted_unconfirmed"];
    case "same_silent": case "foreign_thanks": return moved ? ["submitted_unconfirmed"] : ["unknown_outcome"];
    case "form_again": case "dup": case "error_words": case "http500": return ["unknown_outcome"];
    case "errors": return ["failed"];
    case "email_code": return ["needs_user"];
  }
}
const SECRET_KINDS = new Set(["identity", "password", "honeypot", "sensitive"]);

type Report = { name: string; total: number; fails: Map<string, string[]>; counts: Record<string, number> };
function check(rep: Report, ok: boolean, kind: string, detail: () => string) {
  if (ok) return;
  if (!rep.fails.has(kind)) rep.fails.set(kind, []);
  rep.fails.get(kind)!.push(detail());
}
function done(rep: Report) {
  const n = [...rep.fails.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[apply r2] ${rep.name}: ${rep.total} scenarios, ${n} failures; ${JSON.stringify(rep.counts)}`];
  for (const [k, xs] of rep.fails) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x.slice(0, 500)}`); }
  console.log(lines.join("\n"));
  eq(n, 0, lines.join("\n"));
}

// The cloud worker's queue in memory: the job's resume, its finish and the questions it asks.
function memoryCloud(w: World, rec: { finish?: { state: string; evidence: any; outcome: string }; asked: Record<string, unknown>[] }): CloudQueue {
  return {
    claim: async () => [], authorize: async () => {}, gatePresent: async () => true,
    // The resume the queue keeps for the job: after a resume_swap, another file's bytes under the approved hash.
    resume: async () => {
      const bytes = w.c.twist === "resume_swap" && w.phase === "submit" ? await Deno.readFile(w.resumePath) : w.resumeBytes;
      return { filename: "resume.pdf", sha256: w.resumeSha, b64: btoa(String.fromCharCode(...bytes)) };
    },
    ask: async (_j, qs) => { rec.asked.push(...qs); return qs.length; },
    finish: async (_j, state, evidence, outcome) => { rec.finish = { state, evidence, outcome }; },
  };
}

export async function runForm(c: FormCase, root: string, rep: Report) {
  const clock = () => NOW + c.n * 60_000;
  const w = await world(c, root);
  const engine = inProcessEngine(w, clock);
  const name = () => `#${c.n} ${c.twist}/${c.after} lang=${c.lang} pages=${c.pages} action=${c.action}${c.extraLabel ? ` extra=${JSON.stringify(c.extraLabel)}` : ""}`;
  rep.total++;
  // 1. The card: the engine's dry run, the payload, its hash (what the person's yes approves).
  const prep = await prepare({ url: c.posting, factsPath: w.factsPath, resumePath: w.resumePath, account: { epoch: 0, version: 0 }, now: NOW, runEngine: engine });
  const prepResult: any = prep.ready ? null : prep.result;
  check(rep, w.posts.length === 0, "the dry run sent the application", () => `${name()} -> ${w.posts.length} bodies`);
  // Asked by text after the stop: never an identity number or a password (ask-once.ts questionsToStore, as both workers ask).
  if (prepResult?.reason === "needs_answers") {
    const { questions } = questionsToStore({ ...prepResult, posting: prepResult.posting ?? c.posting }, { facts: {}, answered: new Set() });
    const asked = questions.map((q: any) => String(q.label));
    if (c.twist === "identity") check(rep, !asked.some((l) => l === c.extraLabel || l.includes(c.extraLabel!)), "an identity number asked by text", () => `${name()} -> asked ${JSON.stringify(asked)}`);
    if (c.twist === "password") check(rep, !asked.some((l) => /password/i.test(l)), "a password asked by text", () => `${name()} -> asked ${JSON.stringify(asked)}`);
    if (c.twist === "honeypot_words") check(rep, !asked.includes(c.extraLabel!), "a honeypot asked of the person", () => `${name()} -> asked ${JSON.stringify(asked)}`);
  }
  if (c.twist === "identity" || c.twist === "password") {
    check(rep, !prep.ready, `${c.twist}: a card was made for a form that asks for it`, () => `${name()} -> ${JSON.stringify(prep.ready ? (prep as any).payload.fields.map((f: any) => f.label) : prepResult)}`);
    if (c.twist === "identity") check(rep, prepResult?.reason === "IDENTITY_NUMBER_REQUESTED", "identity: the engine did not stop on the identity number", () => `${name()} -> ${JSON.stringify({ reason: prepResult?.reason, questions: prepResult?.questions?.map((q: any) => q.label) })}`);
    if (c.twist === "password") check(rep, prepResult?.reason === "ACCOUNT_LOGIN_REQUIRED", "password: the engine did not stop on the password box", () => `${name()} -> ${JSON.stringify(prepResult?.reason)}`);
  }
  if (c.twist === "maxlength" || c.twist === "reformat") check(rep, !prep.ready, `${c.twist}: approved an answer the page does not keep as given`, () => `${name()} -> ${JSON.stringify((prep as any).card)}`);
  if (c.twist === "captcha_open") check(rep, !prep.ready && prepResult?.state === "needs_user" && prepResult?.reason === "captcha", "captcha at open: not handed to the person", () => `${name()} -> ${JSON.stringify(prepResult)}`);
  if (c.twist === "redirect_open") check(rep, !prep.ready && prepResult?.reason === "HOST_REDIRECT_REFUSED", "redirect at open: not refused", () => `${name()} -> ${JSON.stringify(prepResult)}`);
  if (c.twist === "refuse_open") {
    check(rep, !prep.ready && prepResult?.reason === "HOST_RATE_LIMITED" && prepResult?.retry_after_s === retryAfterSeconds(c.refuse!.retryAfter || null, clock()),
      "refused for load at open: not recorded with the host's own wait", () => `${name()} retry-after ${JSON.stringify(c.refuse)} -> ${JSON.stringify(prepResult)}`);
  }
  if (prep.ready) {
    const payload: any = (prep as any).payload;
    const card: string[] = (prep as any).card;
    for (const f of c.fields.filter((x) => SECRET_KINDS.has(String(x.kind)))) {
      check(rep, !payload.fields.some((p: any) => p.name === f.name && String(p.value ?? "").trim()), `${f.kind}: on the card with a value`, () => `${name()} -> ${JSON.stringify(payload.fields.find((p: any) => p.name === f.name))}`);
    }
    if (c.twist === "none" && c.lang === "en") rep.counts.none_ready = (rep.counts.none_ready ?? 0) + 1;
    // 2. The world turns against the approved application.
    w.phase = "submit";
    let job: Job = { id: crypto.randomUUID(), lease_token: crypto.randomUUID(), url: c.posting, user_id: c.person.id, payload };
    let resumeFor = async () => ({ path: w.resumePath, sha256: payload.resume_sha256 });
    if (c.twist === "resume_swap") await Deno.writeFile(w.resumePath, new TextEncoder().encode("%PDF-1.4 TEST another resume, swapped after the yes"));
    if (c.twist === "fact_edit") {
      const i = payload.fields.findIndex((f: any) => typeof f.value === "string" && !/^[0-9a-f]{64}$/.test(f.value));
      const p2 = structuredClone(payload);
      p2.fields[i].value = `${p2.fields[i].value} (edited)`;
      if (p2.fields[i].source?.value !== undefined) p2.fields[i].source.value = p2.fields[i].value;
      job = { ...job, payload: p2 };
      await Deno.writeTextFile(w.factsPath, JSON.stringify(factsFile(c, true)));
    }
    if (c.twist === "other_approval") job = { ...job, payload: { ...payload, engine_approval: (await hashApplyPayload({ other: c.n })) } };
    const cloud = c.n % 3 === 2;
    let final: { state: string; reason?: string; evidence?: any; outcome?: string };
    const drive = async () => {
      if (cloud) {
        const rec: { finish?: any; asked: Record<string, unknown>[] } = { asked: [] };
        const h = await hashApplyPayload(job.payload);
        const cj: CloudJob = { id: job.id, lease_token: job.lease_token, user_id: c.person.id, company: job.payload.company, url: job.url, payload: job.payload,
          payload_hash: h, approval_hash: h, job_id: job.payload.job_id };
        const r = await runCloudJob(cj, { queue: memoryCloud(w, rec), runEngine: engine, log: () => {}, now: clock });
        for (const q of rec.asked) check(rep, !NEVER_BY_TEXT.test(String((q as any).label)) && !(c.twist === "identity" && String((q as any).label).includes(c.extraLabel!)), "the cloud asked an identity question by text", () => `${name()} -> ${JSON.stringify(q)}`);
        return { state: r.state, reason: r.reason, evidence: rec.finish?.evidence, outcome: r.outcome };
      }
      let fin: any = null;
      await runApproved({ claim: async () => [job], finish: async (_id, _l, state, evidence) => { fin = { state, evidence }; }, resumeFor, writeFacts: async (_j, facts) => {
        const p = `${w.dir}/approved-facts-${crypto.randomUUID()}.json`;
        await Deno.writeTextFile(p, JSON.stringify(facts));
        return p;
      }, runEngine: engine });
      return { state: fin.state, reason: fin.evidence?.reason ?? undefined, evidence: fin.evidence };
    };
    final = await drive();
    if (ONLY) console.log(JSON.stringify({ fields: c.fields.map((f) => [f.name, f.label, f.type, f.required, f.page, f.options]), payload: payload.fields.map((f: any) => [f.name, f.label, f.value]), final, posts: w.posts.map((p) => p.entries) }, null, 1));
    if (c.twist === "twice") { const second = await drive(); rep.counts.twice = (rep.counts.twice ?? 0) + 1; void second; }
    void resumeFor;
    rep.counts[cloud ? "cloud" : "own"] = (rep.counts[cloud ? "cloud" : "own"] ?? 0) + 1;
    // 3. The employer's record against the approved card.
    check(rep, w.posts.length <= 1, "the employer got the application more than once", () => `${name()} -> ${w.posts.length} bodies, final ${final.state}`);
    if (STOPS.has(c.twist)) check(rep, w.posts.length === 0, `${c.twist}: sent anyway`, () => `${name()} -> final ${final.state} ${final.reason}; body ${JSON.stringify(w.posts[0]?.entries)}`);
    if (c.twist === "none" && c.lang === "en") check(rep, w.posts.length === 1, "none: a plain approved application was not sent", () => `${name()} -> ${final.state} ${final.reason}`);
    const body = w.posts[0];
    if (body) {
      rep.counts.sent = (rep.counts.sent ?? 0) + 1;
      const got = new Map<string, unknown[]>();
      for (const [k, v] of body.entries) got.set(k, [...(got.get(k) ?? []), v]);
      const fileField = c.fields.find((f) => f.kind === "resume")!;
      const approvedNames = new Set<string>();
      for (const f of payload.fields) {
        approvedNames.add(f.name);
        const spec = c.fields.find((x) => x.name === f.name || (!x.name && x.id === f.name)) ?? c.fields.find((x) => x.id === f.name);
        const sent = got.get(f.name) ?? [];
        if (spec?.type === "file") { check(rep, sent.length === 1 && (sent[0] as any)?.sha256 === payload.resume_sha256, "the resume sent is not the approved file", () => `${name()} -> ${JSON.stringify(sent)} vs ${payload.resume_sha256}`); continue; }
        const want = spec?.type === "checkbox" ? null : spec?.options ? (spec.options.find((o) => o.value === f.value || o.label === f.value)?.value ?? f.value) : f.value;
        if (want !== null) check(rep, sent.length === 1 && sent[0] === want, "an approved answer was not sent exactly", () => `${name()} field ${f.name} (${f.label}) approved ${JSON.stringify(f.value)} -> sent ${JSON.stringify(sent)}`);
      }
      check(rep, (got.get(fileField.name) ?? []).length === 1 && ((got.get(fileField.name)![0] as any).sha256 === payload.resume_sha256), "no confirmed resume in the body", () => `${name()} -> ${JSON.stringify(got.get(fileField.name))}`);
      for (const [k, vs] of got) {
        if (approvedNames.has(k) || k === fileField.name) continue;
        for (const v of vs) {
          const pageSet = c.hidden.some(([n, hv]) => n === k && hv === v);
          check(rep, pageSet || v === "" || (typeof v === "object" && (v as any).size === 0), "a value the person never approved was sent", () => `${name()} -> ${k}=${JSON.stringify(v)}`);
        }
      }
      for (const f of c.fields.filter((x) => SECRET_KINDS.has(String(x.kind)))) {
        check(rep, !(got.get(f.name) ?? []).some((v) => typeof v === "string" && v.trim()), `${f.kind}: filled on the employer's form`, () => `${name()} -> ${f.name}=${JSON.stringify(got.get(f.name))}`);
      }
      // The truth after the one body.
      const want = expectedAfterSend(c);
      check(rep, want.includes(final.state), `after the send: ${c.twist === "captcha_after" || c.twist === "redirect_after" ? c.twist : c.after}: expected ${want.join("/")}`, () => `${name()} -> ${final.state} (${final.reason})`);
      check(rep, final.state !== "not_submitted", "the employer took it, the record says not submitted (it may be sent again)", () => `${name()} -> ${final.state} (${final.reason})`);
      check(rep, !(final.evidence?.link && final.evidence?.handed_back) && final.outcome !== "bot_check" && !(final.state === "needs_user" && /captcha|bot_check/.test(String(final.reason))),
        "handed back to the person after the application went (they would send it again)", () => `${name()} -> ${JSON.stringify({ state: final.state, reason: final.reason, outcome: final.outcome })}`);
    } else {
      check(rep, !["confirmed", "submitted_unconfirmed"].includes(final.state), "said sent with nothing received", () => `${name()} -> ${final.state} (${final.reason})`);
      if (["captcha_next", "captcha_click"].includes(c.twist)) check(rep, final.state === "needs_user", `${c.twist}: the check was not handed to the person`, () => `${name()} -> ${final.state} (${final.reason})`);
    }
    if (c.twist === "remove_option") void chosen;
  } else {
    rep.counts.not_ready = (rep.counts.not_ready ?? 0) + 1;
    const why = `not_ready:${String(prepResult?.reason ?? "").split(":")[0]}`;
    rep.counts[why] = (rep.counts[why] ?? 0) + 1;
    if (c.twist === "none" && c.lang === "en") check(rep, false, "none: a plain form was not prepared", () => `${name()} -> ${JSON.stringify(prepResult)}`);
  }
  await Deno.remove(w.dir, { recursive: true }).catch(() => {});
  void handBack; void isBotCheck; void settle;
}

export function formsTests(part: number) {
  const all = formCases(SEED, FORMS);
  const mine = all.filter((c) => (ONLY ? String(c.n) === ONLY : c.n % FORM_PARTS === part - 1));
  Deno.test({
    name: `apply r2 forms part ${part}/${FORM_PARTS}: ${mine.length} hostile forms prepared, approved, turned and driven through the real engine: the employer's record is the approved payload once, or nothing`,
    sanitizeResources: false, sanitizeOps: false,
    async fn() {
      const root = await Deno.makeTempDir({ prefix: "apply-r2-forms-" });
      const rep: Report = { name: `forms part ${part}`, total: 0, fails: new Map(), counts: {} };
      try {
        for (const c of mine) await runForm(c, root, rep);
      } finally {
        await Deno.remove(root, { recursive: true }).catch(() => {});
      }
      done(rep);
    },
  });
}
