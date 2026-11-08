// R9-C: one market research brief (synthetic companies, .example sources, synthetic figures), shared by the string and browser tests.
import { bodyHtml, KIND_CSS, validateKind, type FileRecord } from "../../supabase/functions/_shared/file_kinds.ts";
import { fileShellHtml } from "../../supabase/functions/_shared/file_design.ts";
import { layout } from "../../supabase/functions/_shared/file_page.ts";

export const NOW = Date.parse("2026-11-07T18:00:00Z");
export const MARKET = {
  variant: "market", title: "What would change the market for home batteries", subject: "Home battery storage",
  thesis: "Cheaper cells and new utility tariffs decide whether home batteries go mainstream.",
  summary: [
    { text: "Battery pack prices fell 20% in 2024, the survey reports.", source: "Reported, not verified", cite: [1] },
    { text: "Acme Energy says it installed 41,000 home batteries in 2025.", source: "Reported, not verified", cite: [2] },
    { text: "Globex Power lists home batteries as one of three product lines.", source: "Reported, not verified", cite: [3] },
  ],
  comparison: {
    options: [{ name: "Acme Energy" }, { name: "Globex Power" }, { name: "Initech Grid" }],
    rows: [
      { label: "Home batteries installed (2025)", cells: [{ value: "41,000", source: "Reported, not verified", cite: [2] }, null, null] },
      { label: "Product lines", cells: [{ value: "Batteries, solar", source: "Reported, not verified", cite: [2] }, { value: "Batteries, solar, EV chargers", source: "Reported, not verified", cite: [3] }, null] },
    ],
  },
  conditions: [{ text: "Pack prices keep falling through 2027.", cite: [1] }, { text: "Utilities keep paying homes for stored power at peak hours.", cite: [4] }],
  risks: [{ text: "A tariff change could remove most of the bill savings.", cite: [4] }],
  sources: [
    { title: "Battery price survey 2024", url: "https://research.example/battery-prices-2024", fetched_at: "2026-11-07T15:00:00Z" },
    { title: "Acme Energy annual report 2025", url: "https://acme.example/annual-report", fetched_at: "2026-11-07T15:01:00Z" },
    { title: "Globex Power products", url: "https://globex.example/products", fetched_at: "2026-11-07T15:02:00Z" },
    { title: "Utility tariff notice", url: "https://utility.example/tariffs/storage", fetched_at: "2026-11-06T10:00:00Z" },
  ],
};
export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
export function marketRecord(data: unknown = MARKET): FileRecord {
  const v = validateKind("research_brief", data, { now: NOW });
  if (!v.ok) throw new Error(v.errors.join("; "));
  return { id: "0123456789", userId: "u", kind: "research_brief", data: v.data, state: {}, tag: null, created_at: NOW, expires_at: NOW + 3600_000, revoked_at: null };
}
// The page as trainee-file serves it (handler.ts handleKind): the shared shell, the kind's body, the kind's CSS.
export function marketPage(data: unknown = MARKET): string {
  const rec = marketRecord(data);
  return layout(`${rec.data.title} - Trainee`, `<div id="root">${fileShellHtml({ made: "Made for Ada · Nov 7, 2026", eyebrow: "Research brief", title: rec.data.title, stamp: "Facts as of Nov 7, 2026, 12:00 PM CT", body: bodyHtml(rec, "fs1." + "a".repeat(64)) })}</div>`, { css: KIND_CSS });
}
