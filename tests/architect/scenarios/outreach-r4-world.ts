// OUTREACH R4 (2026-11-05): the pure battery's world (tests/architect/scenarios-outreach-r4.test.ts). The product's own
// turns and workers run against it: outreachTurn over memoryOutreachStore, queueApprovedOutreach, runSendWorker,
// runReplyCheck, runOutreachSends / runOutreachReplies (the older scheduled run) and runOutreachFollowups. What stands in:
//   memoryRail   the sending rail's database functions (career_send_enqueue / _claim / _go / _complete / _record /
//                _replies_due, as 20261031020000 and 20261105100000 define them) over the outreach store's own drafts,
//                do-not-contact list and bounce list, so both senders and the chat read one truth.
//   VirtualGmail Gmail at the HTTP boundary on the battery's clock: Sent mail, threads, the inbox, a scripted refusal.
// The database's own behaviour is proven on real Postgres (tests/architect/flow-scenarios-outreach-r4.test.ts,
// tests/db/career_outreach_r4.test.sql); this mirror only lets ~10,000 lifecycles run in seconds.
import { emailHash, messageOf, type OutreachDraft, type memoryOutreachStore } from "../../../supabase/functions/_shared/career_outreach.ts";

type Store = ReturnType<typeof memoryOutreachStore>;
export interface RailRow {
  id: string; user_id: string; kind: string; source_id: string; approval_hash: string; idem: string; to: string; subject: string; body: string;
  state: "queued" | "sending" | "sent" | "replied" | "bounced" | "cancelled" | "refused" | "failed"; attempts: number; first_claimed_at: string | null;
  result: string | null; gmail_id: string | null; gmail_thread: string | null; sent_at: string | null; next_at: number; lease_owner: string | null;
  address_type: string | null; follow_up_of: string | null;
}
const DAY = 86_400_000;
// R4_MIRROR_BEFORE=1 replays the rail as it was before 20261105100000 (no on_rail, a tried retry re-opens its draft), to show
// what the battery finds without that migration.
const BEFORE = (() => { try { return Deno.env.get("R4_MIRROR_BEFORE") === "1"; } catch { return false; } })();

export function memoryRail(store: Store, o: { now: () => number; connected: Set<string>; quiet?: Set<string> }) {
  const rows: RailRow[] = [];
  let seq = 0;
  const iso = (t: number) => new Date(t).toISOString();
  const blocked = async (to: string) => (await store.blocked!([to])).get(to) ?? null;
  const draftOf = async (u: string, id: string) => (await store.drafts!(u, [id]))[0] ?? null;
  const put = async (u: string, d: OutreachDraft, patch: Partial<OutreachDraft>, expect?: string) => {
    const cur = await draftOf(u, d.id);
    if (!cur || (expect && cur.status !== expect)) return;
    await store.update(u, { ...cur, ...patch } as OutreachDraft);
  };
  const fns: Record<string, (p: any) => Promise<any>> = {
    async career_send_enqueue(p) {
      const u = p.user, out: any[] = [];
      for (const it of p.items) {
        const src = it.source_id, h = it.approval_hash, to = String(it.to ?? "").trim().toLowerCase(), k = it.kind;
        let why: string | null = null;
        if (!o.connected.has(u)) why = "not_connected";
        let d: OutreachDraft | null = null;
        if (!why && k === "outreach") {
          d = await draftOf(u, src);
          if (!d) why = "not_found";
          else if (d.status !== "approved" || !d.approved_hash) why = "not_approved";
          else if (d.approved_hash !== h || d.hash !== h || d.recipient.email.trim().toLowerCase() !== to) why = "changed";
        }
        if (!why) { const b = await blocked(to); if (b) why = b === "bounced" ? "bad_address" : "opted_out"; }
        const idem = `${k}:${src}:${h}`;
        const ex = rows.find((r) => r.idem === idem);
        if (!why && ex) { out.push({ source_id: src, status: "already_queued", id: ex.id, state: ex.state }); continue; }
        if (!why && k === "outreach" && rows.some((r) => r.user_id === u && r.to === to && r.kind === "outreach" && ["queued", "sending", "sent", "replied", "bounced"].includes(r.state) && !(r.source_id === src && r.state === "queued"))) why = "already_emailed";
        if (why) {
          if (k === "outreach" && d && ["opted_out", "bad_address", "already_emailed"].includes(why)) await put(u, d, { status: "skipped", approved_hash: null, approved_at: null, result: why }, "approved");
          out.push({ source_id: src, status: "refused", reason: why });
          continue;
        }
        for (const r of rows) if (r.user_id === u && r.kind === k && r.source_id === src && r.approval_hash !== h && r.state === "queued") { r.state = "cancelled"; r.result = "replaced by a newer approval of the same draft"; }
        const row: RailRow = { id: `q${++seq}`, user_id: u, kind: k, source_id: src, approval_hash: h, idem, to, subject: String(it.subject ?? ""), body: String(it.body ?? ""), state: "queued", attempts: 0,
          first_claimed_at: null, result: null, gmail_id: null, gmail_thread: null, sent_at: null, next_at: o.now(), lease_owner: null, address_type: it.address_type ?? null, follow_up_of: null };
        rows.push(row);
        if (k === "outreach" && !BEFORE) (store as any).markOnRail?.(src); // 20261105100000: a draft with a queue row is the rail's
        out.push({ source_id: src, status: "queued", id: row.id });
      }
      return out;
    },
    async career_send_claim(p) {
      const t = Date.parse(p.now ?? iso(o.now())), w = p.worker, per = p.per_account ?? 25;
      for (const r of rows) if (r.state === "sending" && r.lease_owner && r.lease_owner !== w) { r.state = "queued"; r.lease_owner = null; r.result = "lease lapsed"; }
      const accounts: any[] = [];
      const users = [...new Set(rows.filter((r) => r.state === "queued" && r.next_at <= t).map((r) => r.user_id))];
      for (const u of users) {
        if (o.quiet?.has(u)) continue;
        const items: any[] = [];
        for (const q of rows.filter((r) => r.user_id === u && r.state === "queued" && r.next_at <= t).slice(0, per)) {
          const b = await blocked(q.to);
          if (b) { q.state = "cancelled"; q.result = b === "bounced" ? "bad_address" : "opted_out"; continue; }
          const d = q.kind === "outreach" ? await draftOf(u, q.source_id) : null;
          if (q.kind === "outreach") {
            if (!d || !(d.status === "approved" || (d.status === "sending" && d.result === "send_rail")) || d.approved_hash !== q.approval_hash || d.hash !== q.approval_hash) {
              q.state = !d || d.status === "skipped" ? "cancelled" : "refused";
              q.result = !d ? "draft gone" : d.status === "skipped" ? "approval withdrawn" : "changed after approval";
              continue;
            }
            const anchor = Math.max(Date.parse(String(d.approved_at)), Date.parse(d.created_at));
            if (q.attempts === 0 && anchor < t - 7 * DAY) { q.state = "cancelled"; q.result = "approval lapsed (more than 7 days)"; await put(u, d, { status: "skipped", approved_hash: null, approved_at: null, result: "expired" }); continue; }
            await put(u, d, { status: "sending", result: "send_rail" });
          }
          q.state = "sending"; q.lease_owner = w; q.attempts++; q.first_claimed_at ??= iso(t);
          const anchor = d ? Math.max(Date.parse(String(d.approved_at)), Date.parse(d.created_at)) : t;
          items.push({ id: q.id, user_id: u, kind: q.kind, source_id: q.source_id, approval_hash: q.approval_hash, provider: "gmail", to: q.to, subject: q.subject, body: q.body,
            attempts: q.attempts, first_claimed_at: q.first_claimed_at, follow_up_of: q.follow_up_of, address_type: q.address_type, from_email: `${u}@person.example`,
            lapsed: q.kind === "outreach" && q.attempts > 1 && anchor < t - 7 * DAY ? true : null,
            draft: d ? { recipient: d.recipient, subject: d.subject, body: d.body, footer: d.footer } : null });
        }
        if (items.length) accounts.push({ user_id: u, provider: "gmail", items });
      }
      return { accounts };
    },
    async career_send_go(p) {
      const q = rows.find((r) => r.id === p.id);
      if (!q || q.state !== "sending" || q.lease_owner !== p.worker || !o.connected.has(q.user_id)) return "stop";
      return (await blocked(q.to)) ? "stop" : "go";
    },
    async career_send_complete(p) {
      const res: string[] = [];
      for (const x of p.results ?? []) {
        const q = rows.find((r) => r.id === x.id);
        if (!q || q.state !== "sending" || q.lease_owner !== p.worker) { res.push("stale"); continue; }
        q.lease_owner = null;
        const d = q.kind === "outreach" ? await draftOf(q.user_id, q.source_id) : null;
        if (x.outcome === "sent" || x.outcome === "already_sent") {
          Object.assign(q, { state: "sent", sent_at: iso(o.now()), gmail_id: x.gmail_id, gmail_thread: x.thread_id || null, result: x.outcome });
          if (d) await put(q.user_id, d, { status: "sent", sent_at: iso(o.now()), gmail_id: x.gmail_id, gmail_thread: x.thread_id || null, result: "sent" });
          res.push("sent");
        } else if (x.outcome === "lapsed") {
          q.state = "cancelled"; q.result = "approval lapsed (more than 7 days)";
          if (d) await put(q.user_id, d, { status: "skipped", approved_hash: null, approved_at: null, result: "expired" }, "sending");
          res.push("cancelled");
        } else if (["retry", "quota", "reconnect", "policy"].includes(x.outcome)) {
          q.state = "queued"; q.result = `${x.outcome}: ${x.detail ?? ""}`;
          if (x.untried) { q.attempts = Math.max(0, q.attempts - 1); if (q.attempts === 0) q.first_claimed_at = null; }
          q.next_at = Date.parse(x.retry_at ?? x.resume_at ?? iso(o.now()));
          // 20261105100000 (4): a try Gmail may have taken keeps its draft the rail's until the next try has looked in Sent.
          if (d) await put(q.user_id, d, x.untried || BEFORE ? { status: "approved", result: "queued" } : { status: "sending", result: "send_rail" }, "sending");
          res.push(x.outcome);
        } else if (x.outcome === "refused" || x.outcome === "failed") {
          q.state = x.outcome; q.result = x.detail ?? x.outcome;
          if (d) await put(q.user_id, d, { status: x.outcome === "refused" ? "shown" : "failed", approved_hash: null, approved_at: null, result: `${x.outcome}: ${x.detail ?? ""}` }, "sending");
          res.push(x.outcome);
        } else throw new Error(`unknown outcome ${x.outcome}`);
      }
      return res;
    },
    async career_send_record(p) {
      const q = rows.find((r) => r.id === p.id);
      if (!q || !["sent", "replied", "bounced"].includes(q.state)) return "not_sent";
      const d = q.kind === "outreach" ? await draftOf(q.user_id, q.source_id) : null;
      if (p.kind === "bounce") {
        store.markBounced(q.to);
        q.state = "bounced"; q.result = "bounced";
        for (const r of rows) if (r.to === q.to && r.state === "queued") { r.state = "cancelled"; r.result = "bad_address"; }
        if (d) await put(q.user_id, d, { status: "bounced", result: "bounce" });
      } else {
        if (p.kind === "stop") {
          await store.addDnc(q.user_id, await emailHash(q.to), "recipient asked to stop", o.now());
          for (const r of rows) if (r.to === q.to && r.state === "queued") { r.state = "cancelled"; r.result = "opted_out"; }
        }
        q.state = "replied"; q.result = p.kind;
        if (d) await put(q.user_id, d, { status: "replied", result: p.kind });
      }
      return p.kind;
    },
    async career_send_replies_due(_p) {
      return rows.filter((r) => r.state === "sent" && r.gmail_thread).map((r) => ({ id: r.id, user_id: r.user_id, recipient_email: r.to, gmail_id: r.gmail_id, gmail_thread: r.gmail_thread, sent_at: r.sent_at, address_type: r.address_type }));
    },
  };
  return {
    rows,
    rpc: async (name: string, args: { p: unknown }) => {
      const f = fns[name];
      if (!f) return { data: null, error: { message: `no such function ${name}` } };
      try { return { data: await f(args.p), error: null }; } catch (e) { return { data: null, error: { message: e instanceof Error ? e.message : String(e) } }; }
    },
  };
}

// ------------------------------------------------------------------------------------------------ Gmail on the battery's clock
export interface Sent { id: string; thread: string; account: string; to: string; subject: string; text: string; headers: string[]; at: number; via: "rail" | "legacy" }
const b64d = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)));
const b64e = (s: string) => { const b = new TextEncoder().encode(s); let x = ""; for (const c of b) x += String.fromCharCode(c); return btoa(x).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const decodeWord = (v: string) => v.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, x) => new TextDecoder().decode(Uint8Array.from(atob(x), (c) => c.charCodeAt(0))));
export class VirtualGmail {
  sent: Sent[] = [];
  threads = new Map<string, { id: string; labelIds: string[]; from: string; subject: string; text: string }[]>();
  inbox: { id: string; account: string; from: string; subject: string; at: number }[] = [];
  // The next n sends answer this (e.g. a 503: it may have gone, so the worker checks Sent before a retry).
  refuse: { n: number; status: number; went: boolean } | null = null;
  private seq = 0;
  constructor(private now: () => number) {}
  private add(account: string, to: string, subject: string, text: string, headers: string[], via: Sent["via"]): Sent {
    const m: Sent = { id: `m${++this.seq}`, thread: `t${this.seq}`, account, to, subject, text, headers, at: this.now(), via };
    this.sent.push(m);
    this.threads.set(m.thread, [{ id: m.id, labelIds: ["SENT"], from: `${account}@person.example`, subject, text }]);
    return m;
  }
  // The older scheduled run's sender (career_outreach_gmail.ts gmailSender's shape).
  legacySend(account: string, m: { to: string; subject: string; text: string }) { return this.add(account, m.to, m.subject, m.text, [], "legacy"); }
  reply(thread: string, from: string, subject: string, text: string) { this.threads.get(thread)?.push({ id: `r${++this.seq}`, labelIds: ["INBOX"], from, subject, text }); }
  received(account: string, from: string, subject: string) { this.inbox.push({ id: `i${++this.seq}`, account, from, subject, at: this.now() }); }
  fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.host !== "gmail.googleapis.com") throw new Error(`unexpected host ${u.host}`);
    const auth = req.headers.get("authorization") ?? "";
    const account = auth.replace(/^Bearer tok-(send|read)-/, "");
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    if (req.method === "POST" && path === "/messages/send") {
      if (!auth.startsWith("Bearer tok-send-")) return new Response("{}", { status: 401 });
      const raw = b64d(String((await req.json()).raw ?? ""));
      const [head, body] = raw.split("\r\n\r\n");
      const headers = head.split("\r\n");
      const h = (n: string) => headers.filter((l) => l.toLowerCase().startsWith(`${n.toLowerCase()}:`)).map((l) => l.slice(n.length + 1).trim());
      const text = b64d(body.replace(/\r\n/g, "").replace(/\+/g, "-").replace(/\//g, "_")).replace(/\r\n/g, "\n");
      if (this.refuse && this.refuse.n > 0) {
        this.refuse.n--;
        if (this.refuse.went) this.add(account, h("To").join(","), decodeWord(h("Subject")[0] ?? ""), text, headers, "rail");
        return new Response(JSON.stringify({ error: { message: "backend error" } }), { status: this.refuse.status });
      }
      const m = this.add(account, h("To").join(","), decodeWord(h("Subject")[0] ?? ""), text, headers, "rail");
      return Response.json({ id: m.id, threadId: m.thread });
    }
    if (req.method === "GET" && path === "/messages") {
      const qs = u.searchParams.get("q") ?? "";
      const from = /from:(\S+)/.exec(qs)?.[1];
      const after = Number(/after:(\d+)/.exec(qs)?.[1] ?? 0) * 1000;
      if (from) {
        const word = /subject:(\S+)/.exec(qs)?.[1]?.toLowerCase() ?? "";
        return Response.json({ messages: this.inbox.filter((m) => m.account === account && m.from.toLowerCase().includes(from) && m.subject.toLowerCase().includes(word) && m.at >= after).map((m) => ({ id: m.id })) });
      }
      const to = /to:(\S+)/.exec(qs)?.[1] ?? "";
      return Response.json({ messages: this.sent.filter((m) => m.account === account && m.to === to && m.at >= after).map((m) => ({ id: m.id, threadId: m.thread })) });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (req.method === "GET" && one) {
      const s = this.sent.find((x) => x.id === one[1] && x.account === account);
      if (s) return Response.json({ id: s.id, threadId: s.thread, payload: { headers: [{ name: "To", value: s.to }, { name: "Subject", value: s.subject }] } });
      for (const t of this.threads.values()) {
        const m = t.find((x) => x.id === one[1]);
        if (m) return Response.json({ id: m.id, payload: { mimeType: "text/plain", body: { data: b64e(m.text) }, headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }] } });
      }
      return new Response("{}", { status: 404 });
    }
    const th = /^\/threads\/([^/]+)$/.exec(path);
    if (req.method === "GET" && th) {
      const t = this.threads.get(th[1]);
      if (!t) return new Response("{}", { status: 404 });
      return Response.json({ id: th[1], messages: t.map((x) => ({ id: x.id, labelIds: x.labelIds, snippet: x.text.slice(0, 200), payload: { headers: [{ name: "From", value: x.from }, { name: "Subject", value: x.subject }] } })) });
    }
    return new Response("{}", { status: 404 });
  };
}

// What a sent email says, as the approval hashed it.
export const sentMessage = (s: Sent) => ({ to: s.to.trim().toLowerCase(), subject: s.subject, text: s.text });
export const draftMessage = (d: OutreachDraft) => messageOf(d);
