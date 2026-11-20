// D-072 (files writers): the writer of the F-07 Materials File's rows (career_material_versions, 20261110160000; FILE-RECORDS.md
// section 5). Before it nothing in production wrote a version, so the Materials File was shown only for rows a test had seeded.
//
// Every tailored resume or cover letter Trainee DELIVERS writes one version row: the document (doc_key: one per target, so a second
// file for the same posting or role is its v2), the version number, a human label ("the resume for Data Analyst at Acme"), the target
// posting (role_job_id) when it was made for one, the file itself (its name, bytes and sha256, checked by the table against the
// bytes), and what changed, from the producer's own change list (never a model's summary). The same file delivered again writes
// nothing. A row never changes after insert (the table's trigger), and an approved version is kept: approving a newer one on the page
// (approvedoc, career_material_version_approve_as) is bound to that version's own payload hash and its role.
//
// The producers attach `material` to the document they deliver (channel_artifacts.ts TurnDocument): the resume task
// (career_resume_task.ts), tailor_resume (agent/career_tools.ts) and the router's posting tailor (its artifact). A cover letter is the
// brain's create_file draft of type cover_letter (withLetterVersions below); its file is the letter's text as delivered.
// The change rows of the Materials page (file_family_records_materials.ts DocChange), written out so the brain loads no File page code.
export interface DocChange { kind: "Emphasis" | "Wording" | "Fact needed"; before?: string | null; after: string; text: string; lead?: string }
import type { FileService } from "./file_service.ts";

export interface MaterialMeta {
  doc_kind: "resume" | "letter";
  target: string;                 // what it was made for, as said: "Data Analyst at Acme", "data analyst internships"
  role_job_id?: string | null;    // the posting (career_postings.job_id) when made for one
  posting_key?: string | null;    // a posting with no id: postingKeyOf(its own text or URL), a digest. Only ever part of doc_key (which posting this is); never shown
  based_on?: string | null;       // "your confirmed resume"
  changes?: DocChange[];          // from the producer's own change list
  format_check?: string | null;   // the producer's own check of the file, in words
}
export interface MaterialFile { name: string; bytes: Uint8Array; sha256: string }
export interface MaterialWriteStore {
  newest(userId: string, docKey: string): Promise<{ version: number; file_sha256: string | null } | null>;
  insert(userId: string, row: MaterialRow): Promise<"ok" | "conflict">;
}
export interface MaterialRow {
  doc_key: string; doc_kind: "resume" | "letter"; version: number; label: string; based_on: string | null; role_job_id: string | null;
  changes: DocChange[]; format_check: string | null; file: MaterialFile;
}
export type MaterialWrite = { written: true; doc_key: string; version: number } | { written: false; doc_key: string; why: "same_file" | "no_target" };

const clean = (s: unknown, n = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
// One document per target. A posting is told apart by a short digest: of its id (so any id fits), else of its own text or URL
// (posting_key), so two pasted postings, or two at one employer, are two documents and never each other's "v2". With no posting
// it is the target's words; words the key's alphabet cannot spell (no Latin letters, or symbols that fold away: "C++", "C#") add a
// digest of the words themselves, so "数据分析师" and "产品经理" do not both become `resume`. Nothing here is shown to the person.
const digest10 = async (s: string) => (await sha256Hex(new TextEncoder().encode(s))).slice(0, 10);
const postingText = (s: unknown) => String(s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export async function docKeyOf(m: Pick<MaterialMeta, "doc_kind" | "target" | "role_job_id" | "posting_key">): Promise<string> {
  const job = clean(m.role_job_id, 200), posting = job ? "" : postingText(m.posting_key), words = postingText(clean(m.target, 90));
  const lossy = /[^a-z0-9\s,.\-\/&()':]/.test(words.normalize("NFKD").replace(/\p{M}/gu, ""));
  const mark = job ? await digest10(job) : posting ? await digest10(posting) : lossy ? await digest10(words) : "";
  const name = slug(clean(m.target, mark ? 40 : 80)).slice(0, mark ? 30 : 50).replace(/-+$/g, "");
  return [m.doc_kind, name, mark].filter(Boolean).join("-").slice(0, 60);
}
// Which posting a pasted posting is: a digest of its text (or URL), case and spacing aside. The text itself goes no further.
export const postingKeyOf = (textOrUrl: string): Promise<string> => sha256Hex(new TextEncoder().encode(postingText(textOrUrl)));
export async function sha256Hex(b: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export async function writeMaterialVersion(store: MaterialWriteStore, userId: string, meta: MaterialMeta, file: MaterialFile): Promise<MaterialWrite> {
  const target = clean(meta.target, 90);
  const doc_key = await docKeyOf(meta);
  if (!target || doc_key.length < 3) return { written: false, doc_key, why: "no_target" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const base = await store.newest(userId, doc_key);
    if (base?.file_sha256 === file.sha256) return { written: false, doc_key, why: "same_file" };
    const version = (base?.version ?? 0) + 1;
    const label = clean(`the ${meta.doc_kind === "letter" ? "cover letter" : "resume"} for ${target}`, 120);
    const row: MaterialRow = { doc_key, doc_kind: meta.doc_kind, version, label, based_on: clean(meta.based_on, 120) || null, role_job_id: clean(meta.role_job_id, 200) || null,
      changes: (meta.changes ?? []).slice(0, 20), format_check: clean(meta.format_check, 200) || null, file };
    if (await store.insert(userId, row) === "ok") return { written: true, doc_key, version };
  }
  throw new Error("the document's versions changed under three writes in a row");
}

// The change kinds the tailoring code itself reports (career_tailor.ts ChangeItem), as the page's change rows.
export function changesOfItems(items: { kind: string; text: string; line?: string }[]): DocChange[] {
  return items.filter((c) => c && c.kind !== "kept" && clean(c.text)).slice(0, 12).map((c) => ({
    kind: c.kind === "reword" || c.kind === "edit" ? "Wording" as const : "Emphasis" as const,
    after: clean(c.line || c.text, 200), text: clean(c.text, 300),
  }));
}

// ---------------------------------------------------------------- cover letters (create_file draft, type cover_letter)
// The brain's FileService, with every cover letter it makes written as a version of that letter. A failed write never fails the File.
export function withLetterVersions(files: FileService, store: MaterialWriteStore, onError: (e: unknown) => void = () => {}): FileService {
  return {
    ...files,
    async create(userId: string, kind: string, data: unknown, opts?: unknown) {
      // deno-lint-ignore no-explicit-any
      const r = await (files.create as any)(userId, kind, data, opts);
      // deno-lint-ignore no-explicit-any
      const d = data as any;
      if (r?.ok && kind === "draft" && d && d.type === "cover_letter" && clean(d.body, 10)) {
        try {
          const body = String(d.body), bytes = new TextEncoder().encode(body);
          const target = clean(String(d.title ?? "").replace(/^\s*cover\s+letter\s+(?:for|to)\s+/i, ""), 90) || clean(d.to, 90);
          // What it is based on is said only when it is known: the facts the draft itself lists (its basis, shown on the draft's
          // File). A letter that lists none says nothing about its basis; no claim is stamped on it unchecked.
          const basis = Array.isArray(d.basis) ? d.basis.filter((f: unknown) => f && typeof f === "object").length : 0;
          await writeMaterialVersion(store, userId, { doc_kind: "letter", target, based_on: basis ? `the ${basis} fact${basis === 1 ? "" : "s"} listed on the draft` : null, format_check: null,
            changes: [] }, { name: `${slug(target).slice(0, 60) || "cover-letter"}-letter.txt`, bytes, sha256: await sha256Hex(bytes) });
        } catch (e) { onError(e); }
      }
      return r;
    },
  } as FileService;
}

// ---------------------------------------------------------------- the stores
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
// deno-lint-ignore no-explicit-any
export function supabaseMaterialWriter(admin: any): MaterialWriteStore {
  return {
    async newest(u, doc) {
      const r = await admin.from("career_material_versions").select("version,file_sha256").eq("user_id", u).eq("doc_key", doc).order("version", { ascending: false }).limit(1);
      if (r.error) throw new Error(`read the document versions: ${r.error.message}`);
      return r.data?.[0] ?? null;
    },
    async insert(u, row) {
      // payload_hash is computed by the table's trigger from the content; the placeholder is replaced on insert. bytea as \x hex.
      const r = await admin.from("career_material_versions").insert({ user_id: u, doc_key: row.doc_key, doc_kind: row.doc_kind, version: row.version, label: row.label,
        based_on: row.based_on, role_job_id: row.role_job_id, changes: row.changes, format_check: row.format_check,
        file_name: row.file.name.replace(/[/\\]/g, "-").slice(0, 200), file_bytes: `\\x${hex(row.file.bytes)}`, file_sha256: row.file.sha256, payload_hash: "0".repeat(64) });
      if (!r.error) return "ok";
      if (r.error.code === "23505") return "conflict";
      throw new Error(`write the document version: ${r.error.message}`);
    },
  };
}

// ---------------------------------------------------------------- a turn's delivered documents
// The documents this turn delivered (stored[i]: documents[i] was stored for the person's channel), each with the material its
// producer set, or, for the router's posting tailor, read from its artifact (the posting id and company it was made for). One
// version per file made: the Word copy of a PDF delivered beside it is the same version, so only the PDF is written. A document with
// no material (a picture, a re-sent file with no producer) writes nothing.
// deno-lint-ignore no-explicit-any
export function routerMaterialOf(result: any): { sha256: string | null; base64: string; meta: MaterialMeta } | null {
  const a = result?.artifact;
  if (!a || a.kind !== "tailored_resume" || !a.pdf || typeof a.pdf.base64 !== "string") return null;
  const company = clean(a.company, 80), job = clean(a.jobId, 200);
  if (!company && !job) return null;
  return { sha256: typeof a.pdf.sha256 === "string" ? a.pdf.sha256 : null, base64: a.pdf.base64,
    meta: { doc_kind: "resume", target: company ? `the posting at ${company}` : "the posting", role_job_id: job || null, based_on: "your confirmed resume", changes: [] } };
}
const metaOf = (x: unknown): MaterialMeta | null => {
  // deno-lint-ignore no-explicit-any
  const m = x as any;
  if (!m || typeof m !== "object" || (m.doc_kind !== "resume" && m.doc_kind !== "letter") || !clean(m.target)) return null;
  return { doc_kind: m.doc_kind, target: String(m.target), role_job_id: m.role_job_id ?? null, posting_key: typeof m.posting_key === "string" ? m.posting_key : null, based_on: m.based_on ?? null, format_check: m.format_check ?? null,
    changes: Array.isArray(m.changes) ? m.changes.filter((c: DocChange) => c && ["Emphasis", "Wording", "Fact needed"].includes(c.kind) && clean(c.after)) : [] };
};
const bytesOf = (b64: string) => { const bin = atob(b64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
export async function writeTurnMaterials(store: MaterialWriteStore, userId: string, docs: { format: string | null; filename: string; base64: string; sha256: string | null; material?: unknown }[],
  stored: boolean[], result: unknown): Promise<MaterialWrite[]> {
  const router = routerMaterialOf(result), out: MaterialWrite[] = [];
  const picked = docs.map((d, i) => ({ d, i, meta: metaOf(d.material) ?? (router && (d.sha256 && d.sha256 === router.sha256 || d.base64 === router.base64) ? router.meta : null) }))
    .filter((x) => x.meta && stored[x.i]);
  for (const x of picked) {
    const isPdf = x.d.format === "pdf" || /\.pdf$/i.test(x.d.filename);
    if (!isPdf && picked.some((y) => y !== x && (y.d.format === "pdf" || /\.pdf$/i.test(y.d.filename)) && y.meta!.target === x.meta!.target)) continue;
    const bytes = bytesOf(x.d.base64);
    out.push(await writeMaterialVersion(store, userId, x.meta!, { name: x.d.filename, bytes, sha256: await sha256Hex(bytes) }));
  }
  return out;
}
