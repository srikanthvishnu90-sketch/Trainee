// PR-5 (b)/(c) of the 2026-11-06 root-cause report: what the person gets when today's AI allowance is spent.
//
// Over the per-person daily cap the brain is not tried (zero model calls). Code serves fixed views instead, all of them
// safety/failure text (ARCHITECTURE §3.1), none written by a model:
//   - /help or "help": the channel's help text, the limit note, and the commands that still work;
//   - a question about how approval works (cards, a text yes, an answer that changes after approval): the approval rules,
//     built below from named constants whose wording each cites the code that enforces it;
//   - anything else the router cannot answer: "AI answers are paused until <reset>; these still work: ...".
import { CHANNEL_REPLIES } from "../_shared/channel.ts";
import { LIMIT_NOTE, SPEND_UNREAD_NOTE } from "../_shared/career_spend_cap.ts";

export const CAP_VIEW_INTENT = "career_cap_view";
export const CAP_HELP_INTENT = "career_cap_help";
export const CAP_APPROVAL_INTENT = "career_cap_approval_rules";
// Router intents that mean "no module answered": under the cap these get the paused view instead of the catch-all.
export const CAP_REPLACED_INTENTS: readonly string[] = ["unclaimed", "career_catchall", "career_fallback"];

// The next UTC midnight, when the day's spend (agent_daily_costs is keyed by UTC day) starts again.
export function capResetAt(now: number): string {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return `${new Date(next).toISOString().slice(0, 10)} 00:00 UTC`;
}

// What still works without the model: code-owned turns only.
export const STILL_WORKS = "searching postings, \"show my applications\", approving or declining the cards you are shown (tap or a text yes/no), STOP and START.";

// Each rule states what the code does; the file it comes from is named so a change there is a change here.
export const APPROVAL_RULES: readonly string[] = [
  // career_apply_cards.ts (D-031, D-MS-1): the card shows every answer; nothing is approved unseen.
  "Nothing is sent or submitted until you approve the exact application shown to you. Each card lists what will go, answer by answer.",
  // career_apply_cards.ts, telegram_jobs.ts: tapping Confirm / Approve is the approval.
  "Tapping Approve or Confirm on a card approves exactly that application.",
  // career_apply_cards.ts D-MS-1: scope, window, single use, subsets, what is not an answer.
  "A text \"yes\" approves exactly the batch on the latest card, and only if that card is my last message (or you replied to it), within 10 minutes of my showing it, once. \"yes except 3\" and \"only 1, 2 and 5\" approve just those. \"no\" declines and \"wait\" holds. \"maybe\", \"ok?\" or \"1 or 2\" approve nothing. A yes approves; it does not send by itself, your own worker sends afterwards.",
  // apply_all_yes.ts: the results-list offer.
  "\"Reply yes to apply to all shown\" approves only the roles that were already prepared and unchanged when offered. A role not yet prepared is queued to get ready, never approved by that yes.",
  // career_cloud_card_chat.ts: the cloud card's own rule.
  "For a cloud card (a draft I prepared for sending as you), a text yes only opens the card; only your tap on Approve sends it.",
  // career_apply_card_answer_as / telegram_jobs.ts: approval is bound to the payload hash; the submit worker re-checks it.
  "Every approval is bound to a hash of the exact payload. If an answer, your resume or other details change after I showed it, that application is refused by name and nothing is approved; I show you the current version to check and approve again. If it changes after you approved but before it is sent, it is not sent (it is marked \"not sent: the application changed after it was approved\") and you approve the new version.",
];

export function approvalRulesText(): string {
  return `How approval works:\n${APPROVAL_RULES.map((r) => `- ${r}`).join("\n")}`;
}

// A message that is only a request for help.
export function isHelpAsk(message: string): boolean {
  return /^\s*\/?(help|info|commands|what can you do\??)\s*[.!?]?\s*$/i.test(String(message ?? ""));
}

// A question about HOW approval works (not an order to send or approve): question-shaped, with an approval word and a
// send/apply word, or a change-after-approval question. A bare "yes" or "approve 2" never matches (those are code's).
export function isApprovalQuestion(message: string): boolean {
  const t = String(message ?? "").toLowerCase();
  if (t.trim().length < 12) return false;
  if (!/\?|^\s*(does|do|is|are|can|will|what|how|when|must|should|if)\b/.test(t)) return false;
  const approval = /\b(approv\w*|tap|card|confirm\w*|text (a )?yes|reply (with )?yes|a yes|my yes)\b/.test(t);
  const sends = /\b(send|sent|submit\w*|appl(y|ication|ications)|goes? out)\b/.test(t);
  const changes = /\b(chang\w*|edit\w*|update\w*)\b/.test(t) && /\b(after|before)\b/.test(t) && approval;
  return (approval && sends) || changes || /\bwithout (my )?approv\w*/.test(t);
}

export type CapView = { reply: string; intent: string; status: "completed" };

// The view for a turn the brain would have taken, or null when code's router should answer it. `unread`: the spend could
// not be read, so the same views carry SPEND_UNREAD_NOTE instead of the limit note.
export function capViewFor(message: string, o: { now: number; unread?: boolean }): CapView | null {
  const note = o.unread ? SPEND_UNREAD_NOTE : LIMIT_NOTE;
  if (isHelpAsk(message)) return { reply: `${CHANNEL_REPLIES.help}\n\nThese still work: ${STILL_WORKS}\n${note}`, intent: CAP_HELP_INTENT, status: "completed" };
  if (isApprovalQuestion(message)) return { reply: `${approvalRulesText()}\n\n${note}`, intent: CAP_APPROVAL_INTENT, status: "completed" };
  return null;
}

// The router had nothing for this turn: say so plainly instead of "I'm not sure which part".
export function capPausedView(o: { now: number; unread?: boolean }): CapView {
  const until = o.unread ? "I can check today's usage again" : capResetAt(o.now);
  return { reply: `AI answers are paused until ${until}; these still work: ${STILL_WORKS}`, intent: CAP_VIEW_INTENT, status: "completed" };
}
