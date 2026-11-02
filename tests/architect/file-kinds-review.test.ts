// Review probes for #280 (written first; each failed against 9b7d344). Placeholders, label spoofing, the records label, approval order,
// the fail-closed fact guard, and Remove's honesty.
import assertNode from "node:assert/strict";
import { signedIn, phonePost } from "./file-session-fakes.ts";
const A = signedIn();
import { actionsOf, textOf, validateKind, type FileRecord } from "../../supabase/functions/_shared/file_kinds.ts";
import { createFileService, memoryFileStore, type FileKindStore } from "../../supabase/functions/_shared/file_service.ts";
import { createFileTool } from "../../supabase/functions/_shared/agent/file_tool.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const SECRET = "file-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file";
const U = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-10-28T12:00:00Z");
const ENV: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const INTRO = { title: "Intro to Dana Lee", person: { name: "Dana Lee", role: "Analytics Manager", company: "Acme", source: "Reported, not verified" },
  why: [{ text: "You built weekly pricing dashboards in SQL.", source: "From your resume" }, { text: "Acme is hiring a Data Analyst.", source: "From the posting" }, { text: "You want a growth-team role.", source: "From you" }],
  message: { channel: "email", subject: "Quick question", body: "Hi Dana, I build pricing dashboards and saw Acme is hiring. Could I ask two questions?" } };
const BRIEF = { title: "Acme", subject: "Acme", findings: [{ label: "Product", value: "Pricing analytics", source: "Reported, not verified" }], sources: [{ title: "About", url: "https://acme.example/about" }] };

Deno.test("probe 2: placeholders cannot be smuggled past the check", () => {
  const bad = ["n/a.", "TBD.", "not known", "—", "unknown​", "Unknown‍ ", "N／A", "- - -", "…", "to be determined", "Not Applicable", "undisclosed"];
  for (const v of bad) {
    const x = clone(BRIEF); x.findings[0].value = v;
    assert(!validateKind("research_brief", x).ok, `fact value ${JSON.stringify(v)} accepted`);
    const y = clone(INTRO); y.person.name = v;
    assert(!validateKind("introduction", y).ok, `person name ${JSON.stringify(v)} accepted`);
  }
  for (const v of ["[Your Name]", "Hi Dana, I am [Your Name].", "Dear {{first_name}}", "Hello <name>", "Best, [YOUR NAME]"]) {
    const y = clone(INTRO); y.message.body = v;
    assert(!validateKind("introduction", y).ok, `message ${JSON.stringify(v)} accepted`);
  }
  const y = clone(INTRO); y.person.name = "Unknown"; assert(!validateKind("introduction", y).ok);
});
Deno.test("probe 3: label-looking text inside a value is refused", () => {
  for (const v of ["Python [From the posting]", "Python (From your resume)", "Python ​[from you]", "Python - Reported, not verified", "Python · From the posting"]) {
    const x = clone(BRIEF); x.findings[0].value = v;
    assert(!validateKind("research_brief", x).ok, `${JSON.stringify(v)} accepted`);
  }
  const ok = clone(BRIEF); ok.findings[0].value = "They want to hear from you early"; assert(validateKind("research_brief", ok).ok, "plain words are fine");
});
Deno.test("probe 1: the records label is not something the model can supply, on any kind", async () => {
  const svc = createFileService({ store: memoryFileStore(), env: { get: (k) => ENV[k] }, now: () => NOW });
  const plan = { title: "Prep", variant: "interview_prep", sections: [{ heading: "Facts", items: [{ label: "Pay", value: "$200k", source: "From Trainee's records" }] }] };
  assert(!validateKind("plan_review", plan).ok, "plan_review accepted the records label from the model");
  const proof = { title: "Application to Acme", company: "Acme", role: "Data Analyst", status: "confirmed", submitted_at: "2026-10-28T10:00:00Z", as_of: "2026-10-28T11:00:00Z", confirmation: { id: "GH-1" }, answers: [], problems: [] };
  const r = await svc.create(U, "application_proof", proof);
  assert(!r.ok, "application_proof was created from model-written company/status/confirmation");
});
Deno.test("probe 4: an approved introduction with no sender reads 'Approved. Not sent', never 'done'", () => {
  const rec: FileRecord = { id: "0123456789", userId: U, kind: "introduction", data: INTRO, state: { choice: "approved" }, tag: "a".repeat(16), created_at: NOW, expires_at: NOW + 1e6, revoked_at: null };
  const t = textOf(rec, { now: NOW });
  assert(/Introduce: approved, not sent/.test(t) && !/Introduce: done/.test(t), t);
  assert(actionsOf(rec).find((a) => a.id === "introduce")!.state !== "done");
});
Deno.test("probe 4b: the approval is recorded BEFORE any send attempt", async () => {
  const store = memoryFileStore();
  const svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const made = (await svc.create(U, "introduction", INTRO)) as { id: string };
  const seen: unknown[] = [];
  const stub: FileStore = { async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { return "saved"; }, async prepared() { return null; }, async applied() { return false; },
    async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; }, async wanted() { return false; } };
  const d: FileDeps = { ...A.deps, store: stub, now: () => NOW, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } }, tap: {} as never, files: svc,
    fileEffects: { async introduce(u: string) { seen.push((await store.get(u, made.id))?.state.choice); return { ok: false, reason: "mail down" }; } } };
  const t = await A.tok(U, made.id, NOW);
  const tag = (await store.get(U, made.id))!.tag!;
  const r = await handleFile(new Request("https://x.example/f", await phonePost({ t, action: "introduce", tag }, SECRET)), d);
  eq(seen, ["approved"], "at send time the approval was already stored");
  assert(/not sent/i.test(await r.text()));
  eq((await store.get(U, made.id))?.state.choice, "approved");
});
Deno.test("probe 5: with no fact guard the tool refuses (fails closed)", async () => {
  const svc = createFileService({ store: memoryFileStore(), env: { get: (k) => ENV[k] }, now: () => NOW });
  const tool = createFileTool(svc);
  for (const turn of [undefined, { message: "m", added: [] }]) {
    let threw = false;
    try { await tool.run({ kind: "research_brief", data: BRIEF }, { userId: U, threadId: "t", now: NOW, state: {}, turn: turn as never }); } catch { threw = true; }
    assert(threw, "created a file with no guard available");
  }
});
Deno.test("probe 6: Remove reports failure when the revoke did nothing", async () => {
  const inner = memoryFileStore();
  const store: FileKindStore = { ...inner, put: inner.put, get: inner.get, patch: inner.patch, revoke: async () => false };
  const svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const made = (await svc.create(U, "research_brief", BRIEF)) as { id: string };
  const stub = { async recallList() { return null; } } as unknown as FileStore;
  const d: FileDeps = { ...A.deps, store: stub, now: () => NOW, env: { get: (k) => ENV[k] }, cards: {} as never, tap: {} as never, files: svc };
  const t = await A.tok(U, made.id, NOW);
  const r = await handleFile(new Request("https://x.example/f", await phonePost({ t, action: "remove" }, SECRET)), d);
  const body = await r.text();
  assert(r.status >= 500 || r.status === 409, `status ${r.status}`);
  assert(!/is removed|File removed/i.test(body) && /couldn.t remove|not removed/i.test(body), body.slice(0, 300));
});

// ---- the records label: values come from a real application record, resolved server-side from an id
const ROW = (o: Record<string, unknown> = {}) => ({ state: "confirmed", reason: null, confirmation_id: "GH-4471", created_at: "2026-10-28T09:00:00Z", updated_at: "2026-10-28T10:00:00Z", company: "Acme", url: "https://boards.greenhouse.io/acme/jobs/1",
  payload: { resume_name: "ada-resume.pdf", fields: [{ name: "first_name", label: "First name", value: "Ada" }, { name: "pw", label: "Password", value: "hunter2" }, { name: "cv", label: "Resume", type: "file", value: "x" }] }, ...o });
const withRecords = (rows: Record<string, unknown>, at = { t: NOW }) => {
  const store = memoryFileStore();
  const svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => at.t, records: { async application(u, id) { return u === U ? (rows[id] as never) ?? null : null; } } });
  return { store, svc };
};
Deno.test("application_proof is built from the record: every value comes from the row, none from the model", async () => {
  const w = withRecords({ "job-1": ROW() });
  const r = await w.svc.create(U, "application_proof", { application_id: "job-1" });
  assert(r.ok, JSON.stringify(r));
  const d = (await w.store.get(U, (r as { id: string }).id))!.data;
  eq([d.company, d.status, d.confirmation, d.submitted_at, d.destination, d.resume, d.from_record], ["Acme", "confirmed", { id: "GH-4471" }, undefined, "boards.greenhouse.io", "ada-resume.pdf", true]);
  eq(d.answers.map((a: any) => [a.question, a.answer, a.source]), [["First name", "Ada", "From Trainee's records"]], "secrets and files are not copied");
  const text = textOf((await w.store.get(U, (r as { id: string }).id))!, { now: NOW });
  assert(text.includes("Company: Acme [From Trainee's records]"));
  // the model cannot add or override anything
  assert(!(await w.svc.create(U, "application_proof", { application_id: "job-1", status: "confirmed", company: "Evil" })).ok);
});
Deno.test("application_proof: unreadable, unknown, someone else's, unmapped or future records give no file", async () => {
  const at = { t: NOW };
  const w = withRecords({ "job-1": ROW(), "job-2": ROW({ state: "unknown_outcome" }), "job-3": ROW({ updated_at: "2026-10-29T10:00:00Z" }), "job-4": ROW({ state: "confirmed", confirmation_id: null }) }, at);
  for (const id of ["nope", "job-2", "job-3", "job-4", ""]) { const r = await w.svc.create(U, "application_proof", { application_id: id }); assert(!r.ok, id); }
  eq(w.store.size(), 0);
  assert(!(await w.svc.create("22222222-2222-4222-8222-222222222222", "application_proof", { application_id: "job-1" })).ok, "another person's id");
  const none = createFileService({ store: memoryFileStore(), env: { get: (k) => ENV[k] }, now: () => NOW });
  assert(!(await none.create(U, "application_proof", { application_id: "job-1" })).ok, "no record reader wired: no file");
});
Deno.test("application_proof statuses map to the five exact words; failed and needs-you rows say why", async () => {
  const w = withRecords({ a: ROW({ state: "queued" }), b: ROW({ state: "driving" }), c: ROW({ state: "submitted_unconfirmed", confirmation_id: null }), d: ROW({ state: "failed", reason: "The form rejected the upload." }), e: ROW({ state: "needs_user", reason: "A work-authorization answer is needed." }) });
  const got: string[] = [];
  for (const id of ["a", "b", "c", "d", "e"]) { const r = await w.svc.create(U, "application_proof", { application_id: id }); assert(r.ok, id + JSON.stringify(r)); got.push((await w.store.get(U, (r as { id: string }).id))!.data.status); }
  eq(got, ["queued", "prepared", "submitted", "failed", "prepared"]);
});
Deno.test("a stored application proof that code did not build from a record is not served", async () => {
  const w = withRecords({});
  await w.store.put({ id: "abcdef0123", userId: U, kind: "application_proof", data: { title: "x", company: "Acme", status: "confirmed" }, state: {}, tag: null, created_at: NOW, expires_at: NOW + 1e6, revoked_at: null });
  eq((await w.svc.get(U, "abcdef0123")).state, "missing");
});
Deno.test("the records label renders only on an application proof built from a record", () => {
  const rec: FileRecord = { id: "0123456789", userId: U, kind: "research_brief", data: { ...BRIEF, findings: [{ label: "Pay", value: "$200k", source: "From Trainee's records" }] }, state: {}, tag: null, created_at: NOW, expires_at: NOW + 1e6, revoked_at: null };
  assert(!textOf(rec, { now: NOW }).includes("$200k"), "an unsourced fact is not rendered");
});

// ---- round 3 probes
Deno.test("probe r3-3: more placeholders, spaced-out letters and Cyrillic/Greek look-alikes are refused (small denylist, by design)", () => {
  for (const v of ["none given", "Pending", "not disclosed", "u n k n o w n", "U N K N O W N.", "unknоwn" /* Cyrillic o */, "unkոown".replace("ո", "n"), "υnknown" /* Greek upsilon */, "ΝΑ" /* Greek capital nu + alpha */, "tbd".replace("b", "ь"), "n​/​a"]) {
    const x = clone(BRIEF); x.findings[0].value = v;
    assert(!validateKind("research_brief", x).ok, `${JSON.stringify(v)} accepted`);
  }
  const ok = clone(BRIEF); ok.findings[0].value = "Pending FDA review of the new device"; assert(validateKind("research_brief", ok).ok, "a real sentence that starts with a denylisted word is fine");
  const ok2 = clone(BRIEF); ok2.findings[0].value = "A B testing platform"; assert(validateKind("research_brief", ok2).ok);
  const sp = clone(BRIEF); sp.findings[0].value = "Pythоn [Frоm the posting]"; assert(!validateKind("research_brief", sp).ok, "look-alike spoof of a label");
});
Deno.test("probe r3-2: two simultaneous Introduce taps attempt exactly one send", async () => {
  const store = memoryFileStore();
  const svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW });
  const made = (await svc.create(U, "introduction", INTRO)) as { id: string };
  let sends = 0;
  const stub: FileStore = { async remember() {}, async recall() { return null; }, async rememberList() {}, async recallList() { return null; }, async postings() { return []; }, async save() { return "saved"; }, async prepared() { return null; }, async applied() { return false; },
    async want() { return { result: "queued" }; }, async appRow() { return null; }, async claimLink() { return true; }, async wanted() { return false; } };
  const d: FileDeps = { ...A.deps, store: stub, now: () => NOW, env: { get: (k) => ENV[k] }, cards: { async open() { throw new Error("no"); } }, tap: {} as never, files: svc,
    fileEffects: { async introduce() { sends++; await new Promise((r) => setTimeout(r, 15)); return { ok: true }; } } };
  const t = await A.tok(U, made.id, NOW);
  const tag = (await store.get(U, made.id))!.tag!;
  const tap = async (action: string) => handleFile(new Request("https://x.example/f", await phonePost({ t, action, tag }, SECRET)), d);
  await Promise.all([tap("introduce"), tap("introduce"), tap("introduce"), tap("pass")]);
  const choice = (await store.get(U, made.id))?.state.choice;
  eq(sends, choice === "passed" ? 0 : 1, `${sends} sends attempted, choice ${choice}: exactly one decision wins, and Pass and Introduce exclude each other`);
});
Deno.test("probe r3-1: a proof built from a row says 'Last updated', never 'Submitted' (the row has no submit time)", async () => {
  const store = memoryFileStore();
  const svc = createFileService({ store, env: { get: (k) => ENV[k] }, now: () => NOW, records: { async application() { return { state: "confirmed", reason: null, confirmation_id: "GH-1", created_at: "2026-10-28T09:00:00Z", updated_at: "2026-10-28T10:00:00Z", company: "Acme", payload: {} } as never; } } });
  const r = (await svc.create(U, "application_proof", { application_id: "j" })) as { id: string };
  const rec = (await store.get(U, r.id))!;
  eq(rec.data.submitted_at, undefined);
  const t = textOf(rec, { now: NOW });
  assert(/Last updated: Oct 28, 10:00 UTC/.test(t) && !/Submitted:/.test(t), t);
});
