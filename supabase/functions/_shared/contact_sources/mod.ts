// Entry point for the networking builder. Call importContacts(candidates, { suppression, existing }) and read Contact; ask emailEligibility()
// before any send. Adapters produce Candidates; the web ones need a WebGate (allowlist + robots); the licensed one is off until configured.
export * from "./types.ts";
export * from "./suppression.ts";
export * from "./web_gate.ts";
export * from "./coverage.ts";
export { csvCandidates, pastedCandidates, parseCsv } from "./adapters/user_data.ts";
export { edgarInsiders, form4Candidates, secRules, validSecUserAgent, recentInsiderFilings } from "./adapters/edgar.ts";
export { pageContacts, parseCards, PRESETS } from "./adapters/pages.ts";
export { licensedAdapter } from "./adapters/licensed.ts";
export type { LicensedProvider, LicenseConfig, ProviderRecord, ProviderQuery } from "./adapters/licensed.ts";
