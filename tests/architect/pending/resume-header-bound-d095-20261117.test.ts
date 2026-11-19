// D-095 (owner, 2026-11-17): the header of a confirmed resume (name, email, phone) counts as confirmed facts, bound to that
// resume. The independent review of ag/mass-apply-10 (blocker 2) found three ways the MA05 design broke that ruling:
//   P2 a new resume's header confirmation replaced the old header facts only by matching label, so a header with no phone
//      kept the earlier resume's phone, and a name split differently kept the earlier resume's first and last name: mixed
//      identities on one profile;
//   P3 header facts were confirmed even when the resume's entries were held (the reply said they were not confirmed);
//   R  header facts carried no upload hash, so career_apply_profile_for (20261026120018: an upload-hashed fact only while its
//      hash is the confirmed record's) kept them after the resume was replaced or deleted.
// Fixed: every header confirmation removes every resume-header:* fact first; header facts are added only when the yes
// evidenced the entries (none held, at least one stamped); each carries source_ref.upload_sha256, as the entries do.
import assertNode from "node:assert/strict";
import { evidenceResumeConfirmation, heldEvents, sha256Hex } from "../../../supabase/functions/_shared/career_router_evidence.ts";
import { pgBinDir, type Pg, startPg } from "../../flow/pg.ts";
import { careerHandler, supabaseParity } from "../../flow/handler.ts";

const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ok = (v: unknown, m?: string) => assertNode.ok(v, m);
const U = "7b0f8f8e-6a43-4a49-9d2c-0000000d0951";
const NEW = "Mary Ann Smith\nChicago, IL | mary.new@example.test\n\nEDUCATION\nX College - B.S. Math";
const headerNew = { name: "Mary Ann Smith", email: "mary.new@example.test", contactLine: "Chicago, IL | mary.new@example.test", confirmed_at: "2026-11-17T00:00:00Z" };
const oldHeaderFacts = () => [
  { id: "resume-header:first_name", kind: "profile", name: "First name", value: "Maya", text: "First name: Maya", status: "confirmed", needs_confirmation: false, confirmation_event_id: "e1", provenance: "p", source_ref: { upload: "m0", upload_sha256: "a".repeat(64) } },
  { id: "resume-header:last_name", kind: "profile", name: "Last name", value: "Fictional", text: "Last name: Fictional", status: "confirmed", needs_confirmation: false, confirmation_event_id: "e2", provenance: "p", source_ref: { upload: "m0", upload_sha256: "a".repeat(64) } },
  { id: "resume-header:phone", kind: "profile", name: "Phone", value: "+1 555-0142", text: "Phone: +1 555-0142", status: "confirmed", needs_confirmation: false, confirmation_event_id: "e3", provenance: "p", source_ref: { upload: "m0", upload_sha256: "a".repeat(64) } },
];
const draft = () => ({ id: "E1", kind: "education", text: "X College - B.S. Math", title: "X College - B.S. Math", status: "draft", needs_confirmation: true });
async function confirmNew(o: { shown: string; before: any[] }) {
  const sha = await sha256Hex(NEW);
  const after = { facts: [...o.before.map((f) => ({ ...f, ...(f.id === "E1" ? { status: "confirmed", needs_confirmation: false } : {}) }))], resume_header: headerNew };
  const r = await evidenceResumeConfirmation({ userId: U, now: Date.parse("2026-11-17T00:00:00Z"), message: "yes", before: { facts: o.before, resume_header: { name: "Maya Fictional", confirmed_at: "2026-11-01T00:00:00Z" } }, after,
    out: { intent: "career_resume_ingest", resultStatus: "completed" }, shown: { text: o.shown, message_ids: ["1"] },
    upload: { kind: "message", ref: "agent_messages:9", sha256: sha, text: NEW }, events: heldEvents() });
  return { r, after, sha };
}

Deno.test("P2: a new resume's header confirmation removes every earlier header fact; no mixed identities", async () => {
  const { r, after, sha } = await confirmNew({ before: [...oldHeaderFacts(), draft()], shown: `At the top: Mary Ann Smith | ${headerNew.contactLine}\n1. X College - B.S. Math` });
  eq(r.stamped, 1);
  const head = after.facts.filter((f: any) => String(f.id).startsWith("resume-header:"));
  eq(head.map((f: any) => `${f.id}=${f.value}`).sort(), ["resume-header:email=mary.new@example.test", "resume-header:full_name=Mary Ann Smith"], "only the new resume's header");
  for (const f of head) eq(f.source_ref?.upload_sha256, sha, `${f.id} is bound to the confirmed upload's hash`);
});

Deno.test("P3: entries held at the yes, so no header fact is confirmed (and the earlier ones are gone)", async () => {
  const { r, after } = await confirmNew({ before: [...oldHeaderFacts(), draft()], shown: `At the top: Mary Ann Smith | ${headerNew.contactLine}` });
  eq([r.stamped, r.unshown, r.held], [0, 1, ["E1"]]);
  eq(r.header ?? 0, 0, "no header facts while the entries are held");
  eq(after.facts.filter((f: any) => String(f.id).startsWith("resume-header:")), [], "nothing of the header is confirmed");
});

// R: the database's own filter, through the production handler on a real Postgres (CI's migration order).
let pg: Pg | null = null;
Deno.test({ name: "R: header facts drop with the resume they came from (replaced, then deleted)", sanitizeResources: false, sanitizeOps: false, async fn() {
  if (!pgBinDir()) { if (Deno.env.get("CI") === "true") throw Error("needs Postgres 16 in CI"); console.log("NOT_RUN locally: no Postgres binaries"); return; }
  const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
  const RESUME = await Deno.readTextFile(`${ROOT}/packages/career-data/fixtures/test-resume.txt`);
  pg = await startPg();
  try {
    await supabaseParity(pg);
    const person = "7b0f8f8e-6a43-4a49-9d2c-0000000d0952";
    await pg.sql(`insert into auth.users (id, email) values ('${person}', '${person}@example.test'); insert into public.profiles (id) values ('${person}');
      insert into public.career_watch_kv (user_id, key, value) values ('${person}', 'career:account', '{"epoch":0,"version":0,"paused":false}');`);
    const handler = await careerHandler(pg, { "tok-h": person });
    const chat = handler.chat("tok-h");
    eq((await chat.say(`here is my resume:\n${RESUME}`)).status, 200);
    eq((await chat.say("yes, that's my resume")).status, 200);
    const headerIn = async () => JSON.parse(await pg!.sql(`select coalesce(json_agg(f->>'id'), '[]') from jsonb_array_elements(coalesce(public.career_apply_profile_for('${person}')->'facts', '[]')) f where f->>'id' like 'resume-header:%'`));
    const before = await headerIn();
    ok(before.length > 0, "the confirmed header's facts are read while that resume is the confirmed record");
    const other = "c".repeat(64);
    await pg.sql(`select public.career_resume_put('${person}', '${other}', 'file', 'test:other', 'Other.pdf', null, 'test: another resume confirmed')`);
    eq(await headerIn(), [], "replaced: the earlier resume's header facts are not read");
    await pg.sql(`select public.career_resume_delete_as('${person}')`);
    eq(await headerIn(), [], "deleted: no header facts");
  } finally { await pg?.stop?.(); }
} });
