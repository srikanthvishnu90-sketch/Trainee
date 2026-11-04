// The texting channel's store over Supabase (WO-013b-1): the ChannelStore of channel.ts over career_outbox and
// channel_contacts (supabase/migrations/20261019020001_channel_delivery.sql). due() claims rows, so two overlapping runs
// never send the same one; release() puts back what a run claimed and did not finish (a capped row); sweep() fails a row
// a dead run left "sending", never resending it (the provider may already have it: at most once beats twice).
// WO-038 (20261021070000_channel_parity.sql): the claim resolves each row's channel (its own, or the person's home
// channel); a WhatsApp row carries the window's times; "held" rows wait for the person's next message; STOP is the
// person's across channels.
import type { ChannelStore, DeliveryMark, OutboxRow } from "./channel.ts";
import type { Channel } from "./channel_adapters.ts";
import { alertStillWanted } from "./career_watch_alerts.ts";
import { buttonsForRows } from "./channel_card_tap.ts"; // FEATURE 16

export const SENDING_TIMEOUT_MS = 10 * 60000; // longer than any run can last (a function's wall clock is shorter)
export const UNKNOWN_OUTCOME = "delivery outcome unknown: the run stopped before recording it; not resent";
const DAY_MS = 86400000;
const dayRange = (day: string) => { const t = Date.parse(`${day}T00:00:00Z`); return [new Date(t).toISOString(), new Date(t + DAY_MS).toISOString()]; };
const iso = (t: number) => new Date(t).toISOString();
const ms = (v: unknown) => (typeof v === "string" && v ? Date.parse(v) : null);
function must<T>(r: { data: T | null; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data as T;
}

export type DeliveryStore = ChannelStore & { release(): Promise<number>; sweep(now: number): Promise<number> };

// `only` narrows the store to one row (a reply sent the moment it is written); `user` to everything due for one person
// (a WhatsApp message: what waited for the window goes out first, then the answer). The rules are the same.
// deno-lint-ignore no-explicit-any
export function supabaseChannelStore(admin: any, o: { only?: { userId: string; key: string }; user?: string } = {}): DeliveryStore {
  const claimed = new Map<string, { prior: string; attempts: number }>();
  return {
    async due(now, limit) {
      const claim = o.only ? admin.rpc("career_outbox_claim_key", { p_user: o.only.userId, p_key: o.only.key, p_now: iso(now) })
        : o.user ? admin.rpc("career_outbox_claim_user", { p_user: o.user, p_now: iso(now), p_limit: limit })
        : admin.rpc("career_outbox_claim", { p_now: iso(now), p_limit: limit });
      const rows = must<any[]>(await claim, "claim due messages") || [];
      const out: OutboxRow[] = rows.map((r) => ({ id: String(r.id), userId: r.user_id, contact: r.contact, key: r.key, text: r.text, deliver_at: Date.parse(r.deliver_at), attempts: r.attempts }));
      for (const r of rows) claimed.set(String(r.id), { prior: r.prior_status, attempts: r.attempts });
      // A WhatsApp row needs the person's last message there (the 24-hour window) and the last nudge.
      const wa = [...new Set(out.filter((r) => String(r.contact).startsWith("wa:")).map((r) => r.contact))];
      if (wa.length) {
        const seen = must<any[]>(await admin.from("channel_contacts").select("contact,last_inbound_at,nudged_at").in("contact", wa), "read the WhatsApp window") || [];
        const by = new Map(seen.map((s) => [s.contact, s]));
        for (const r of out) if (by.has(r.contact)) { const s = by.get(r.contact); r.lastInboundAt = ms(s.last_inbound_at); r.nudgedAt = ms(s.nudged_at); }
        for (const r of out) if (String(r.contact).startsWith("wa:") && r.lastInboundAt === undefined) { r.lastInboundAt = null; r.nudgedAt = null; }
      }
      // FEATURE 16: a Telegram row that carries an open card goes out with the card's Approve and Decline buttons, bound
      // to that card and its items' hashes (channel_card_tap.ts). A read that fails sends the text without them: the
      // card can still be answered by a reply to it, or in the app.
      const tg = out.filter((r) => String(r.contact).startsWith("tg:")).map((r) => r.id);
      if (tg.length) {
        try {
          const buttons = await buttonsForRows(admin, tg);
          for (const r of out) if (buttons.has(r.id)) r.buttons = buttons.get(r.id)!;
        } catch (e) { console.error("deliver: the card's buttons could not be read:", e instanceof Error ? e.message : String(e)); }
      }
      return out.sort((a, b) => a.deliver_at - b.deliver_at || Number(a.id) - Number(b.id));
    },
    async optedOut(contact) {
      return must<boolean>(await admin.rpc("channel_opted_out", { p_contact: contact }), "read opt-out") === true;
    },
    // CHANNEL DELIVERY SCENARIOS (2026-10-29): the time of the person's STOP, read as channel_opted_out reads the STOP itself
    // (this contact, or any contact of the account it belongs to).
    async optedOutAt(contact) {
      const own = must<any>(await admin.from("channel_contacts").select("user_id,opted_out,opted_out_at").eq("contact", contact).maybeSingle(), "read the opt-out time");
      const rows: any[] = own?.user_id
        ? must<any[]>(await admin.from("channel_contacts").select("opted_out,opted_out_at").eq("user_id", own.user_id).eq("opted_out", true), "read the opt-out time") || []
        : own ? [own] : [];
      const at = rows.filter((r) => r.opted_out === true && r.opted_out_at).map((r) => Date.parse(r.opted_out_at)).filter(Number.isFinite);
      return at.length ? Math.max(...at) : null;
    },
    // WO-091c: paused, opted out or erased (career_user_quiet, 20261022120000_career_control_state.sql).
    async quiet(userId) {
      return must<boolean>(await admin.rpc("career_user_quiet", { p_user: userId }), "read the pause") === true;
    },
    // A queued job alert or report, checked at delivery against the person's alert settings, the watch record behind them
    // (career_watch_kv) and the posting (career_postings). A read that fails throws: the row waits, never sent on a guess.
    async alertWanted(m) {
      const prefs = must<any>(await admin.from("career_alert_prefs").select("prefs").eq("user_id", m.userId).maybeSingle(), "read alert settings");
      const record = prefs?.prefs?.interests?.length
        ? must<any>(await admin.from("career_watch_kv").select("value").eq("user_id", m.userId).eq("key", `career:watch-profile:${m.userId}`).maybeSingle(), "read the watch record")?.value ?? null
        : null;
      const posting = m.key.startsWith("alert:")
        ? must<any>(await admin.from("career_postings").select("*").eq("job_id", m.key.slice("alert:".length)).maybeSingle(), "read the posting")
        : null;
      return alertStillWanted(m.key, { row: prefs ? { prefs: prefs.prefs } : null, record, posting });
    },
    async setOptOut(contact, out, at) {
      must(await admin.rpc("channel_set_opt_out", { p_contact: contact, p_out: out, p_at: iso(at) }), "save opt-out");
    },
    async contactsSentOn(day, channel?: Channel) {
      const r = channel ? await admin.rpc("career_outbox_contacts_on_channel", { p_day: day, p_channel: channel }) : await admin.rpc("career_outbox_contacts_on", { p_day: day });
      return Number(must<number>(r, "count today's contacts")) || 0;
    },
    async sentTo(contact, day) {
      const [from, to] = dayRange(day);
      const r = must<any[]>(await admin.from("career_outbox").select("id").eq("contact", contact).eq("status", "delivered").gte("delivered_at", from).lt("delivered_at", to).limit(1), "read today's sends");
      return (r || []).length > 0;
    },
    async mark(id, m: DeliveryMark) {
      const c = claimed.get(id);
      const base = { status: m.status, claimed_at: null, error: m.error ? m.error.slice(0, 500) : null };
      const patch = m.status === "delivered" ? { ...base, delivered_at: iso(m.at), provider_id: m.providerId ? m.providerId.slice(0, 200) : null, retry_at: null,
          ...(m.providerIds ? { provider_ids: m.providerIds.slice(0, 10).map((x) => x.slice(0, 200)) } : {}) }
        : m.status === "failed" ? { ...base, attempts: (c?.attempts ?? 0) + 1, retry_at: m.retryAt ? iso(m.retryAt) : null }
        : { ...base, retry_at: null };
      must(await admin.from("career_outbox").update(patch).eq("id", id).eq("status", "sending"), "record delivery");
      claimed.delete(id);
    },
    async heldFor(userId) {
      const r = await admin.from("career_outbox").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "held");
      if (r.error) throw new Error(`count held messages: ${r.error.message}`);
      return Number(r.count) || 0;
    },
    async nudgesOn(day) {
      const [from, to] = dayRange(day);
      const r = await admin.from("channel_contacts").select("contact", { count: "exact", head: true }).eq("channel", "whatsapp").gte("nudged_at", from).lt("nudged_at", to);
      if (r.error) throw new Error(`count today's templates: ${r.error.message}`);
      return Number(r.count) || 0;
    },
    async setNudged(contact, at) {
      must(await admin.from("channel_contacts").update({ nudged_at: iso(at) }).eq("contact", contact), "record the template");
    },
    async release() {
      let n = 0;
      for (const [id, c] of claimed) {
        must(await admin.from("career_outbox").update({ status: c.prior, claimed_at: null, contact: null }).eq("id", id).eq("status", "sending"), "release a claimed message");
        claimed.delete(id); n++;
      }
      return n;
    },
    async sweep(now) {
      const r = must<any[]>(await admin.from("career_outbox").update({ status: "failed", retry_at: null, claimed_at: null, error: UNKNOWN_OUTCOME })
        .eq("status", "sending").lt("claimed_at", iso(now - SENDING_TIMEOUT_MS)).select("id"), "fail abandoned sends") || [];
      return r.length;
    },
  };
}
