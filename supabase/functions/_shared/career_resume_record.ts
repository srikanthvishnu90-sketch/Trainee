// ONE CONFIRMED RESUME (2026-10-26; migration 20261026120018, docs/architect/RESUME-FLOW-2026-10-26.md): the person asks
// which resume Trainee uses, or deletes it, in plain words, on any channel (the turn is the chat's, which every channel's
// text reaches). Code's, before any brain, like the cloud and the card. The answer is read from the one record
// (career_resume_current_as); a delete goes through career_resume_delete_as and says exactly what it stopped.

export const RESUME_RECORD_INTENT = "career_resume_record";

export type ResumeCommand = { kind: "status" } | { kind: "delete" };
const norm = (t: string) => String(t ?? "").toLowerCase().replace(/[’`]/g, "'").replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
const NOUN = "(?:resume|résumé|cv)";
const PLEASE = "(?:please |pls |can you |could you )?";
export function parseResumeCommand(text: string): ResumeCommand | null {
  const t = norm(text);
  if (t.length > 120) return null;
  if (new RegExp(`^${PLEASE}(?:delete|remove|erase|forget|clear|get rid of|throw away|trash) (?:my|the) (?:current |old )?${NOUN}(?: (?:you have|on file|from (?:my|your) (?:file|record|account)|you're using|you are using))?(?: please| pls)?$`).test(t)) {
    return { kind: "delete" };
  }
  if (new RegExp(`^(?:what|which) ${NOUN} (?:do you have|is on file|are you using|will you (?:send|use)|do you send|do you use)(?: on file)?(?: for me)?$`).test(t) ||
    new RegExp(`^(?:do you have|have you got|did you get|did you save) my ${NOUN}(?: on file)?$`).test(t) ||
    new RegExp(`^${PLEASE}show (?:me )?my ${NOUN}(?: on file)?$`).test(t)) {
    return { kind: "status" };
  }
  return null;
}

export interface ResumeRecord {
  state: "none" | "confirmed" | "deleted"; kind?: "file" | "paste" | null; filename?: string | null; confirmed_at?: string | null; file_kept?: boolean;
}
export interface ResumeDeleted {
  had: boolean; kind?: "file" | "paste" | null; filename?: string | null; confirmed_at?: string | null;
  stopped?: { cancelled?: number; discarded?: number; being_sent?: number; companies?: string[] };
}
export interface ResumeRecordStore {
  current(userId: string): Promise<ResumeRecord>;
  remove(userId: string): Promise<ResumeDeleted>;
}

const day = (iso: string | null | undefined) => (typeof iso === "string" && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : "an earlier day");
const what = (r: { kind?: string | null; filename?: string | null; confirmed_at?: string | null }) =>
  r.kind === "file" ? `${r.filename ? `the file ${r.filename}` : "the file"} you sent and confirmed on ${day(r.confirmed_at)}`
    : `the resume you pasted and confirmed on ${day(r.confirmed_at)}`;
const NONE = 'I don\'t have a resume on file for you. Paste your resume here and confirm it when I show you its entries; every application then uses that one.';
const n = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);

export function statusReply(r: ResumeRecord): string {
  if (r.state !== "confirmed") return NONE;
  const head = `The resume on file is ${what(r)}. Every application I prepare uses only it`;
  const how = r.kind === "file"
    ? ": each one carries that file or a version made from the entries you confirmed in it, and nothing goes out until you approve it."
    : ": each one carries a resume made from the entries you confirmed in it, and nothing goes out until you approve it.";
  const cloud = r.kind === "paste" ? " It is text, not a file, so applications sent from the cloud have no file of yours to attach."
    : r.file_kept === false ? " I don't keep a copy of that file, so applications sent from the cloud can't attach it." : "";
  return `${head}${how}${cloud} To change it, paste your new resume here and confirm it; to remove it, say "delete my resume".`;
}

export function deleteReply(d: ResumeDeleted): string {
  const s = d.stopped ?? {};
  const parts: string[] = [];
  parts.push(d.had ? `Deleted ${what(d)}; I keep no copy of it. The entries you confirmed from it stay in your profile until you say "forget my career profile", and no application uses them without a resume on file.` : "I didn't have a resume on file for you, so there was nothing to delete.");
  if (s.cancelled) parts.push(`${n(s.cancelled, "approved application that hadn't gone out was", "approved applications that hadn't gone out were")} cancelled${s.companies?.length ? ` (${s.companies.slice(0, 6).join(", ")})` : ""}.`);
  if (s.discarded) parts.push(`${n(s.discarded, "prepared application was", "prepared applications were")} discarded.`);
  if (s.being_sent) parts.push(`${n(s.being_sent, "application was", "applications were")} already being sent; one that went out can't be taken back.`);
  parts.push("No application will be prepared or sent until you paste your resume here and confirm it.");
  return parts.join(" ");
}

// One turn. Null when the text is not about the resume on file, so the turn goes on as before.
export async function resumeRecordTurn(o: { message: string; userId: string; store: ResumeRecordStore }): Promise<{ reply: string; status: string; intent: string } | null> {
  const cmd = parseResumeCommand(o.message);
  if (!cmd) return null;
  if (cmd.kind === "status") {
    let r: ResumeRecord;
    try { r = await o.store.current(o.userId); } catch { return { reply: "I couldn't read your resume on file just now. Ask me again in a minute.", status: "unreadable", intent: RESUME_RECORD_INTENT }; }
    return { reply: statusReply(r), status: r.state === "confirmed" ? "on_file" : "none", intent: RESUME_RECORD_INTENT };
  }
  let d: ResumeDeleted;
  try { d = await o.store.remove(o.userId); } catch { return { reply: "I couldn't delete your resume just now; nothing was changed. Ask me again in a minute.", status: "failed", intent: RESUME_RECORD_INTENT }; }
  return { reply: deleteReply(d), status: d.had ? "deleted" : "none", intent: RESUME_RECORD_INTENT };
}

// deno-lint-ignore no-explicit-any
export function supabaseResumeRecordStore(admin: any): ResumeRecordStore {
  const must = (r: any, what: string) => { if (r?.error) throw new Error(`${what}: ${r.error.message}`); return r?.data; };
  return {
    current: async (u) => (must(await admin.rpc("career_resume_current_as", { p_user: u }), "read the resume on file") ?? { state: "none" }) as ResumeRecord,
    remove: async (u) => must(await admin.rpc("career_resume_delete_as", { p_user: u }), "delete the resume") as ResumeDeleted,
  };
}
