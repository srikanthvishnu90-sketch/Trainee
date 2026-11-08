// R9-G (e2e E18): one message that asks for an application AND an email to someone there ("apply to the Data Analyst role
// at Stripe and email Maya there about it"). Each half goes to the turn that owns it, unchanged: the apply half to the apply
// turn (career_apply_chat.ts applyTurn: queued, prepared, one card, the person's yes to that exact payload), the email half
// to the networking turn (career_networking.ts networkingTurn: a draft to a person in their own contacts, its own approval
// by number). Nothing is guessed: "there" is the employer the apply half names, in the same message, and "about it" is that
// role; a message where either half does not read that way is not this ask.
const CO = "([A-Z][A-Za-z0-9&.'’-]*(?:\\s+(?!and\\b|then\\b)[A-Z][A-Za-z0-9&.'’-]*)*)";
const SPLIT = new RegExp(
  `^(.*?\\bapply\\s+(?:me\\s+)?(?:to|for)\\s+(?:the\\s+|that\\s+)?(.+?)\\s+(?:role|position|job|internship|opening)\\s+at\\s+${CO})` +
    `\\s*,?\\s+(?:and|then|and then|plus)\\s+((?:e-?mail|message|write to|reach out to|contact)\\s+.+?)\\s*[.!]?$`,
  "i",
);

export interface ApplyAndReach { apply: string; outreach: string; company: string; role: string }

export function applyAndReachOf(message: string): ApplyAndReach | null {
  const raw = String(message ?? "").trim();
  if (!raw || /\?\s*$/.test(raw) || /\b(?:don'?t|do not|never|wouldn'?t)\b/i.test(raw)) return null;
  const m = SPLIT.exec(raw);
  if (!m) return null;
  const role = m[2].trim(), company = m[3].trim();
  let reach = m[4].trim();
  // "there" / "at that company" / "at the same place": the employer named in the apply half.
  const there = /\s+(?:there|at\s+(?:that|the\s+same)\s+(?:company|place|firm|employer))\b/i;
  if (there.test(reach)) reach = reach.replace(there, ` at ${company}`);
  // The email half must name its employer by now, as the networking turn reads it ("email Maya at Stripe ...").
  if (!new RegExp(`\\bat\\s+${company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(reach)) return null;
  // "about it" / "about the role" / "about that": the role the apply half names.
  reach = reach.replace(/\babout\s+(?:it|that|this|the\s+(?:role|job|application|position))\b/i, `about the ${role} role`);
  return { apply: m[1].trim(), outreach: reach, company, role };
}

// After that application's card is answered: whether this thread still holds the email half's drafts, shown by the same
// message (its reply carried meta.compound_outreach) within the drafts' 3 days, and not yet answered. Then the drafts are
// shown again through the outreach turn's own "show drafts" (unchanged, exactly as drafted). Their approval stays their
// own: nothing here approves, sends or changes a draft.
const BATCH_TTL_MS = 3 * 24 * 3600_000;
export async function compoundOutreachAgain(o: {
  admin: { from(t: string): any }; threadId: string; now: number;
  // Whether a draft of the person's newest batch, shown in this thread, still waits for their answer.
  waiting: () => Promise<boolean>;
  show: () => Promise<{ reply: string; status: string; intent: string; parts?: string[] } | null>;
}): Promise<{ reply: string; status: string; intent: string; parts?: string[] } | null> {
  const r = await o.admin.from("agent_messages").select("id,meta,created_at").eq("thread_id", o.threadId).eq("role", "assistant")
    .order("id", { ascending: false }).limit(40);
  if (r.error || !Array.isArray(r.data)) return null;
  const rows = r.data as { id: number; meta: any; created_at: string }[];
  const at = rows.findIndex((m) => m?.meta?.compound_outreach === true);
  if (at < 0 || Date.parse(rows[at].created_at) < o.now - BATCH_TTL_MS) return null;
  // Once the drafts were shown again or answered after it (a later outreach reply), they are not shown a second time.
  if (rows.slice(0, at).some((m) => /^career_outreach_/.test(String(m?.meta?.intent ?? "")))) return null;
  if (!await o.waiting()) return null;
  const shown = await o.show();
  return shown && /^shown/.test(shown.status) ? shown : null;
}

// R9-G (e2e E09): "tailor my resume for the <role> role at <Co> and apply with it": the tailor half goes to the router's
// tailor (the truth-checked tailored resume, returned as its file), the apply half to the apply turn for the same role at
// the same employer (queued, prepared, one card, the person's yes to that exact payload). The card shows exactly which
// resume file the application sends.
const TAILOR_THEN_APPLY = new RegExp(
  `^(?:(?:please|pls|can you|could you)\\s+)?((?:tailor|customi[sz]e)\\s+my\\s+(?:resume|cv|résumé)\\s+(?:for|to)\\s+(?:the\\s+|that\\s+)?(.+?)\\s+(role|position|job|internship|opening)\\s+at\\s+${CO})` +
    `\\s*,?\\s+(?:and|then|and then)\\s+(?:then\\s+)?apply(?:\\s+(?:me\\s+)?(?:with|using)\\s+(?:it|that|this|that one|the tailored (?:one|resume|version)))?(?:\\s+(?:to|for)\\s+(?:it|that|the role|that role|the job))?(?:\\s+please)?\\s*[.!]?$`,
  "i",
);
export interface TailorAndApply { tailor: string; apply: string; company: string; role: string }
export function tailorAndApplyOf(message: string): TailorAndApply | null {
  const raw = String(message ?? "").trim();
  if (!raw || /\?\s*$/.test(raw)) return null;
  const m = TAILOR_THEN_APPLY.exec(raw);
  if (!m) return null;
  const role = m[2].trim(), noun = m[3].toLowerCase(), company = m[4].trim();
  return { tailor: m[1].trim(), apply: `apply to the ${role} ${noun} at ${company}`, company, role };
}
