import { APPLY_ALL_YES_ENV, applyAllYesEnabled } from "../_shared/apply_all_yes_flag.ts";
// RELEASE CONFIG (D-035, owner 2026-11-01: "Ship staged brain"): which brain a deployed agent-chat serves is part of the
// deployed SHA, not a hand-set secret. This file is reply code (it lives under supabase/functions/agent-chat/, which
// scripts/launch/reply-code.ts lists), so changing it needs a fresh reply-quality measurement before it can deploy, and
// the deploy standard's S3 reads it at each SHA to know which brain to measure (scripts/launch/deploy-standard.ts,
// servedBrainAt): the candidate's served brain against the deployed SHA's served brain.
//
//   PRODUCTION_BRAIN = "staged"   question, advice and conversation turns to the brain (career_staged.ts); every action,
//                                 the host's controls, structured requests and a model outage stay with code and the router.
//
// The one environment override is the EMERGENCY ROLLBACK, and it can only turn the brain off:
//
//   supabase secrets set CAREER_BRAIN=router --project-ref <ref>     every turn to the router at once, no deploy
//   supabase secrets unset CAREER_BRAIN --project-ref <ref>          back to PRODUCTION_BRAIN
//
// Any value other than the release brain itself (router, agent, a typo) serves the router: an override never turns on a
// brain the committed config did not ship, and a mistyped rollback still rolls back. CAREER_BRAIN=agent stays pinned off
// (career_brain.ts AGENT_BRAIN_RELEASED). Unset, or set to the release brain: PRODUCTION_BRAIN. The rollback is temporary;
// the lasting change is a reviewed commit that sets PRODUCTION_BRAIN = "router" and passes the deploy standard (D-034).
// CAREER_BRAIN_ROUTER_INTENTS (career_staged.ts) still keeps single turn classes on the router.

type Env = { get(k: string): string | undefined };

export type ServedBrain = "router" | "staged";

// The brain this commit serves in production. Read as text by deploy-standard.ts at any SHA: keep it one line, quoted.
export const PRODUCTION_BRAIN: ServedBrain = "staged";

// The environment variable of the emergency rollback, and the only value it is documented to take.
export const ROLLBACK_ENV = "CAREER_BRAIN";
export const ROLLBACK_VALUE = "router";

// The brain served for this environment: PRODUCTION_BRAIN unless the rollback override is set.
export function servedBrain(env: Env, release: ServedBrain = PRODUCTION_BRAIN): ServedBrain {
  const v = (env.get(ROLLBACK_ENV) ?? "").trim().toLowerCase();
  if (!v || v === release) return release;
  return "router";
}

// PRODUCTION_BRAIN as written in a copy of this file (the deploy standard reads it at a SHA with git show). A SHA without
// this file predates D-035 and served the router (CAREER_BRAIN unset in production; 33f7d00, run 41233949107): null here,
// "router" at the caller. A file whose value cannot be read is an error, never a guess.
export function parseProductionBrain(text: string): ServedBrain {
  const m = /^export const PRODUCTION_BRAIN(?:\s*:\s*ServedBrain)?\s*=\s*"(router|staged)"\s*;/m.exec(text);
  if (!m) throw new Error("release_config.ts: PRODUCTION_BRAIN is not one quoted router|staged line");
  return m[1] as ServedBrain;
}
export const RELEASE_CONFIG_PATH = "supabase/functions/agent-chat/release_config.ts";

// ------------------------------------------------------------------------------------------------ release flags (D-036)
// RELEASE FLAGS (D-036, owner 2026-11-01 18:42 CT: "turn everything on that u believe is needed, to test everything end to
// end"). The feature switches this commit serves ON in production, as part of the deployed SHA (like PRODUCTION_BRAIN),
// not as hand-set secrets. Every one of them keeps the person's approval of the exact payload in front of any external
// effect (a send, a submit, a message to anyone but the person), and none needs a secret production lacks. The full
// inventory, with what stays OFF and why, is docs/architect/RELEASE-FLAGS-2026-11-01.md.
//
//   CAREER_TEXTING_NATIVE     channel-native delivery: split like a person texts, typing indicator, the "on it" interim
//   CAREER_NETWORKING_DRAFT   the model drafts outreach under the fact-lock; approved by hash, delivered by the person
//   CAREER_TAILOR_REWRITE     truthful bullet rewrite toward a posting, each bullet audited against its one confirmed fact
//   CAREER_MOCK_JUDGE         the model grades the person's own mock-interview answers
//   CAREER_MAIL_TRACKING      application status from the person's Gmail (gmail.readonly), read only
//   CAREER_BRIEF_DIGEST       interview briefs, interview drafts and the weekly digest, to the person
//   CAREER_OUTREACH_FOLLOWUPS follow-up reminders on mail the person sent, to the person's own outbox
//   CAREER_INTRO_REMINDERS    introduction reminders the person asked for, to the person's own outbox
//
// The environment can only turn a release flag OFF (the rollback, no deploy):
//
//   supabase secrets set CAREER_MAIL_TRACKING=off --project-ref <ref>   that one feature off at once
//   supabase secrets unset CAREER_MAIL_TRACKING --project-ref <ref>     back to the release value
//
// As with CAREER_BRAIN: unset, or set to the release value ("on"), serves the release value; any other value (off, 0, a
// typo) serves "off", so a mistyped rollback still rolls back. A switch that is not in this table is read from the
// environment exactly as before (default off; RELEASE_NEVER_ON below).
//
// D-037 (owner, in writing, 2026-11-01 20:04 CT: "turn these on: Real submissions … Sending email as the person … Reply
// rewriters"): real submissions and sending email as the person are release flags too. Every guard in front of them is
// unchanged and still decides each item: the person's approval of the exact payload (an application's payload hash; an
// email's to, subject and body by hash), the database's own switches (RELEASE_DB_SWITCHES, written by trainee-go-live.sh),
// the cloud gate and its waiver, the opt-in, the pauses, any per-person or per-site number the owner sets, captchas handed to
// the person, LinkedIn and Indeed never opened. Mail leaves only from the person's own Google account, and only when that
// person's own grant carries gmail.send (careerTokenFor: no gmail.send, no token, nothing sent, the person told to
// reconnect); nothing ever sends from Trainee's identity. The cloud runner's switches can be on while its Vercel sandbox
// secrets are missing: it then answers "needs setup" and starts nothing (cloud_runner_http.ts). The three reply rewriters
// stay off until each is measured (D-037 condition 3; docs/architect/RELEASE-FLAGS-2026-11-01.md).
//
//   UPMORE_SCRIPT_SUBMIT_LIVE   the cloud sandbox presses Submit on an approved application (release value "1")
//   CLOUD_RUNNER_ENABLED        the cloud runner's send tick; CLOUD_PREPARE_ENABLED its preparation tick
//   CAREER_EMAIL_SEND           an approved apply-by-email or follow-up email from the person's Gmail
//   CAREER_OUTREACH_SEND        the scheduled send of approved outreach from the person's Gmail
//   CAREER_SEND_RAIL            the sending rail for every approved email (one recipient, the person's own account)
//   gmail.send is never asked for at the normal connect (it is not in the verification submission: an unverified scope
//   would warn every read-only connect). It is asked for incrementally, only when the person approves their first send:
//   the chat answers "to send this from your Gmail, allow sending: <link>", a connect link with reason "send" whose consent
//   asks for gmail.send alone with include_granted_scopes (trainee-connect/store.ts). Google has not verified the scope:
//   until it does, only the Google test users the owner adds in the Google Cloud console can grant it (his step).
//   GOOGLE_APPROVED_EXTRA_SCOPES stays the owner's list of scopes Google approved (several allowed), not a release flag.
export const RELEASE_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  CAREER_TEXTING_NATIVE: "on",
  CAREER_NETWORKING_DRAFT: "on",
  CAREER_TAILOR_REWRITE: "on",
  CAREER_MOCK_JUDGE: "on",
  CAREER_MAIL_TRACKING: "on",
  CAREER_BRIEF_DIGEST: "on",
  CAREER_OUTREACH_FOLLOWUPS: "on",
  CAREER_INTRO_REMINDERS: "on",
  UPMORE_SCRIPT_SUBMIT_LIVE: "1",
  CLOUD_RUNNER_ENABLED: "on",
  CLOUD_PREPARE_ENABLED: "on",
  CAREER_EMAIL_SEND: "on",
  CAREER_OUTREACH_SEND: "on",
  CAREER_SEND_RAIL: "on",
});

// APPLY ALL BY YES (owner, 2026-11-02 17:10 CT; _shared/apply_all_yes.ts): not a release flag. It adds no new way to send: a bare yes
// approves only the roles the results message offered, each through the same hash-bound Confirm as the page's Apply, so every guard
// there (duplicate, changed tag, posting screen, paused account, the database kill switches below, the queue's pace and cloud opt-in)
// still decides each one. Served ON by this commit; the environment can only turn it OFF (no deploy), and the results message then
// carries no question and no offer:
//   supabase secrets set CAREER_APPLY_ALL_YES=off --project-ref <ref>     off at once
//   supabase secrets unset CAREER_APPLY_ALL_YES --project-ref <ref>       back to on
// One shared definition (_shared/apply_all_yes.ts), also used by the results page.
export { APPLY_ALL_YES_ENV };
export const applyAllYesOn: (env: Env) => boolean = applyAllYesEnabled;

// D-037: the database switches the release serves on (public.career_cloud_settings; the database reads anything but 'on' as
// off). trainee-go-live.sh writes them on every go-live from scripts/launch/release-db-switches.sql, which
// tests/architect/release-flags.test.ts holds to this table. Their kill switch is the row: set it to 'off' and every claim
// stops at once; `trainee-go-live.sh --real-submit off` writes 'off' instead, so a later go-live does not undo it.
export const RELEASE_DB_SWITCHES: Readonly<Record<string, "on">> = Object.freeze({
  CAREER_AGENT_SUBMIT: "on",
  CAREER_CLOUD_APPLY: "on",
  APPLY_VM: "on",
});

// D-036 review (2026-11-01): ON once its condition is met, not before; until then each is read from the environment as
// before (default off) and every report names it as pending, never as live. Moving one into RELEASE_FLAGS is its own commit.
export const RELEASE_PENDING: Readonly<Record<string, string>> = Object.freeze({
  CAREER_PLANNER: "measured first: the task eval (brain-eval suite=tasks), planner on against off, and #371's fix (a crisis message with two asks reaches the 988 reply before the planner; planner reminders are delivered) landed",
  CAREER_CRISIS_MODERATION: "reader pending #354: no code at this SHA reads it, so it is not reported as a live safety layer",
  CAREER_BATCH_EXECUTOR: "executor not deployed: nothing in production loads workers/career-browser/batch-executor.cjs, so a batch ask would commit an intent nobody runs (D-007, WO-106)",
});

// Switches the release config does not turn on: reply words no measurement covers yet (D-037 condition 3: each rewriter goes
// on only after its measurement), or what production does not have or the owner has not decided
// (docs/architect/RELEASE-FLAGS-2026-11-01.md, "why off"). tests/architect/release-flags.test.ts fails if one of them
// enters RELEASE_FLAGS. The environment reads them as before. LinkedIn and Indeed automation and any send from Trainee's own
// identity have no switch at all: there is no code path to turn on (CLAUDE.md; D-033).
export const RELEASE_NEVER_ON: readonly string[] = Object.freeze([
  "CAREER_OUTREACH_REPLIES", "CAREER_OUTREACH_REPLIES_MODEL",
  "CAREER_REPLY_WRITER", "CAREER_KNOWLEDGE", "CAREER_JUDGE", "CAREER_MAIL_MODEL",
  "CAREER_PEOPLE_SEARCH", "CAREER_PEOPLE_SWEEP", "CAREER_PDL", "CAREER_VOICE", "CAREER_PREPARE_AHEAD", "CAREER_PREPARE_AHEAD_COVER",
  "CAREER_RESEARCH_REPLY", "CAREER_RESEARCH_BRIEF", "TRAINEE_LOGO_GUESS", "CHANNEL_UNKNOWN_REPLY", "TRAINEE_SIGNUP",
  "WHATSAPP_TEMPLATE_UPDATES", "UPMORE_LEGACY_GMAIL_CONNECT",
]);

export const FLAG_ROLLBACK_VALUE = "off";

// The value a switch has in this environment: a release flag's release value unless the environment rolls it back; any
// other name exactly as the environment holds it.
export function releaseValue(env: Env, name: string): string | undefined {
  const release = Object.prototype.hasOwnProperty.call(RELEASE_FLAGS, name) ? RELEASE_FLAGS[name] : undefined;
  const v = env.get(name);
  if (release === undefined) return v;
  const t = (v ?? "").trim().toLowerCase();
  return !t || t === release ? release : FLAG_ROLLBACK_VALUE;
}

// Whether a switch is "on" in this environment, release flags included (UPMORE_SCRIPT_SUBMIT_LIVE's on is "1": read it with
// releaseValue(env, name) === "1").
export function releaseFlagOn(env: Env, name: string): boolean {
  return releaseValue(env, name) === "on";
}

// The environment as the release serves it: release flags at their release value (unless rolled back), everything else
// passed through, read at call time (a rollback or a test that changes the environment is seen on the next read).
export function releaseEnv(env: Env): Env {
  return { get: (k: string) => releaseValue(env, k) };
}

// RELEASE_FLAGS as written in a copy of this file (deploy-standard.ts reads it at a SHA with git show, as PRODUCTION_BRAIN):
// the sorted flag names; [] for a SHA without the table (it predates D-036 and turned none on by config).
export function parseReleaseFlags(text: string): string[] {
  const m = /export const RELEASE_FLAGS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/.exec(text);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*"[^"\n]+"\s*,?\s*$/gm)].map((x) => x[1]).sort();
}
