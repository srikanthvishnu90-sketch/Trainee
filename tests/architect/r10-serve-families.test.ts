// R10 WO-E: the File families served by trainee-file from the records it stores (file_family_serve.ts), through the real handler
// (handleFile). The signed-in owner gets the family page when TRAINEE_FILE_FAMILIES is on, and the kind's existing page when it is off;
// another account and a signed-out browser get nothing of the File. Every live control on a served page posts an action the kind's
// handler answers for that record (no dead buttons), and a tap goes through the existing actOn path.
import assert from "node:assert/strict";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { FAMILY_SOURCES, kindRoutes } from "../../supabase/functions/_shared/file_family_serve.ts";
import { validateKind, type FileRecord } from "../../supabase/functions/_shared/file_kinds.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { phonePost, signedIn } from "./file-session-fakes.ts";

const U = "11111111-1111-4111-8111-111111111111", OTHER = "22222222-2222-4222-8222-222222222222", NOW = Date.parse("2026-11-09T15:45:00Z");
const SECRET = "file-link-secret-0123456789-abcdef";
const INTRO = { title: "Intro to Dana", person: { name: "Dana Lee", role: "Analytics Manager", company: "Example Co", source: "Reported, not verified" },
  why: [{ text: "You built pricing dashboards in SQL.", source: "From your resume" }, { text: "Example Co is hiring a Data Analyst.", source: "From the posting" }, { text: "You want a growth-team role.", source: "From you" }],
  message: { channel: "email", to: "dana@example.com", subject: "A question about analytics", body: "Hi Dana, could I ask two questions about the team?" } };
const PROOF = { from_record: true, title: "Application to Example Co", company: "Example Co", role: "Data Analyst", status: "submitted", prepared_at: "2026-11-08T14:00:00Z",
  submitted_at: "2026-11-08T15:04:00Z", as_of: "2026-11-08T15:05:00Z", answers: [], problems: [] };

async function world(flag: string | undefined) {
  const A = signedIn(), env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_FILE_FAMILIES: flag };
  const store = memoryFileStore(), svc = createFileService({ store, env: { get: (k) => env[k] }, now: () => NOW });
  const d = { ...A.deps, store: { async recallList() { return null; }, async recall() { return null; } } as unknown as FileStore, now: () => NOW, env: { get: (k: string) => env[k] },
    cards: { async open() { return null; } }, tap: {} as never, files: svc, timeZone: async () => "America/Chicago" } as unknown as FileDeps;
  const intro = await svc.create(U, "introduction", structuredClone(INTRO)) as { ok: true; id: string };
  assert.ok(intro.ok, JSON.stringify(intro));
  const v = validateKind("application_proof", PROOF, { trusted: true, now: NOW }) as { ok: true; data: unknown };
  const proofId = "0a1b2c3d4e";
  await store.put({ id: proofId, userId: U, kind: "application_proof", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null } as FileRecord);
  const open = async (id: string, as = U) => await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${await A.tok(as, id, NOW)}` } }), d);
  return { A, d, svc, store, intro: intro.id, proof: proofId, open };
}
const posted = (h: string) => [...h.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => /name="action" value="([^"]+)"/.exec(m[1])?.[1] ?? "");

Deno.test("serve families: the owner gets F-12 for an emailed introduction and F-09 for an application record; flag off keeps the kind pages", async () => {
  const on = await world("on");
  const i = await (await on.open(on.intro)).text();
  assert.match(i, /data-family="F-12"/); assert.match(i, /Dana Lee - recipient verified/); assert.match(i, /Hi Dana, could I ask two questions about the team\?/);
  assert.match(i, /name="action" value="introduce"><input type="hidden" name="tag" value="[0-9a-f]{16}"><button type="submit" class="ff-btn ff-pri" data-effect="send">Approve send/);
  const p = await (await on.open(on.proof)).text();
  assert.match(p, /data-family="F-09"/); assert.match(p, /Recorded as submitted, but no employer confirmation with a link and time is on file/); assert.doesNotMatch(p, /Submitted - confirmed/);
  assert.match(p, /name="action" value="flag">[\s\S]*<textarea id="ff-flag" name="note"/);
  // Every live control posts an action the kind's handler answers for this record.
  const rec = (await on.svc.get(U, on.intro)) as { state: "ok"; rec: FileRecord };
  for (const a of posted(i)) assert.ok(kindRoutes(rec.rec).has(a), `introduction: ${a}`);
  for (const a of posted(p)) assert.ok(["status", "flag", "remove"].includes(a), `application_proof: ${a}`);
  const off = await world(undefined);
  assert.doesNotMatch(await (await off.open(off.intro)).text(), /data-family=/);
});

Deno.test("serve families: another account and a signed-out browser get nothing of the File", async () => {
  const w = await world("on");
  for (const id of [w.intro, w.proof]) {
    const other = await w.open(id, OTHER), t = await other.text();
    assert.doesNotMatch(t, /Dana Lee|Hi Dana|Example Co|data-family=/, `another account: ${id}`);
    const anon = await handleFile(new Request("https://trainee.example/file"), w.d), a = await anon.text();
    assert.doesNotMatch(a, /Dana Lee|Hi Dana|Example Co|data-family=/, `signed out: ${id}`);
  }
});

Deno.test("serve families: a tap on the served page goes through the record's own action and the page says what happened", async () => {
  const w = await world("on");
  const tok = await w.A.tok(U, w.intro, NOW);
  const r = await handleFile(new Request("https://trainee.example/file", await phonePost({ t: tok, action: "pass" }, SECRET)), w.d), h = await r.text();
  assert.match(h, /data-family="F-12"/); assert.match(h, /<p class="ff-note" role="status">Passed\. Nothing was sent\.<\/p>/);
  assert.match(h, /disabled data-effect="send">Approve send<\/button><span class="ff-off">You passed on this one\./);
});

Deno.test("serve families: every family names its data source today, or why it has none", () => {
  for (const [id, s] of Object.entries(FAMILY_SOURCES)) assert.ok(s.source || (s.why && s.why.length > 20), id);
  assert.deepEqual(Object.entries(FAMILY_SOURCES).filter(([, s]) => s.source).map(([id]) => id), ["F-05", "F-09", "F-12"]);
});

Deno.test("serve families: nothing the kind page showed is lost - the record's status, confirmation, not-done items, flags and approval code", async () => {
  const w = await world("on");
  const v = validateKind("application_proof", { ...PROOF, status: "confirmed", confirmation: { id: "GH-4471" }, problems: [{ item: "Portfolio link", outcome: "skipped", reason: "The form had no field for it." }] }, { trusted: true, now: NOW }) as { ok: true; data: unknown };
  await w.store.put({ id: "1b2c3d4e5f", userId: U, kind: "application_proof", data: v.data, state: { flags: [{ at: NOW, note: "They never got my resume." }] }, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null } as FileRecord);
  const p = await (await w.open("1b2c3d4e5f")).text();
  for (const s of ["Confirmed by the employer.", "GH-4471", "Portfolio link", "Skipped:", "They never got my resume."]) assert.ok(p.includes(s), s);
  assert.match(p, /disabled data-effect="submit">Approve submission<\/button><span class="ff-off">Already approved/);
  const i = await (await w.open(w.intro)).text(), rec = (await w.svc.get(U, w.intro)) as { state: "ok"; rec: FileRecord };
  assert.match(i, new RegExp(`Approval code</dt><dd><span class="ff-v" data-claim="1" data-src="personal">${rec.rec.tag}`));
  // An introduction with no stored address keeps its kind page: F-12 never approves an email it cannot address.
  const noTo = await w.svc.create(U, "introduction", { ...structuredClone(INTRO), message: { ...INTRO.message, to: undefined } }) as { ok: true; id: string };
  assert.doesNotMatch(await (await w.open(noTo.id)).text(), /data-family=/);
});

Deno.test("serve families: the employer's confirmation stays on F-09 - its ID, the link, and the screenshot (inline only from the project's storage)", async () => {
  const mk = async (supabase: string | undefined) => {
    const A = signedIn(), env: Record<string, string | undefined> = { TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: "https://trainee.example/file", TRAINEE_FILE_FAMILIES: "on", SUPABASE_URL: supabase };
    const store = memoryFileStore(), svc = createFileService({ store, env: { get: (k) => env[k] }, now: () => NOW });
    const d = { ...A.deps, store: { async recallList() { return null; }, async recall() { return null; } } as unknown as FileStore, now: () => NOW, env: { get: (k: string) => env[k] },
      cards: { async open() { return null; } }, tap: {} as never, files: svc, timeZone: async () => "America/Chicago" } as unknown as FileDeps;
    const v = validateKind("application_proof", { ...PROOF, status: "confirmed", confirmation: { id: "GH-4471", url: "https://boards.greenhouse.io/acme/confirmation/4471", screenshot_url: "https://proj.supabase.co/storage/v1/object/sign/proofs/gh-4471.png" } }, { trusted: true, now: NOW }) as { ok: true; data: unknown };
    await store.put({ id: "2c3d4e5f6a", userId: U, kind: "application_proof", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null } as FileRecord);
    return await handleFile(new Request("https://trainee.example/file", { headers: { cookie: `tf_s=${await A.tok(U, "2c3d4e5f6a", NOW)}` } }), d);
  };
  const r = await mk("https://proj.supabase.co"), h = await r.text();
  assert.match(h, /data-family="F-09"/); assert.match(h, /Confirmation ID:<\/strong> GH-4471/);
  assert.match(h, /href="https:\/\/boards\.greenhouse\.io\/acme\/confirmation\/4471"[^>]*>Open the confirmation/);
  assert.match(h, /<img src="https:\/\/proj\.supabase\.co\/storage\/v1\/object\/sign\/proofs\/gh-4471\.png" alt="Example Co&#39;s confirmation screen"/);
  assert.match(r.headers.get("content-security-policy")!, /img-src [^;]*https:\/\/proj\.supabase\.co/, "the CSP allows exactly the storage origin");
  const other = await (await mk(undefined)).text();
  assert.doesNotMatch(other, /<img src="https:\/\/proj/); assert.match(other, /href="https:\/\/proj\.supabase\.co\/storage\/v1\/object\/sign\/proofs\/gh-4471\.png"[^>]*>Open the screenshot/);
});
