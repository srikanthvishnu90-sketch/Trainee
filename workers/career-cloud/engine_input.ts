// The engine's input for a cloud-only person (bridge review 1, item A1): what the engine's dry run reads
// (scripts/apply.ts --facts) built from what the person gave Trainee in Messages, and nothing else:
//   - their chat profile's facts, as stored (state.career.stores.profile.facts in agent_flow_state). The one contract,
//     trustedManifest, projects them (typed_profile_fields.ts: today phone, work authorization, country) and keeps only
//     the confirmed, owner-evidenced, unquarantined ones;
//   - their own answers to asked questions (career_apply_questions rows, state answered), as text_answers: the rows the
//     contract keeps as theirs (text-answer:<row id>), a fact-scoped one (fact:<key>) for every posting, a label- or
//     job-scoped one (an attestation, a posting's own question) only where it was asked.
// Nothing is parsed, merged, defaulted or confirmed here: a value reaches an application only through trustedManifest,
// and a chat fact and a texted answer that disagree exclude each other there (asked again). Rows of another person, rows
// not answered and malformed rows are left out and named in `skipped`, never repaired.
import { trustedManifest } from "../../extension/src/apply_core.ts";
import { approvedTextAnswers } from "../career-browser/approved_sources.ts";

export interface AnswerRow { id: string; key: string; kind: string; answer: string }
export interface EngineFacts {
  user_id: string;
  facts: Record<string, unknown>[];
  answers: Record<string, never>;
  saved: Record<string, never>;
  text_answers: AnswerRow[];
}
export interface EngineInput {
  facts: EngineFacts;
  // What the contract keeps from it, for the producer's log and the card: kept keys by table, exclusions with the reason,
  // conflicts (asked again), the manifest hash the approval will bind and the quarantine rules it was judged under.
  manifest: { hash: string; version: string; kept: { answers: string[]; saved: string[] }; excluded: { key: string; factId: string; why: string }[]; conflicts: { key: string; factIds: string[] }[] };
  skipped: { id: string; why: string }[];
}

const KEY = /^(fact:[a-z0-9_]{1,60}|label:[0-9a-f]{16}|job:[0-9a-f]{16})$/; // career_apply_questions.key
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function engineInput(o: { owner: string; profile: unknown; rows: unknown[]; resumeSha256?: string }): EngineInput {
  if (typeof o.owner !== "string" || !UUID.test(o.owner)) throw Error("ENGINE_INPUT_OWNER");
  const skipped: EngineInput["skipped"] = [];
  const given: AnswerRow[] = [];
  for (const r of Array.isArray(o.rows) ? o.rows : []) {
    const id = object(r) && typeof r.id === "string" ? r.id : "";
    const why = !object(r) ? "not a row" : !UUID.test(id) ? "no row id"
      : r.user_id !== undefined && r.user_id !== o.owner ? "another person's row"
      : r.state !== undefined && r.state !== "answered" ? "not answered"
      : typeof r.key !== "string" || !KEY.test(r.key) ? "malformed key"
      : typeof r.answer !== "string" || !r.answer.trim() || r.answer.length > 2000 ? "no answer" : "";
    if (why) { skipped.push({ id, why }); continue; }
    const row = r as Record<string, string>;
    given.push({ id: row.id, key: row.key, kind: String(row.kind ?? ""), answer: row.answer });
  }
  given.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // The same approved sources the preparation built the card from (approved_sources.ts): a source derived there and not
  // here read as withdrawn at send, so every hosted application that used a derived full name was refused.
  const text_answers = approvedTextAnswers(given);
  const p = object(o.profile) ? o.profile : {};
  // A profile stored for another person contributes nothing (the projection refuses it too; this keeps it out of the file).
  const own = p.user_id === undefined || p.user_id === o.owner;
  if (!own) skipped.push({ id: "profile", why: "another person's profile" });
  const facts = own && Array.isArray(p.facts) ? structuredClone(p.facts.filter(object)) : [];
  const file: EngineFacts = { user_id: o.owner, facts, answers: {}, saved: {}, text_answers };
  const m = trustedManifest({ owner: o.owner, file: structuredClone(file), rows: structuredClone(text_answers),
    resume: typeof o.resumeSha256 === "string" && /^[0-9a-f]{64}$/.test(o.resumeSha256) ? { sha256: o.resumeSha256 } : null });
  return {
    facts: file,
    manifest: { hash: m.hash, version: m.version, kept: { answers: Object.keys(m.answers).sort(), saved: Object.keys(m.saved).sort() },
      excluded: m.excluded, conflicts: m.conflicts },
    skipped,
  };
}

// Where the producer reads them: the person's latest stored chat profile and their answered questions.
export interface EngineInputSource {
  latestProfile(owner: string): Promise<unknown | null>;
  answeredRows(owner: string): Promise<unknown[]>;
}
export async function readEngineInput(source: EngineInputSource, owner: string, resumeSha256?: string): Promise<EngineInput & { profileFound: boolean }> {
  let profile: unknown | null, rows: unknown[];
  try {
    [profile, rows] = await Promise.all([source.latestProfile(owner), source.answeredRows(owner)]);
  } catch (e) {
    // A failed read stops the preparation named; it never prepares on an empty or partial input.
    throw Object.assign(Error("ENGINE_INPUT_READ_FAILED"), { cause: e });
  }
  if (!Array.isArray(rows)) throw Error("ENGINE_INPUT_READ_FAILED");
  return { ...engineInput({ owner, profile: profile ?? {}, rows, resumeSha256 }), profileFound: profile != null };
}

// The source over PostgREST with the service key (the cloud producer's machine). Two reads, both scoped to the one person.
export function restEngineInputSource(o: { url: string; key: string; fetch?: typeof fetch }): EngineInputSource {
  const f = o.fetch ?? fetch;
  const get = async (path: string) => {
    const r = await f(`${o.url.replace(/\/$/, "")}/rest/v1/${path}`, { headers: { apikey: o.key, Authorization: `Bearer ${o.key}` } });
    const text = await r.text();
    if (!r.ok) throw Error(`${path.split("?")[0]}: ${r.status} ${text.slice(0, 200)}`);
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw Error(`${path.split("?")[0]}: not a list`);
    return rows;
  };
  return {
    async latestProfile(owner) {
      // The same read the chat restores from (production-sources.cjs readStoredMaster): the freshest snapshot with a profile.
      const rows = await get(`agent_flow_state?select=state,updated_at&user_id=eq.${encodeURIComponent(owner)}&order=updated_at.desc&limit=25`);
      for (const row of rows) {
        const profile = row?.state?.career?.stores?.profile;
        if (object(profile) && (object(profile.basics) || Array.isArray(profile.facts))) return profile;
      }
      return null;
    },
    answeredRows: (owner) =>
      get(`career_apply_questions?select=id,user_id,key,kind,answer,state&user_id=eq.${encodeURIComponent(owner)}&state=eq.answered&order=answered_at.asc`),
  };
}
