// Coverage report: how much of each field a set of contacts actually has, by source and by role family. Honest counts, no estimates.
import type { Contact, RoleFamily, SourceKind } from "./types.ts";
import { ROLE_FAMILIES, SOURCE_KINDS } from "./types.ts";

export interface Coverage {
  total: number; with_provenance: number;
  fields: Record<"role_title" | "firm" | "location" | "education" | "shared_connections" | "email", number>;
  email_by_basis: Record<string, number>;
  by_source: Record<string, number>; by_family: Record<string, number>;
}
export function coverageReport(list: Contact[]): Coverage {
  const c: Coverage = { total: list.length, with_provenance: 0, fields: { role_title: 0, firm: 0, location: 0, education: 0, shared_connections: 0, email: 0 }, email_by_basis: {}, by_source: {}, by_family: {} };
  for (const k of SOURCE_KINDS) c.by_source[k] = 0; for (const f of ROLE_FAMILIES) c.by_family[f] = 0;
  for (const x of list) {
    if (x.provenance.length && x.provenance.every((p) => p.source_url && p.retrieved_at && p.license_note)) c.with_provenance++;
    if (x.role_title) c.fields.role_title++; if (x.firm) c.fields.firm++; if (x.location) c.fields.location++;
    if (x.education.length) c.fields.education++; if (x.shared_connections.length) c.fields.shared_connections++;
    if (x.email) { c.fields.email++; c.email_by_basis[x.email_basis!] = (c.email_by_basis[x.email_basis!] ?? 0) + 1; }
    for (const k of new Set(x.provenance.map((p) => p.source_kind as SourceKind))) c.by_source[k]++;
    c.by_family[x.role_family as RoleFamily]++;
  }
  return c;
}
export function coverageMarkdown(c: Coverage): string {
  const pct = (n: number) => c.total ? `${n}/${c.total} (${Math.round((100 * n) / c.total)}%)` : "0/0";
  return [`Contacts: ${c.total}; with full provenance: ${pct(c.with_provenance)}`, "", "| Field | Filled |", "|---|---|",
    ...Object.entries(c.fields).map(([k, v]) => `| ${k} | ${pct(v)} |`), "", `Email basis: ${JSON.stringify(c.email_by_basis)}`, `By source: ${JSON.stringify(c.by_source)}`, `By role family: ${JSON.stringify(c.by_family)}`].join("\n");
}
