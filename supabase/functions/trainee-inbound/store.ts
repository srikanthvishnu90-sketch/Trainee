// The inbound store over Supabase (WO-013b-2; every channel since WO-038): channel_inbound (message ids claimed per
// provider), channel_contacts (a person's contacts, one per channel, sharing one thread; STOPs and closed-signup refusals
// kept by contact), career_outbox (the reply, bound to the channel it answers), and the linking functions of
// 20261021070000_channel_parity.sql.
import { type InboundStore, type Person, PhoneTakenError } from "../_shared/channel_inbound.ts";

const iso = (t: number) => new Date(t).toISOString();
const duplicate = (e: { code?: string; message: string } | null) => !!e && (e.code === "23505" || /duplicate key/i.test(e.message));
function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

// The undeliverable sign-up address of a contact with no email or phone (a Telegram chat, a WhatsApp username).
export function channelOnlyEmail(contact: string): string {
  const m = /^(tg|wa):([A-Za-z0-9._-]{1,128})$/.exec(contact);
  if (!m) throw new Error("not a channel-only contact");
  return `${m[1] === "tg" ? "tg" : "wa"}-${m[2].toLowerCase().replace(/[^a-z0-9-]/g, "-")}@users.trainee.invalid`;
}
// deno-lint-ignore no-explicit-any
export function supabaseInboundStore(admin: any): InboundStore {
  return {
    async claimMessage(id, at, provider) {
      const r = await admin.from("channel_inbound").insert({ provider_message_id: id, received_at: iso(at), ...(provider && provider !== "loopmessage" ? { provider } : {}) });
      if (duplicate(r.error)) return false;
      must(r, "claim the inbound message");
      return true;
    },
    async person(contact) {
      // A WhatsApp sender may be known by its other id (the alias); both values are quoted for PostgREST (ids carry dots).
      const by = contact.startsWith("wa:") && /^wa:[A-Za-z0-9._-]{1,128}$/.test(contact) ? `contact.eq."${contact}",alias.eq."${contact.slice(3)}"` : null;
      const q = admin.from("channel_contacts").select("contact,user_id,thread_id,alias");
      const rows = must<any[]>(await (by ? q.or(by) : q.eq("contact", contact)).limit(2), "read the contact") || [];
      const r = rows.find((x) => x.user_id && x.contact === contact) ?? rows.find((x) => x.user_id) ?? null;
      return r ? { userId: r.user_id, threadId: r.thread_id ?? null, contact: r.contact, alias: r.alias ?? null } : null;
    },
    async refusedBefore(contact, at) {
      // IDENTITY SCENARIOS (2026-10-30): the refusal itself is recorded (refused_at, 20261030120000_channel_identity.sql); a
      // row some other step left (an unlinked chat, a question never answered) is not a refusal already said.
      return must<boolean>(await admin.rpc("channel_refused_before", { p_contact: contact, p_at: iso(at) }), "record the refusal") === true;
    },
    async createPerson(contact, at, phone): Promise<Person> {
      // An account with the number when the platform gives one (iMessage, WhatsApp), the email for an iMessage email, and
      // neither for Telegram or a WhatsApp username: whether Supabase accepts an account with neither is UNKNOWN (WO-038
      // doc; the owner's smoke run checks it), and a refusal is said to the person once, like any failure here.
      // FEATURE 16 (launch audit 2026-10-26): Supabase Auth refuses a user with neither an email nor a phone, so a Telegram
      // chat (which never gives a number) or a WhatsApp username got no account at all. Such a person gets a synthetic,
      // unique, undeliverable address under the reserved .invalid TLD (RFC 2606), confirmed, with no password, marked
      // channel-only: nothing ever sends to it (Trainee's mail goes from the person's own Gmail grant, never to the auth
      // email), and nobody can sign in with it. One chat, one address: a retry finds the same account (channel_contacts).
      const tel = contact.startsWith("+") ? contact : phone ?? null;
      const channel = contact.startsWith("tg:") ? "telegram" : "whatsapp";
      const created = await admin.auth.admin.createUser(contact.includes("@") && !contact.startsWith("wa:") ? { email: contact, email_confirm: true }
        : tel ? { phone: tel.slice(1), phone_confirm: true }
        : { email: channelOnlyEmail(contact), email_confirm: true, user_metadata: { trainee_channel: channel, channel_only: true }, app_metadata: { channel_only: true } });
      // Review of PR #194: a Telegram chat whose channel-only account already exists (it signed up, was linked to a web
      // account, then unlinked) gets that account back, never a second sign-up (Auth refuses the taken address).
      if (created.error && contact.startsWith("tg:")) {
        const back = await admin.rpc("channel_telegram_reattach_as", { p_contact: contact, p_now: iso(at) });
        if (!back.error && typeof back.data === "string" && back.data) return { userId: back.data, threadId: null, contact };
      }
      // IDENTITY SCENARIOS (2026-10-30): Auth keeps one account per phone (GoTrue phone_exists, 422). The number is another
      // account's sign-in phone: said as such (channel_inbound.ts), never "I couldn't answer that" on every message.
      if (created.error && tel && /phone_exists|phone number already registered/i.test(`${(created.error as { code?: string }).code ?? ""} ${created.error.message ?? ""}`)) throw new PhoneTakenError();
      if (created.error || !created.data?.user?.id) throw new Error(`create an account for a new contact: ${created.error?.message ?? "no user returned"}`);
      const userId = created.data.user.id as string;
      // A Telegram contact keeps the number it signed up with (the person's own share, verified by Telegram), so the same
      // number on iMessage or WhatsApp later asks this chat instead of signing up a second time.
      must(await admin.from("channel_contacts").upsert({ contact, user_id: userId, updated_at: iso(at), ...(phone && (contact.startsWith("wa:") || contact.startsWith("tg:")) ? { phone } : {}) }, { onConflict: "contact" }), "link the contact");
      return { userId, threadId: null, contact };
    },
    async setThread(contact, threadId, userId) {
      // One thread per person: every channel's contact shares it.
      must(await (userId ? admin.from("channel_contacts").update({ thread_id: threadId }).eq("user_id", userId) : admin.from("channel_contacts").update({ thread_id: threadId }).eq("contact", contact)), "save the texting thread");
    },
    async setOptOut(contact, out, at) {
      must(await admin.rpc("channel_set_opt_out", { p_contact: contact, p_out: out, p_at: iso(at) }), "save opt-out");
    },
    async enqueueReply(userId, key, text, at, channel, part, cardId) {
      const r = await admin.from("career_outbox").insert({ user_id: userId, key, kind: "reply", text, deliver_at: iso(at), ...(channel ? { channel } : {}),
        ...(part ? { part_of: part.of, part: part.n } : {}), ...(cardId ? { card_id: cardId } : {}) });
      if (duplicate(r.error)) return false;
      must(r, "queue the reply");
      return true;
    },
    async sawInbound(contact, at, o) {
      must(await admin.rpc("channel_inbound_seen", { p_contact: contact, p_at: iso(at), p_alias: o.alias ?? null, p_phone: o.phone ?? null }), "record the message time");
    },
    async linkCandidate(phone, except) {
      // IDENTITY SCENARIOS (2026-10-30): channel_link_candidate_of (20261030120000) also returns a stopped account, marked.
      const rows = must<any[]>(await admin.rpc("channel_link_candidate_of", { p_phone: phone, p_except: except }), "look for the same number") || [];
      return rows[0]?.user_id ? { userId: rows[0].user_id, contact: rows[0].contact, optedOut: rows[0].opted_out === true } : null;
    },
    async pendingLink(contact, at) {
      const r = must<string | null>(await admin.rpc("channel_link_pending", { p_contact: contact, p_now: iso(at) }), "read the open question");
      return typeof r === "string" && r ? r : null;
    },
    async askToLink(a) {
      return must<string | null>(await admin.rpc("channel_link_ask", { p_user: a.userId, p_contact: a.contact, p_phone: a.phone, p_asked_on: a.askedOn, p_text: a.text, p_now: iso(a.at) }), "ask to link") ?? null;
    },
    async confirmLink(a) {
      const r = must<any>(await admin.rpc("channel_link_confirm", { p_user: a.userId, p_asked_on: a.askedOn, p_notice: a.notice, p_now: iso(a.at) }), "link the contact");
      if (r?.error === "ambiguous") return { ambiguous: true as const }; // TELEGRAM LINK OWNERSHIP: two chats asked; neither linked
      return r && typeof r.contact === "string" ? { contact: r.contact, key: typeof r.key === "string" ? r.key : null } : null;
    },
    async issueLinkNonce(userId, at) {
      const n = must<string>(await admin.rpc("channel_link_nonce_issue", { p_user: userId, p_now: iso(at) }), "make a link");
      if (typeof n !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(n)) throw new Error("make a link: no link returned");
      return n;
    },
    // TELEGRAM LINK OWNERSHIP (2026-10-31): 20261031040000_telegram_link_confirm.sql. Opening a code asks the account's own
    // channel (the question queued under key); only a chat already the account's comes back linked.
    async redeemLinkNonce(nonce, contact, at, askText) {
      const r = must<any>(await admin.rpc("channel_link_nonce_ask", { p_nonce: nonce, p_contact: contact, p_text: askText, p_now: iso(at) }), "use a link");
      if (r?.asked === true && typeof r.user_id === "string" && typeof r.key === "string") return { ok: false, why: "asked", userId: r.user_id, key: r.key };
      if (r?.linked === true && typeof r.user_id === "string") return { ok: true, userId: r.user_id, threadId: r.thread_id ?? null };
      return { ok: false, why: r?.error === "linked_elsewhere" ? "linked_elsewhere" : r?.error === "no_channel" || r?.error === "stopped" ? "cant_ask" : "invalid" };
    },
    async pendingCodeLink(contact, at) {
      return must<boolean>(await admin.rpc("channel_link_code_pending", { p_contact: contact, p_now: iso(at) }), "read the link question") === true;
    },
    async unlinkTelegram(userId, at) {
      return Number(must<number>(await admin.rpc("channel_telegram_unlink_as", { p_user: userId, p_now: iso(at) }), "unlink Telegram")) || 0;
    },
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): 20261030100000_channel_delivery_r2.sql.
    async failSent(providerMessageId, at, error, retry) {
      return Number(must<number>(await admin.rpc("career_outbox_fail_sent", { p_provider_id: providerMessageId, p_at: iso(at), p_error: error, p_retry: retry }), "record a failed message")) || 0;
    },
    async releaseContact(contact, at) {
      must(await admin.rpc("channel_contact_release", { p_contact: contact, p_at: iso(at) }), "let a number go");
    },
    async movedNumber(from, to, at) {
      return must<boolean>(await admin.rpc("channel_wa_number_moved", { p_old: from, p_new: to, p_at: iso(at) }), "move a number") === true;
    },
    async reholdSent(providerMessageId, at, error) {
      return Number(must<number>(await admin.rpc("career_outbox_rehold", { p_provider_id: providerMessageId, p_at: iso(at), p_error: error }), "hold a failed message")) || 0;
    },
  };
}
