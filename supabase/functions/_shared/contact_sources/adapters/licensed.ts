// LICENSED PROVIDER adapter: People Data Labs / Apollo / Hunter style APIs. OFF by default and stays off until the owner supplies an API key
// AND records that he signed the provider's contract/terms. Nothing here knows a provider's endpoint: a provider is an object with
// search(), written when the contract exists, so no unlicensed call can be made by accident.
import type { Candidate, EmailBasis } from "../types.ts";

export interface ProviderQuery { firm?: string; domain?: string; title?: string; name?: string; limit?: number }
export interface ProviderRecord {
  full_name: string; title?: string; company?: string; location?: string; education?: string[];
  email?: string; email_status?: string;      // the provider's own verdict, e.g. "valid", "verified", "accept_all", "unknown"
  record_url: string;                          // the provider's record URL or API URL the data came from (https)
}
export interface LicensedProvider {
  id: "people_data_labs" | "apollo" | "hunter" | string;
  terms_url: string;
  search(q: ProviderQuery, apiKey: string): Promise<ProviderRecord[]>;
}
export interface LicenseConfig {
  provider: LicensedProvider; api_key: string;
  contract_signed_on: string;   // YYYY-MM-DD, entered by the owner after he signed
  contract_signed_by: string;   // the owner
  permitted_use_note: string;   // what the contract allows (outreach? storage? resale no?), one sentence, from the contract
}
export type LicensedAdapterState = { enabled: false; reason: string } | { enabled: true; run: (q: ProviderQuery, now?: Date) => Promise<Candidate[]> };

// Email passes only when the provider itself calls it verified. Everything else keeps the person but drops the address.
const VERIFIED = new Set(["valid", "verified", "deliverable"]);
export function licensedAdapter(cfg: LicenseConfig | null | undefined): LicensedAdapterState {
  if (!cfg) return { enabled: false, reason: "off: no provider configured. The owner must pick a provider, sign its terms, and supply the API key." };
  if (!cfg.api_key || cfg.api_key.length < 8) return { enabled: false, reason: "off: no API key" };
  if (!cfg.contract_signed_on || Number.isNaN(Date.parse(cfg.contract_signed_on)) || !cfg.contract_signed_by || !cfg.permitted_use_note?.trim()) return { enabled: false, reason: "off: owner has not recorded a signed contract (date, signer, permitted use)" };
  if (!/^https:\/\//.test(cfg.provider?.terms_url ?? "")) return { enabled: false, reason: "off: provider terms URL missing" };
  return { enabled: true, run: async (q, now = new Date()) => {
    const recs = await cfg.provider.search(q, cfg.api_key); const out: Candidate[] = [];
    for (const r of recs) {
      if (!r.full_name || !/^https:\/\//.test(r.record_url ?? "")) continue;
      const ok = !!r.email && VERIFIED.has(String(r.email_status ?? "").toLowerCase());
      out.push({
        full_name: r.full_name, role_title: r.title ?? null, firm: r.company ?? null, location: r.location ?? null, education: r.education ?? [],
        email: ok ? r.email : null, email_basis: ok ? "licensed_verifier" as EmailBasis : null, email_detail: ok ? `${r.email_status} (${cfg.provider.id}, ${now.toISOString().slice(0, 10)})` : null,
        provenance: { source_kind: "licensed_provider", source_url: r.record_url, retrieved_at: now.toISOString(), license_note: `Licensed from ${cfg.provider.id} under contract signed ${cfg.contract_signed_on} by ${cfg.contract_signed_by}; permitted use: ${cfg.permitted_use_note}; terms ${cfg.provider.terms_url}` },
      });
    }
    return out;
  } };
}
