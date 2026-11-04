// Adapters for the user's OWN data: a CSV/LinkedIn data-export file the user downloaded themselves, and names they paste.
// Nothing here fetches anything. A profile-URL column is dropped, never stored and never visited.
import type { Candidate, EmailBasis, Provenance } from "../types.ts";
import { cleanEmail, cleanName } from "../types.ts";

const USER_NOTE = "Supplied by the user from their own data (their own export or typing). The user attests the right to use it; no third-party licence is implied.";
export function userCsvProvenance(fileName: string, now: Date): Provenance {
  return { source_kind: "user_csv", source_url: `user-upload://${encodeURIComponent(fileName || "contacts.csv")}`, retrieved_at: now.toISOString(), license_note: USER_NOTE };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((c) => c.trim() !== "")) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}
const norm = (h: string) => h.toLowerCase().replace(/[^a-z]+/g, " ").trim();
const FORMULA = /^[=+@\t\r]|^-(?!\d)/; // spreadsheet formula starters: stripped, so a cell can never run in the user's viewer
const cell = (v: string | undefined) => { const t = String(v ?? "").trim(); return FORMULA.test(t) ? t.replace(/^[=+@\t\r-]+/, "").trim() : t; };

// Columns understood (case/spacing-insensitive): First Name, Last Name, Name/Full Name, Company/Organization/Firm, Position/Title/Job Title,
// Location, Education/School, Email Address/Email, Shared Connections/Mutual Connections (; or | separated). LinkedIn's export has a few
// "Notes:" lines above the header; we find the header row by looking for a name column.
export function csvCandidates(fileName: string, text: string, now = new Date()): Candidate[] {
  const rows = parseCsv(text);
  const hi = rows.findIndex((r) => { const h = r.map(norm); return h.includes("first name") || h.includes("name") || h.includes("full name"); });
  if (hi < 0) return [];
  const head = rows[hi].map(norm);
  const idx = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const iF = idx("first name"), iL = idx("last name"), iN = idx("name", "full name"), iC = idx("company", "organization", "firm", "employer");
  const iP = idx("position", "title", "job title", "role"), iLoc = idx("location", "city"), iE = idx("education", "school", "university");
  const iM = idx("email address", "email", "e mail"), iS = idx("shared connections", "mutual connections", "shared contacts");
  const prov = userCsvProvenance(fileName, now), out: Candidate[] = [];
  for (const r of rows.slice(hi + 1)) {
    const name = iN >= 0 && cell(r[iN]) ? cell(r[iN]) : `${iF >= 0 ? cell(r[iF]) : ""} ${iL >= 0 ? cell(r[iL]) : ""}`.trim();
    const email = iM >= 0 ? cleanEmail(cell(r[iM])) : null;
    const split = (v: string) => v.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    out.push({
      full_name: name, firm: iC >= 0 ? cell(r[iC]) || null : null, role_title: iP >= 0 ? cell(r[iP]) || null : null,
      location: iLoc >= 0 ? cell(r[iLoc]) || null : null, education: iE >= 0 ? split(cell(r[iE])) : [],
      shared_connections: iS >= 0 ? split(cell(r[iS])) : [],
      email, email_basis: email ? "user_supplied" as EmailBasis : null, provenance: { ...prov },
    });
  }
  return out;
}

// Pasted names, one per line. Understood: "Jane Doe", "Jane Doe, VP Finance, Acme Capital", "Jane Doe - Acme", "Jane Doe at Acme",
// "Jane Doe <jane@acme.com>" (an address the user typed is user_supplied). Anything else is a name only.
export function pastedCandidates(text: string, now = new Date(), pasteId = "p1"): Candidate[] {
  const prov: Provenance = { source_kind: "pasted", source_url: `user-paste://${encodeURIComponent(pasteId)}`, retrieved_at: now.toISOString(), license_note: USER_NOTE };
  const out: Candidate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim().replace(/^[-*\d.)\s]+(?=[A-Za-z])/, ""); if (!line) continue;
    let email: string | null = null;
    const m = line.match(/<([^>]+@[^>]+)>|\b([\w.+'-]+@[\w-]+(?:\.[\w-]+)+)\b/);
    if (m) { email = cleanEmail(m[1] ?? m[2]); line = line.replace(m[0], "").trim(); }
    let name = line, role: string | null = null, firm: string | null = null;
    const at = line.match(/^(.+?)\s+at\s+(.+)$/i);
    if (at) { name = at[1]; firm = at[2]; }
    else {
      const parts = line.split(/\s*[,\t|]\s*|\s+[-–—]\s+/).filter(Boolean);
      name = parts[0] ?? ""; if (parts.length === 2) firm = parts[1]; else if (parts.length >= 3) { role = parts[1]; firm = parts.slice(2).join(", "); }
    }
    out.push({ full_name: cleanName(name), role_title: role, firm, email, email_basis: email ? "user_supplied" : null, provenance: { ...prov } });
  }
  return out;
}
