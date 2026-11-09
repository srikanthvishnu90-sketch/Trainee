// R10 owner ruling (2026-11-09): people apply by a plain message and a yes. A search ranks the postings Trainee can submit
// itself ahead of EQUAL-fit postings that need the person's own account, and labels each one, in chat and on the File. A
// better-fit posting is never hidden or pushed below a worse fit because it needs an account: it is labelled.
//
// canSubmit(posting) -> { can, reason } is the per-posting capability check WO-M fills in. Until then the stub knows nothing
// (null): no label is shown and no order changes, so nothing is claimed that has not been checked.
export interface SubmitCapability { can: boolean; reason: string }
export interface SubmitPosting { job_id: string; url: string | null; company: string | null; title: string }
export type CanSubmit = (p: SubmitPosting) => SubmitCapability | null | Promise<SubmitCapability | null>;

export const CAN_SUBMIT_LABEL = "I can submit this one for you";
export const OWN_ACCOUNT_LABEL = "this employer requires your own account";
export const canSubmitStub: CanSubmit = () => null; // WO-M: the real check

export const submitLabel = (c: SubmitCapability | null | undefined): string | null => (c ? (c.can ? CAN_SUBMIT_LABEL : OWN_ACCOUNT_LABEL) : null);

// Each posting's capability; a check that fails is unknown for that posting (never "can").
export async function capabilitiesOf(postings: SubmitPosting[], check: CanSubmit | null | undefined): Promise<Map<string, SubmitCapability | null>> {
  const out = new Map<string, SubmitCapability | null>();
  for (const p of postings) {
    let c: SubmitCapability | null = null;
    if (check) { try { const r = await check(p); c = r && typeof r.can === "boolean" ? { can: r.can, reason: String(r.reason ?? "") } : null; } catch { c = null; } }
    out.set(p.job_id, c);
  }
  return out;
}

// Stable: rows keep their fit order; within each run of neighbouring rows of the same fit tier, the ones Trainee can submit
// come first, then the unknown, then the ones that need the person's own account. Never across a fit difference.
export function rankBySubmit<T>(rows: T[], tier: (r: T) => number, id: (r: T) => string, caps: Map<string, SubmitCapability | null>): T[] {
  const key = (r: T) => { const c = caps.get(id(r)); return c ? (c.can ? 0 : 2) : 1; };
  const out: T[] = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && tier(rows[j]) === tier(rows[i])) j++;
    out.push(...rows.slice(i, j).map((r, k) => ({ r, k })).sort((a, b) => key(a.r) - key(b.r) || a.k - b.k).map((x) => x.r));
    i = j;
  }
  return out;
}
