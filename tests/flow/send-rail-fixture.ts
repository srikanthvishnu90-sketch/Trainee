// The sending rail's test fixture (lane M1): a throwaway Postgres with every migration (tests/flow/pg.ts), sessions over
// tests/flow/pgwire.ts, and a fake Gmail at the HTTP boundary (gmail.googleapis.com) that keeps each account's Sent
// mail and threads, so every assertion reads real state: the database's rows and what "Gmail" received. Nothing here
// reaches Google or the live project; no real email is ever sent.
import { pgBinDir, startPg, type Pg } from "./pg.ts";
import { PgConn, serviceRpc } from "./pgwire.ts";
import { messageOf, payloadHash } from "../../supabase/functions/_shared/career_outreach.ts";
import type { WorkerDeps } from "../../supabase/functions/_shared/career_send_rail.ts";

export const CI = Deno.env.get("CI") === "true";
export const haveDb = () => !!pgBinDir();

export interface RailDb { pg: Pg; conn: () => Promise<PgConn>; sql: PgConn; stop: () => Promise<void> }
export async function railDb(): Promise<RailDb> {
  // TRAINEE_TEST_PG=<socket dir>:<port> reuses a database already provisioned by tests/flow/provision-pg.sh (local runs).
  const reuse = Deno.env.get("TRAINEE_TEST_PG");
  const pg: Pg = reuse ? { host: reuse.split(":")[0], port: Number(reuse.split(":")[1]), stop: async () => {} } as unknown as Pg : await startPg();
  const opened: PgConn[] = [];
  const conn = async () => { const c = await PgConn.connect({ host: pg.host, port: pg.port }); opened.push(c); return c; };
  const sql = await conn();
  return { pg, conn, sql, stop: async () => { for (const c of opened) c.close(); await pg.stop(); } };
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
// A person with a career Google grant (the connection row only: the fake token stands for the vault entry).
export async function person(db: RailDb, id: string, o: { connected?: boolean; outlook?: boolean } = {}) {
  await db.sql.query(`insert into auth.users(id, email) values (${q(id)}, ${q(`${id.slice(-6)}@example.test`)}) on conflict do nothing;
    insert into public.profiles(id) values (${q(id)}) on conflict do nothing;
    ${o.outlook ? `insert into public.user_oauth_connections(user_id, provider, vault_name, email, scopes) values (${q(id)}, 'microsoft', ${q(`oauth_microsoft_${id}`)}, 'me@outlook.example', 'Mail.Send Mail.Read') on conflict do nothing;` : ""}
    ${o.connected === false ? "" : `insert into public.user_oauth_connections(user_id, provider, vault_name, email, scopes) values (${q(id)}, 'google_career', ${q(`oauth_google_career_${id}`)}, 'me@example.test', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send') on conflict do nothing;`}`);
}
export const uid = (n: number, tag = "5e") => `00000000-0000-4000-8${tag.padStart(3, "0")}-${n.toString(16).padStart(12, "0")}`;

// Approved outreach drafts, as N2's approval leaves them (status approved, approved_hash = hash of the exact message).
export async function approvedDrafts(db: RailDb, userId: string, tos: string[], o: { subject?: (i: number) => string; recipient?: Record<string, unknown> } = {}) {
  let batch = crypto.randomUUID();
  const out: { draftId: string; approvalHash: string; to: string }[] = [];
  for (const [i, to] of tos.entries()) {
    if (i && i % 10 === 0) batch = crypto.randomUUID(); // a batch holds 1..10 (career_outreach_drafts.n)
    const recipient = { name: `Person ${i + 1}`, firm: "Example Co", title: "Analyst", school: "", email: to, source: "test", ...(o.recipient ?? {}) };
    const d = { recipient, subject: o.subject ? o.subject(i) : `A quick question ${i + 1}`, body: `Hi Person ${i + 1},\n\nWould you have 15 minutes this week?`, footer: "Sam Lee\n\nIf you'd rather not hear from me, reply stop and I won't write again." };
    const hash = await payloadHash(messageOf(d));
    const id = crypto.randomUUID();
    await db.sql.query(`insert into public.career_outreach_drafts(id, user_id, batch_id, n, recipient, recipient_email, subject, body, footer, hash, status, approved_hash, approved_at)
      values (${q(id)}, ${q(userId)}, ${q(batch)}, ${(i % 10) + 1}, ${q(JSON.stringify(recipient))}::jsonb, ${q(to)}, ${q(d.subject)}, ${q(d.body)}, ${q(d.footer)}, ${q(hash)}, 'approved', ${q(hash)}, now())`);
    out.push({ draftId: id, approvalHash: hash, to });
  }
  return out;
}

// The rows of the drafts table as N2's store returns them (supabaseOutreachStore.drafts), read over SQL.
export function draftsReader(db: RailDb | PgConn) {
  const conn = db instanceof PgConn ? db : db.sql;
  return async (userId: string, ids: string[]) => {
    if (!ids.length) return [];
    const rows = await conn.query(`select coalesce(jsonb_agg(to_jsonb(d)), '[]') from public.career_outreach_drafts d where user_id = ${q(userId)} and id in (${ids.map(q).join(",")})`);
    return JSON.parse(rows[0][0] ?? "[]");
  };
}

// ------------------------------------------------------------------------------------------------ fake Gmail
export interface SentMail { id: string; threadId: string; account: string; to: string; subject: string; text: string; headers: string[]; at: number }
type Script = (account: string, n: number) => Response | "throw" | null;
const b64urlDecode = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
};
const decodeWord = (v: string) => v.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, x) => new TextDecoder().decode(Uint8Array.from(atob(x), (c) => c.charCodeAt(0))));
export class FakeGmail {
  sent: SentMail[] = [];
  threads = new Map<string, { id: string; labelIds: string[]; from: string; subject: string; snippet: string }[]>();
  calls: { method: string; path: string; account: string }[] = [];
  inFlight = new Map<string, number>();
  maxInFlight = new Map<string, number>();
  sends = new Map<string, number>();
  script: Script | null = null;
  // Called after Gmail accepted a send and before the worker hears back: lets a test kill the worker there.
  afterAccept: ((m: SentMail) => void) | null = null;
  private seq = 0;
  // Ids unique across fakes: a later test's Gmail must never answer for an earlier one's thread.
  private tag = crypto.randomUUID().slice(0, 8);
  fetch = async (input: Request | URL | string, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request && !init ? input : new Request(input as any, init);
    const u = new URL(req.url);
    if (u.host !== "gmail.googleapis.com") throw new Error(`unexpected host ${u.host}`);
    const account = (req.headers.get("authorization") ?? "").replace(/^Bearer tok-(send|read)-/, "");
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    this.calls.push({ method: req.method, path, account });
    if (req.method === "POST" && path === "/messages/send") {
      if (!(req.headers.get("authorization") ?? "").startsWith("Bearer tok-send-")) return new Response("{}", { status: 401 });
      const n = (this.sends.get(account) ?? 0) + 1;
      this.sends.set(account, n);
      const now = (this.inFlight.get(account) ?? 0) + 1;
      this.inFlight.set(account, now);
      this.maxInFlight.set(account, Math.max(this.maxInFlight.get(account) ?? 0, now));
      try {
        await new Promise((r) => setTimeout(r, 0));
        const s = this.script?.(account, n) ?? null;
        if (s === "throw") throw new TypeError("network error");
        if (s) return s;
        const raw = b64urlDecode(String((await req.json()).raw ?? ""));
        const [head, body] = raw.split("\r\n\r\n");
        const headers = head.split("\r\n");
        const h = (name: string) => headers.filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)).map((l) => l.slice(name.length + 1).trim());
        const m: SentMail = { id: `m${this.tag}-${++this.seq}`, threadId: `t${this.tag}-${this.seq}`, account, to: h("To").join(","), subject: decodeWord(h("Subject")[0] ?? ""),
          text: new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\r\n/g, "")), (c) => c.charCodeAt(0))).replace(/\r\n/g, "\n"), headers, at: Date.now() };
        this.sent.push(m);
        this.threads.set(m.threadId, [{ id: m.id, labelIds: ["SENT"], from: "me@example.test", subject: m.subject, snippet: m.text.slice(0, 100) }]);
        this.afterAccept?.(m);
        return Response.json({ id: m.id, threadId: m.threadId, labelIds: ["SENT"] });
      } finally {
        this.inFlight.set(account, (this.inFlight.get(account) ?? 1) - 1);
      }
    }
    if (req.method === "GET" && path === "/messages") {
      const qs = u.searchParams.get("q") ?? "";
      // A search of the person's inbox (from: and subject:), e.g. the List-Unsubscribe mailto arriving as a new email.
      const from = /from:(\S+)/.exec(qs)?.[1];
      if (from) {
        const word = /subject:(\S+)/.exec(qs)?.[1]?.toLowerCase() ?? "";
        const hits = this.inbox.filter((m) => m.account === account && m.from.toLowerCase().includes(from) && m.subject.toLowerCase().includes(word));
        return Response.json({ messages: hits.map((m) => ({ id: m.id })) });
      }
      const to = /to:(\S+)/.exec(qs)?.[1] ?? "", after = Number(/after:(\d+)/.exec(qs)?.[1] ?? 0) * 1000;
      const hits = this.sent.filter((m) => m.account === account && m.to === to && m.at >= after);
      return Response.json({ messages: hits.map((m) => ({ id: m.id, threadId: m.threadId })) });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (req.method === "GET" && one) {
      const m = this.sent.find((x) => x.id === one[1] && x.account === account);
      if (!m) return new Response("{}", { status: 404 });
      return Response.json({ id: m.id, threadId: m.threadId, payload: { headers: [{ name: "To", value: m.to }, { name: "Subject", value: m.subject }] } });
    }
    const th = /^\/threads\/([^/]+)$/.exec(path);
    if (req.method === "GET" && th) {
      const t = this.threads.get(th[1]);
      if (!t) return new Response("{}", { status: 404 });
      return Response.json({ id: th[1], messages: t.map((x) => ({ id: x.id, labelIds: x.labelIds, snippet: x.snippet, payload: { headers: [{ name: "From", value: x.from }, { name: "Subject", value: x.subject }] } })) });
    }
    return new Response("{}", { status: 404 });
  };
  inbox: { id: string; account: string; from: string; subject: string }[] = [];
  // A new email in the person's inbox, outside any thread Trainee started.
  received(account: string, from: string, subject: string) { this.inbox.push({ id: `i${++this.seq}`, account, from, subject }); }
  reply(threadId: string, from: string, subject: string, snippet: string) {
    this.threads.get(threadId)!.push({ id: `r${++this.seq}`, labelIds: ["INBOX"], from, subject, snippet });
  }
  to(addr: string) { return this.sent.filter((m) => m.to === addr); }
}

// The worker's dependencies over one session: the database's own functions as the service role, the fake Gmail, a
// token per person (null for those the test disconnects), the drafts as N2's store reads them.
export function railDeps(db: RailDb, conn: PgConn, gmail: FakeGmail, o: { now?: () => number; noToken?: Set<string> } = {}): WorkerDeps {
  const rpc = serviceRpc(conn);
  return {
    rpc: rpc.rpc, fetch: gmail.fetch, now: o.now,
    token: async (u, scope) => (o.noToken?.has(u) ? null : `tok-${scope.endsWith("gmail.send") ? "send" : "read"}-${u}`),
    drafts: draftsReader(conn),
  };
}
export async function rows<T = any>(db: RailDb, sql: string): Promise<T[]> {
  const r = await db.sql.query(`select coalesce(jsonb_agg(to_jsonb(x)), '[]') from (${sql}) x`);
  return JSON.parse(r[0][0] ?? "[]");
}
