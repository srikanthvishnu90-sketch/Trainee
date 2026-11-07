// R9-G: the preparation (prepare-ahead.ts) and the send-time check (engine_input.ts read by current_sources.ts) must read
// the same approved sources. The preparation derives the full name from the person's texted first and last names; when
// the send check did not, every hosted application whose form asks "Full name" was refused at send with
// APPROVED_SOURCE_WITHDRAWN after the person's yes. Real engineInput, trustedManifest, planner, prepare and hashing; no
// network, no database, no browser.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { engineInput } from "../../workers/career-cloud/engine_input.ts";
import { assertCurrentApprovedSources } from "../../workers/career-cloud/current_sources.ts";
import { approvedTextAnswers } from "../../workers/career-browser/approved_sources.ts";
import { withFullName } from "../../workers/career-browser/prepare-ahead.ts";
import { engineFacts, prepare } from "../../workers/career-browser/approve-first.ts";
import { trustedManifest } from "../../extension/src/apply_core.ts";
import { applicationApprovalHash, planApplication } from "../../scripts/apply.ts";
import { hashApplyPayload } from "../../supabase/functions/_shared/career_apply_store.ts";

const OWNER = "00000000-0000-4000-8000-00000000ab01";
const URL = "https://jobs.lever.co/synthetic/fullname/apply", JOB = "lever:synthetic:fullname";
const SHA = "b".repeat(64), NOW = 1792627200000;
const row = (n: number, key: string, answer: string) =>
  ({ id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, user_id: OWNER, key, kind: "fact", answer, state: "answered" });
const ROWS = [row(1, "fact:first_name", "Alex"), row(2, "fact:last_name", "Testcase"), row(3, "fact:email", "alex@example.test")];
const schema = [
  { name: "name", label: "Full name", type: "text", required: true, options: [] },
  { name: "email", label: "Email", type: "email", required: true, options: [] },
  { name: "resume", label: "Resume/CV", type: "file", required: true, options: [] },
];

// The card exactly as the preparation builds it: prepare-ahead.ts's rows (approvedTextAnswers), its merged facts file,
// the trust contract over both, the planner and approve-first's prepare.
async function preparedCard() {
  const rows = approvedTextAnswers(structuredClone(ROWS));
  const merged = engineFacts({ user_id: OWNER, answers: {}, saved: {} }, rows);
  const manifest = trustedManifest({ owner: OWNER, file: merged, rows, resume: { sha256: SHA } });
  const derived = Object.keys(manifest.byFactId).find((k) => k.includes("+"));
  if (!derived) throw Error("fixture: the preparation kept no derived full name");
  const artifact = { filename: "synthetic.pdf", sha256: SHA };
  const plan = planApplication({ manifest, userId: OWNER, jobId: JOB, employer: "Synthetic", schema, artifact, now: NOW });
  if (!plan.ready) throw Error("fixture planner failed: " + JSON.stringify(plan));
  const schemaHash = await hashApplyPayload(schema);
  const engineHash = await applicationApprovalHash({ userId: OWNER, posting: JOB, destination: URL, fields: plan.fields,
    resumeSha256: SHA, schemaHash, pageFieldNames: [], manifest });
  const p = await prepare({ url: URL, factsPath: "unused.json", resumePath: "unused.pdf", account: { epoch: 1, version: 1 }, now: NOW,
    runEngine: async () => ({ result: { state: "not_submitted", reason: "dry_run" }, evidence: { approval_hash: engineHash, schema,
      fields: plan.fields, sources: manifest.byFactId, replay_sources: Object.values(manifest.byFactId),
      trust: { quarantine_version: manifest.version, manifest_hash: manifest.hash },
      payload: { user_id: OWNER, posting: JOB, company: "Synthetic", destination: URL, resume: artifact, page_fields: {}, schema_hash: schemaHash } } }) } as any);
  if (!p.ready) throw Error("fixture prepare failed");
  return { payload: (p as any).payload, derived, plan };
}

Deno.test("one definition: prepare-ahead's withFullName is the shared approved-sources function", () => {
  assertEquals(withFullName, approvedTextAnswers);
});

Deno.test("the send check reads the full name the preparation derived from the texted first and last names", async () => {
  const { payload, derived, plan } = await preparedCard();
  assertEquals(plan.fields.find((f: any) => f.label === "Full name")?.value, "Alex Testcase");
  const live = engineInput({ owner: OWNER, profile: {}, rows: structuredClone(ROWS), resumeSha256: SHA });
  // Before the fix this threw APPROVED_SOURCE_WITHDRAWN for `derived` (text-answer:<first>+<last>).
  assertCurrentApprovedSources(payload, live);
  assertEquals(live.facts.text_answers.find((r) => r.key === "fact:full_name")?.answer, "Alex Testcase");
  assertEquals(derived.startsWith("text-answer:"), true);
});

Deno.test("a withdrawn or changed first or last name still refuses the derived full name at send", async () => {
  const { payload } = await preparedCard();
  const without = ROWS.filter((r) => r.key !== "fact:last_name");
  assertThrows(() => assertCurrentApprovedSources(payload, engineInput({ owner: OWNER, profile: {}, rows: without, resumeSha256: SHA })),
    Error, "APPROVED_SOURCE_WITHDRAWN");
  const changed = ROWS.map((r) => r.key === "fact:first_name" ? { ...r, answer: "Sam" } : r);
  assertThrows(() => assertCurrentApprovedSources(payload, engineInput({ owner: OWNER, profile: {}, rows: changed, resumeSha256: SHA })),
    Error, "APPROVED_SOURCE_WITHDRAWN");
});

Deno.test("a full name they texted themselves is never overwritten by the derived one, on either side", () => {
  const own = [...ROWS, row(4, "fact:full_name", "Alexandra Testcase")];
  const live = engineInput({ owner: OWNER, profile: {}, rows: own });
  assertEquals(live.facts.text_answers.filter((r) => r.key === "fact:full_name").map((r) => r.answer), ["Alexandra Testcase"]);
  assertEquals(approvedTextAnswers(own).filter((r) => r.key === "fact:full_name").length, 1);
});
