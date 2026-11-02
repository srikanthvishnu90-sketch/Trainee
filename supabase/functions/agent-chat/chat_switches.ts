// D-036 review (2026-11-01): the chat's release-flag switches in one place, so each one's rollback is tested
// (tests/architect/release-flags.test.ts: every switch on in production and off under its own FLAG=off) and the handler
// reads them only from here (the same test pins every gate in handler-career.ts to these names).
import { releaseFlagOn } from "./release_config.ts";

type Env = { get(k: string): string | undefined };

export const CHAT_SWITCHES = {
  networkingDraft: "CAREER_NETWORKING_DRAFT",   // the model drafts outreach (approved by hash, delivered by the person)
  followupReminders: "CAREER_OUTREACH_FOLLOWUPS", // follow-up reminders promised and pushed to the person's outbox
  introPush: "CAREER_INTRO_REMINDERS",          // introduction reminders pushed at their date (else said at the next message)
  mailTracking: "CAREER_MAIL_TRACKING",         // "check my email now" runs the person's mail read
} as const;
export type ChatSwitches = { -readonly [K in keyof typeof CHAT_SWITCHES]: boolean };

export function chatSwitches(env: Env): ChatSwitches {
  const out = {} as ChatSwitches;
  for (const [k, flag] of Object.entries(CHAT_SWITCHES)) out[k as keyof ChatSwitches] = releaseFlagOn(env, flag);
  return out;
}
