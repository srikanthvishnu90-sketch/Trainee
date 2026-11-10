// WO-122 (coordinator ruling on a-sensitive, D.4 6: a reused answer never travels silently): a sensitive answer reused
// from another application says where it came from on the card, the date it was given is inside the payload hash and the
// engine approval hash, the date is in the person's own zone (never UTC), and the server accepts exactly that suffix.
// Real trustedManifest, planner, contract, prepare, approval hashes and the server's card check; no network, no browser.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { engineApprovalFromPayload, prepare, textAnswerRows } from "../../workers/career-browser/approve-first.ts";
import { cardLines, trustedManifest } from "../../extension/src/apply_core.ts";
import { applicationApprovalHash, planApplication } from "../../scripts/apply.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";
import { preparedCardProblem, reusedSourceSuffix } from "../../supabase/functions/_shared/career_prepared_card.ts";

const OWNER = "00000000-0000-4000-8000-000000122b01";
const A = "greenhouse:synthetic:1001", B = "greenhouse:synthetic:2002";
const URL = "https://boards.greenhouse.io/synthetic/jobs/2002", SHA = "c".repeat(64), NOW = Date.UTC(2026, 10, 10, 12);
const SPONSOR = "Will you now or in the future require visa sponsorship?", GPA = "What is your GPA?";
const CITY = "What city do you currently live in?", HEARD = "How did you hear about us?";
const schema = [
  { name: "sponsor", label: SPONSOR, type: "select", required: true, options: [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }] },
  { name: "gpa", label: GPA, type: "text", required: true, options: [] },
  { name: "city", label: CITY, type: "text", required: true, options: [] },
  { name: "heard", label: HEARD, type: "text", required: true, options: [] },
];
const fileFact = (value: string, id: string) =>
  ({ value, factId: id, confirmed: true, provenance: "owner stated this in onboarding", confirmation_event_id: `ev-${id}` });
const FILE = { user_id: OWNER, answers: { gpa: fileFact("3.8", "F-gpa"), how_heard: fileFact("A friend", "F-heard") }, saved: {} };
// As career_apply_answers_own_v2 returns them: sponsorship was texted for A at 21:30 Chicago on Nov 9 (03:30 UTC, Nov 10).
const ROW = (o: Record<string, unknown> = {}) => ({ id: "00000000-0000-4000-8000-000000122c01", user_id: OWNER, key: "fact:sponsorship",
  kind: "fact", answer: "No", answered_at: "2026-11-10T03:30:00Z", job_ids: [A], ...o });
const CITY_ROW = { id: "00000000-0000-4000-8000-000000122c02", user_id: OWNER, key: "fact:city", kind: "fact", answer: "Chicago",
  answered_at: "2026-11-08T15:00:00Z", job_ids: [A] };

async function prepared(o: { rows?: Record<string, unknown>[]; tz?: string | null } = {}) {
  const rows = textAnswerRows(o.rows ?? [ROW(), CITY_ROW]);
  const manifest = trustedManifest({ owner: OWNER, file: FILE, rows, resume: { sha256: SHA } });
  const artifact = { filename: "resume.pdf", sha256: SHA };
  const plan = planApplication({ manifest, userId: OWNER, jobId: B, employer: "Synthetic B", schema, artifact, now: NOW });
  if (!plan.ready) throw Error("fixture planner: " + JSON.stringify(plan));
  const schemaHash = await hashApplyPayload(schema);
  const approval = await applicationApprovalHash({ userId: OWNER, posting: B, destination: URL, fields: plan.fields, resumeSha256: SHA,
    schemaHash, pageFieldNames: [], manifest });
  const p: any = await prepare({ url: URL, factsPath: "unused.json", resumePath: "unused.pdf", account: { epoch: 1, version: 1 }, now: NOW,
    tz: o.tz === undefined ? "America/Chicago" : o.tz,
    runEngine: async () => ({ result: { state: "not_submitted", reason: "dry_run" }, evidence: { approval_hash: approval, schema,
      fields: plan.fields, sources: manifest.byFactId, replay_sources: Object.values(manifest.byFactId),
      trust: { quarantine_version: manifest.version, manifest_hash: manifest.hash },
      payload: { user_id: OWNER, posting: B, company: "Synthetic B", destination: URL, resume: artifact, page_fields: {}, schema_hash: schemaHash } } }) } as any);
  if (!p.ready) throw Error("fixture prepare: " + JSON.stringify(p.result));
  return p as { payload: any; card: string[] };
}
const line = (card: string[], label: string) => card.find((l) => l.startsWith(label + ": "));

Deno.test("sources and dates: B's card says where each reused sensitive answer came from, in the person's zone", async () => {
  const { payload, card } = await prepared();
  console.log("B's card:\n  " + card.join("\n  "));
  assertEquals(line(card, SPONSOR), `${SPONSOR}: No (from your answer on Nov 9)`);
  assertEquals(line(card, GPA), `${GPA}: 3.8 (from your confirmed facts)`);
  // Not sensitive: a reused city or how they heard takes no label.
  assertEquals(line(card, CITY), `${CITY}: Chicago`);
  assertEquals(line(card, HEARD), `${HEARD}: A friend`);
  const sponsor = payload.fields.find((f: any) => f.label === SPONSOR);
  assertEquals(sponsor.source.at, "2026-11-10T03:30:00Z");
  assertEquals(payload.tz, "America/Chicago");
  assertEquals(preparedCardProblem(payload, card, { filename: "resume.pdf" }), null);
});

Deno.test("sources and dates: with no zone stored, no date is shown (a UTC date would say Nov 10)", async () => {
  const { payload, card } = await prepared({ tz: null });
  assertEquals(line(card, SPONSOR), `${SPONSOR}: No (from your confirmed facts)`);
  assert(!card.some((l) => /Nov 10|Nov 9/.test(l)), "no date without the person's zone");
  assertEquals(payload.tz, undefined);
  assertEquals(reusedSourceSuffix(payload.fields.find((f: any) => f.label === SPONSOR), B, "UTC"), " (from your confirmed facts)");
  assertEquals(reusedSourceSuffix(payload.fields.find((f: any) => f.label === SPONSOR), B, "Etc/UTC"), " (from your confirmed facts)");
  assertEquals(preparedCardProblem(payload, card, { filename: "resume.pdf" }), null);
});

Deno.test("sources and dates: the same answer given for B itself takes no suffix", async () => {
  const { payload, card } = await prepared({ rows: [ROW({ job_ids: [A, B] }), CITY_ROW] });
  assertEquals(line(card, SPONSOR), `${SPONSOR}: No`);
  assertEquals(preparedCardProblem(payload, card, { filename: "resume.pdf" }), null);
});

Deno.test("sources and dates: under v1 (no job_ids) a texted answer's freshness is unknown, and it takes no suffix", async () => {
  const { card } = await prepared({ rows: [ROW({ job_ids: undefined }), CITY_ROW] });
  assertEquals(line(card, SPONSOR), `${SPONSOR}: No`);
  assertEquals(line(card, GPA), `${GPA}: 3.8 (from your confirmed facts)`);
});

Deno.test("hash: source.at is inside the payload hash and the engine approval hash; the round trip matches", async () => {
  const { payload } = await prepared();
  assertEquals(await engineApprovalFromPayload(payload), payload.engine_approval);
  const moved = structuredClone(payload);
  for (const f of [...moved.fields, ...moved.replay_sources]) {
    if (f?.source?.at) f.source.at = "2026-11-01T15:00:00Z";
    else if (f?.at) f.at = "2026-11-01T15:00:00Z";
  }
  assertNotEquals(await hashApplyPayload(moved), await hashApplyPayload(payload));
  assertNotEquals(await engineApprovalFromPayload(moved), payload.engine_approval);
});

Deno.test("hash: a payload prepared before WO-122 (no at, no job_ids) still validates", async () => {
  const legacy = [{ ...ROW(), answered_at: undefined, job_ids: undefined }, { ...CITY_ROW, answered_at: undefined, job_ids: undefined }];
  const { payload, card } = await prepared({ rows: legacy });
  assertEquals(payload.fields.find((f: any) => f.label === SPONSOR).source.at, undefined);
  assertEquals(await engineApprovalFromPayload(payload), payload.engine_approval);
  assertEquals(preparedCardProblem(payload, card, { filename: "resume.pdf" }), null);
});

Deno.test("hash: a texted answer with job_ids but no date shows the no-date suffix and validates", async () => {
  const { payload, card } = await prepared({ rows: [{ ...ROW(), answered_at: undefined }, CITY_ROW] });
  assertEquals(line(card, SPONSOR), `${SPONSOR}: No (from your confirmed facts)`);
  assertEquals(await engineApprovalFromPayload(payload), payload.engine_approval);
});

Deno.test("server check: exactly the suffix; refuses a missing one, one on a fresh field, another date and extra words", async () => {
  const { payload, card } = await prepared();
  const swap = (label: string, to: string) => card.map((l) => (l.startsWith(label + ": ") ? to : l));
  const kept = { filename: "resume.pdf" };
  assertEquals(preparedCardProblem(payload, card, kept), null);
  assert(preparedCardProblem(payload, swap(SPONSOR, `${SPONSOR}: No`), kept), "missing suffix on a reused answer");
  assert(preparedCardProblem(payload, swap(GPA, `${GPA}: 3.8`), kept), "missing suffix on a facts-file answer");
  assert(preparedCardProblem(payload, swap(SPONSOR, `${SPONSOR}: No (from your answer on Nov 10)`), kept), "another date");
  assert(preparedCardProblem(payload, swap(SPONSOR, `${SPONSOR}: No (from your answer on Nov 9) for sure`), kept), "extra words");
  assert(preparedCardProblem(payload, swap(SPONSOR, `${SPONSOR}: No (from your confirmed facts)`), kept), "the no-date suffix where a date is due");
  assert(preparedCardProblem(payload, swap(CITY, `${CITY}: Chicago (from your answer on Nov 8)`), kept), "a suffix on a non-sensitive field");
  const fresh = await prepared({ rows: [ROW({ job_ids: [A, B] }), CITY_ROW] });
  assert(preparedCardProblem(fresh.payload, fresh.card.map((l) => (l.startsWith(SPONSOR + ": ") ? `${SPONSOR}: No (from your answer on Nov 9)` : l)), kept),
    "a suffix on a fresh field");
});

Deno.test("the extension's card labels a reused facts-file answer with the same formatter", () => {
  const payload: any = { job_id: B, url: URL, resume_name: "resume.pdf", fields: [
    { name: "gpa", label: GPA, value: "3.8", source: "trainee", factId: "F-gpa", detail: "" },
    { name: "heard", label: HEARD, value: "A friend", source: "trainee", factId: "F-heard", detail: "" },
    { name: "sponsor", label: SPONSOR, value: "No", source: "you", factId: null, detail: "" },
  ] };
  const lines = cardLines({ company: "Synthetic B", family: "greenhouse" as any, payload, openRequired: [], identity: [], blockers: [], verification: [] });
  assert(lines.includes(`${GPA}: 3.8 (from your confirmed facts)`), lines.join("\n"));
  assert(lines.includes(`${HEARD}: A friend`));
  assert(lines.includes(`${SPONSOR}: No (typed by you)`));
});
