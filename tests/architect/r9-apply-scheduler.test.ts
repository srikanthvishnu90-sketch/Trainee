// Release 9, workstream A, part 2 (architect, 2026-11-07): the production pace of real submission
// (workers/career-browser/apply-scheduler.cjs), on a virtual clock, in memory, with a fake submit. No network.
//   - a person's pace: 60 an hour, at most 200 in any 24 hours (owner, 2026-11-07, "200/day", DECISIONS D-R9-1), both
//     configurable by name, never unlimited because a value is unreadable;
//   - per employer and per site (the ATS host) limits across people;
//   - a transient failure before anything reached the employer is retried with backoff, then dead-lettered with its reason;
//     a permanent one is dead-lettered at once with its reason; a page that may have been posted is never sent again;
//   - every submission keeps its proof (confirmation page, the employer's email, an API receipt); "sent" with no proof is
//     an unknown outcome, never a success, and never resent (D-024);
//   - nothing is sent without an approval whose hash is the payload's own (D-MS-1), re-checked at the moment of sending;
//   - the same posting (job id or canonical link, D-MS-3) is never applied twice for one person.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createRequire } from "node:module";
import { postingKey as tsPostingKey } from "../../supabase/functions/_shared/career_apply.ts";

const require = createRequire(import.meta.url);
const S = require("../../workers/career-browser/apply-scheduler.cjs");
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-09T09:00:00Z");

function app(user: string, i: number, o: Record<string, unknown> = {}) {
  const payload = { user_id: user, job_id: `J${i}`, fields: [{ name: "email", value: `${user}@example.test` }] };
  const sha = S.payloadSha256(payload);
  return { id: `${user}-${i}`, userId: user, jobId: `J${i}`, company: `Employer ${i % 97}`, url: `https://boards.greenhouse.io/e${i % 97}/jobs/${1000 + i}`,
    payload, payloadSha256: sha, approvalHash: sha, ...o };
}
const ok = (ref = "APP-1") => async () => ({ posted: true, outcome: "submitted", proof: { kind: "confirmation_page", ref, at: 0 } });
function world(submit: (a: any) => Promise<any>, limits: Record<string, number> = {}) {
  let t = T0;
  const sent: any[] = [];
  const sch = S.createApplyScheduler({ now: () => t, limits: { perEmployerHour: 1000, perSiteMinute: 1000, ...limits }, submit: async (a: any) => { sent.push({ id: a.id, at: t }); return submit(a); } });
  const runUntil = async (end: number) => {
    for (let guard = 0; guard < 1_000_000; guard++) {
      const due = sch.nextDueAt();
      if (due === null || due > end) { t = end; return; }
      t = Math.max(t, due);
      await sch.tick();
    }
    throw new Error("runaway");
  };
  return { sch, sent, runUntil, at: () => t, set: (x: number) => { t = x; } };
}

Deno.test("R9-2 limits: 60 an hour and 200 a day by default, each configurable by name; an unreadable value is the default, never unlimited", () => {
  const d = S.limitsFromEnv({});
  assertEquals([d.perPersonHour, d.perPersonDay], [60, 200]);
  const set = S.limitsFromEnv({ CAREER_APPLY_PER_PERSON_HOUR: "30", CAREER_APPLY_PER_PERSON_DAY: "500", CAREER_APPLY_PER_EMPLOYER_HOUR: "5", CAREER_APPLY_PER_SITE_MINUTE: "12" });
  assertEquals([set.perPersonHour, set.perPersonDay, set.perEmployerHour, set.perSiteMinute], [30, 500, 5, 12]);
  for (const bad of ["", "0", "-3", "lots", "1e9x", "none", "off", "unlimited"]) {
    assertEquals(S.limitsFromEnv({ CAREER_APPLY_PER_PERSON_DAY: bad }).perPersonDay, 200, `"${bad}"`);
  }
  assertEquals(S.DEFAULT_LIMITS.perPersonDay, 200);
});

Deno.test("R9-2 the posting key is the TS ledger's, rule for rule", () => {
  for (const u of ["https://boards.greenhouse.io/acme/jobs/4012?gh_src=x", "https://careers.example.test/jobs?gh_jid=4012", "https://jobs.lever.co/acme/1b2c3d4e-0000-4000-8000-000000000001/apply",
    "https://jobs.ashbyhq.com/acme/1b2c3d4e-0000-4000-8000-000000000001/application?utm_source=x", "https://www.example.test:443/careers/role/?b=2&a=1&ref=z", "not a link", "http://EXAMPLE.test:8080/x/"]) {
    assertEquals(S.postingKey(u), tsPostingKey(u), u);
  }
});

Deno.test("R9-2 a person's 60 an hour, sustained, and 200 in any 24 hours", async () => {
  const w = world(ok());
  for (let i = 0; i < 260; i++) assert(w.sch.enqueue(app("A", i)).ok);
  await w.runUntil(T0 + HOUR - 1);
  assertEquals(w.sent.length, 60, "60 in the first hour");
  await w.runUntil(T0 + 3 * HOUR - 1);
  assertEquals(w.sent.length, 180, "60 more each hour");
  await w.runUntil(T0 + DAY - 1);
  assertEquals(w.sent.length, 200, "then the 24-hour cap holds");
  // No 60-minute window ever holds more than 60, and no 24-hour window more than 200.
  for (const s of w.sent) assert(w.sent.filter((x) => x.at >= s.at && x.at < s.at + HOUR).length <= 60);
  await w.runUntil(T0 + DAY + HOUR);
  assertEquals(w.sent.length, 260, "the rest go once the window frees");
  assertEquals(new Set(w.sent.map((s) => s.id)).size, 260, "each once");
});

Deno.test("R9-2 per-employer and per-site limits hold across people", async () => {
  const w = world(ok(), { perEmployerHour: 3, perSiteMinute: 2 });
  for (const u of ["A", "B", "C", "D"]) for (let i = 0; i < 3; i++) w.sch.enqueue(app(u, i * 97, { company: "Acme", url: `https://boards.greenhouse.io/acme/jobs/${u.charCodeAt(0)}${i}` }));
  await w.runUntil(T0 + HOUR - 1);
  assertEquals(w.sent.length, 3, "three to Acme in an hour, whoever applies");
  for (const s of w.sent) assert(w.sent.filter((x) => x.at >= s.at && x.at < s.at + MIN).length <= 2, "two a minute on one site");
  await w.runUntil(T0 + 4 * HOUR);
  assertEquals(w.sent.length, 12);
});

Deno.test("R9-2 transient failures retry with backoff, then dead-letter with the reason; permanent ones dead-letter at once", async () => {
  let n = 0;
  const w = world(async (a: any) => {
    if (a.jobId === "J1") return { posted: false, outcome: "transient", reason: "http_503" };
    if (a.jobId === "J2") return { posted: false, outcome: "permanent", reason: "posting_closed" };
    if (a.jobId === "J3") return ++n < 3 ? { posted: false, outcome: "transient", reason: "http_429" } : { posted: true, outcome: "submitted", proof: { kind: "api_receipt", ref: "R-3", at: 0 } };
    return { posted: true, outcome: "submitted", proof: { kind: "email", ref: "msg-1", at: 0 } };
  }, { maxAttempts: 4, backoffBaseMs: MIN });
  for (const i of [1, 2, 3, 4]) w.sch.enqueue(app("A", i));
  await w.runUntil(T0 + DAY);
  const j1 = w.sent.filter((s) => s.id === "A-1").map((s) => s.at);
  assertEquals(j1.length, 4, "four attempts");
  for (let k = 1; k < j1.length; k++) assert(j1[k] - j1[k - 1] >= MIN * 2 ** (k - 1), "each wait at least doubles");
  const dl = w.sch.deadLetters();
  assertEquals(dl.map((d: any) => [d.id, d.reason]).sort(), [["A-1", "retries_exhausted: http_503"], ["A-2", "permanent: posting_closed"]]);
  assertEquals(w.sent.filter((s) => s.id === "A-2").length, 1, "a permanent failure is not retried");
  const j3 = w.sch.job("A-3"), j4 = w.sch.job("A-4");
  assertEquals([j3.state, j3.proof.kind, j3.attempts], ["submitted_unconfirmed", "api_receipt", 3]);
  assertEquals([j4.state, j4.proof.kind], ["confirmed", "email"], "only the employer's email confirms");
});

Deno.test("R9-2 every submission keeps its proof; posted without proof is unknown and never sent again", async () => {
  const w = world(async (a: any) => a.jobId === "J1" ? { posted: true, outcome: "submitted", proof: null }
    : a.jobId === "J2" ? { posted: true, outcome: "transient", reason: "timeout_after_click" }
    : { posted: true, outcome: "submitted", proof: { kind: "confirmation_page", ref: "Thank you, APP-9", at: 0 } });
  for (const i of [1, 2, 3]) w.sch.enqueue(app("A", i));
  await w.runUntil(T0 + DAY);
  assertEquals(w.sch.job("A-1").state, "unknown_outcome");
  assertEquals(w.sch.job("A-2").state, "unknown_outcome", "a failure after the click may have reached the employer: never retried");
  assertEquals(w.sent.filter((s) => s.id === "A-2").length, 1);
  assertEquals(w.sch.job("A-3").state, "submitted_unconfirmed");
  assertEquals(w.sch.job("A-3").proof, { kind: "confirmation_page", ref: "Thank you, APP-9", at: w.sent.find((s) => s.id === "A-3")!.at }, "the proof, stamped when it was sent");
  for (const j of w.sch.jobs()) if (["submitted_unconfirmed", "confirmed"].includes(j.state)) assert(j.proof && j.proof.ref, j.id);
  // An unknown outcome still counts: the same posting is refused afterwards.
  assertEquals(w.sch.enqueue(app("A", 1, { id: "again" })).reason, "duplicate_job");
});

Deno.test("R9-2 no send without the approval of this exact payload, checked again at the moment of sending", async () => {
  const w = world(ok());
  const a = app("A", 1);
  assertEquals(w.sch.enqueue({ ...a, approvalHash: undefined }).reason, "not_approved");
  assertEquals(w.sch.enqueue({ ...a, approvalHash: "0".repeat(64) }).reason, "not_approved");
  assertEquals(w.sch.enqueue({ ...a, payloadSha256: "f".repeat(64), approvalHash: "f".repeat(64) }).reason, "payload_hash_mismatch", "a hash that is not the payload's own");
  const b = app("A", 2);
  assert(w.sch.enqueue(b).ok);
  b.payload.fields.push({ name: "added_after_yes", value: "x" }); // the payload changed after the yes
  await w.runUntil(T0 + HOUR);
  assertEquals(w.sent.length, 0, "never sent");
  assertEquals(w.sch.deadLetters().map((d: any) => [d.id, d.reason]), [["A-2", "permanent: payload_changed_after_approval"]]);
});

Deno.test("R9-2 the same posting is applied to once per person, by job id or by any link to it", async () => {
  const w = world(ok());
  assert(w.sch.enqueue(app("A", 1, { url: "https://boards.greenhouse.io/acme/jobs/777" })).ok);
  assertEquals(w.sch.enqueue(app("A", 2, { url: "https://careers.acme.test/open?gh_jid=777" })).reason, "duplicate_job");
  assertEquals(w.sch.enqueue(app("A", 1, { id: "A-1b", url: "https://boards.greenhouse.io/acme/jobs/778" })).reason, "duplicate_job", "same job id");
  assert(w.sch.enqueue(app("B", 1, { url: "https://boards.greenhouse.io/acme/jobs/777" })).ok, "another person");
  assert(w.sch.enqueue(app("A", 3, { url: "https://boards.greenhouse.io/acme/jobs/779", company: "Acme" })).ok, "another role at the company");
  // A dead-lettered application that never reached the employer frees its posting for a later approval.
  const v = world(async () => ({ posted: false, outcome: "permanent", reason: "form_changed" }));
  v.sch.enqueue(app("A", 5));
  await v.runUntil(T0 + HOUR);
  assert(v.sch.enqueue(app("A", 5, { id: "A-5b" })).ok);
});

Deno.test("R9-2 the batch executor paces an approved batch through the scheduler, one application at a time", () => {
  const src = Deno.readTextFileSync(new URL("../../workers/career-browser/batch-executor.cjs", import.meta.url));
  assert(/d\.scheduler/.test(src) && /only: \[key\]/.test(src), "executeApprove drives one key at a time when a scheduler is given");
  const main = Deno.readTextFileSync(new URL("../../scripts/career/batch-executor-main.cjs", import.meta.url));
  assert(/limitsFromEnv\(e\)/.test(main), "the entry point reads the limits from its environment");
  assert(/CAREER_BATCH_EXECUTOR/.test(main) && !/CAREER_BATCH_EXECUTOR\s*=\s*["']on["']/.test(main), "the switch stays the owner's");
});
