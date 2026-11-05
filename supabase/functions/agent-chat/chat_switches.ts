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

// MASS APPLY STATE (2026-11-04; review of #496): what a reply may SAY about live effects. These words gate nothing: every
// effect keeps its own gate. A claim is made only from what the gates themselves read, and only when every gate is known:
//   employerSubmit true   the release flags (UPMORE_SCRIPT_SUBMIT_LIVE at "1", CLOUD_RUNNER_ENABLED), the database's
//                         switch rows the cloud text-card route needs (career_cloud_settings CAREER_AGENT_SUBMIT,
//                         CAREER_CLOUD_APPLY, CAREER_CLOUD_TEXT_CARDS, each exactly 'on', as the database reads them) and
//                         this person's cloud opt-in (career_apply_cloud_optin, via the situation's capability) are all on;
//   employerSubmit false  a release flag is off in this environment (no route submits for anyone);
//   employerSubmit null   anything else: a row off, missing or unreadable, the person not opted in or unreadable. A row
//                         off may still leave another route (APPLY_VM for the people APPLY_VM_USER_IDS names), so no claim
//                         either way; the status replies read what each application's own record says happened.
//   emailSend             the same rule: true only with CAREER_EMAIL_SEND and CAREER_SEND_RAIL on and the person's grant
//                         carrying gmail.send; false when a flag is off; null otherwise.
export type LiveSwitches = { employerSubmit: boolean | null; emailSend: boolean | null; batchExecutor: boolean };
export const SUBMIT_DB_SWITCHES = ["CAREER_AGENT_SUBMIT", "CAREER_CLOUD_APPLY", "CAREER_CLOUD_TEXT_CARDS"] as const;
type Known = "on" | "off" | "not_connected" | "expired" | "never" | "unknown" | string | null | undefined;
export interface LiveInputs {
  settings: Record<string, string> | null; // career_cloud_settings key -> value; null: could not be read
  cloudOptIn: Known;                        // the situation's cloud_apply capability status
  gmailSend: Known;                         // the situation's gmail_send capability status
}
export function liveSwitches(env: Env, i: LiveInputs): LiveSwitches {
  const sw = chatSwitches(env);
  const envSubmit = releaseValue(env, "UPMORE_SCRIPT_SUBMIT_LIVE") === "1" && releaseFlagOn(env, "CLOUD_RUNNER_ENABLED");
  const rowsOn = !!i.settings && SUBMIT_DB_SWITCHES.every((k) => i.settings![k] === "on");
  const envEmail = sw.emailSend && releaseFlagOn(env, "CAREER_SEND_RAIL");
  return {
    employerSubmit: !envSubmit ? false : rowsOn && i.cloudOptIn === "on" ? true : null,
    emailSend: !envEmail ? false : i.gmailSend === "on" ? true : null,
    batchExecutor: sw.batchExecutor,
  };
}
// The switch rows, read as the service role (the table is revoked from everyone else), kept exactly as stored: the database
// reads value = 'on' and nothing else, so "ON" or " on" is off here too. null when the read fails.
export async function readSubmitSettings(admin: { from(t: string): any }): Promise<Record<string, string> | null> {
  try {
    const r = await admin.from("career_cloud_settings").select("key,value").in("key", [...SUBMIT_DB_SWITCHES]);
    if (r?.error || !Array.isArray(r?.data)) return null;
    return Object.fromEntries(r.data.map((x: { key: string; value: string }) => [String(x.key), String(x.value)]));
  } catch { return null; }
}
