// D-036 review (2026-11-01): the scheduled run's release-flag switches in one place, so each one's rollback is tested
// (tests/architect/release-flags.test.ts: on in production, off under its own FLAG=off) and index.ts reads them only
// from here (the same test pins every gate in index.ts to these names).
import { releaseFlagOn } from "../agent-chat/release_config.ts";

type Env = { get(k: string): string | undefined };

export const PROACTIVE_SWITCHES = {
  mail: "CAREER_MAIL_TRACKING",               // application status read from the person's Gmail
  outreachFollowups: "CAREER_OUTREACH_FOLLOWUPS", // follow-up reminders queued to the person's outbox
  introReminders: "CAREER_INTRO_REMINDERS",   // introduction reminders queued to the person's outbox
  briefs: "CAREER_BRIEF_DIGEST",              // interview briefs, drafts and the weekly digest
} as const;
export type ProactiveSwitches = { -readonly [K in keyof typeof PROACTIVE_SWITCHES]: boolean };

export function proactiveSwitches(env: Env): ProactiveSwitches {
  const out = {} as ProactiveSwitches;
  for (const [k, flag] of Object.entries(PROACTIVE_SWITCHES)) out[k as keyof ProactiveSwitches] = releaseFlagOn(env, flag);
  return out;
}
