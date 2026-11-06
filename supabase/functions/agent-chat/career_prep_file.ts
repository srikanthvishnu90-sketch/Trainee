// BETA C03 / A15.1 (2026-11-04): the interview prep File. The router's prep File claim (142 handlePrepFile, 127 prepFileData)
// builds the page's data in code and returns it as result.file; this turns it into a real File: stored for this one person
// the same way every other File is (file_service.ts create, career_watch_kv "tf:file:<id>"), its signed link minted by code,
// and that link sent as its own message after a short summary (the results page's shape, role_results.ts). The model never
// writes the page or its link.
//
// Rules that do not move: the data is validated against the plan_review kind before it is stored (a line without a source is
// refused, a placeholder is refused); "Made by Trainee" is accepted only here, on code-built data (file_kinds.ts MADE). When the
// File cannot be made (links not configured, a store error, data the kind refuses), nothing claims a File: the reply says it
// was not made and why, and gives the same questions and plan as text, so the person still has them.
import type { FileService } from "../_shared/file_service.ts";

export interface PrepFileOut { reply: string; intent?: string | null; resultStatus?: string | null; result?: unknown; parts?: string[]; [k: string]: unknown }
export interface PrepFileMade { out: PrepFileOut; meta: Record<string, unknown> }

// The File the router asked for on this turn, if any: a plan_review interview prep page with its sections.
export function prepFileOf(result: unknown): { kind: "plan_review"; data: Record<string, any> } | null {
  const f = result && typeof result === "object" ? (result as Record<string, any>).file : null;
  if (!f || typeof f !== "object" || f.kind !== "plan_review") return null;
  const d = f.data;
  if (!d || typeof d !== "object" || d.variant !== "interview_prep" || !Array.isArray(d.sections) || !d.sections.length) return null;
  return { kind: "plan_review", data: d };
}

// The same page as plain lines, for when the page itself could not be made.
export function prepFileText(data: Record<string, any>): string {
  const L: string[] = [String(data.title ?? "Interview prep")];
  for (const s of Array.isArray(data.sections) ? data.sections : []) {
    L.push("", `${s.heading}:`);
    for (const it of Array.isArray(s.items) ? s.items : []) L.push(`- ${it.label}: ${it.value}`);
  }
  return L.join("\n");
}

const why = (error: string) => {
  const e = error.replace(/^not created:\s*/i, "");
  if (/links aren't set up/i.test(e)) return "File links aren't set up on this service yet";
  return "the page couldn't be saved just now";
};

export async function prepFileTurn(o: { out: PrepFileOut; userId: string; files: FileService | null }): Promise<PrepFileMade | null> {
  const file = prepFileOf(o.out.result);
  if (!file) return null;
  let made: Awaited<ReturnType<FileService["create"]>> | null = null, failure = "";
  if (!o.files) failure = "not created: file links aren't set up yet";
  else {
    try { made = await o.files.create(o.userId, file.kind, file.data, { trusted: true }); }
    catch (e) { failure = `not created: ${(e as Error)?.message ?? e}`; }
    if (made && !made.ok) failure = made.error;
  }
  if (made && made.ok && made.url) {
    // A Mini App URL (webApp) opens only from Telegram's own button; sent as a plain link it opened signed out (TELEGRAM SCENARIOS
    // 2026-10-30). The signed link is what is sent, alone on its own line.
    const parts = [o.out.reply.trim(), made.url];
    return { out: { ...o.out, reply: parts.join("\n"), parts, resultStatus: "prepared" }, meta: { prep_file: { id: made.id, kind: made.kind, title: made.title } } };
  }
  const reason = failure ? why(failure) : "the page has no link it can be opened with";
  const head = o.out.reply.replace(/^Your one-page interview prep File:/, "Your interview prep:").trim();
  const reply = `${head}\n\nI couldn't make the File page itself (${reason}), so no File was created. Here is the same page as text:\n\n${prepFileText(file.data)}`;
  return { out: { ...o.out, reply, parts: undefined, resultStatus: "not_created" }, meta: { prep_file_error: failure.slice(0, 200) || reason } };
}
