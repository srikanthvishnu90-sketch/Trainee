// A narrow projection into the existing WO-102 confirmed-facts file. Reading a profile is never a confirmation:
// the owner, positive provenance and confirmation event must already exist and pass trustedManifest unchanged.
import { FACT_SCHEMA } from './fact_schema.ts';
import { quarantinedFact } from './fact_quarantine.ts';

type Key = 'country' | 'work_authorization' | 'phone' | 'full_name' | 'first_name' | 'last_name' | 'email';
interface FieldRow {
  value: string; factId: string; confirmed: true; user_id: string;
  provenance: string; confirmation_event_id: string; derived_from?: string[];
}
export interface TypedProfileFile { user_id: string; answers: Partial<Record<Key, FieldRow>>; saved: Record<string, never> }
export interface FieldQuestion { factId: string; reason: string }
const object = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);
const denied = (f: any) => [f, f?.provenance].some(v => object(v) && (v.unproven === true || v.quarantined === true || v.rejected === true)) ||
  [f?.source, f?.origin].some(v => typeof v === 'string' && /^(agent|assistant|model|llm|generated|(?:agent|assistant|model|ai)[ _-]generated)$/i.test(v.trim()));
const clean = (v: unknown) => typeof v === 'string' ? v.trim().replace(/[.!]+$/, '').trim() : '';
const US = /^(?:the )?(?:US|U\.S\.?|USA|United States(?: of America)?)$/i;
const countryValue = (s: string) => /^[A-Za-z][A-Za-z .'-]{1,79}$/.test(s) && !/\b(?:not|unknown|maybe|perhaps|or|unsure)\b/i.test(s) ? s : null;
const phoneValue = (s: string) => /^\+?[\d ()-]+$/.test(s) && s.replace(/\D/g, '').length >= 7 && s.replace(/\D/g, '').length <= 15 ? s : null;
// Domain records preserve both spellings. Projection must carry every dependency to the canonical allowlist;
// a malformed spelling cannot disappear or be masked by an otherwise valid alias.
function derivationIds(f: any): string[] | undefined | null {
  const ids = new Set<string>(); let present = false;
  for (const key of ['derived_from', 'derivedFrom']) {
    if (!Object.hasOwn(f, key)) continue;
    present = true;
    if (!Array.isArray(f[key])) return null;
    for (const id of f[key]) {
      if (typeof id !== 'string' || !id.trim()) return null;
      ids.add(id); // Preserve source IDs exactly; normalization cannot create a different source reference.
    }
  }
  return present ? [...ids] : undefined;
}
// MASS APPLY CONVERSATIONS (2026-11-16, eval MA05): the contact line of a resume the person confirmed word for word
// (career_router_evidence.ts evidenceResumeHeader: kind "profile", name "Full name" / "First name" / "Last name" / "Email",
// each with its own fact_confirmed event). Only those exact names, and only a value that reads as one.
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const NAME = /^[\p{L}][\p{L}'’.-]*(?: [\p{L}][\p{L}'’.-]*){0,5}$/u;
const CONTACT: [RegExp, Key, (v: string) => string | null][] = [
  [/^full name$/i, 'full_name', (v) => (NAME.test(v) ? v : null)], [/^first name$/i, 'first_name', (v) => (NAME.test(v) && !v.includes(' ') ? v : null)],
  [/^last name$/i, 'last_name', (v) => (NAME.test(v) && !v.includes(' ') ? v : null)], [/^email$/i, 'email', (v) => (EMAIL.test(v) ? v : null)],
];
function fieldOf(f: any): { key: Key; value: string } | null {
  const t = clean(f.text), name = clean(f.name || f.title);
  let m: RegExpMatchArray | null;
  if (f.kind === 'profile') for (const [re, key, ok] of CONTACT) if (re.test(name)) { const value = ok(String(f.value ?? '').trim()); return value ? { key, value } : null; }
  if ((f.kind === 'profile' && /^country$/i.test(name)) || (m = t.match(/^my country(?: of residence)? is (.+)$/i))) {
    const value = countryValue(clean(f.kind === 'profile' && /^country$/i.test(name) ? f.value : m![1]));
    return value ? { key: 'country', value } : null;
  }
  if ((f.kind === 'profile' && /^(?:mobile )?phone(?: number)?$/i.test(name)) || (m = t.match(/^my (?:mobile )?phone(?: number)? is (.+)$/i))) {
    const value = phoneValue(clean(f.kind === 'profile' && /^(?:mobile )?phone(?: number)?$/i.test(name) ? f.value : m![1]));
    return value ? { key: 'phone', value } : null;
  }
  // The apply planner's global authorization fact is US-scoped. Never turn residence, citizenship, an unqualified
  // "authorized", or another country's statement into this answer. Foreign/missing context is an explicit question.
  if (f.kind === 'eligibility' && /^work authori[sz]ation(?: \(US\))?$/i.test(name)) {
    const value = clean(f.value);
    return US.test(clean(f.country)) && /^(Yes|No)$/i.test(value) ? { key: 'work_authorization', value: /^yes$/i.test(value) ? 'Yes' : 'No' } : null;
  }
  m = t.match(/^I am (not )?authori[sz]ed to work in (.+)$/i);
  return m && US.test(m[2]) ? { key: 'work_authorization', value: m[1] ? 'No' : 'Yes' } : null;
}
export function typedProfileFile(o: { owner: string; profile: any }): { file: TypedProfileFile; needs: FieldQuestion[] } {
  const file: TypedProfileFile = { user_id: o.owner, answers: {}, saved: {} }, needs: FieldQuestion[] = [];
  const profile = o.profile;
  const candidates = new Map<Key, { fact: any; value: string; derived?: string[] }[]>();
  for (const f of Array.isArray(profile?.facts) ? profile.facts : []) {
    const id = typeof f?.id === 'string' ? f.id : '';
    if (!object(f) || profile.user_id !== o.owner || (f.user_id !== undefined && f.user_id !== o.owner) || denied(profile) || denied(f) ||
      // D-007: a bank row (its factId) or delegated provenance never projects; the projection names the row by its own id,
      // so a bank factId it carried would otherwise be dropped before the manifest's own check reads it.
      quarantinedFact(f) ||
      f.status !== 'confirmed' || f.needs_confirmation !== false) {
      needs.push({ factId: id, reason: 'An owned confirmed source is required before this can answer an application field.' }); continue;
    }
    if (typeof f.provenance !== 'string' || !f.provenance.trim() || typeof f.confirmation_event_id !== 'string' || !f.confirmation_event_id.trim()) {
      needs.push({ factId: id, reason: 'The original positive provenance and confirmation event are required; projection cannot create them.' }); continue;
    }
    const derived = derivationIds(f);
    if (derived === null) {
      needs.push({ factId: id, reason: 'Malformed derivation metadata requires review before its source dependencies can be checked.' }); continue;
    }
    const field = fieldOf(f);
    if (!field) { needs.push({ factId: id, reason: 'No unambiguous supported field value and country context were stated.' }); continue; }
    // These keys and wire types are the existing apply schema, not a second field registry.
    if (FACT_SCHEMA.facts[field.key].type !== 'text') throw new Error('typed profile field schema changed');
    const rows = candidates.get(field.key) ?? []; rows.push({ fact: f, value: field.value, derived }); candidates.set(field.key, rows);
  }
  for (const [key, rows] of candidates) {
    if (new Set(rows.map(r => r.value.toLowerCase())).size !== 1) {
      for (const r of rows) needs.push({ factId: r.fact.id, reason: `Conflicting ${key} values need the owner's correction.` }); continue;
    }
    const { fact: f, value, derived } = rows[0];
    file.answers[key] = { value, factId: f.id, confirmed: true, user_id: o.owner, provenance: f.provenance,
      confirmation_event_id: f.confirmation_event_id, ...(derived !== undefined ? { derived_from: derived } : {}) };
  }
  // This is a shape projection, not authority. The caller must pass this unchanged file through the existing
  // trustedManifest allowlist, including reserved/quarantined IDs, provenance, derivation and conflict checks.
  return { file, needs };
}
