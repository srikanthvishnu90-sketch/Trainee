// The results page to the product spec (PRD sections 4, 5, 6, 8.8): pure functions, no I/O.
//   - stable short role ids (R-01...), derived from the refs sorted, never from the page's sort order or filter (4.7)
//   - one primary state per role, from the row's own state; the top counts are counted from these, never from clicks (6.1, 6.5)
//   - the status words of 6.5: prepared / approved / started / submitted and confirmed / still checking
//   - readable unknown labels instead of blanks (4.4)
//   - the plain-text export (4.9): real URLs only, no fake ones
import type { Row } from "./file_page.ts";

export const NOT_LISTED = "Not listed";

// R-01, R-02 ...: the position of the ref among ALL of the list's refs sorted by the ref itself. The ref is a fixed hash of the
// person and the posting, and the list's membership is fixed when it is made, so a re-sort by fit, a filter or a dismissal never
// renames a role. Nothing is stored.
export function roleIds(refs: readonly string[]): Map<string, string> {
  const sorted = [...new Set(refs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const width = Math.max(2, String(sorted.length).length);
  return new Map(sorted.map((ref, i) => [ref, `R-${String(i + 1).padStart(width, "0")}`]));
}

// A requisition id only where the posting's own text states one ("Requisition ID: R-4471", "Req #: 12345"); never guessed from the
// board's internal job id, which is not a requisition.
export function reqIdOf(text: string | null | undefined): string | null {
  const m = /\b(?:requisition|req)\.?\s*(?:id|no\.?|number|#)?\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9._-]{1,24})\b/i.exec(String(text ?? "").slice(0, 20000));
  return m ? m[1] : null;
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

export interface Spec { bucket: Bucket; label: string; detail: string; evidence: string | null; sent: boolean }
type R = Pick<Row, "status" | "byHand" | "blocked" | "tag"> & { openQs?: number };

// One primary state per role. A row is "Submitted and confirmed" ONLY when the application row holds evidence (an employer
// reference or a confirmation email); a "confirmed" with none on file is "Still checking".
export function specOf(r: R): Spec {
  const s = r.status;
  if (s) {
    switch (s.word) {
      case "confirmed":
        return s.evidence ? { bucket: "done", label: "Submitted and confirmed", detail: s.detail, evidence: s.evidence, sent: true }
          : { bucket: "progress", label: "Still checking", detail: "Recorded as confirmed, but no confirmation reference or email is on file for it yet, so it isn't counted as confirmed.", evidence: null, sent: true };
      case "submitted": return { bucket: "progress", label: "Still checking", detail: s.detail, evidence: null, sent: true };
      case "unknown": return { bucket: "progress", label: "Still checking", detail: s.detail, evidence: null, sent: true };
      case "queued": return { bucket: "progress", label: "Approved", detail: "Approved and waiting its turn; not started.", evidence: null, sent: false };
      case "sending": return { bucket: "progress", label: "Started", detail: s.detail, evidence: null, sent: false };
      case "preparing": return { bucket: "preparing", label: "Preparing", detail: s.detail, evidence: null, sent: false };
      case "needs you": return { bucket: "needs", label: "Needs you", detail: s.detail, evidence: null, sent: false };
      case "failed": case "not submitted": return { bucket: "blocked", label: "Not sent", detail: s.detail, evidence: null, sent: false };
      case "in applications": return { bucket: "blocked", label: "Already in your applications", detail: s.detail, evidence: null, sent: true };
    }
  }
  if (r.byHand) return { bucket: "blocked", label: "Apply by hand", detail: "Not applied for automatically on this site.", evidence: null, sent: false };
  if (r.blocked) return { bucket: "blocked", label: "Blocked", detail: r.blocked, evidence: null, sent: false };
  if (r.openQs) return { bucket: "needs", label: "Needs you", detail: `${r.openQs} ${r.openQs === 1 ? "question needs" : "questions need"} your answer first.`, evidence: null, sent: false };
  if (r.tag) return { bucket: "ready", label: "Prepared", detail: "Prepared and waiting for your approval. Nothing has been sent.", evidence: null, sent: false };
  return { bucket: "notprep", label: "Not prepared yet", detail: "Nothing is prepared for this role yet.", evidence: null, sent: false };
}

export function countsOf(rows: readonly R[]): { key: Bucket; label: string; n: number }[] {
  const n = new Map<Bucket, number>();
  for (const r of rows) { const b = specOf(r).bucket; n.set(b, (n.get(b) ?? 0) + 1); }
  return BUCKETS.map((b) => ({ ...b, n: n.get(b.key) ?? 0 }));
}

// What the top of the page may say about what is already sent. "Nothing has been sent" is written only when no role is approved,
// started, submitted or already in the person's applications.
export const NOTHING_SENT = "Nothing has been sent. Apply sends only the application shown under What will be sent.";
export function coverage(rows: readonly R[]): string {
  const moving = rows.filter((r) => { const s = specOf(r); return s.sent || s.bucket === "progress" || s.bucket === "done"; }).length;
  return moving ? `${moving} ${moving === 1 ? "role is" : "roles are"} already approved, started or submitted (counted above). For every other role, nothing has been sent, and Apply sends only the application shown under What will be sent.` : NOTHING_SENT;
}

// What the Apply button on a card does, in words next to it (PRD 5).
export function applyHelp(r: R & { openQs?: number }): string {
  if (r.openQs) return `Apply first asks the ${r.openQs === 1 ? "employer's question" : `${r.openQs} employer questions`} this role needs. Nothing is sent.`;
  if (r.tag) return "Apply approves and sends exactly the application shown under What will be sent. Nothing else goes.";
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
    const userStep = r.byHand || r.spec.bucket === "needs" || r.spec.label === "Not sent" || r.spec.label === "Blocked";
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
