// The texting channel's store over Supabase (WO-013b-1): the ChannelStore of channel.ts over career_outbox and
// channel_contacts (supabase/migrations/20261019020001_channel_delivery.sql). due() claims rows, so two overlapping runs
// never send the same one; release() puts back what a run claimed and did not finish (a capped row); sweep() fails a row
// a dead run left "sending", never resending it (the provider may already have it: at most once beats twice).
// WO-038 (20261021070000_channel_parity.sql): the claim resolves each row's channel (its own, or the person's home
// channel); a WhatsApp row carries the window's times; "held" rows wait for the person's next message; STOP is the
// person's across channels.
import type { ChannelStore, DeliveryMark, OutboxRow } from "./channel.ts";
import type { Channel } from "./channel_adapters.ts";
import { alertStillWanted, alertWithinLimits, freshAlertText } from "./career_watch_alerts.ts";
import { briefStillTrue } from "./channel.ts";
import { localDayStart, zoneOr } from "./career_alerts.ts";
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

// reroute (CHANNEL DELIVERY ROUND 2, optional): rows bound to a channel the person no longer has go to their home channel,
// or fail with the reason when they have none (career_outbox_reroute); how many.
export type DeliveryStore = ChannelStore & { release(): Promise<number>; sweep(now: number): Promise<number>; reroute?(now: number): Promise<number> };

// `only` narrows the store to one row (a reply sent the moment it is written); `user` to everything due for one person
// (a WhatsApp message: what waited for the window goes out first, then the answer). The rules are the same.
// deno-lint-ignore no-explicit-any
export function supabaseChannelStore(admin: any, o: { only?: { userId: string; key: string }; user?: string } = {}): DeliveryStore {
  const claimed = new Map<string, { prior: string; attempts: number; parts?: number }>();
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
        // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): whether the window ever held each one (held_at,
        // 20261030070000_proactive_r2.sql). A project without the column, or a read that fails, leaves it unknown: such a
        // row is never treated as stale on WhatsApp (as before).
        const ids = out.filter((r) => String(r.contact).startsWith("wa:")).map((r) => r.id);
        const held = await admin.from("career_outbox").select("id,held_at").in("id", ids);
        if (!held.error) {
          const at = new Map<string, number | null>((held.data ?? []).map((h: any) => [String(h.id), ms(h.held_at)]));
          for (const r of out) if (at.has(r.id)) r.heldAt = at.get(r.id) ?? null;
        }
      }
      // CHANNEL DELIVERY ROUND 2 (2026-10-30): a row tried before may have sent some of its messages (sent_parts,
      // 20261030100000_channel_delivery_r2.sql) with their ids; it resumes after them. Without the column (a project
      // without the migration) or on a failed read, nothing is known to have gone and the row goes whole, as before.
      // (Any claimed row: a row held part way goes back to "queued" when the person writes.)
      const again = out.map((r) => r.id);
      if (again.length) {
        const sp = await Promise.resolve().then(() => admin.from("career_outbox").select("id,sent_parts,provider_ids").in("id", again).gt("sent_parts", 0))
          .catch((e: unknown) => ({ data: null, error: { message: e instanceof Error ? e.message : String(e) } }));
        if (!sp.error) for (const x of sp.data ?? []) {
          const r = out.find((y) => y.id === String(x.id));
          if (r && Number(x.sent_parts) > 0) { r.sentParts = Number(x.sent_parts); r.sentIds = Array.isArray(x.provider_ids) ? x.provider_ids.map(String) : []; const c = claimed.get(r.id); if (c) c.parts = r.sentParts; }
        }
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
    // IDENTITY SCENARIOS (2026-10-30): the contact is still this person's, read at the moment of sending.
    async stillTheirs(userId, contact) {
      const row = must<any>(await admin.from("channel_contacts").select("user_id").eq("contact", contact).maybeSingle(), "read the contact's owner");
      return !!row && row.user_id === userId;
    },
    // WO-091c: paused, opted out or erased (career_user_quiet, 20261022120000_career_control_state.sql).
    async quiet(userId) {
      return must<boolean>(await admin.rpc("career_user_quiet", { p_user: userId }), "read the pause") === true;
    },
    // ERASE SCENARIOS ROUND 2 (2026-10-30): the account was deleted (career_account_gone, 20261030050000). On a project
    // without that migration the check is skipped (false), as before it existed.
    async gone(userId) {
      const r = await admin.rpc("career_account_gone", { p_user: userId });
      const said = `${(r.error as any)?.code ?? ""} ${r.error?.message ?? ""}`;
      if (r.error && /career_account_gone|PGRST202/i.test(said) && /exist|find|no function|PGRST202/i.test(said)) return false;
      return must<boolean>(r, "read whether the account exists") === true;
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
    // PROACTIVE SCENARIOS ROUND 3 (2026-11-01): the alert's or report's words as they are true now (freshAlertText), from the
    // person's settings, the watch record and the postings (an alert's by its job id, a report's by its links) read now.
    async freshText(m, now) {
      const prefs = must<any>(await admin.from("career_alert_prefs").select("prefs").eq("user_id", m.userId).maybeSingle(), "read alert settings");
      if (!prefs) return null;
      const record = prefs.prefs?.interests?.length
        ? must<any>(await admin.from("career_watch_kv").select("value").eq("user_id", m.userId).eq("key", `career:watch-profile:${m.userId}`).maybeSingle(), "read the watch record")?.value ?? null
        : null;
      const postings = new Map<string, any>();
      if (m.key.startsWith("alert:")) {
        const p = must<any>(await admin.from("career_postings").select("*").eq("job_id", m.key.slice("alert:".length)).maybeSingle(), "read the posting");
        if (p) postings.set(String(p.job_id), p);
      } else {
        const urls = [...new Set([...String(m.text).matchAll(/^ {2}(https:\/\/\S+)$/gm)].map((x) => x[1]))].slice(0, 50);
        const got = urls.length ? must<any[]>(await admin.from("career_postings").select("*").in("url", urls), "read the report's postings") || [] : [];
        // The same link on two rows: the open one is the posting the line names.
        for (const p of got.sort((a, b) => Number(!a.closed_at) - Number(!b.closed_at))) postings.set(String(p.url), p);
      }
      return freshAlertText(m.key, m.text, { row: { prefs: prefs.prefs }, record, postings, at: now });
    },
    // PROACTIVE SCENARIOS ROUND 3 (2026-11-01): a queued interview brief whose interview a later email cancelled or moved
    // (career_interviews.cancelled_at / moved_at, 20261030070000_proactive_r2.sql). brief:<invite>:<n>; the ":moved" brief
    // is the new time's and goes unless that one was cancelled too. A project without the columns sends it, as before.
    async briefWanted(m) {
      const k = /^brief:([^:]+):(.+)$/.exec(m.key);
      if (!k) return true;
      const r = await admin.from("career_interviews").select("moved_at,cancelled_at").eq("user_id", m.userId).eq("invite_key", k[1]).limit(1);
      if (r.error) {
        if (/moved_at|cancelled_at/.test(r.error.message ?? "") && /exist/i.test(r.error.message ?? "")) return true;
        throw new Error(`read the interview: ${r.error.message}`);
      }
      return briefStillTrue(m.key, (r.data ?? [])[0] ?? null);
    },
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): a job alert against the person's fit floor and daily cap now: the fit it was
    // queued with (alert_fit, 20261030070000_proactive_r2.sql; without the column the fit is not known and never holds an
    // alert back) and the alerts already delivered today on their clock. A read that fails throws: the row waits.
    async alertWithinLimits(m, now) {
      const prefs = must<any>(await admin.from("career_alert_prefs").select("prefs,tz").eq("user_id", m.userId).maybeSingle(), "read alert settings");
      if (!prefs) return true;
      const f = await admin.from("career_outbox").select("alert_fit").eq("id", m.id).maybeSingle();
      const fit = !f.error && typeof f.data?.alert_fit === "number" ? f.data.alert_fit : null;
      const since = new Date(localDayStart(now, zoneOr(prefs.tz))).toISOString();
      const r = await admin.from("career_outbox").select("id", { count: "exact", head: true }).eq("user_id", m.userId).eq("kind", "alert").eq("status", "delivered").gte("delivered_at", since);
      if (r.error) throw new Error(`count today's alerts: ${r.error.message}`);
      return alertWithinLimits(prefs.prefs, fit, Number(r.count) || 0);
    },
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): a daily report's postings closed since it was written.
    async closedLinks(urls) {
      const rows = must<any[]>(await admin.from("career_postings").select("url").in("url", urls.slice(0, 50)).not("closed_at", "is", null), "read the report's postings") || [];
      return new Set(rows.map((r) => String(r.url)));
    },
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): the person's zone and quiet hours now (their alert settings), null with none.
    async quietHours(userId) {
      const r = must<any>(await admin.from("career_alert_prefs").select("tz,prefs").eq("user_id", userId).maybeSingle(), "read quiet hours");
      return r ? { tz: r.tz ?? null, quiet_start: r.prefs?.quiet_start, quiet_end: r.prefs?.quiet_end } : null;
    },
    // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): channel_template_claim (20261030070000_proactive_r2.sql). A project without
    // it answers null: the run counts as before.
    async claimTemplate(contact, day, cap, at) {
      const r = await admin.rpc("channel_template_claim", { p_contact: contact, p_day: day, p_cap: cap, p_at: iso(at) });
      const said = `${(r.error as any)?.code ?? ""} ${r.error?.message ?? ""}`;
      if (r.error && /channel_template_claim|PGRST202/i.test(said) && /exist|find|no function|PGRST202/i.test(said)) return null;
      return must<boolean>(r, "claim a template") === true;
    },
    async unclaimTemplate(contact, at) {
      must(await admin.from("channel_contacts").update({ nudged_at: null }).eq("contact", contact).eq("nudged_at", iso(at)), "give back a template");
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
      // CHANNEL DELIVERY ROUND 2: every id a row went out as is kept (a single one too), and sent_parts recorded on a row
      // that stopped part way; a delivered row's sent_parts goes back to 0.
      const ids = (m.providerIds ?? []).slice(0, 10).map((x) => x.slice(0, 200));
      const progress = m.sentParts !== undefined ? { sent_parts: m.sentParts, provider_ids: ids.length ? ids : null } : {};
      // PROACTIVE SCENARIOS ROUND 3: a row delivery wrote anew keeps the words that went.
      const patch = m.status === "delivered" ? { ...base, ...(m.text !== undefined ? { text: m.text } : {}), delivered_at: iso(m.at), provider_id: m.providerId ? m.providerId.slice(0, 200) : null, retry_at: null,
          ...(ids.length ? { provider_ids: ids } : { provider_ids: null }), ...(m.sentParts !== undefined || (c?.parts ?? 0) > 0 ? { sent_parts: 0 } : {}) }
        : m.status === "failed" ? { ...base, attempts: (c?.attempts ?? 0) + 1, retry_at: m.retryAt ? iso(m.retryAt) : null, ...progress }
        // PROACTIVE SCENARIOS ROUND 2 (2026-10-30): put back for later (quiet hours on the person's clock now).
        : m.status === "queued" ? { ...base, status: "queued", contact: null, retry_at: null, ...(m.deliverAt ? { deliver_at: iso(m.deliverAt) } : {}) }
        : { ...base, retry_at: null, ...progress };
      let done = await admin.from("career_outbox").update(patch).eq("id", id).eq("status", "sending");
      // A project without 20261030100000 has no sent_parts: recorded without it (the row then goes whole next time, as before).
      if (done.error && "sent_parts" in patch && /sent_parts/.test(done.error.message ?? "")) {
        const { sent_parts: _drop, ...rest } = patch as Record<string, unknown>;
        done = await admin.from("career_outbox").update(rest).eq("id", id).eq("status", "sending");
      }
      must(done, "record delivery");
      claimed.delete(id);
    },
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): the template's count is everything waiting for the person on WhatsApp: held,
    // and still to go (a run claims 20; a person with 37 waiting was told "20 new updates").
    async heldFor(userId) {
      const r = await admin.from("career_outbox").select("id", { count: "exact", head: true }).eq("user_id", userId)
        .in("status", ["held", "queued", "sending"]).or("channel.is.null,channel.eq.whatsapp");
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
    // CHANNEL DELIVERY ROUND 2 (2026-10-30): career_outbox_reroute. A project without it answers 0 (rows stay as before).
    async reroute(now) {
      const r = await admin.rpc("career_outbox_reroute", { p_now: iso(now) });
      const said = `${(r.error as any)?.code ?? ""} ${r.error?.message ?? ""}`;
      if (r.error && /career_outbox_reroute|PGRST202/i.test(said) && /exist|find|no function|PGRST202/i.test(said)) return 0;
      return Number(must<number>(r, "reroute rows of an unlinked channel")) || 0;
    },
    async sweep(now) {
      const r = must<any[]>(await admin.from("career_outbox").update({ status: "failed", retry_at: null, claimed_at: null, error: UNKNOWN_OUTCOME })
        .eq("status", "sending").lt("claimed_at", iso(now - SENDING_TIMEOUT_MS)).select("id"), "fail abandoned sends") || [];
      return r.length;
    },
  };
}
