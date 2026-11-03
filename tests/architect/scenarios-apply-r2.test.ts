// Round 2 of the apply and mass-submission batteries (architect, 2026-10-30): fresh seeds and the categories round 1
// (scenarios-apply.test.ts, scenarios-file-apply*) does not cover, on the real pure code in memory, deterministic (a
// virtual clock for the schedulers), no network, no model, no Chromium. ~10,000 generated scenarios here
// (tests/architect/scenarios/apply-r2-generator.ts), beside the ~2,400 hostile forms driven through the real engine in
// scenarios-apply-r2-forms*.test.ts and the Postgres sample in flow-scenarios-apply-r2.test.ts:
//   outcomes   3,000 pages after the one application request (thanks with and without a number, nothing on the same or
//              another address, the form again, validation errors, "you already applied", errors in thank-you words,
//              thanks in German, French and Spanish, an emailed code, a check): the engine's judge after a send
//              (career_apply.ts outcomeAfterSend) is never "not submitted" (which may be sent again), never "confirmed"
//              on a duplicate or an error page, and a check after the send is never handed back to the person; the
//              workers (settle, handBack) and the extension (outcomeAfterClick) agree
//   labels     2,400 form questions: identity numbers of many countries in many spellings are never asked by text
//              (NEVER_BY_TEXT, questionsToStore) and stop the engine (isIdentityField); a birth date, demographics,
//              salary history and honeypots are never filled from another fact; ordinary questions still are
//   status     1,200 finished applications in every state and reason: the chat's status line, the file page's word
//              and the receipt say the same truth (sent or not, confirmed or not, unknown and never resent)
//   integrity  330 approved applications and what changed after the yes (the resume's bytes or hash, a missing resume, an
//              answer changed, added or removed, the approval, the payload hash, the link, the person), driven through
//              the person's computer and the cloud worker with the real engine over the fake browser: only the unchanged
//              one reaches the employer, exactly as approved
//   scale      one person and 2,000 postings, and 2,000 people with ten each (20,000 applications), the same job on
//              Greenhouse and the employer's own careers page, one employer through Lever and Ashby, hosts refusing in
//              storms (Retry-After seconds, dates, none) and the clock jumping back an hour and forward a day: each
//              posting once per person, duplicates never queued, every refusing host held as long as it asked and then
//              resumed, nothing left behind, no number of Trainee's own
//   kills      the person's computer killed at eight points (right after the claim, at the journal's start, in the
//              engine before the send, while filling, after the send, after the engine before the record, a record whose
//              reply was lost after it committed, a record that cannot be written): each application reaches the
//              employer at most once, is never driven twice, and ends as what is known
import assertNode from "node:assert/strict";
import { CHANGES, type Change, formCase, KILL_POINTS, type KillPoint, labelCases, NOW, outcomeCases, rng, sample, scalePostings, SEED } from "./scenarios/apply-r2-generator.ts";
import { classifyField, classifyOutcome, COUNTED_STATES, outcomeAfterSend, planBatch, postingKey } from "../../supabase/functions/_shared/career_apply.ts";
import { mapQuestion, NEVER_BY_TEXT } from "../../supabase/functions/_shared/question_map.ts";
import { isIdentityField, outcomeAfterClick } from "../../extension/src/apply_core.ts";
import { type Job, ownQueue, prepare, questionsToStore, runApproved, runLoop } from "../../workers/career-browser/approve-first.ts";
import { type CloudJob, type CloudQueue, runCloudJob, settle } from "../../workers/career-cloud/worker.ts";
import { handBack, isBotCheck, type Journal, type JournalEntry, localHostGate, type MassJob, massRun, pacingFrom, retryAfterSeconds } from "../../workers/career-browser/mass-run.ts";
import { statusLine } from "../../supabase/functions/_shared/career_apply_status.ts";
import { statusOf } from "../../supabase/functions/_shared/file_page.ts";
import { receiptText } from "../../supabase/functions/_shared/career_apply_receipts.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { inProcessEngine, world } from "./scenarios/apply-r2-world.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
type Report = { name: string; total: number; fails: Map<string, string[]> };
const report = (name: string): Report => ({ name, total: 0, fails: new Map() });
function check(rep: Report, ok: boolean, kind: string, detail: () => string) {
  if (ok) return;
  if (!rep.fails.has(kind)) rep.fails.set(kind, []);
  rep.fails.get(kind)!.push(detail());
}
function done(rep: Report, extra = "") {
  const n = [...rep.fails.values()].reduce((a, b) => a + b.length, 0);
  const lines = [`[apply r2] ${rep.name}: ${rep.total} scenarios, ${n} failures${extra ? `; ${extra}` : ""}`];
  for (const [k, xs] of rep.fails) { lines.push(`  FAIL ${k}: ${xs.length}`); for (const x of xs.slice(0, 3)) lines.push(`    ${x.slice(0, 400)}`); }
  console.log(lines.join("\n"));
  eq(n, 0, lines.join("\n"));
}

// ------------------------------------------------------------------------------------------------ outcomes
const OUTCOMES = outcomeCases(SEED + 1, 3000);
Deno.test(`outcomes: ${OUTCOMES.length} pages after the one application request: never "not submitted", never confirmed on a duplicate or an error, a check after the send never handed back`, () => {
  const rep = report("outcomes");
  for (const c of OUTCOMES) {
    rep.total++;
    const name = () => `#${c.n} ${c.kind}: ${JSON.stringify({ text: c.obs.page_text, moved: c.obs.url_after !== c.obs.url_before, form: c.obs.form_present_after, captcha: c.obs.captcha, code: c.obs.email_code_prompt })}`;
    const r = outcomeAfterSend(c.obs);
    check(rep, c.expect.includes(r.state), `${c.kind}: expected ${c.expect.join("/")}`, () => `${name()} -> ${r.state} (${r.reason})`);
    check(rep, (r.state as string) !== "not_submitted", "after a send: not submitted (it may be sent again)", () => `${name()} -> ${r.reason}`);
    if (c.kind === "dup" || c.kind === "error_words") {
      check(rep, classifyOutcome(c.obs).state !== "confirmed", `${c.kind}: the page's words read as the employer's confirmation`, () => name());
      check(rep, outcomeAfterClick(c.obs).state !== "confirmed", `${c.kind}: the extension reads it as confirmed`, () => name());
    }
    if (!c.obs.captcha) check(rep, outcomeAfterClick(c.obs).state !== "not_submitted", "the extension after its click: not submitted", () => name());
    // What the workers make of the engine's result: never a hand-back or a check once the application went.
    const result = { state: r.state, reason: r.reason };
    const s = settle(result);
    check(rep, !isBotCheck(result) && handBack(result) === null && s.outcome !== "bot_check" && s.state === r.state,
      "the worker hands a sent application back to the person", () => `${name()} -> ${JSON.stringify(s)}`);
  }
  done(rep, JSON.stringify(Object.fromEntries([...new Set(OUTCOMES.map((c) => c.kind))].map((k) => [k, OUTCOMES.filter((c) => c.kind === k).length]))));
});

// ------------------------------------------------------------------------------------------------ labels
const LABELS = labelCases(SEED + 2, 2400);
const ownFact = (k: string, v: string) => ({ value: v, factId: `F-${k}`, confirmed: true, user_id: "u-r2", provenance: "owner stated in chat 2026-10-20", confirmation_event_id: `evt-${k}` });
const ALL_FACTS = { first_name: "Test", last_name: "Person", email: "t.person@example.test", phone: "+1 555 0100", linkedin: "https://www.linkedin.com/in/t-person", website: "https://t.example.test",
  sponsorship: "No", work_authorization: "Yes", salary_expectation: "$95,000", city: "Austin" } as Record<string, string>;
Deno.test(`labels: ${LABELS.length} questions: identity numbers never asked by text and stop the engine; birth date, demographics, salary history and honeypots never filled from another fact; ordinary questions still answered`, () => {
  const rep = report("labels");
  const answers = Object.fromEntries(Object.entries(ALL_FACTS).map(([k, v]) => [k, ownFact(k, v)]));
  for (const c of LABELS) {
    rep.total++;
    const name = () => `#${c.n} ${c.family} ${JSON.stringify(c.label)} ${c.required ? "required" : "optional"}`;
    const field = { name: "q", label: c.label, type: "text", required: c.required, options: [] as { label: string; value: string }[] };
    const plan = planBatch({ userId: "u-r2", postings: [{ job_id: "local:1", company: "Acme", title: "", fields: [field] }], answers, saved: {}, log: [], now: NOW });
    const filled = (plan.ready[0]?.fields ?? []).find((f: any) => f.name === "q");
    const asked = questionsToStore({ posting: "local:1", questions: [{ label: c.label, type: "input_text", options: [] }] }, { facts: {}, answered: new Set() }).questions;
    if (c.family === "identity") {
      check(rep, NEVER_BY_TEXT.test(c.label), "an identity number may be asked by text (NEVER_BY_TEXT)", name);
      check(rep, asked.length === 0, "an identity number is stored as a question to ask by text", name);
      check(rep, isIdentityField({ label: c.label }), "the engine would not stop on it (isIdentityField)", name);
      check(rep, !filled, "an identity number was filled", () => `${name()} -> ${JSON.stringify(filled)}`);
    } else if (c.family === "sensitive" || c.family === "honeypot") {
      check(rep, !filled || !String(filled.value ?? "").trim(), `${c.family}: filled from another fact`, () => `${name()} -> ${JSON.stringify(filled?.value)} (${classifyField(c.label, "text")}, ${mapQuestion({ label: c.label, type: "text", options: [] }).fact})`);
      if (c.family === "honeypot") check(rep, classifyField(c.label, "text") === "unknown" && mapQuestion({ label: c.label, type: "text", options: [] }).fact === "unknown", "a honeypot maps to a fact", name);
    } else {
      check(rep, !NEVER_BY_TEXT.test(c.label) && !isIdentityField({ label: c.label }), "an ordinary question read as an identity number", name);
      check(rep, !!filled && Object.values(ALL_FACTS).includes(String(filled.value)), "an ordinary question the person answered was not filled", () => `${name()} -> ${JSON.stringify(plan.needs ?? plan)}`);
    }
  }
  // Words that only look like identity numbers: never refused.
  for (const l of ["¿Puedes trabajar sin patrocinio de visa?", "Trabajo sin supervisión", "Business identity statement", "Spinning up new teams"]) {
    rep.total++;
    check(rep, !NEVER_BY_TEXT.test(l), "a question read as an identity number", () => l);
  }
  done(rep, JSON.stringify(Object.fromEntries(["identity", "sensitive", "honeypot", "control"].map((f) => [f, LABELS.filter((c) => c.family === f).length]))));
});

// ------------------------------------------------------------------------------------------------ status
type Row = { id: string; company: string; state: string; reason: string | null; confirmation_id?: string | null; created_at: string; updated_at: string; url: string };
const STATUS_ROWS: Row[] = (() => {
  const r = rng(SEED + 3), out: Row[] = [];
  const reasons: Record<string, (string | null)[]> = {
    confirmed: [null, "employer confirmation on the page"], submitted_unconfirmed: [null, "the page moved and the form is gone, but the employer said nothing yet"],
    unknown_outcome: ["READBACK_REQUIRED", "after the application was sent, the employer's page says an application is already on file; whether this one was taken is not known; counted as applied, never sent again",
      "a verification check showed after the application was sent; whether the employer took it is not known; never sent again", "the worker stopped while this application ran; not retried"],
    needs_user: ["email_code", "captcha", "bot_check", "login_required"],
    not_submitted: ["APPROVED_APPLICATION_CHANGED", "IDENTITY_NUMBER_REQUESTED", "ACCOUNT_LOGIN_REQUIRED", "HOST_REDIRECT_REFUSED", "needs_answers", "APPROVED_BODY_MISMATCH", "RESUME_CHANGED"],
    failed: ["Please complete this required field."],
  };
  const states = Object.keys(reasons);
  for (let i = 0; i < 1200; i++) {
    const state = states[i % states.length], reason = r.pick(reasons[state]);
    out.push({ id: `r${i}`, company: r.pick(["Acme", "Contoso", "Northwind Traders", "Fabrikam"]), state, reason, confirmation_id: state === "confirmed" && r.next() < 0.5 ? `APP-${r.int(10000, 99999)}` : null,
      created_at: "2026-10-29T10:00:00Z", updated_at: "2026-10-30T11:00:00Z", url: `https://job-boards.greenhouse.io/acme/jobs/${r.int(1000, 9999)}` });
  }
  return out;
})();
Deno.test(`status: ${STATUS_ROWS.length} finished applications: the chat, the file page and the receipt tell the same truth`, () => {
  const rep = report("status");
  const RAW = /\b(email_code|bot_check|login_required|captcha)\b(?! check)/;
  for (const row of STATUS_ROWS) {
    rep.total++;
    const chat = statusLine(row as any), page = statusOf({ app: row as any, wanted: false })!, receipt = receiptText(row);
    const all = `${chat} | ${page.word}: ${page.detail} | ${receipt}`;
    const name = () => `${row.state}/${row.reason}: ${all}`;
    const sentClaim = /\b(submitted|sent to|sent,|applied to)\b/i;
    const notSentClaim = /stopped before it was sent|nothing reached|not sent|not submitted/i;
    switch (row.state) {
      case "confirmed": check(rep, /confirmed/i.test(chat) && page.word === "confirmed" && /confirmed/i.test(receipt), "confirmed: not said as confirmed everywhere", name); break;
      case "submitted_unconfirmed": check(rep, /not confirmed|hasn't confirmed|has not confirmed/i.test(chat) && page.word === "submitted" && /not confirmed/i.test(receipt), "submitted: not said as sent and unconfirmed everywhere", name); break;
      case "unknown_outcome": check(rep, /can't tell|cannot tell/i.test(chat) && page.word === "unknown" && /cannot tell/i.test(receipt) && /not (be )?sen[dt] (it )?again|won't be sent again/i.test(`${chat} ${receipt}`) && !notSentClaim.test(all), "unknown: not said as unknown and never resent everywhere", name); break;
      case "needs_user":
        if (row.reason === "email_code") check(rep, !notSentClaim.test(all) && /code/i.test(chat) && /code/i.test(page.detail) && /code/i.test(receipt), "an emailed code after the send: said as stopped before it was sent", name);
        else check(rep, !sentClaim.test(all.replace(/not sent|before it was sent|nothing reached/gi, "")), "a stop before the send: said as sent", name);
        check(rep, !RAW.test(`${chat} ${page.detail}`), "the queue's own code shown to the person", name);
        break;
      case "not_submitted": case "failed": check(rep, notSentClaim.test(chat) && ["not submitted", "failed"].includes(page.word) && /not sent|did not accept|nothing reached/i.test(receipt), `${row.state}: not said as not sent everywhere`, name); break;
    }
    check(rep, !/\bapplied\b/i.test(chat) && !/\bapplied\b/i.test(`${page.word} ${page.detail}`), "the chat or the file page says applied", name);
  }
  done(rep);
});

// ------------------------------------------------------------------------------------------------ integrity
// One approved application per case (the real engine's dry run over the fake browser, approve-first.ts prepare), then
// what changed after the yes, driven through the person's computer (runApproved) or the cloud worker (runCloudJob).
// The payload's own hash is the queue's (the person's computer gets only rows the database's claim checked): the cloud's.
const INTEGRITY = Array.from({ length: 330 }, (_, i) => ({ n: i, change: CHANGES[i % CHANGES.length] as Change, cloud: i % 2 === 1 || CHANGES[i % CHANGES.length] === "payload_hash" }));
Deno.test({
  name: `integrity: ${INTEGRITY.length} approved applications changed after the yes, through both workers and the real engine: only the unchanged one reaches the employer, exactly as approved`,
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const rep = report("integrity");
    const root = await Deno.makeTempDir({ prefix: "apply-r2-integrity-" });
    const r = rng(SEED + 4);
    try {
      for (const k of INTEGRITY) {
        rep.total++;
        // A plain form the person can answer (no twist), its own posting.
        let c = formCase(r, 50_000 + k.n);
        for (let tries = 0; c.twist !== "none" || c.lang !== "en"; tries++) c = { ...formCase(r, 50_000 + k.n), n: 50_000 + k.n };
        c = { ...c, twist: "none", after: "thanks", n: 50_000 + k.n };
        const w = await world(c, root);
        const engine = inProcessEngine(w, () => NOW + k.n * 60_000);
        const name = () => `#${k.n} ${k.change} via ${k.cloud ? "cloud" : "own computer"}`;
        const prep = await prepare({ url: c.posting, factsPath: w.factsPath, resumePath: w.resumePath, account: { epoch: 0, version: 0 }, now: NOW, runEngine: engine });
        if (!prep.ready) { check(rep, false, "a plain form was not prepared", () => `${name()} -> ${JSON.stringify(prep.result)}`); continue; }
        w.phase = "submit";
        const payload: any = structuredClone(prep.payload);
        let jobUrl = c.posting, jobUser = c.person.id, payloadHash: string | null = null;
        let resumeBytes = w.resumeBytes, resumeSha = payload.resume_sha256 as string | null, resumePresent = true;
        const text = payload.fields.findIndex((f: any) => typeof f.value === "string" && f.factId !== `approved-local-resume:${payload.resume_sha256}`);
        switch (k.change) {
          case "resume_bytes": resumeBytes = new TextEncoder().encode("%PDF-1.4 TEST a different resume under the approved name"); break;
          case "resume_other_sha": resumeSha = "a".repeat(64); break;
          case "resume_missing": resumePresent = false; break;
          case "answer_value": payload.fields[text].value = `${payload.fields[text].value}x`; if (payload.fields[text].source) payload.fields[text].source.value = payload.fields[text].value; break;
          case "answer_added": payload.fields.push({ name: "referral_code", label: "Referral code", value: "TEST-REF", factId: "F-ref" }); break;
          case "answer_removed": payload.fields.splice(text, 1); break;
          case "approval": payload.engine_approval = await hashApplyPayload({ other: k.n }); break;
          case "payload_hash": payloadHash = await hashApplyPayload({ not: "this payload" }); break;
          case "url": jobUrl = `${c.posting}9`; break;
          case "user": jobUser = "00000000-0000-4000-8000-00000000dead"; break;
        }
        await Deno.writeFile(w.resumePath, resumeBytes);
        let final: { state: string; reason?: string };
        if (k.cloud) {
          const h = await hashApplyPayload(payload);
          const job: CloudJob = { id: crypto.randomUUID(), lease_token: crypto.randomUUID(), user_id: jobUser, company: payload.company, url: jobUrl, payload,
            payload_hash: payloadHash ?? h, approval_hash: h, job_id: payload.job_id };
          const q: CloudQueue = { claim: async () => [], authorize: async () => {}, gatePresent: async () => true, ask: async () => 0, finish: async () => {},
            resume: async () => (resumePresent ? { filename: "resume.pdf", sha256: resumeSha ?? "", b64: btoa(String.fromCharCode(...resumeBytes)) } : null) };
          const res = await runCloudJob(job, { queue: q, runEngine: engine, log: () => {}, now: () => NOW });
          final = { state: res.state, reason: res.reason };
        } else {
          const job: Job = { id: crypto.randomUUID(), lease_token: crypto.randomUUID(), url: jobUrl, user_id: jobUser, payload: k.change === "user" ? { ...payload, user_id: jobUser } : payload };
          let fin: any = null;
          await runApproved({ claim: async () => [job], finish: async (_i, _l, state, evidence) => { fin = { state, reason: evidence.reason }; },
            resumeFor: async () => (resumePresent ? { path: w.resumePath, sha256: resumeSha ?? "" } : null as any),
            writeFacts: async (_j, facts) => { const p = `${w.dir}/approved-${crypto.randomUUID()}.json`; await Deno.writeTextFile(p, JSON.stringify(facts)); return p; }, runEngine: engine });
          final = fin;
        }
        if (k.change === "none") {
          check(rep, w.posts.length === 1 && ["confirmed", "submitted_unconfirmed"].includes(final.state), "the unchanged approval was not sent", () => `${name()} -> ${w.posts.length} bodies, ${final.state} (${final.reason})`);
          const body = new Map(w.posts[0]?.entries ?? []);
          for (const f of prep.payload.fields as any[]) {
            const got = body.get(f.name);
            check(rep, typeof got === "object" ? (got as any).sha256 === prep.payload.resume_sha256 : got === f.value || (got !== undefined && c.fields.find((x) => x.name === f.name)?.options?.some((o) => o.value === got && (o.label === f.value || o.value === f.value))),
              "an approved answer was not sent exactly", () => `${name()} ${f.name}: approved ${JSON.stringify(f.value)}, sent ${JSON.stringify(got)}`);
          }
        } else {
          check(rep, w.posts.length === 0, `${k.change}: reached the employer`, () => `${name()} -> ${final.state} (${final.reason})`);
          check(rep, final.state === "not_submitted", `${k.change}: not recorded as not sent`, () => `${name()} -> ${final.state} (${final.reason})`);
        }
        await Deno.remove(w.dir, { recursive: true }).catch(() => {});
      }
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
    done(rep);
  },
});

// ------------------------------------------------------------------------------------------------ virtual time
// The schedulers' clock and timers, virtual: setTimeout fires in time order once nothing else is pending, Date.now is
// the virtual time (jumpable), so an hour of back-off runs in milliseconds and every run is the same run.
function virtualTime(start: number) {
  const realST = globalThis.setTimeout, realCT = globalThis.clearTimeout, realNow = Date.now;
  let now = start, seq = 0, pumping = false;
  const timers = new Map<number, { at: number; fn: (...a: unknown[]) => void; args: unknown[] }>();
  const pump = () => {
    if (pumping) return;
    pumping = true;
    realST(() => {
      pumping = false;
      let best: [number, { at: number; fn: (...a: unknown[]) => void; args: unknown[] }] | null = null;
      for (const e of timers) if (!best || e[1].at < best[1].at || (e[1].at === best[1].at && e[0] < best[0])) best = e;
      if (!best) return;
      timers.delete(best[0]);
      now = Math.max(now, best[1].at);
      best[1].fn(...best[1].args);
      pump();
    }, 0);
  };
  (globalThis as any).setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => { const id = 1_000_000 + ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn, args }); pump(); return id; };
  (globalThis as any).clearTimeout = (id: number) => { timers.delete(id); };
  Date.now = () => now;
  return {
    now: () => now,
    jump: (ms: number) => { now += ms; },
    restore: () => { (globalThis as any).setTimeout = realST; (globalThis as any).clearTimeout = realCT; Date.now = realNow; },
  };
}

// The queue as the database keeps it (career_apply_jobs and its functions), in memory: the same posting (its key) is
// refused while an application for it counts; a claim leases; a finish needs the lease; a requeue puts the same row back
// with its not-before time; the sweep closes a drive left 15 minutes as unknown.
interface QRow { id: string; user: string; key: string; url: string; host: string; state: string; lease: string | null; claimed_at: number; not_before: number; reason?: string }
function memQueue(now: () => number) {
  const rows = new Map<string, QRow>();
  let ids = 0;
  const q = {
    rows,
    enqueue(user: string, url: string): "queued" | "duplicate_job" {
      const key = postingKey(url) ?? url;
      for (const r of rows.values()) if (r.user === user && r.key === key && COUNTED_STATES.has(r.state)) return "duplicate_job";
      const id = `j${++ids}`;
      rows.set(id, { id, user, key, url, host: new URL(url).host, state: "queued", lease: null, claimed_at: 0, not_before: 0 });
      return "queued";
    },
    claim(limit: number, user?: string): (MassJob & Job & { user_id: string })[] {
      const out: (MassJob & Job & { user_id: string })[] = [];
      for (const r of rows.values()) {
        if (out.length >= limit) break;
        if (r.state !== "queued" || r.not_before > now() || (user && r.user !== user)) continue;
        r.state = "driving"; r.lease = crypto.randomUUID(); r.claimed_at = now();
        out.push({ id: r.id, lease_token: r.lease, url: r.url, user_id: r.user, claimed_at: new Date(r.claimed_at).toISOString(),
          payload: { version: 1, user_id: r.user, job_id: r.key, url: r.url, fields: [], engine_approval: "e".repeat(64), resume_sha256: "d".repeat(64) } });
      }
      return out;
    },
    finish(id: string, lease: string, state: string, reason?: string) {
      const r = rows.get(id);
      if (!r || r.state !== "driving" || r.lease !== lease) throw Object.assign(Error("invalid apply transition"), { code: "P0001" });
      r.state = state; r.reason = reason; r.lease = null;
    },
    requeue(id: string, lease: string, until: number) {
      const r = rows.get(id);
      if (!r || r.state !== "driving" || r.lease !== lease) throw Object.assign(Error("invalid apply claim"), { code: "P0001" });
      r.state = "queued"; r.lease = null; r.not_before = Math.max(until, now());
      return r.not_before;
    },
    sweep() { for (const r of rows.values()) if (r.state === "driving" && now() - r.claimed_at > 15 * 60_000) { r.state = "unknown_outcome"; r.lease = null; } },
    // The person's own computer's functions over this queue (approve-first.ts ownQueue's RPCs), for one person.
    client(user: string, fault?: (name: string, a: any) => "lose_reply" | "fail" | "die" | null) {
      return {
        rpc: async (name: string, a: any) => {
          const f = fault?.(name, a) ?? null;
          if (f === "fail") return { data: null, error: { code: "08006", message: "connection failure (failover)" } };
          if (f === "die") return await new Promise<never>(() => {}); // the machine died before the call reached the database
          let out: { data: any; error: any };
          try {
            if (name === "career_apply_claim_own") out = { data: q.claim(a.p_limit, user), error: null };
            else if (name === "career_apply_finish_own") { q.finish(a.p_id, a.p_lease, a.p_state, a.p_evidence?.reason); out = { data: true, error: null }; }
            else if (name === "career_apply_requeue_refused_own" || name === "career_apply_requeue_unstarted_own") out = { data: { not_before: new Date(q.requeue(a.p_id, a.p_lease, Date.parse(a.p_until))).toISOString() }, error: null };
            else out = { data: null, error: { code: "PGRST202", message: `could not find the function ${name}` } };
          } catch (e: any) { out = { data: null, error: { code: e.code ?? "P0001", message: e.message } }; }
          if (f === "lose_reply") return { data: null, error: { code: "08006", message: "connection lost after commit" } };
          return out;
        },
      };
    },
  };
  return q;
}

// ------------------------------------------------------------------------------------------------ scale
type HostPlan = { kind: "ok" | "storm" | "storm_date" | "storm_none"; refusals: number; retry: string | null };
function hostPlans(seed: number, hosts: string[]) {
  const r = rng(seed), plans = new Map<string, HostPlan>();
  for (const h of hosts) {
    const roll = r.next();
    plans.set(h, roll < 0.6 ? { kind: "ok", refusals: 0, retry: null }
      : roll < 0.8 ? { kind: "storm", refusals: r.int(1, 12), retry: String(r.pick([1, 5, 30, 120, 600])) }
      : roll < 0.9 ? { kind: "storm_date", refusals: r.int(1, 6), retry: "date" }
      : { kind: "storm_none", refusals: r.int(1, 5), retry: null });
  }
  return plans;
}
async function scaleRun(o: { people: number; each: number; seed: number; concurrency: number; jumps?: boolean }) {
  const vt = virtualTime(NOW);
  try {
    const q = memQueue(vt.now);
    const r = rng(o.seed);
    const want = new Map<string, Set<string>>(); // person -> distinct posting keys
    let refusedDup = 0, offered = 0;
    for (let p = 0; p < o.people; p++) {
      const user = `u${p}`;
      const ps = scalePostings(r, o.each, `t${p % 13}`);
      want.set(user, new Set());
      for (const x of ps) {
        offered++;
        const res = q.enqueue(user, x.url);
        if (res === "duplicate_job") refusedDup++;
        else want.get(user)!.add(postingKey(x.url)!);
      }
    }
    const hosts = [...new Set([...q.rows.values()].map((x) => x.host))];
    const plans = hostPlans(o.seed + 1, hosts);
    const refusedSoFar = new Map<string, number>();
    const holds: { host: string; at: number; until: number }[] = []; // each refusal: when, and until when the host asked us to wait
    const starts: { id: string; host: string; at: number }[] = [];
    const employer = new Map<string, number>(); // user|key -> bodies received
    const engineRuns = new Map<string, number>();
    let jumped = 0;
    const outcome = await massRun<MassJob & Job & { user_id: string }>({
      claim: async (n) => q.claim(n),
      run: async (job, onStart) => {
        await onStart();
        const row = q.rows.get(job.id)!, plan = plans.get(row.host)!;
        starts.push({ id: job.id, host: row.host, at: vt.now() });
        engineRuns.set(job.id, (engineRuns.get(job.id) ?? 0) + 1);
        // The clock jumps (a VM's clock corrected): back an hour once, forward a day once.
        if (o.jumps && starts.length === 400 && jumped === 0) { vt.jump(-3_600_000); jumped++; }
        if (o.jumps && starts.length === 900 && jumped === 1) { vt.jump(86_400_000); jumped++; }
        const n = (refusedSoFar.get(row.host) ?? 0);
        if (n < plan.refusals) {
          refusedSoFar.set(row.host, n + 1);
          const raw = plan.retry === "date" ? new Date(vt.now() + 45_000).toUTCString() : plan.retry;
          const s = retryAfterSeconds(raw, vt.now());
          return { state: "refused", reason: "HOST_RATE_LIMITED", recorded: false, retry_after_s: s, requeue: true, status: 429 };
        }
        const k = `${row.user}|${row.key}`;
        employer.set(k, (employer.get(k) ?? 0) + 1);
        q.finish(job.id, job.lease_token, "submitted_unconfirmed");
        return { state: "submitted_unconfirmed", recorded: true };
      },
      requeue: async (job, rq) => {
        holds.push({ host: new URL(job.url).host, at: vt.now(), until: rq.until });
        const nb = q.requeue(job.id, job.lease_token, rq.until);
        return { state: "queued", reason: "HOST_RATE_LIMITED", recorded: true, not_before: nb };
      },
      putBack: async (job, _why, until) => ({ state: "queued", recorded: true, not_before: q.requeue(job.id, job.lease_token, until) }),
      unstarted: async (job, why) => { q.finish(job.id, job.lease_token, "not_submitted", why); return { state: "not_submitted", reason: why, recorded: true }; },
      orphaned: async () => ({ state: "unknown_outcome", recorded: true }),
      pacing: pacingFrom(() => undefined, { concurrency: o.concurrency, claimBatch: o.concurrency * 2 }), stop: () => false, drain: true, idleMs: 1_000,
      gate: localHostGate(), now: vt.now, sleep: (ms) => new Promise((res) => setTimeout(res, ms)), log: () => {},
    });
    return { q, want, refusedDup, offered, plans, starts, holds, employer, engineRuns, outcome, end: vt.now(), jumped };
  } finally {
    vt.restore();
  }
}
function judgeScale(rep: Report, name: string, s: Awaited<ReturnType<typeof scaleRun>>, jumps = false) {
  rep.total++;
  let distinct = 0;
  for (const [user, keys] of s.want) for (const k of keys) {
    distinct++;
    const n = s.employer.get(`${user}|${k}`) ?? 0;
    check(rep, n === 1, `${name}: a posting not submitted exactly once`, () => `${user} ${k}: ${n} bodies`);
  }
  for (const r of s.q.rows.values()) check(rep, r.state === "submitted_unconfirmed", `${name}: left behind`, () => `${r.id} ${r.url}: ${r.state}`);
  for (const [id, n] of s.engineRuns) {
    const row = s.q.rows.get(id)!;
    check(rep, n <= s.plans.get(row.host)!.refusals + 1, `${name}: an application's engine ran more often than its host refused`, () => `${id} ${row.host}: ${n}`);
  }
  // Duplicates across boards were never queued: the queue holds one row per distinct posting.
  check(rep, s.q.rows.size === distinct && s.offered === distinct + s.refusedDup, `${name}: duplicates queued`, () => `${s.q.rows.size} rows, ${distinct} distinct, ${s.refusedDup} refused`);
  check(rep, s.refusedDup > 0, `${name}: no duplicate across boards was offered (the generator's own check)`, () => "");
  // Nothing started on a refusing host after its refusal and inside the hold it asked for (starts at the refusal's own
  // instant were already in flight); each hold at least what the host asked (Retry-After), else the default doubling.
  if (!jumps) {
    for (const hd of s.holds) {
      const plan = s.plans.get(hd.host)!;
      const waitS = plan.retry === "date" ? 44 : plan.retry === null ? 30 : Number(plan.retry);
      check(rep, hd.until - hd.at >= waitS * 1000, `${name}: a hold shorter than the host asked`, () => `${hd.host} (${plan.kind} ${plan.retry}) held ${(hd.until - hd.at) / 1000}s`);
      const inside = s.starts.filter((x) => x.host === hd.host && x.at > hd.at && x.at < hd.until);
      check(rep, inside.length === 0, `${name}: a refusing host asked again inside its hold`, () => `${hd.host} (${plan.kind} ${plan.retry}) refused at ${hd.at}, held to ${hd.until}; started at ${inside.map((x) => x.at).join(", ")}`);
    }
  }
  return distinct;
}
Deno.test({
  name: "scale: one person and 2,000 postings, and 2,000 people with ten each, the same job on two boards, refusal storms, the clock jumping: each posting once, duplicates never queued, holds kept, nothing left",
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const rep = report("scale");
    const one = await scaleRun({ people: 1, each: 2000, seed: SEED + 10, concurrency: 16 });
    const d1 = judgeScale(rep, "1 x 2000", one);
    const many = await scaleRun({ people: 2000, each: 10, seed: SEED + 11, concurrency: 64 });
    const d2 = judgeScale(rep, "2000 x 10", many);
    const jump = await scaleRun({ people: 40, each: 50, seed: SEED + 12, concurrency: 8, jumps: true });
    const d3 = judgeScale(rep, "40 x 50 with clock jumps", jump, true);
    check(rep, jump.jumped === 2, "the clock did not jump (the generator's own check)", () => String(jump.jumped));
    done(rep, `distinct postings ${d1} + ${d2} + ${d3}; duplicates refused ${one.refusedDup} + ${many.refusedDup} + ${jump.refusedDup}; engine runs ${[one, many, jump].map((s) => [...s.engineRuns.values()].reduce((a, b) => a + b, 0)).join(" + ")}; virtual hours ${[one, many, jump].map((s) => ((s.end - NOW) / 3_600_000).toFixed(1)).join(" / ")}`);
  },
});

// ------------------------------------------------------------------------------------------------ kills
// The person's own computer (approve-first.ts runLoop over ownQueue) killed at each point and started again on its
// journal; the database's functions in memory (memQueue), the employer counting bodies.
const never = <T>() => new Promise<T>(() => {});
Deno.test({
  name: `kills: the person's computer killed at ${KILL_POINTS.length} points, ${KILL_POINTS.length * 30} rounds: each application reaches the employer at most once, is never driven twice, and ends as what is known`,
  sanitizeResources: false, sanitizeOps: false,
  async fn() {
    const rep = report("kills");
    const vt = virtualTime(NOW);
    try {
      const r = rng(SEED + 20);
      for (let round = 0; round < KILL_POINTS.length * 30; round++) {
        const point: KillPoint = KILL_POINTS[round % KILL_POINTS.length];
        rep.total++;
        const q = memQueue(vt.now);
        const user = `k${round}`, n = r.int(2, 5), at = r.int(0, n - 1);
        for (let i = 0; i < n; i++) q.enqueue(user, `https://k${round}-${i % 3}.example.test/jobs/${i}`);
        const ids = [...q.rows.keys()], target = ids[at];
        const employer = new Map<string, number>(), engine = new Map<string, number>();
        const entries = new Map<string, JournalEntry<Job>>();
        const lives = [{ dead: false }, { dead: false }];
        let died!: () => void;
        const death = new Promise<void>((res) => { died = res; });
        const die = () => { if (!lives[0].dead) { lives[0].dead = true; died(); } };
        const journal = (w: number): Journal<Job> => ({
          async put(job, claimedAt) { if (lives[w].dead) return await never(); entries.set(job.id, { job: structuredClone(job), claimedAt, started: false }); },
          async start(id) {
            if (w === 0 && id === target && point === "journal_start") die();
            if (lives[w].dead) return await never();
            entries.set(id, { ...entries.get(id)!, started: true });
          },
          async done(id) { if (lives[w].dead) return await never(); entries.delete(id); },
          async list() { return [...entries.values()].sort((a, b) => a.claimedAt - b.claimedAt); },
        });
        let failures = 0;
        const fault = (w: number) => (name: string, a: any): "lose_reply" | "fail" | "die" | null => {
          if (w === 0 && name === "career_apply_claim_own" && point === "claim" && !lives[0].dead) { queueMicrotask(die); return null; }
          if (name === "career_apply_finish_own" && a.p_id === target) {
            if (w === 0 && point === "after_engine_before_record") { die(); return "die"; }
            if (point === "record_lost_reply" && failures++ === 0) return "lose_reply";
            if (point === "record_fails" && w === 0) return "fail";
          }
          return null;
        };
        const client = (w: number) => {
          const base = q.client(user, fault(w));
          return { rpc: async (name: string, a: any) => { if (lives[w].dead) return await never<any>(); const out = await base.rpc(name, a); if (lives[w].dead) return await never<any>(); return out; } };
        };
        const engineOf = (w: number) => async (args: string[]) => {
          if (lives[w].dead) return await never<any>();
          const id = args[args.indexOf("--application-id") + 1];
          engine.set(id, (engine.get(id) ?? 0) + 1);
          const row = q.rows.get(id)!;
          if (w === 0 && id === target && (point === "engine_open" || point === "engine_fill")) { die(); return await never<any>(); }
          employer.set(id, (employer.get(id) ?? 0) + 1);
          if (w === 0 && id === target && point === "engine_after_send") { die(); return await never<any>(); }
          void row;
          return { result: { state: "submitted_unconfirmed", reason: "acknowledged" }, evidence: null };
        };
        const common = { resume: { path: "/nonexistent/TEST-resume.pdf", sha256: "d".repeat(64) }, writeFacts: async () => "/nonexistent/TEST-facts.json", log: () => {}, idleMs: 15_000,
          sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)), gate: localHostGate(), pacing: pacingFrom(() => undefined, { concurrency: 2 }), drain: true, stop: () => false };
        const w1 = runLoop({ ...common, queue: ownQueue(client(0)), journal: journal(0), runEngine: engineOf(0) });
        const first = await Promise.race([death.then(() => "died"), w1.then(() => "ended")]);
        if (point !== "record_lost_reply" && point !== "record_fails") check(rep, first === "died", `${point}: the worker never reached its kill point`, () => `round ${round}`);
        if (point === "record_fails" && first === "ended") {
          // It could not record the target (the database down): its journal line stays; the machine restarts later.
          lives[0].dead = true;
        }
        await new Promise((res) => setTimeout(res, 10));
        await runLoop({ ...common, queue: ownQueue(client(1)), journal: journal(1), runEngine: engineOf(1) });
        vt.jump(16 * 60_000);
        q.sweep();
        const st = q.rows.get(target)!.state;
        for (const id of ids) {
          check(rep, (employer.get(id) ?? 0) <= 1, `${point}: the employer got it twice`, () => `round ${round} ${id}`);
          check(rep, (engine.get(id) ?? 0) <= 1, `${point}: driven twice`, () => `round ${round} ${id}: ${engine.get(id)}`);
          check(rep, !["queued", "driving"].includes(q.rows.get(id)!.state), `${point}: left ${q.rows.get(id)!.state}`, () => `round ${round} ${id}`);
          // The others claimed with it: sent and recorded, or (in flight on the machine that died) unknown, never "not sent".
          if (id !== target) check(rep, ["submitted_unconfirmed", "unknown_outcome"].includes(q.rows.get(id)!.state), `${point}: another application ended ${q.rows.get(id)!.state}`, () => `round ${round} ${id}`);
        }
        const sent = employer.get(target) ?? 0;
        // What is known: sent and recorded as sent; not started (run once later); or unknown, never "not sent" once it may have gone.
        const want: Record<KillPoint, string[]> = {
          claim: ["unknown_outcome", "submitted_unconfirmed"], journal_start: ["submitted_unconfirmed"], engine_open: ["unknown_outcome"], engine_fill: ["unknown_outcome"],
          engine_after_send: ["unknown_outcome"], after_engine_before_record: ["unknown_outcome"], record_lost_reply: ["submitted_unconfirmed"], record_fails: ["unknown_outcome", "submitted_unconfirmed"],
        };
        check(rep, want[point].includes(st), `${point}: the target ended ${st}, expected ${want[point].join("/")}`, () => `round ${round}, ${sent} bodies, engine ${engine.get(target) ?? 0}`);
        if (sent === 1) check(rep, st !== "not_submitted", `${point}: sent, recorded as not sent`, () => `round ${round}`);
        if (st === "submitted_unconfirmed") check(rep, sent === 1, `${point}: recorded as sent with nothing sent`, () => `round ${round}`);
      }
    } finally {
      vt.restore();
    }
    done(rep);
  },
});
void sample; void isIdentityField;
