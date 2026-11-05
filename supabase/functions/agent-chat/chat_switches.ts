// D-036 review (2026-11-01): the chat's release-flag switches in one place, so each one's rollback is tested
// (tests/architect/release-flags.test.ts: every switch on in production and off under its own FLAG=off) and the handler
// reads them only from here (the same test pins every gate in handler-career.ts to these names).
import { releaseFlagOn, releaseValue } from "./release_config.ts";

type Env = { get(k: string): string | undefined };

export const CHAT_SWITCHES = {
  networkingDraft: "CAREER_NETWORKING_DRAFT",   // the model drafts outreach (approved by hash, delivered by the person)
  followupReminders: "CAREER_OUTREACH_FOLLOWUPS", // follow-up reminders promised and pushed to the person's outbox
  introPush: "CAREER_INTRO_REMINDERS",          // introduction reminders pushed at their date (else said at the next message)
  mailTracking: "CAREER_MAIL_TRACKING",         // "check my email now" runs the person's mail read
  emailSend: "CAREER_EMAIL_SEND",               // D-037: an approved email leaves from the person's own Gmail (gmail.send)
  batchExecutor: "CAREER_BATCH_EXECUTOR",       // D-037: an approved batch is handed to the worker's executor
} as const;
export type ChatSwitches = { -readonly [K in keyof typeof CHAT_SWITCHES]: boolean };

export function chatSwitches(env: Env): ChatSwitches {
  const out = {} as ChatSwitches;
  for (const [k, flag] of Object.entries(CHAT_SWITCHES)) out[k as keyof ChatSwitches] = releaseFlagOn(env, flag);
  return out;
}

// MASS APPLY STATE (2026-11-04): what a reply may SAY about live effects, read from the same release config the effects
// themselves read, so the words follow the switches (the router's approval rule used to say "Submitting to employers is
// not wired" on every Edge turn even with real submission on, D-041). employerSubmit: the cloud submitter presses Submit
// on an approved application (UPMORE_SCRIPT_SUBMIT_LIVE at its release value "1" and the runner's send tick on); the
// database's per-account switches (RELEASE_DB_SWITCHES) still decide each claim, and a refused claim is recorded as not
// sent, which is what the status replies then read. These words gate nothing: every effect keeps its own gate.
export type LiveSwitches = { employerSubmit: boolean; emailSend: boolean; batchExecutor: boolean };
export function liveSwitches(env: Env): LiveSwitches {
  const sw = chatSwitches(env);
  return {
    employerSubmit: releaseValue(env, "UPMORE_SCRIPT_SUBMIT_LIVE") === "1" && releaseFlagOn(env, "CLOUD_RUNNER_ENABLED"),
    emailSend: sw.emailSend,
    batchExecutor: sw.batchExecutor,
  };
}
