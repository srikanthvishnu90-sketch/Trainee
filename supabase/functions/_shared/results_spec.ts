// The results page to the product spec (PRD sections 4, 5, 6, 8.8): pure functions, no I/O.
//   - stable short role ids (R-01...), derived from the refs sorted, never from the page's sort order or filter (4.7)
//   - one primary state per role, from the row's own state; the top counts are counted from these, never from clicks (6.1, 6.5)
//   - the status words of 6.5: prepared / approved / started / submitted and confirmed / still checking
//   - readable unknown labels instead of blanks (4.4)
//   - the plain-text export (4.9): real URLs only, no fake ones
import type { Row } from "./file_page.ts";

export const NOT_LISTED = "Not listed";

// R-01, R-02 ...: the position of the ref among ALL of the list's refs sorted by the ref itself. The ref is a fixed hash of the
// person and the posting. Callers pass the list's raw refs (the unfiltered recallList), so a re-sort, a filter or a dismissal never
// renames a role; if the stored list itself changed, ids would change with it. Nothing is stored.
export function roleIds(refs: readonly string[]): Map<string, string> {
  const sorted = [...new Set(refs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const width = Math.max(2, String(sorted.length).length);
  return new Map(sorted.map((ref, i) => [ref, `R-${String(i + 1).padStart(width, "0")}`]));
}

// A requisition id only where the posting's own text states one ("Requisition ID: R-4471", "Req #: 12345"); never guessed from the
// board's internal job id, which is not a requisition. It needs an explicit id / no. / number / # label and a token with a digit.
export function reqIdOf(text: string | null | undefined): string | null {
  const m = /\b(?:requisition|req)\.?\s*(?:id|no\.?|number|#)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9._-]{1,24})\b/i.exec(String(text ?? "").slice(0, 20000));
  return m && /\d/.test(m[1]) ? m[1] : null;
}

export type Bucket = "ready" | "needs" | "preparing" | "notprep" | "progress" | "done" | "blocked";
export const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "ready", label: "Ready to apply" },
  { key: "needs", label: "Needs you" },
  { key: "preparing", label: "Preparing" },
  { key: "notprep", label: "Not prepared yet" },
  { key: "progress", label: "Approved, started or still checking" },
  { key: "done", label: "Submitted, confirmed" },
  { key: "blocked", label: "Blocked or applied by hand" },
];

// The state system of the design spec (1.6): the labels are verbatim, one primary state per role.
export type StateKey = "discovered" | "checking" | "needs_info" | "preparing" | "ready" | "approved" | "queued" | "in_progress" | "user_step" | "uncertain" | "submitted" | "blocked" | "excluded" | "closed";
export type Tone = "neutral" | "info" | "attention" | "plum" | "risk" | "confirmed";
export const STATES: Record<StateKey, { label: string; tone: Tone }> = {
  discovered: { label: "Discovered", tone: "neutral" }, checking: { label: "Checking", tone: "info" },
  needs_info: { label: "Needs candidate information", tone: "attention" }, preparing: { label: "Preparing", tone: "info" },
  ready: { label: "Ready for review", tone: "plum" }, approved: { label: "Approved", tone: "plum" }, queued: { label: "Queued", tone: "info" },
  in_progress: { label: "In progress", tone: "info" }, user_step: { label: "User step needed", tone: "attention" },
  uncertain: { label: "Submission uncertain", tone: "risk" }, submitted: { label: "Submitted - confirmed", tone: "confirmed" },
  blocked: { label: "Blocked", tone: "risk" }, excluded: { label: "Excluded", tone: "neutral" }, closed: { label: "Closed before submission", tone: "neutral" },
};
export interface Spec { bucket: Bucket; key: StateKey; tone: Tone; label: string; detail: string; evidence: string | null; sent: boolean }
type R = Pick<Row, "status" | "byHand" | "blocked" | "tag"> & { openQs?: number; missing?: string[] };
const mk = (key: StateKey, bucket: Bucket, detail: string, evidence: string | null, sent: boolean): Spec => ({ bucket, key, tone: STATES[key].tone, label: STATES[key].label, detail, evidence, sent });

// One primary state per role. A row is "Submitted - confirmed" ONLY when the application row holds evidence (an employer
// reference or a confirmation email); a "confirmed" with none on file is "Checking". A posting that is closed or past its deadline is
// "Closed before submission"; a dismissed role is "Excluded" (stateOfDismissed).
export function specOf(r: R): Spec {
  const s = r.status;
  if (s) {
    switch (s.word) {
      case "confirmed":
        return s.evidence ? mk("submitted", "done", s.detail, s.evidence, true)
          : mk("checking", "progress", "Recorded as confirmed, but no confirmation reference or email is on file for it yet, so it isn't counted as confirmed.", null, true);
      case "submitted": return mk("checking", "progress", s.detail, null, true);
      case "unknown": return mk("uncertain", "progress", s.detail, null, true);
      case "queued": return mk("queued", "progress", "Approved and waiting its turn; not started.", null, false);
      case "sending": return mk("in_progress", "progress", s.detail, null, false);
      case "preparing": return mk("preparing", "preparing", s.detail, null, false);
      case "needs you": return mk("user_step", "needs", s.detail, null, !!s.sent);
      case "failed": case "not submitted": return mk("blocked", "blocked", s.detail, null, false);
      case "in applications": return mk("in_progress", "blocked", s.detail, null, true);
    }
  }
  if (r.byHand) return mk("user_step", "blocked", "Not applied for automatically on this site. Apply there yourself.", null, false);
  if (r.blocked) return /\b(closed|deadline|expired|no longer|filled)\b/i.test(r.blocked) ? mk("closed", "blocked", r.blocked, null, false) : mk("blocked", "blocked", r.blocked, null, false);
  if (r.openQs) {
    const what = r.missing?.length ? `Missing: ${r.missing.join("; ")}.` : `${r.openQs} ${r.openQs === 1 ? "question needs" : "questions need"} your answer first.`;
    return mk("needs_info", "needs", what, null, false);
  }
  if (r.tag) return mk("ready", "ready", "Prepared and waiting for your approval. Nothing has been sent.", null, false);
  return mk("discovered", "notprep", "Found; nothing is prepared for this role yet.", null, false);
}
// A role the person dismissed: intentionally not pursued, the reason kept (private, reversible).
export const stateOfDismissed = (): Spec => mk("excluded", "blocked", "Dismissed by you. Private and reversible; no application was touched.", null, false);

// The counts strip in the spec's own state words: every role is in exactly one state, so the numbers sum to the role total.
export function stateCountsOf(rows: readonly R[]): { key: StateKey; label: string; tone: Tone; n: number }[] {
  const n = new Map<StateKey, number>();
  for (const r of rows) { const k = specOf(r).key; n.set(k, (n.get(k) ?? 0) + 1); }
  return (Object.keys(STATES) as StateKey[]).map((key) => ({ key, label: STATES[key].label, tone: STATES[key].tone, n: n.get(key) ?? 0 }));
}
export function countsOf(rows: readonly R[]): { key: Bucket; label: string; n: number }[] {
  const n = new Map<Bucket, number>();
  for (const r of rows) { const b = specOf(r).bucket; n.set(b, (n.get(b) ?? 0) + 1); }
  return BUCKETS.map((b) => ({ ...b, n: n.get(b.key) ?? 0 }));
}

// What the top of the page may say about what is already sent. "Nothing has been sent" is written only when no role is approved,
// started, submitted or already in the person's applications.
export const NOTHING_SENT = "Nothing has been sent. Apply sends only the application as its card shows it.";
export function coverage(rows: readonly R[]): string {
  const moving = rows.filter((r) => { const s = specOf(r); return s.sent || s.bucket === "progress" || s.bucket === "done"; }).length;
  return moving ? `${moving} ${moving === 1 ? "role is" : "roles are"} already approved, started or submitted (including any you dismissed). For every other role, nothing has been sent, and Apply sends only the application as its card shows it.` : NOTHING_SENT;
}

// What the Apply button on a card does, in words next to it (PRD 5).
export function applyHelp(r: R & { openQs?: number }): string {
  if (r.openQs) return `Apply first asks the ${r.openQs === 1 ? "employer's question" : `${r.openQs} employer questions`} this role needs. Nothing is sent.`;
  if (r.tag) return "Apply approves and sends exactly the application as its card shows it. Nothing else goes.";
  return "Apply starts preparing this application so you can see it. Nothing is sent until you tap Apply again.";
}

// ---------------------------------------------------------------- the plain-text export (PRD 4.9)
export interface ExportRole { id: string; employer: string; title: string; reqId: string | null; place: string; pay: string; source: string; url: string | null; checked: string | null;
  spec: Spec; byHand: boolean; dismissed: boolean }
const oneLine = (s: string) => String(s ?? "").replace(/[‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
const httpUrl = (u: string | null) => { try { const x = new URL(String(u)); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; } };
export function renderExport(o: { title: string; updated: string; counts: { label: string; n: number }[]; coverageLine: string; paused: boolean; roles: ExportRole[] }): string {
  const L: string[] = [oneLine(o.title), `Page updated ${o.updated}`, "", oneLine(o.coverageLine), ...(o.paused ? ["Paused: no new applications start from this page."] : []), "", "Where things stand"];
  for (const c of o.counts) if (c.n) L.push(`- ${c.label}: ${c.n}`);
  L.push("");
  for (const r of o.roles) {
    const url = httpUrl(r.url);
    // A link is "Open application" only where the person finishes it themselves on the employer's site; everything else is an
    // action the private workspace carries out after approval. No made-up addresses.
    const userStep = r.byHand || r.spec.bucket === "needs" || r.spec.key === "blocked" || r.spec.key === "closed" || r.spec.key === "user_step";
    L.push(`${r.id}  ${oneLine(r.title)} at ${oneLine(r.employer)}`);
    L.push(`  Status: ${r.dismissed ? "Dismissed by you (private; no application touched)" : r.spec.label}`);
    if (!r.dismissed && r.spec.detail) L.push(`  Detail: ${oneLine(r.spec.detail)}`);
    if (r.spec.evidence) L.push(`  Evidence: ${oneLine(r.spec.evidence)}`);
    L.push(`  Requisition ID: ${r.reqId ?? NOT_LISTED}`, `  Location: ${oneLine(r.place) || NOT_LISTED}`, `  Pay: ${oneLine(r.pay)}`, `  Source: ${oneLine(r.source) || NOT_LISTED}`, `  Checked: ${r.checked ?? "Check time unknown"}`);
    L.push(`  Source URL: ${url ?? NOT_LISTED}`);
    L.push(`  ${url && userStep ? `Open application: ${url}` : "Action available in private workspace"}`, "");
  }
  return L.join("\n");
}
