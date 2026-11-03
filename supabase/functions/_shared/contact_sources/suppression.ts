// Suppression / opt-out list. A person who asks is removed and never re-imported. Keys: email, or normalized name (+ firm when
// the person named one). A name-only request blocks that name at every firm: over-blocking an opt-out is the safe error.
import type { Contact } from "./types.ts";
import { cleanEmail, nameKey, normKey } from "./types.ts";

export interface SuppressionEntry { key: string; added_at: string; reason: string }
export class SuppressionList {
  private m = new Map<string, SuppressionEntry>();
  constructor(private now: () => Date = () => new Date()) {}
  private keys(p: { email?: string | null; name?: string | null; firm?: string | null }): string[] {
    const k: string[] = []; const e = cleanEmail(p.email);
    if (e) k.push(`e:${e}`);
    if (p.name && nameKey(p.name)) k.push(p.firm ? `nf:${nameKey(p.name)}|${normKey(p.firm)}` : `n:${nameKey(p.name)}`);
    return [...new Set(k)];
  }
  suppress(p: { email?: string | null; name?: string | null; firm?: string | null }, reason = "opt-out request"): number {
    const ks = this.keys(p); for (const key of ks) if (!this.m.has(key)) this.m.set(key, { key, added_at: this.now().toISOString(), reason });
    return ks.length;
  }
  matches(c: { full_name: string; firm?: string | null; email?: string | null }): boolean {
    const e = cleanEmail(c.email);
    return (!!e && this.m.has(`e:${e}`)) || this.m.has(`n:${nameKey(c.full_name)}`) || this.m.has(`nf:${nameKey(c.full_name)}|${normKey(c.firm)}`);
  }
  purge(list: Contact[]): Contact[] { return list.filter((c) => !this.matches(c)); }
  get size() { return this.m.size; }
  toJSON(): SuppressionEntry[] { return [...this.m.values()]; }
  static fromJSON(rows: SuppressionEntry[], now?: () => Date): SuppressionList { const s = new SuppressionList(now); for (const r of rows ?? []) if (r?.key) s.m.set(r.key, r); return s; }
}
