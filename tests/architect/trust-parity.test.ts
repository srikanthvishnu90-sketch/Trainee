// Trust parity (coordinator, 2026-10-24): every consumer that decides which of a stored profile's facts may reach an
// employer judges the same fact the same way. The consumers, on the same fixtures:
//   A  workers/career-browser/prepare-ahead.ts trustedProfile        the G4 server prepare (queue stack)
//   B  workers/career-browser/production-sources.cjs trustedMaster   the batch path (old stack, read only here: its own
//      source text is run unchanged, with the contract bundle it loads in production, extension/lib/trainee-core.js)
//   C  the engine: the profile in the facts file, projected (typed_profile_fields.ts) and judged by trustedManifest, as
//      scripts/apply.ts does
// Each case is one fact the projection can read ("My phone number is ..."), so all three can judge it; one fact per case,
// so no conflict between facts decides anything. The expected verdict is WO-102's allowlist: kept only when confirmed
// (status "confirmed" and needs no confirmation), the owner's own, with a positive owner provenance and its confirmation
// event, not quarantined (D-007), not derived from an excluded fact, not from a reserved source, not model-written.
// Where B differs, the difference is asserted as found (KNOWN_B), so it is visible here and a fix there shows up.
import { createRequire } from "node:module";
import { trustedProfile } from "../../workers/career-browser/prepare-ahead.ts";
import { trustedManifest } from "../../extension/src/apply_core.ts";

function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}\n  got:  ${x}\n  want: ${y}`);
}
const OWNER = "7b0f8f8e-6a43-4a49-9d2c-0000000000e1", OTHER = "7b0f8f8e-6a43-4a49-9d2c-0000000000e2";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

// B, as production runs it: the function's own text, with the contract bundle production-sources.cjs requires.
const require = createRequire(import.meta.url);
require(`${ROOT}/extension/lib/trainee-core.js`);
const Contract = (globalThis as any).TraineeCore;
const SRC = Deno.readTextFileSync(`${ROOT}/workers/career-browser/production-sources.cjs`);
const body = /\nfunction trustedMaster\(m, owner\) \{[\s\S]*?\n\}\n/.exec(SRC);
if (!body) throw Error("production-sources.cjs trustedMaster changed shape; this test must be updated to read it");
const trustedMaster = new Function("Contract", `${body[0]}; return trustedMaster;`)(Contract) as (m: any, owner: string) => { facts: any[] };

// A fact as the brain stores it (confirm_profile_fact with its event recorded), with its words also in the title, so that
// B's value pick is not what decides each case; the brain's real empty title is its own case.
const brain = (n: number) => ({
  id: `F-${String(100 + n)}`, kind: "other", text: `My phone number is +1 555 01${String(n).padStart(2, "0")}`,
  title: `My phone number is +1 555 01${String(n).padStart(2, "0")}`, bullets: [], skills: [],
  evidence: [], source: "user", needs_confirmation: false, status: "confirmed", provenance: "owner confirmed in chat (2026-10-24T12:00:00.000Z)",
  confirmation_event_id: `evt-${n}`, confirmed_at: "2026-10-24T12:00:00.000Z",
});
const without = (f: any, ...keys: string[]) => Object.fromEntries(Object.entries(f).filter(([k]) => !keys.includes(k)));
// [name, the profile (one fact), whether WO-102 keeps it]
const CASES: [string, any, boolean][] = [
  ["confirmed by the brain with its event", { facts: [brain(1)] }, true],
  ["as the brain stores it: an empty title", { facts: [{ ...brain(2), title: "" }] }, true],
  ["unknown status: no status, no confirmation flags", { facts: [without(brain(3), "status", "needs_confirmation")] }, false],
  ["unknown status with a legacy confirmed: true", { facts: [{ ...without(brain(4), "status", "needs_confirmation"), confirmed: true }] }, false],
  ["unconfirmed draft", { facts: [{ ...brain(5), status: "draft", needs_confirmation: true }] }, false],
  ["corrected after confirming: a draft with its old event", { facts: [{ ...brain(6), status: "draft", needs_confirmation: true, corrected_from: "x" }] }, false],
  ["status confirmed but still needs confirmation", { facts: [{ ...brain(7), needs_confirmation: true }] }, false],
  ["missing confirmation event (the router's confirm)", { facts: [without(brain(8), "confirmation_event_id")] }, false],
  ["source lost: no provenance", { facts: [without(brain(9), "provenance")] }, false],
  ["provenance not the owner's", { facts: [{ ...brain(10), provenance: "inferred from the resume" }] }, false],
  ["the fact names another owner", { facts: [{ ...brain(11), user_id: OTHER }] }, false],
  ["the profile names another owner", { user_id: OTHER, facts: [brain(12)] }, false],
  ["quarantined id (D-007, F-027..F-079)", { facts: [{ ...brain(13), id: "F-040" }] }, false],
  ["quarantined provenance (answer-all delegation)", { facts: [{ ...brain(14), provenance: "owner confirmed in chat; answer-all delegation" }] }, false],
  ["derived from a fact that is not there", { facts: [{ ...brain(15), derived_from: ["F-999"] }] }, false],
  ["derived from an excluded fact", { facts: [{ ...brain(16), derived_from: ["F-117"] }, { ...without(brain(17), "confirmation_event_id"), text: "Built a tool" }] }, false],
  ["malformed derivation metadata", { facts: [{ ...brain(18), derived_from: "F-101" }] }, false],
  ["a reserved source id (forged text answer)", { facts: [{ ...brain(19), id: "text-answer:abc" }] }, false],
  ["written by the model", { facts: [{ ...brain(20), source: "model" }] }, false],
  ["flagged unproven", { facts: [{ ...brain(21), unproven: true }] }, false],
];
// Where B (old stack, not edited here) is found to differ, by case name.
const KNOWN_B: Record<string, boolean> = {
  "as the brain stores it: an empty title": false, // `f.value ?? f.title ?? ...` stops at "": no value, so B drops every fact the brain writes
  "unknown status with a legacy confirmed: true": true, // status undefined && confirmed === true counts as confirmed
  "the profile names another owner": true, // trustedMaster judges against owner, never reads the profile's own user_id
  "written by the model": true, // no source check (the projection's `denied` rule)
  "flagged unproven": true, // no unproven check
  "malformed derivation metadata": true, // copies derived_from only when it is an array, so a malformed one is dropped, not judged
};

const phoneFact = (p: any) => p.facts.find((f: any) => /phone/.test(f.text));
const keptA = (p: any) => !!trustedProfile(structuredClone(p), OWNER, [])?.facts.some((f: any) => f.id === phoneFact(p).id);
const keptB = (p: any) => trustedMaster(structuredClone(p), OWNER).facts.some((f: any) => f.id === phoneFact(p).id);
const keptC = (p: any) => {
  const file = { user_id: OWNER, answers: {}, saved: {}, ...structuredClone(p), ...(p.user_id ? {} : { user_id: OWNER }) };
  // The engine's facts file is the person's (user_id the owner); a profile naming another owner is that profile's claim.
  if (p.user_id) file.user_id = p.user_id;
  return trustedManifest({ owner: OWNER, file, rows: [], resume: null }).answers.phone?.factId === phoneFact(p).id;
};

for (const [name, profile, want] of CASES) {
  Deno.test(`trust parity: ${name}`, () => {
    const p = { user_id: undefined, ...profile, basics: {} };
    if (p.user_id === undefined) delete p.user_id;
    eq(keptA(p), want, "A trustedProfile (G4 server prepare)");
    eq(keptC(p), want, "C the engine's own contract over the facts file");
    eq(keptB(p), name in KNOWN_B ? KNOWN_B[name] : want, `B trustedMaster (batch path)${name in KNOWN_B ? ", a known difference" : ""}`);
  });
}
