// Item 6 S3: the F-04 Search plan and F-07 Materials studio Files drawn from their real records (career_search_plans,
// career_material_versions; 20261110160000, FILE-RECORDS.md 1 and 5), and the two approvals they serve.
//
//   approveplan  approves the exact plan version shown, bound to its payload hash (fields v, h). Approval authorizes searching and
//                shortlisting only: nothing here can queue, prepare or send an application.
//   approvedoc   approves the exact document version shown, for the one role it was made for (fields doc, v, role, h). Approving a
//                newer version never changes an approved one (E.4 40): every approved version is kept, and the version the apply
//                engine uses for a role is the approved one, never the newest.
// A hash that is not the current one ("stale"), a plan with a newer version ("superseded") or another role ("wrong_role") changes
// nothing and says so. The database checks all of it again (the *_approve_as functions); this module only reads rows, draws the
// family's view data and words the result. No fact is added here: every value is the row's, with the source the row names.
import type { Act, KV, Src, StateInput } from "./file_family.ts";
import type { Materials, SearchPlan } from "./file_family_plan.ts";
import type { FamilyGetResult, FamilyPostResult, FamilyRec, FamilyRecords } from "./file_family_serve.ts";

export type SrcKind = "you" | "resume" | "brief" | "plan";
export interface PlanEntry { k: string; v: string | null; src?: { kind: SrcKind; at?: string | null } | null }
export interface PlanRow { version: number; title: string; hard: PlanEntry[]; prefs: PlanEntry[]; batch_cap: number; watch: { text: string; active: boolean } | null; payload_hash: string; approved_at: string | null; created_at: string }
export interface DocChange { kind: "Emphasis" | "Wording" | "Fact needed"; before?: string | null; after: string; text: string; lead?: string }
export interface DocRow {
  doc_key: string; doc_kind: "resume" | "letter"; version: number; label: string; based_on: string | null; role_job_id: string | null; rid: string | null;
  changes: DocChange[]; format_check: string | null; file_name: string | null; has_file: boolean; payload_hash: string; approved_at: string | null; approved_role: string | null; created_at: string;
}
export type ApproveResult = "approved" | "already" | "stale" | "superseded" | "wrong_role" | "missing";
export interface PlanMaterialStore {
  plans(userId: string): Promise<PlanRow[]>;
  docs(userId: string, docKey: string): Promise<DocRow[]>;
  docFile(userId: string, docKey: string, version: number): Promise<{ name: string; bytes: Uint8Array } | null>;
  approvePlan(userId: string, version: number, hash: string, at: number): Promise<ApproveResult>;
  approveDoc(userId: string, docKey: string, version: number, role: string, hash: string, at: number): Promise<ApproveResult>;
}

// What a File record of these families stores (rec.data.ref): a reference to the rows, never a copy. F-04: {} (the person's newest
// plan); F-07: { doc } (that document's versions). The page is drawn from the rows when it is opened.
export type FamilyRef = { doc?: string };
type PostResult = FamilyPostResult;
type FileOut = FamilyGetResult;
const refOf = (rec: FamilyRec): FamilyRef => (rec.data.ref ?? {}) as FamilyRef;

const SRC: Record<SrcKind, string> = { you: "you confirmed", resume: "resume, confirmed", brief: "your career brief", plan: "your search plan" };
const srcOf = (s: PlanEntry["src"]): Src | null => s ? { label: SRC[s.kind] ?? "you confirmed", ...(s.at ? { at: s.at, dateOnly: true } : {}) } : null;
const kv = (e: PlanEntry): KV => ({ k: e.k, v: e.v, src: srcOf(e.src) });
const HASH = /^[a-f0-9]{64}$/, INT = /^[1-9][0-9]{0,4}$/;
const ago = (iso: string | null) => iso ? new Date(iso).toISOString().slice(0, 10) : "";

// ---------------------------------------------------------------- F-04
export function searchPlanView(rows: PlanRow[], token: string): SearchPlan | null {
  const p = [...rows].sort((a, b) => b.version - a.version)[0];
  if (!p) return null;
  const approve: Act | null = p.approved_at ? null : { label: `Approve search scope v${p.version}`, effect: "approve", post: { token, action: "approveplan", fields: { v: String(p.version), h: p.payload_hash } } };
  return {
    version: p.version, title: p.title, batchCap: p.batch_cap, updatedAt: p.created_at, hard: p.hard.map(kv), prefs: p.prefs.map(kv), watch: p.watch,
    acts: {
      primary: approve, secondary: [{ label: "Tighten search", effect: "decide", href: "?tighten" }, { label: "Explore adjacent roles", effect: "decide", href: "?adjacent" }],
      caption: p.approved_at ? `You approved v${p.version} on ${ago(p.approved_at)}. It covers searching and shortlisting only; every application still needs its own review.` : "Approving covers searching and shortlisting only. Nothing is applied to.",
    },
  };
}
export async function approvePlan(store: PlanMaterialStore, userId: string, fields: URLSearchParams, now: number): Promise<PostResult> {
  const v = fields.get("v") ?? "", h = fields.get("h") ?? "";
  if (!INT.test(v) || !HASH.test(h)) return { ok: false, title: "Not done", lines: ["That approval is not for a plan on this page. Nothing was approved."] };
  const r = await store.approvePlan(userId, Number(v), h, now).catch(() => null);
  return planWords(r, v);
}
function planWords(r: ApproveResult | null, v: string): PostResult {
  switch (r) {
    case "approved": return { ok: true, title: `Search plan v${v} approved`, lines: ["Trainee can search and shortlist with this plan. Nothing was applied to: every application still needs its own review."] };
    case "already": return { ok: true, title: `Search plan v${v} is already approved`, lines: ["Nothing changed. Nothing was applied to."] };
    case "stale": return { ok: false, title: "This plan changed", lines: [`The plan you saw is not plan v${v} as it is now, so nothing was approved. Open the File again to see the current plan.`] };
    case "superseded": return { ok: false, title: "There is a newer plan", lines: [`Plan v${v} has a newer version, so nothing was approved. Open the File again to see it.`] };
    case "missing": return { ok: false, title: "This plan isn't on file", lines: ["Nothing was approved."] };
    default: return { ok: false, title: "Couldn't approve just now", lines: ["Nothing was approved. Try again in a minute."] };
  }
}

// ---------------------------------------------------------------- F-07
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// Versions by human distinction (E.4 40): each version is named by its label ("the one-page data analyst draft"), never only "v3".
export function materialsView(rows: DocRow[], token: string): Materials | null {
  const vs = [...rows].sort((a, b) => b.version - a.version), d = vs[0];
  if (!d) return null;
  const role = d.role_job_id ?? d.rid;
  const approved = vs.find((x) => x.approved_at && x.approved_role === role) ?? null;
  const rid = d.rid ?? "this role", kind = d.doc_kind === "letter" ? "Letter" : "Resume";
  const draftApproved = !!d.approved_at;
  const approve: Act | null = draftApproved ? null : !role ? { label: `Approve v${d.version}`, effect: "approve", off: "This version is not for a named role, so approving it would cover nothing. Ask Trainee to tailor it to a role." }
    : { label: `Approve v${d.version} for ${rid}`, effect: "approve", post: { token, action: "approvedoc", fields: { doc: d.doc_key, v: String(d.version), role, h: d.payload_hash } } };
  return {
    rid, docTitle: `${cap1(d.label)} - v${d.version}`, kind, base: d.based_on ?? "your confirmed resume", approved: approved ? `v${approved.version}` : null, draft: `v${d.version}`,
    updatedAt: d.created_at, changes: d.changes, format: d.format_check, usedBy: `${rid} only`,
    versions: vs.map((x) => ({ v: `v${x.version}`, label: x.label, state: x.approved_at ? (x === approved ? "approved - the one used" : "approved") : x === d ? "draft" : "not approved" })),
    download: d.has_file ? { label: `Download v${d.version}`, effect: "download", href: `?download=${encodeURIComponent(d.doc_key)}&v=${d.version}`, aria: `Download v${d.version} to this device. Nothing is sent.` }
      : { label: "Download", effect: "download", href: null, off: "This version's file has not been produced yet, so there is nothing to download." },
    acts: { primary: approve, secondary: [] },
  };
}
export async function approveDoc(store: PlanMaterialStore, userId: string, ref: FamilyRef, fields: URLSearchParams, now: number): Promise<PostResult> {
  const doc = fields.get("doc") ?? "", v = fields.get("v") ?? "", role = fields.get("role") ?? "", h = fields.get("h") ?? "";
  if (doc !== ref.doc || !INT.test(v) || !HASH.test(h) || !role || role.length > 200) return { ok: false, title: "Not done", lines: ["That approval is not for a document on this page. Nothing was approved."] };
  const r = await store.approveDoc(userId, doc, Number(v), role, h, now).catch(() => null);
  switch (r) {
    case "approved": return { ok: true, title: `v${v} approved for this role`, lines: ["This version is the one used for this role, not any newer one. It covers no other role. Nothing was sent or submitted.", "Earlier approved versions are kept as they were."] };
    case "already": return { ok: true, title: `v${v} is already approved`, lines: ["Nothing changed. Nothing was sent or submitted."] };
    case "stale": return { ok: false, title: "This version changed", lines: [`What you saw is not v${v} as it is now, so nothing was approved. Open the File again to see the current version.`] };
    case "wrong_role": return { ok: false, title: "This version is for another role", lines: ["Nothing was approved. Approving a version covers only the role it was made for."] };
    case "missing": return { ok: false, title: "This version isn't on file", lines: ["Nothing was approved."] };
    default: return { ok: false, title: "Couldn't approve just now", lines: ["Nothing was approved. Try again in a minute."] };
  }
}
export async function docDownload(store: PlanMaterialStore, userId: string, ref: FamilyRef, fields: URLSearchParams): Promise<FileOut | null> {
  const doc = fields.get("download") ?? "", v = fields.get("v") ?? "";
  if (doc !== ref.doc || !INT.test(v)) return null;
  const f = await store.docFile(userId, doc, Number(v)).catch(() => null);
  if (!f) return null;
  return { mime: /\.docx$/i.test(f.name) ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : /\.pdf$/i.test(f.name) ? "application/pdf" : "application/octet-stream", filename: f.name, bytes: f.bytes };
}

// The C.24 empty states: nothing on record yet. The page says so and asks in the chat; it never draws an invented plan or document.
const EMPTY_PLAN: StateInput = { state: "empty", family: "F-04", title: "No search plan on file yet", scope: "Your saved search plans: none yet.",
  next: { label: "Draft a search plan", effect: "decide", href: "?plan=search" }, nothingSent: true };
const EMPTY_DOC: StateInput = { state: "empty", family: "F-07", title: "No versions of this document on file", scope: "This document's saved versions: none.",
  next: { label: "Ask for a tailored version", effect: "decide", href: "?add=materials" }, nothingSent: true };

// The two families' adapters, over one store (file_family_serve.ts FamilyRecords). A post's token in the view is a placeholder:
// the File server draws each served post with this page's own token.
export function planMaterialRecords(store: PlanMaterialStore, now: () => number = Date.now): { "F-04": FamilyRecords; "F-07": FamilyRecords } {
  const asOf = () => new Date(now()).toISOString();
  return {
    "F-04": {
      async load(u) { const v = searchPlanView(await store.plans(u), ""); return v ? { view: v, asOf: asOf() } : { state: EMPTY_PLAN, asOf: asOf() }; },
      post: { approveplan: (u, _rec, f, n) => approvePlan(store, u, f, n) },
    },
    "F-07": {
      async load(u, rec) { const d = refOf(rec).doc; if (!d) return null; const v = materialsView(await store.docs(u, d), ""); return v ? { view: v, asOf: asOf() } : { state: EMPTY_DOC, asOf: asOf() }; },
      post: { approvedoc: (u, rec, f, n) => approveDoc(store, u, refOf(rec), f, n) },
      get: { download: (u, rec, f) => docDownload(store, u, refOf(rec), f) },
    },
  };
}

// ---------------------------------------------------------------- stores
// The service-role store (trainee-file deps.ts). Every read and write is keyed by the user id.
// deno-lint-ignore no-explicit-any
export function supabasePlanMaterialStore(admin: any): PlanMaterialStore {
  const must = <T>(r: { data: T; error: unknown }, what: string): T => { if (r.error) throw new Error(`${what}: ${(r.error as { message?: string }).message ?? "failed"}`); return r.data; };
  const DOC = "doc_key,doc_kind,version,label,based_on,role_job_id,rid,changes,format_check,file_name,file_sha256,payload_hash,approved_at,approved_role,created_at";
  const at = (n: number) => new Date(n).toISOString();
  return {
    async plans(u) { return (must(await admin.from("career_search_plans").select("version,title,hard,prefs,batch_cap,watch,payload_hash,approved_at,created_at").eq("user_id", u).order("version", { ascending: false }).limit(20), "read the search plan") ?? []) as PlanRow[]; },
    async docs(u, doc) {
      const rows = (must(await admin.from("career_material_versions").select(DOC).eq("user_id", u).eq("doc_key", doc).order("version", { ascending: false }).limit(30), "read the document versions") ?? []) as (DocRow & { file_sha256: string | null })[];
      return rows.map(({ file_sha256, ...r }) => ({ ...r, has_file: !!file_sha256 }));
    },
    async docFile(u, doc, v) {
      const r = must(await admin.from("career_material_versions").select("file_name,file_bytes").eq("user_id", u).eq("doc_key", doc).eq("version", v).maybeSingle(), "read the document file") as { file_name: string | null; file_bytes: string | null } | null;
      if (!r?.file_name || !r.file_bytes) return null;
      const hex = r.file_bytes.startsWith("\\x") ? r.file_bytes.slice(2) : r.file_bytes; // PostgREST returns bytea as \x hex
      return { name: r.file_name, bytes: Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16)) };
    },
    async approvePlan(u, v, h, n) { return must(await admin.rpc("career_search_plan_approve_as", { p_user: u, p_version: v, p_hash: h, p_at: at(n) }), "approve the plan") as ApproveResult; },
    async approveDoc(u, doc, v, role, h, n) { return must(await admin.rpc("career_material_version_approve_as", { p_user: u, p_doc: doc, p_version: v, p_role: role, p_hash: h, p_at: at(n) }), "approve the version") as ApproveResult; },
  };
}

// The in-memory store (tests): the same rules as the database (versions never overwritten, the hash bound, an approved version kept).
export interface MemPlan extends Omit<PlanRow, "payload_hash" | "approved_at"> { approved_at?: string | null }
export interface MemDoc extends Omit<DocRow, "payload_hash" | "approved_at" | "approved_role" | "has_file" | "file_name"> { file?: { name: string; bytes: Uint8Array } | null; approved_at?: string | null; approved_role?: string | null }
async function sha(x: unknown): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(x))))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
export function memoryPlanMaterialStore() {
  const plans = new Map<string, PlanRow[]>(), docs = new Map<string, (DocRow & { file: { name: string; bytes: Uint8Array } | null })[]>();
  const copy = <T>(x: T): T => structuredClone(x);
  const s = {
    async addPlan(u: string, p: MemPlan) {
      const list = plans.get(u) ?? [];
      if (list.some((x) => x.version === p.version)) throw new Error("a version is never overwritten");
      const { approved_at, ...c } = p;
      list.push({ ...copy(c), payload_hash: await sha(["plan", c.version, c.title, c.hard, c.prefs, c.batch_cap, c.watch]), approved_at: approved_at ?? null }); plans.set(u, list);
    },
    async addDoc(u: string, d: MemDoc) {
      const k = `${u}|${d.doc_key}`, list = docs.get(k) ?? [];
      if (list.some((x) => x.version === d.version)) throw new Error("a version is never overwritten");
      const { file, approved_at, approved_role, ...c } = d;
      list.push({ ...copy(c), file_name: file?.name ?? null, has_file: !!file, file: file ?? null, payload_hash: await sha(["doc", c, file?.name ?? null]), approved_at: approved_at ?? null, approved_role: approved_role ?? null }); docs.set(k, list);
    },
    all: () => copy({ plans: [...plans], docs: [...docs].map(([k, v]) => [k, v.map(({ file, ...r }) => ({ ...r, file: file?.name ?? null }))]) }),
    async plans(u: string) { return copy(plans.get(u) ?? []); },
    async docs(u: string, doc: string) { return (docs.get(`${u}|${doc}`) ?? []).map(({ file: _f, ...r }) => copy(r)); },
    async docFile(u: string, doc: string, v: number) { const r = (docs.get(`${u}|${doc}`) ?? []).find((x) => x.version === v); return r?.file ? { name: r.file.name, bytes: r.file.bytes.slice() } : null; },
    async approvePlan(u: string, v: number, h: string, n: number): Promise<ApproveResult> {
      const list = plans.get(u) ?? [], r = list.find((x) => x.version === v);
      if (!r) return "missing";
      if (r.approved_at) return h === r.payload_hash ? "already" : "stale";
      if (h !== r.payload_hash) return "stale";
      if (list.some((x) => x.version > v)) return "superseded";
      r.approved_at = new Date(n).toISOString(); return "approved";
    },
    async approveDoc(u: string, doc: string, v: number, role: string, h: string, n: number): Promise<ApproveResult> {
      const r = (docs.get(`${u}|${doc}`) ?? []).find((x) => x.version === v);
      if (!r) return "missing";
      if (r.approved_at) return h === r.payload_hash && r.approved_role === role ? "already" : "stale";
      if (h !== r.payload_hash) return "stale";
      if (role !== (r.role_job_id ?? r.rid)) return "wrong_role";
      r.approved_at = new Date(n).toISOString(); r.approved_role = role; return "approved";
    },
  };
  return s satisfies PlanMaterialStore;
}
