// Item 6, S2 (VERIFICATION-15 item 6; FILE-RECORDS.md F-12; D-MN-2): the live F-12 People and messages File, served from one real
// outreach draft (career_outreach_drafts, OutreachStore), never from a model's words.
//
//   messageView       the draft as F-12 draws it: the recipient and whether the address is resolved, the exact text that would be
//                     sent (messageOf: subject, body and footer, byte for byte), the attachment ("None": the send rail sends text only),
//                     and where it stands. It reads "Not sent" until the draft's own row says sent.
//   messageRecords    the S0 hook (file_family_serve.ts FamilyRecords) for F-12: load reads the draft the File names (ref.draft_id) on
//                     every GET; Approve send is served as a POST form with the page token, the draft id and the payload hash the page
//                     showed (fields msg, h). A File is made with createFamily(userId, "F-12", title, null, { ref: { draft_id } }).
//   approveSendPost   the POST: the draft is read again, re-hashed from its stored text, and approved only if that hash is the one the
//                     page showed and the one stored (a stale page is refused with the reason, nothing changes). The approval binds that
//                     hash (approved_hash) and hands exactly that draft to the send rail (queueApprovedOutreach re-reads and re-hashes
//                     it again). Nothing is sent here: the rail's worker sends later, and this page says Sent only from the draft's row.
// The rail is injected. Tests pass a recording outbox (no worker, no Gmail): nothing is ever sent from a test.
import { automatedInbox } from "./automated_inbox.ts";
import { blockedAddresses, messageOf, type OutreachDraft, type OutreachStore, payloadHash, supabaseOutreachStore } from "./career_outreach.ts";
import { type OutreachDeps, queueApprovedOutreach } from "./career_send_rail.ts";
import type { Act } from "./file_family.ts";
import type { MessageReview } from "./file_family_apply.ts";
import type { FamilyRec, FamilyRecords } from "./file_family_serve.ts";

export type MessageStore = Pick<OutreachStore, "update" | "blocked" | "dnc"> & Required<Pick<OutreachStore, "drafts">>;
export interface MessageDeps { store: MessageStore; rail: OutreachDeps | null }

const ADDR = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,24}$/;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const day = (iso: string | null) => iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null;

// Where the draft stands, from its own row only. "Not sent" until the row says sent with the provider's message id.
export function sendState(d: OutreachDraft): { sent: boolean; boundary: string; off: string | null } {
  if (d.status === "sent" && d.gmail_id) return { sent: true, boundary: `Sent ${day(d.sent_at) ?? ""}`.trim(), off: "Already sent. It is never sent twice." };
  if (d.status === "approved") return { sent: false, boundary: "Approved - not sent yet", off: "Approved and queued to send from your account. It is not sent yet." };
  if (d.status === "sending" || d.status === "sent") return { sent: false, boundary: "Sending - not confirmed", off: "It is being sent. It is not confirmed sent yet." };
  if (d.status === "shown") return { sent: false, boundary: "Not sent", off: null };
  return { sent: false, boundary: `Not sent - ${d.status}${d.result ? ` (${d.result})` : ""}`, off: "This message will not be sent. Ask Trainee in the chat for a new draft." };
}

export async function messageView(d: OutreachDraft): Promise<MessageReview> {
  const m = messageOf(d), hash = await payloadHash(m), st = sendState(d);
  const auto = automatedInbox(m.to, d.recipient.firm);
  const resolved = ADDR.test(m.to) && !auto;
  const basis = [d.recipient.title, d.recipient.firm].filter(Boolean).join(", ") + (d.recipient.address === "inferred" ? ". The address was inferred from the company's pattern, not published." : d.recipient.address === "published" ? ". The address was published by them." : ".");
  const approve: Act = { label: "Approve send", effect: "send", post: { token: "", action: "approvesend", fields: { msg: d.id, h: hash } }, ...(st.off ? { off: st.off } : {}),
    ...(hash !== d.hash ? { off: "These words changed after the draft was made. Ask Trainee in the chat to show it again." } : {}) };
  return {
    kind: d.n > 1 ? "Follow-up email" : "Email", recipient: { initials: initials(d.recipient.name), name: d.recipient.name, basis: basis.replace(/^\. /, ""), resolved, relation: null },
    to: resolved ? m.to : null, words: `Subject: ${m.subject}\n\n${m.text}`, channel: "email", attachments: "None (the send rail sends text only)",
    followUp: "None without its own approval", approve, boundary: st.boundary,
    acts: { secondary: [{ label: "Change the words", effect: "decide", href: "?edit=1" }] },
  };
}

// The F-12 FamilyRecords (the S0 hook): the view is the draft's own row, read now; null when it can't be read (the C.24 error page).
export function messageRecords(o: MessageDeps): FamilyRecords {
  const draftOf = async (u: string, rec: FamilyRec) => { const id = rec.data.ref?.draft_id ?? ""; return id ? (await o.store.drafts(u, [id]))[0] ?? null : null; };
  return {
    async load(u, rec) { const d = await draftOf(u, rec); return d && d.id === rec.data.ref?.draft_id ? { view: await messageView(d), asOf: d.sent_at ?? d.approved_at ?? d.created_at ?? null } : null; },
    post: {
      async approvesend(u, rec, fields, now) {
        const id = rec.data.ref?.draft_id ?? "";
        if (!id || (fields.get("msg") ?? "") !== id) return { ok: false, title: "Not done", lines: ["That approval is not for the message on this File.", NOTHING] };
        const r = await approveSendPost(o, u, id, fields.get("h") ?? "", now);
        return { ok: r.ok, title: r.title, lines: r.lines };
      },
    },
  };
}
// The deployed store, with drafts() (supabaseOutreachStore always has it).
export const outreachDrafts = (admin: unknown) => supabaseOutreachStore(admin) as MessageStore;

export type SendResult = { ok: true; title: string; lines: string[] } | { ok: false; status: number; why: "not_found" | "stale" | "not_waiting" | "blocked" | "off" | "refused"; title: string; lines: string[] };
const NOTHING = "Nothing was approved or sent.";
// The POST "approvesend": fields msg (the draft id the record names) and h (the payload hash the page showed).
export async function approveSendPost(o: MessageDeps, userId: string, draftId: string, postedHash: string, now: number): Promise<SendResult> {
  const no = (status: number, why: Extract<SendResult, { ok: false }>["why"], title: string, ...lines: string[]): SendResult => ({ ok: false, status, why, title, lines: [...lines, NOTHING] });
  if (!o.rail) return no(503, "off", "Sending isn't switched on", "Sending from your account isn't switched on yet.");
  const [d] = await o.store.drafts(userId, [draftId]).catch(() => []);
  if (!d || d.id !== draftId) return no(404, "not_found", "This message isn't here", "It is not one of your drafts any more.");
  const h = await payloadHash(messageOf(d));
  // D-MN-2: the yes approves exactly the words the page showed. A page drawn before the words changed carries the old hash.
  if (!/^[0-9a-f]{64}$/.test(postedHash) || postedHash !== h || d.hash !== h) {
    return no(409, "stale", "This page showed an older version", "The words of this message changed after this page was drawn, so this approval was for words that will not be sent. Open the File again to see the current words and approve those.");
  }
  if (d.status !== "shown") return no(409, "not_waiting", "Already decided", sendState(d).off ?? "This message is not waiting for approval.");
  if (automatedInbox(d.recipient.email, d.recipient.firm)) return no(400, "blocked", "Not a person's address", "That address is an automated or shared inbox, not a person.");
  const stopped = await blockedAddresses(o.store as OutreachStore, userId, [d.recipient.email]).catch(() => null);
  if (!stopped) return no(503, "refused", "Couldn't check the address", "Try again in a minute.");
  if (stopped.size) return no(403, "blocked", "This person can't be emailed", "They asked not to be contacted, or the address bounced before.");
  const at = new Date(now).toISOString();
  if (!(await o.store.update(userId, { ...d, status: "approved", approved_hash: h, approved_at: at }, { status: "shown", hash: h }))) {
    return no(409, "stale", "This page showed an older version", "The message changed while you were approving it. Open the File again to see the current words.");
  }
  const [q] = await queueApprovedOutreach(o.rail, userId, [{ draftId: d.id, approvalHash: h }]).catch(() => [undefined]);
  if (q?.status !== "queued" && q?.status !== "already_queued") {
    await o.store.update(userId, { ...d, status: "shown", approved_hash: null, approved_at: null }, { status: "approved" });
    return no(503, "refused", "Not queued", `The send rail did not take it (${q?.reason ?? "no answer"}).`);
  }
  return { ok: true, title: "Approved - not sent yet", lines: [`Approved exactly as shown, to ${messageOf(d).to}. It is queued to send from your account and is not sent yet.`, "This File will say Sent once your account has sent it."] };
}
