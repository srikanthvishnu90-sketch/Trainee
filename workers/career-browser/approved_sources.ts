// The person's own answers as an application may use them: ONE definition, read by the preparation that builds the card
// (prepare-ahead.ts, the cloud preparation sandbox) and by the send-time check that the approved sources still hold
// (workers/career-cloud/engine_input.ts, read by current_sources.ts before the engine and again before Submit).
// A source one side derives and the other does not reads as withdrawn at send (APPROVED_SOURCE_WITHDRAWN), so nothing
// may be derived anywhere else.
//
// FEATURE E2E (2026-10-26): a form that asks "Name" (fact:full_name) of a person who already answered their first and last
// name was asked again: the ask-once rule broken by a field's shape. Their full name is exactly their own two answers, in
// that order, joined by a space; it is added as one more text answer whose id names both (text-answer:<first>+<last>),
// so the trust contract (trustedManifest) keeps it with that provenance. Never when they answered a full name themselves.
// Nothing else is derived: no value is invented (D-007), only their two confirmed words joined.
export interface SourceRow { id: string; key: string; answer: string }

export function withFullName<T extends SourceRow>(rows: T[]): T[] {
  const said = (k: string) => (rows || []).find((r) => r && r.key === `fact:${k}` && typeof r.answer === "string" && r.answer.trim());
  const first = said("first_name"), last = said("last_name");
  if (!first || !last || said("full_name")) return rows || [];
  return [...rows, { ...first, id: `${first.id}+${last.id}`, key: "fact:full_name", answer: `${first.answer.trim()} ${last.answer.trim()}` }];
}

// The approved-source rows from what the person answered: their rows as given, plus what withFullName derives.
export const approvedTextAnswers = withFullName;
