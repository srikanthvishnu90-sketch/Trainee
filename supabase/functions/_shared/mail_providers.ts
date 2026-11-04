// M4 (2026-10-27): one send rail, two providers. Every approved email (outreach, an application sent by email (APL-12), a
// follow-up, any email the person asked Trainee to write) goes through mailRail().send, which dispatches by the person's
// connected provider: Gmail (the career Google grant with gmail.send) or Outlook (the microsoft grant with Mail.Send).
// The interface is documented in docs/architect/MAIL-PROVIDERS-2026-10-27.md; M1's Gmail rail adopts it (Request).
//   - code enforces the approval: the request carries the hash the person approved, and a message whose recipient, subject
//     or text differs from it is CHANGED and never sent (D-MN-2);
//   - exactly once per (person, idemKey): Outlook keeps its own ledger (career_outlook_sends); Gmail's caller keeps its own
//     (M1's claim), and the rail passes the key through;
//   - one recipient, no Cc/Bcc, no header break: each provider refuses rather than cleans;
//   - no volume limit: a provider's refusal (429 / quota) is RATE_LIMITED with the provider's own wait.
// deno-lint-ignore-file no-explicit-any
import type { OutMail, Purpose, SendStatus } from "./outlook_graph.ts";
import { hasScope, sha256Hex } from "./outlook_graph.ts";
import { sendMail as gmailSend } from "./career_mail_gmail.ts";

export type MailProviderId = "gmail" | "outlook";
export interface SendRequest {
  userId: string;
  mail: OutMail; // to, subject, text, optional attachment (applications)
  idemKey: string; // stable per approved message (e.g. "outreach:<draft id>", "apply:<job id>")
  purpose: Purpose;
  approvedHash: string; // approvalHashOf(mail) at the moment the person said yes
  provider?: MailProviderId | null; // the person's choice for this message; else their connected one
}
export type MailSendResult = (SendStatus & { provider?: MailProviderId }) | { status: "NO_PROVIDER"; reason: string };
export interface MailProvider {
  id: MailProviderId;
  send(userId: string, mail: OutMail, o: { idemKey: string; purpose: Purpose }): Promise<SendStatus>;
}
// The same shape as the outreach rail's payloadHash (sha256 of JSON [to, subject, text]), so a hash approved on a card or
// a batch verifies here unchanged.
export const approvalHashOf = (m: Pick<OutMail, "to" | "subject" | "text">) => sha256Hex(JSON.stringify([m.to, m.subject, m.text]));

// Which provider can send for this person: both are read from user_oauth_connections (and Outlook's needs_reconnect).
// When both can, the one connected most recently wins, unless the request names one.
export async function sendProviders(admin: any, userId: string): Promise<{ id: MailProviderId; connected_at: string }[]> {
  const { data, error } = await admin.from("user_oauth_connections").select("provider,scopes,connected_at").eq("user_id", userId).in("provider", ["google_career", "microsoft"]);
  if (error) throw new Error(`read the mail connections: ${error.message}`);
  const out: { id: MailProviderId; connected_at: string }[] = [];
  for (const r of data ?? []) {
    if (r.provider === "google_career" && hasScope(r.scopes, "https://www.googleapis.com/auth/gmail.send")) out.push({ id: "gmail", connected_at: String(r.connected_at ?? "") });
    if (r.provider === "microsoft" && hasScope(r.scopes, "Mail.Send")) {
      const st = await admin.from("career_outlook_state").select("needs_reconnect_at").eq("user_id", userId).maybeSingle();
      if (!st.error && !st.data?.needs_reconnect_at) out.push({ id: "outlook", connected_at: String(r.connected_at ?? "") });
    }
  }
  return out.sort((a, b) => b.connected_at.localeCompare(a.connected_at));
}

export function mailRail(o: { providers: Partial<Record<MailProviderId, MailProvider>>; which: (userId: string) => Promise<{ id: MailProviderId }[]> }) {
  return {
    async send(req: SendRequest): Promise<MailSendResult> {
      if (await approvalHashOf(req.mail) !== req.approvedHash) return { status: "CHANGED", detail: "the message changed after it was approved" };
      const can = await o.which(req.userId);
      const pick = req.provider ? can.find((c) => c.id === req.provider) : can[0];
      if (!pick) return { status: "NO_PROVIDER", reason: req.provider ? `${req.provider} is not connected for sending` : "no Gmail or Outlook connected for sending" };
      const p = o.providers[pick.id];
      if (!p) return { status: "NO_PROVIDER", reason: `${pick.id} sending is not available` };
      const r = await p.send(req.userId, req.mail, { idemKey: req.idemKey, purpose: req.purpose });
      return { ...r, provider: pick.id } as MailSendResult;
    },
  };
}

// The outreach rail's Sender (career_outreach.ts: send(userId, {to, subject, text}) -> sent{id, thread_id} | NOT_WIRED |
// ERROR | RATE_LIMITED), over this rail, so runOutreachSends can send through Outlook with no change to it. The key is the
// approved payload's hash: the same message to the same person goes once.
export function outreachSenderOf(rail: ReturnType<typeof mailRail>) {
  return {
    async send(userId: string, m: { to: string; subject: string; text: string }) {
      const approvedHash = await approvalHashOf(m);
      const r = await rail.send({ userId, mail: m, idemKey: `outreach:${approvedHash}`, purpose: "outreach", approvedHash });
      if (r.status === "sent") return { status: "sent" as const, id: r.id ?? `outlook:${approvedHash.slice(0, 16)}`, thread_id: r.thread_id ?? "" };
      if (r.status === "already_sent") return { status: "sent" as const, id: `outlook:${approvedHash.slice(0, 16)}`, thread_id: "" };
      if (r.status === "NOT_WIRED" || r.status === "NO_PROVIDER" || r.status === "NEEDS_RECONNECT") return { status: "NOT_WIRED" as const, reason: (r as any).reason };
      if (r.status === "RATE_LIMITED") return { status: "RATE_LIMITED" as const, detail: `retry after ${r.retryAfterMs} ms` };
      return { status: "ERROR" as const, detail: (r as any).detail ?? r.status };
    },
  };
}

// Gmail as a MailProvider over the existing one-recipient sender (career_mail_gmail.ts sendMail; token = the career grant
// with gmail.send). Gmail has no idempotency ledger here: the caller's claim is the exactly-once (M1's rail), as today.
export function gmailProvider(d: { fetch: typeof fetch; token: (userId: string) => Promise<string | null> }): MailProvider {
  return {
    id: "gmail",
    async send(userId, mail) {
      const r = await gmailSend(d, userId, { to: mail.to, subject: mail.subject, body: mail.text, attachment: mail.attachment ?? null });
      if (r.status === "sent") return { status: "sent", provider: "gmail", id: r.idHash, thread_id: null } as unknown as SendStatus;
      return r as unknown as SendStatus;
    },
  };
}
export function outlookProvider(rails: { sendMail(userId: string, m: OutMail, o: { idemKey: string; purpose: Purpose }): Promise<SendStatus> }): MailProvider {
  return { id: "outlook", send: (u, m, o) => rails.sendMail(u, m, o) };
}
