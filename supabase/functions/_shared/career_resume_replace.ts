// ONBOARDING ROUND 4 (2026-11-05, tests/architect/scenarios-onboarding-r4.test.ts, flow-scenarios-onboarding-r4.test.ts):
// a confirmed resume replaced by a newer one while applications made with it are prepared, approved or being sent (real
// submission is on, D-041). The database stops what was bound to the old one in the same commit that confirms the new
// one (career_resume_put -> career_resume_stop_unbound, 20261026120018): approved and not yet handed out are cancelled,
// prepared and not yet approved are discarded, the ones being sent now cannot be stopped. The chat's reply said only
// "nothing from that one is used any more", while an application carrying it was being submitted and the person's
// approvals had silently vanished. This reads, before that commit, what it will stop, so the reply says exactly that.
// It changes nothing.

export interface Replaced { cancelled: number; discarded: number; being_sent: number; companies: string[] }

const carried = (p: unknown): string | null => {
  const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const a = (o.attachment && typeof o.attachment === "object" ? o.attachment : {}) as Record<string, unknown>;
  const v = String(o.resume_sha256 ?? "") || String(a.sha256 ?? "");
  return v || null;
};
const n = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);

// What confirming the resume `sha256` (a file's bytes, or a paste's text: `kind`) will stop, when a different resume is
// on file now; null when none is (a first resume, or the same one again) or nothing would stop.
// deno-lint-ignore no-explicit-any
export async function replacedResumeStops(admin: any, userId: string, next: { sha256: string; kind: "file" | "paste" }): Promise<Replaced | null> {
  const rec = await admin.from("career_resume_record").select("state,sha256").eq("user_id", userId).limit(1);
  const row = rec.error ? null : rec.data?.[0];
  if (!row || row.state !== "confirmed" || !row.sha256 || row.sha256 === next.sha256) return null;
  // What the database keeps going: only an application carrying the new resume's own file.
  const keep = next.kind === "file" ? next.sha256 : null;
  const stale = (p: unknown) => carried(p) !== keep;
  const jobs = await admin.from("career_apply_jobs").select("state,attempts,company,payload").eq("user_id", userId).in("state", ["queued", "driving"]);
  const prep = await admin.from("career_apply_prepared").select("state,payload").eq("user_id", userId).in("state", ["ready", "shown"]);
  if (jobs.error || prep.error) return null;
  // deno-lint-ignore no-explicit-any
  const j = ((jobs.data ?? []) as any[]).filter((x) => stale(x.payload));
  const cancelledRows = j.filter((x) => x.state === "queued" && Number(x.attempts ?? 0) === 0);
  const r: Replaced = {
    cancelled: cancelledRows.length,
    discarded: ((prep.data ?? []) as { payload: unknown }[]).filter((x) => stale(x.payload)).length,
    being_sent: j.filter((x) => x.state === "driving").length,
    companies: [...new Set(cancelledRows.map((x) => String(x.company ?? "").trim()).filter(Boolean))].slice(0, 6),
  };
  return r.cancelled + r.discarded + r.being_sent ? r : null;
}

// The sentences the confirmation reply carries for them. Every count is what the commit stops; nothing is promised.
export function replacedResumeLines(r: Replaced): string[] {
  const out: string[] = [];
  if (r.cancelled) out.push(`${n(r.cancelled, "approved application that hadn't gone out yet was", "approved applications that hadn't gone out yet were")} made with your earlier resume, so ${r.cancelled === 1 ? "it is" : "they are"} cancelled${r.companies.length ? ` (${r.companies.join(", ")})` : ""}: approve again and ${r.cancelled === 1 ? "it goes" : "they go"} with this one.`);
  if (r.discarded) out.push(`${n(r.discarded, "prepared application", "prepared applications")} made with your earlier resume ${r.discarded === 1 ? "is" : "are"} discarded, so nothing is approved or sent with the earlier resume.`);
  if (r.being_sent) out.push(`${n(r.being_sent, "application is", "applications are")} being sent right now with your earlier resume and can't be stopped midway; one that goes out can't be taken back.`);
  return out;
}
