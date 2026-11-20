// D-072 (files writers), in process: the three writers' own rules, beside the end-to-end test on Postgres
// (files-writers-d072-pg.test.ts).
//   W1 search plan: a search writes v1 from the person's words; the same search again writes nothing; a watch alone carries over the
//      plan with the watch; paused is kept as paused; sponsorship is never written; a changed search is a new version.
//   W2 materials: a delivered PDF with its producer's material writes v1; the Word copy beside it is the same version; the same file
//      again writes nothing; a new file for the same target is v2; a document no producer marked (a picture) writes nothing; the
//      router's posting tailor is read from its artifact; a document that was not stored (not delivered) writes nothing.
//   W3 cover letters: the brain's create_file draft of type cover_letter is written as a letter version, its file the letter as
//      delivered; another draft type writes nothing; a refused File writes nothing.
//   W4 path comparisons: the ask is recognized (and the people graph's "two paths" is not); compare_paths refuses a path the person
//      did not write, stores each direction's rows from their own words and confirmed record, and predicts nothing; the File view.
//   deno test -A --no-check tests/architect/files-writers-d072.test.ts
import assert from "node:assert/strict";
import { writeSearchPlan, memorySearchPlanWriter } from "../../supabase/functions/_shared/career_search_plan_writer.ts";
import { memoryPlanMaterialStore } from "../../supabase/functions/_shared/file_family_records_materials.ts";
import { type MaterialRow, type MaterialWriteStore, sha256Hex, withLetterVersions, writeTurnMaterials } from "../../supabase/functions/_shared/career_material_writer.ts";
import { memoryPathStore, pathCompareAskOf } from "../../supabase/functions/_shared/career_path_comparisons.ts";
import { PATH_TOOL, pathComparisonTool } from "../../supabase/functions/_shared/agent/path_comparison_tool.ts";
import { pathComparisonView } from "../../supabase/functions/_shared/file_family_records.ts";
import type { FileService } from "../../supabase/functions/_shared/file_service.ts";
import type { SearchAsk } from "../../supabase/functions/_shared/career_search_judge.ts";

const U = "7b0f8f8e-6a43-4a49-9d2c-0000000d0741";
const NOW = Date.parse("2026-11-12T15:00:00Z");
const ask = (x: Partial<SearchAsk> = {}): SearchAsk => ({ role: "data analyst internships", place: "Chicago", remote: false, limits: { bands: ["intern"], pay: null, company: null, term: null, needsSponsor: true }, want: null, ...x });
const alert = (on: boolean) => ({ prefs: { on, keywords: ["data analyst"], locations: ["chicago"], remote_ok: true, report_hour: 8, quiet_start: 22, quiet_end: 7, max_instant_per_day: 3 } });

Deno.test("W1 search plan: versions from the person's search and watch, never a repeat, never sponsorship", async () => {
  const mem = memoryPlanMaterialStore(), w = memorySearchPlanWriter(mem, () => NOW);
  assert.deepEqual(await writeSearchPlan(w, U, { search: ask(), now: NOW }), { written: true, version: 1 });
  const [p1] = await mem.plans(U);
  assert.equal(p1.title, "Data analyst internships in Chicago");
  assert.deepEqual(p1.hard.map((e) => [e.k, e.v]), [["Role", "data analyst internships"], ["Location", "Chicago"], ["Level", "Internship"]]);
  assert.ok(p1.hard.every((e) => e.src?.kind === "you"), "every entry is the person's");
  assert.ok(!JSON.stringify(p1).toLowerCase().includes("sponsor"), "sponsorship is answered per application, never on the plan");
  assert.equal(p1.batch_cap, 8, "the search's own default count");
  assert.deepEqual(await writeSearchPlan(w, U, { search: ask(), now: NOW + 60_000 }), { written: false, why: "unchanged" }, "the same search said again later writes nothing");
  assert.deepEqual(await writeSearchPlan(w, U, { watch: alert(true), now: NOW }), { written: true, version: 2 });
  const p2 = (await mem.plans(U)).find((p) => p.version === 2)!;
  assert.deepEqual([p2.title, p2.hard, p2.watch?.active], [p1.title, p1.hard, true], "a watch carries the plan over with the watch");
  assert.deepEqual(await writeSearchPlan(w, U, { watch: alert(false), now: NOW }), { written: true, version: 3 });
  assert.match((await mem.plans(U)).find((p) => p.version === 3)!.watch!.text, /^Paused\./);
  assert.deepEqual(await writeSearchPlan(w, U, { search: ask({ want: 5, limits: { bands: null, pay: { amount: 30, period: "hour" }, company: null, term: null, needsSponsor: false } }), now: NOW }), { written: true, version: 4 });
  const p4 = (await mem.plans(U)).find((p) => p.version === 4)!;
  assert.deepEqual([p4.batch_cap, p4.hard.find((e) => e.k === "Pay floor")?.v, p4.watch?.active], [5, "$30 an hour or more, where pay is listed", false], "the count and pay said; the paused watch kept");
  // An approved version is never touched: approve v4, change the search, v4 stays approved.
  assert.equal(await mem.approvePlan(U, 4, (await mem.plans(U)).find((p) => p.version === 4)!.payload_hash, NOW), "approved");
  await writeSearchPlan(w, U, { search: ask({ place: "Austin" }), now: NOW });
  const after = await mem.plans(U);
  assert.deepEqual([after.length, !!after.find((p) => p.version === 4)!.approved_at, !!after.find((p) => p.version === 5)!.approved_at], [5, true, false]);
  // Nothing to plan: a stop with no plan and no watch.
  assert.deepEqual(await writeSearchPlan(memorySearchPlanWriter(memoryPlanMaterialStore()), U, { watch: null, now: NOW }), { written: false, why: "nothing_to_plan" });
});

function memMaterials(): MaterialWriteStore & { rows: (MaterialRow & { user: string })[] } {
  const rows: (MaterialRow & { user: string })[] = [];
  return {
    rows,
    async newest(u, doc) { const r = rows.filter((x) => x.user === u && x.doc_key === doc).sort((a, b) => b.version - a.version)[0]; return r ? { version: r.version, file_sha256: r.file.sha256 } : null; },
    async insert(u, row) { if (rows.some((x) => x.user === u && x.doc_key === row.doc_key && x.version === row.version)) return "conflict"; rows.push({ ...row, user: u }); return "ok"; },
  };
}
const b64 = (s: string) => btoa(s);

Deno.test("W2 materials: one version per delivered file, from the producer's own material", async () => {
  const store = memMaterials();
  const material = { doc_kind: "resume", target: "data analyst internships", role_job_id: null, based_on: "your confirmed resume", changes: [{ kind: "Emphasis", after: "Moved Projects above Experience", text: "Order changed; no fact changed." }, { kind: "Invented", after: "x", text: "x" }] };
  const pdf = { format: "pdf", filename: "resume.pdf", base64: b64("%PDF-1 one"), sha256: null, material };
  const docx = { format: "docx", filename: "resume.docx", base64: b64("PK docx"), sha256: null, material };
  const pic = { format: "png", filename: "a.png", base64: b64("png"), sha256: null };
  const w1 = await writeTurnMaterials(store, U, [pdf, docx, pic], [true, true, true], null);
  assert.equal(w1.length, 1, "the Word copy beside the PDF is the same version; the picture is no material");
  assert.deepEqual([store.rows[0].version, store.rows[0].label, store.rows[0].file.name, store.rows[0].file.sha256], [1, "the resume for data analyst internships", "resume.pdf", await sha256Hex(new TextEncoder().encode("%PDF-1 one"))]);
  assert.deepEqual(store.rows[0].changes.map((c) => c.kind), ["Emphasis"], "only the change kinds the page knows");
  assert.deepEqual((await writeTurnMaterials(store, U, [pdf], [true], null))[0], { written: false, doc_key: store.rows[0].doc_key, why: "same_file" });
  await writeTurnMaterials(store, U, [{ ...pdf, base64: b64("%PDF-1 two") }], [true], null);
  assert.deepEqual(store.rows.map((r) => r.version), [1, 2], "a new file for the same target is v2");
  assert.deepEqual(await writeTurnMaterials(store, U, [{ ...pdf, base64: b64("%PDF-1 three") }], [false], null), [], "not stored, not delivered: nothing written");
  // The router's posting tailor: its artifact names the posting and company.
  const art = { kind: "tailored_resume", pdf: { base64: b64("%PDF router"), sha256: "abc" }, jobId: "greenhouse:acme:7", company: "Acme" };
  await writeTurnMaterials(store, U, [{ format: "pdf", filename: "acme.pdf", base64: b64("%PDF router"), sha256: "abc" }], [true], { artifact: art });
  const r = store.rows.at(-1)!;
  assert.deepEqual([r.role_job_id, r.label, r.version], ["greenhouse:acme:7", "the resume for the posting at Acme", 1]);
  assert.match(r.doc_key, /^resume-the-posting-at-acme-[a-f0-9]{10}$/);
});

Deno.test("W3 cover letters: a created cover letter draft is a letter version; nothing else is", async () => {
  const store = memMaterials();
  let ok = true;
  const files = { create: async (_u: string, kind: string) => ok ? { ok: true, id: "f1", kind, title: "t", url: "https://trainee.example/file?t=x", webApp: null } : { ok: false, error: "not created" }, ttlHours: () => 168 } as unknown as FileService;
  const f = withLetterVersions(files, store);
  const letter = { title: "Cover letter for Data Analyst at Acme", type: "cover_letter", body: "Dear Acme team,\nI built a reporting dashboard used by 200 people.", basis: [] };
  assert.equal((await f.create(U, "draft", letter)).ok, true);
  assert.deepEqual([store.rows.length, store.rows[0].doc_kind, store.rows[0].label, new TextDecoder().decode(store.rows[0].file.bytes)], [1, "letter", "the cover letter for Data Analyst at Acme", letter.body]);
  await f.create(U, "draft", letter);
  assert.equal(store.rows.length, 1, "the same letter again writes nothing");
  await f.create(U, "draft", { ...letter, body: `${letter.body}\nThank you.` });
  assert.deepEqual(store.rows.map((r) => r.version), [1, 2], "a changed letter is v2");
  await f.create(U, "draft", { ...letter, type: "email" });
  ok = false;
  await f.create(U, "draft", { ...letter, body: "refused" });
  assert.equal(store.rows.length, 2, "an email draft or a refused File writes nothing");
});

Deno.test("W4 path comparisons: the ask, the person's own words only, rows from their record, the File view", async () => {
  for (const m of ["I'm weighing two paths: consulting at Deloitte or product management at a startup. Can you compare them?", "compare these career paths for me", "I'm torn between the Evercore offer or grad school"]) assert.ok(pathCompareAskOf(m), m);
  for (const m of ["which of my two paths to Stripe should I use for an intro?", "show me my offer comparison", "find me data analyst internships"]) assert.ok(!pathCompareAskOf(m), m);
  const store = memoryPathStore(() => NOW), tool = pathComparisonTool(store);
  assert.equal(tool.name, PATH_TOOL);
  const message = "I'm weighing two paths: consulting at Deloitte or product management at Acme. Can you compare them?";
  const state: Record<string, unknown> = {
    profile: { facts: [{ id: "f1", kind: "experience", title: "Product Analyst Intern, Acme", text: "Wrote product requirements with the product management team", status: "confirmed" },
      { id: "f2", kind: "experience", title: "Draft entry", text: "consulting project", needs_confirmation: true }] },
    offerBenchmark: { offers: [{ offer: { company: "Acme", role: "Associate PM", base: 120000, signing: 10000 }, at: NOW - 86400_000 }] },
  };
  const ctx = { userId: U, threadId: "t", now: NOW, state, turn: { message, added: [] } };
  await assert.rejects(() => tool.run({ paths: [{ name: "Banking", said: "banking at Goldman" }, { name: "PM", said: "product management at Acme" }] }, ctx), /own words/);
  await assert.rejects(() => tool.run({ paths: [{ name: "PM", said: "product management at Acme" }] }, ctx), /2 to 4/);
  assert.equal(store.rows.size, 0, "nothing stored from a refused call");
  // deno-lint-ignore no-explicit-any
  const out: any = await tool.run({ paths: [{ name: "Consulting at Deloitte", said: "consulting at Deloitte" }, { name: "Product management at Acme", said: "product management at Acme" }] }, ctx);
  assert.equal(out.version, 1);
  const row = (await store.newest(U))!;
  const [a, b] = row.directions;
  assert.deepEqual([a.evidence, a.related, a.rows[1].v], ["Weak", 0, null], "the draft entry is not a confirmed fact");
  assert.deepEqual([b.evidence, b.related, b.rows[1].v], ["Partial", 1, "Product Analyst Intern, Acme"]);
  assert.deepEqual(b.rows[2], { k: "Offer on file", v: "Associate PM, base $120,000, signing $10,000", src: { kind: "you", at: new Date(NOW - 86400_000).toISOString() } });
  assert.equal(row.confirmed_facts, 1);
  const v = pathComparisonView({ now: NOW, tz: null, account: null, standing: [], questions: [], interviews: [], digest: null, events: [], offers: [], paths: row });
  assert.ok("view" in v);
  // deno-lint-ignore no-explicit-any
  const d = (v as any).view;
  assert.deepEqual(d.directions.map((x: { letter: string; name: string; evidence: string }) => [x.letter, x.name, x.evidence]), [["A", "Consulting at Deloitte", "Weak"], ["B", "Product management at Acme", "Partial"]]);
  assert.ok(d.directions.every((x: { reach: string }) => /timing not predicted/.test(x.reach)), "nothing predicted");
  assert.ok("state" in pathComparisonView({ now: NOW, tz: null, account: null, standing: [], questions: [], interviews: [], digest: null, events: [], offers: [] }), "none on record: the missing state, as before");
});
