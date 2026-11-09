// R10 WO-E: the File families served from the records trainee-file already stores (file_kinds.ts FileRecord). A family is drawn only
// where a stored record holds what it needs; for anything else this returns null and the kind's existing page is served unchanged.
// Nothing is added that the record does not hold. The controls are the record's own (file_kinds.ts actionsOf), posting the actions
// actOn answers, and the page is drawn with exactly those as its routes, so no control on it is dead.
//
//   introduction (email)   F-12 People and messages: the person, why them, the exact message, Approve send (introduce + tag), Pass
//   application_proof      F-09 Application review after approval: the package, the answers given, the real state and its proof,
//                          View status, Flag a problem (the record's own note form)
//   everything else        null (see FAMILY_SOURCES for why)
import { actionsOf, type FileRecord } from "./file_kinds.ts";
import type { Act, Block, FamilyFile, FamilyId, Src } from "./file_family.ts";
import { esc } from "./file_design.ts";
import { applicationReviewFile, messageReviewFile } from "./file_family_apply.ts";

export const FILE_FAMILIES_ENV = "TRAINEE_FILE_FAMILIES";
// Off unless set to "on": the family pages replace a kind's page only when the owner turns this on.
export const fileFamiliesOn = (env: { get(k: string): string | undefined }): boolean => (env.get(FILE_FAMILIES_ENV) ?? "").trim().toLowerCase() === "on";

// Which stored data each family is drawn from today, and why the rest have none yet (the PR body carries the same table).
export const FAMILY_SOURCES: Record<FamilyId | "F-14n", { source: string | null; why?: string }> = {
  "F-01": { source: null, why: "no stored career-brief record; plan_review sections carry no version, aim or constraint provenance" },
  "F-02": { source: null, why: "profile facts live in the facts store, not as a File record; no category (confirmed/estimate/inferred) is stored" },
  "F-03": { source: null, why: "comparison records hold free options and rows, not directions with evidence strength" },
  "F-04": { source: null, why: "no stored search-plan record (hard constraints, preferences, batch cap)" },
  "F-05": { source: "job_list results feed (trainee-file handleResults); switched by WO-C" },
  "F-06": { source: null, why: "no per-role workspace record (eligibility items, route)" },
  "F-07": { source: null, why: "draft records hold one text, no versions, approved version or change list" },
  "F-08": { source: null, why: "no stored answer-library record" },
  "F-09": { source: "application_proof (after approval: package, answers, status, confirmation)" },
  "F-10": { source: null, why: "no batch record with per-row approval and review version" },
  "F-11": { source: null, why: "no pipeline record; applications are separate application_proof Files" },
  "F-12": { source: "introduction with an email channel (person, why, exact message, approval tag)" },
  "F-13": { source: null, why: "plan_review interview_prep holds prep sections only, no booked time, interviewer or calendar check" },
  "F-14": { source: null, why: "no weekly-brief record" },
  "F-14n": { source: null, why: "no negotiation record" },
  "F-15": { source: null, why: "comparison records are not marked as offers and carry no document sources per term" },
};

// The actions the kind's page answers for this record: its available record actions (actOn) and remove. "copy" is browser-only.
export function kindRoutes(rec: FileRecord): Set<string> {
  return new Set([...actionsOf(rec).filter((a) => a.state === "available" && a.id !== "copy").map((a) => a.id), "remove"]);
}
// The query keys a kind's page reads on GET: only the plain-text twin.
export const KIND_LINKS: ReadonlySet<string> = new Set(["format"]);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const iso = (t: unknown) => { const n = typeof t === "number" ? t : Date.parse(String(t ?? "")); return Number.isFinite(n) ? new Date(n).toISOString() : null; };
const sourced = (xs: unknown) => (Array.isArray(xs) ? xs : []).filter((f) => f && typeof f.source === "string" && f.source && (f.value ?? f.text ?? f.answer));

export function familyOfRecord(rec: FileRecord, token: string): { family: FamilyId; file: FamilyFile } | null {
  const d = rec.data ?? {}, views = actionsOf(rec);
  if (rec.kind === "introduction" && d.message?.channel === "email" && rec.tag) {
    const p = d.person ?? {}, m = d.message ?? {}, intro = views.find((a) => a.id === "introduce"), pass = views.find((a) => a.id === "pass");
    const why = sourced(d.why).map((b) => `${b.text} (${b.source})`).join(" ");
    const name = String(p.name ?? "").trim();
    const passAct: Act[] = pass?.state === "available" ? [{ label: "Pass", effect: "decide", post: { token, action: "pass" } }] : [];
    return { family: "F-12", file: messageReviewFile({
      kind: "Introduction", updatedAt: iso(rec.created_at),
      recipient: { initials: initials(name), name: name || "Not named", basis: [[p.role, p.company].filter(Boolean).join(", "), why].filter(Boolean).join(". "), resolved: !!name && !!p.source && !!m.to },
      to: m.to ?? null, channel: "email", attachments: null, followUp: "None - silence ends the ask", words: [m.subject ? `Subject: ${m.subject}` : "", m.body ?? ""].filter(Boolean).join("\n\n"),
      approve: { label: "Approve send", effect: "send", post: { token, action: "introduce", fields: { tag: rec.tag } } },
      approveOff: intro && intro.state !== "available" ? intro.note ?? "Already decided." : null,
      acts: { secondary: passAct },
    }) };
  }
  if (rec.kind === "application_proof" && ["queued", "prepared", "submitted", "confirmed"].includes(String(d.status))) {
    const c = d.confirmation ?? {}, rec_ = { label: "Trainee's application record" };
    const destHref = typeof d.destination === "string" && /^https:\/\//i.test(d.destination) ? d.destination : null;
    const evidence: Src | null = c.url && /^https:\/\//i.test(c.url) ? { label: c.id ? `Employer confirmation ${c.id}` : "Employer confirmation", href: c.url, at: iso(d.submitted_at ?? d.as_of) } : null;
    const state = d.status === "queued" || d.status === "prepared" ? "approved" as const : "submitted" as const;
    // Flag a problem keeps its own note box (the record's action): a family control cannot carry a text field.
    const flag: Block[] = views.some((a) => a.id === "flag" && a.state === "available")
      ? [{ b: "html", html: `<section class="ff-card"><h2 class="ff-label">Flag a problem</h2><form method="post" class="ff-act"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="flag"><label for="ff-flag" class="ff-p">What looks wrong</label><textarea id="ff-flag" name="note" rows="3" maxlength="500" class="ff-ta"></textarea><button type="submit" class="ff-btn ff-sec" data-effect="decide">Flag a problem</button></form></section>` }] : [];
    return { family: "F-09", file: applicationReviewFile({
      appId: "Application", rid: String(d.role ?? d.company ?? "role"), title: String(d.role ?? "Application"), company: String(d.company ?? ""),
      destination: { label: "where it was sent", href: destHref, at: iso(d.as_of) },
      pkg: [{ k: "Company", v: d.company ?? null, src: rec_ }, { k: "Role", v: d.role ?? null, src: rec_ }, { k: "Resume", v: d.resume ?? null, src: rec_ }],
      answers: sourced(d.answers).map((a) => ({ q: String(a.question ?? a.label ?? "Answer"), a: String(a.value ?? a.answer ?? a.text), required: false })),
      conditions: [], approve: { label: "Approve submission", effect: "submit" }, after: { state, evidence },
      edit: views.some((a) => a.id === "status" && a.state === "available") ? { label: "View status", effect: "decide", post: { token, action: "status" } } : null,
      extra: flag,
    }) };
  }
  return null;
}
