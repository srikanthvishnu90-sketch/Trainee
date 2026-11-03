// Fixture doubles for the channel-bridge edge tests (telegram/whatsapp).
// Mirrors the supabase-js call shapes supabase/functions/_shared/channel_bridge.ts
// uses, plus a fetch double that records calls and answers per-URL.

export function assert(v: unknown, msg = "assertion failed") {
  if (!v) throw new Error(msg);
}
export function assertEq(a: unknown, b: unknown, msg = "") {
  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)} ${msg}`);
}

export class FakeAdmin {
  threads = new Map<string, { thread_id: string; last_message_id: string | null }>();
  createdThreads: { user_id: string; title: string }[] = [];
  upserts: any[] = [];
  private seq = 0;
  constructor(private keyOf: (channel: string, sender: string) => string = (c, s) => `${c}:${s}`) {}
  from(table: string) {
    const self = this;
    if (table === "channel_threads") {
      const filters: Record<string, string> = {};
      const q: any = {
        select() { return q; },
        eq(col: string, val: string) { filters[col] = val; return q; },
        async maybeSingle() {
          const row = self.threads.get(self.keyOf(filters.channel, filters.sender_key));
          return { data: row ? { ...row } : null };
        },
        async upsert(row: any) {
          self.upserts.push(row);
          self.threads.set(self.keyOf(row.channel, row.sender_key), {
            thread_id: row.thread_id,
            last_message_id: row.last_message_id ?? self.threads.get(self.keyOf(row.channel, row.sender_key))?.last_message_id ?? null,
          });
          return { error: null };
        },
      };
      return q;
    }
    if (table === "agent_threads") {
      const q: any = {
        insert(row: any) { self.createdThreads.push(row); return q; },
        select() { return q; },
        async single() { return { data: { id: `thread-${++self.seq}` } }; },
      };
      return q;
    }
    throw new Error("unexpected table " + table);
  }
}

export type FetchCall = { url: string; init: any };

// Answers: agent-chat -> { reply, thread_id? }; telegram sendMessage -> { ok: true };
// twilio Messages -> { sid }. Everything recorded in `calls`.
export function fakeFetch(agentReply: string) {
  const calls: FetchCall[] = [];
  const fn = async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/functions/v1/agent-chat")) {
      return new Response(JSON.stringify({ reply: agentReply }), { status: 200 });
    }
    if (u.includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (u.includes("api.twilio.com")) {
      return new Response(JSON.stringify({ sid: "SMfixture" }), { status: 201 });
    }
    return new Response("{}", { status: 200 });
  };
  return { fn: fn as any, calls };
}

// --- Presentation-layer additions (channel approvals + rich chat doubles) ---

// Minimal thenable query builder over an in-memory row set, mirroring the
// supabase-js shapes channel_present.ts uses on channel_pending_approvals:
// insert(row); select().eq().order().limit() awaited -> {data:[rows]};
// select().eq().maybeSingle(); update(patch).eq().is().select() -> {data:[rows]}.
class FakeQuery {
  private filters: [string, unknown][] = [];
  private nullCols: string[] = [];
  private ord: { col: string; asc: boolean } | null = null;
  private lim: number | null = null;
  private patch: Record<string, unknown> | null = null;
  private wantRows = false;
  constructor(private rows: () => Map<string, any>, private keyOfRow: (row: any) => string) {}
  // created_at as the column's default (now()) when the row does not carry one: the offer's time is the database's.
  insert(row: any) { this.rows().set(this.keyOfRow(row), { created_at: new Date().toISOString(), ...row }); return Promise.resolve({ data: null, error: null }); }
  select(_cols?: string) { this.wantRows = true; return this; }
  update(patch: Record<string, unknown>) { this.patch = patch; return this; }
  eq(col: string, val: unknown) { this.filters.push([col, val]); return this; }
  is(col: string, val: unknown) { if (val === null) this.nullCols.push(col); return this; }
  order(col: string, o?: { ascending?: boolean }) { this.ord = { col, asc: o?.ascending !== false }; return this; }
  limit(n: number) { this.lim = n; return this; }
  private matched(): any[] {
    let out = [...this.rows().values()].filter((r) =>
      this.filters.every(([c, v]) => r[c] === v) && this.nullCols.every((c) => r[c] == null));
    if (this.ord) {
      const { col, asc } = this.ord;
      out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
    }
    if (this.lim != null) out = out.slice(0, this.lim);
    return out;
  }
  async maybeSingle() { const m = this.matched(); return { data: m.length ? { ...m[0] } : null, error: null }; }
  then(resolve: (v: any) => void) {
    if (this.patch) {
      const m = this.matched();
      for (const r of m) Object.assign(r, this.patch);
      resolve({ data: this.wantRows ? m.map((r) => ({ ...r })) : null, error: null });
    } else {
      resolve({ data: this.matched().map((r) => ({ ...r })), error: null });
    }
  }
}

export class FakeAdminApprovals extends FakeAdmin {
  approvals = new Map<string, any>(); // token -> channel_pending_approvals row
  batchRuns = new Map<string, any>(); // runId -> career_batch_run/v1 record
  batchIntents = new Map<string, any>(); // user_id:intent_id -> career_batch_intents_v1 row (F-037 readback)
  override from(table: string) {
    if (table === "channel_pending_approvals") {
      return new FakeQuery(() => this.approvals, (row: any) => row.token);
    }
    if (table === "career_batch_intents_v1") {
      return new FakeQuery(() => this.batchIntents, (row: any) => `${row.user_id}:${row.intent_id}`);
    }
    return super.from(table);
  }
  async rpc(name: string, args: any) {
    if (name === "career_batch_result_v1") {
      const rec = this.batchRuns.get(args.p_run);
      // Owner-scoped, like the real RPC: a foreign run reads as nothing.
      return { data: { batch: rec && rec.userId === args.p_user ? rec : null }, error: null };
    }
    throw new Error("unexpected rpc " + name);
  }
}

// Rich fetch double: the agent-chat answer is computed from the request body
// (so a test can script card replies, approvals, artifacts); telegram method
// calls are answered per-method; `telegramParseFailOnce` makes the first
// parse_mode sendMessage fail the way Telegram fails bad HTML.
export function fakeFetchRich(opts: {
  chat?: (body: any) => any;
  telegramParseFailOnce?: boolean;
} = {}) {
  const calls: FetchCall[] = [];
  let parseFailed = false;
  const fn = async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes("/functions/v1/agent-chat")) {
      const body = init?.body ? JSON.parse(init.body) : {};
      const out = opts.chat ? opts.chat(body) : { reply: "Hello from the agent." };
      if (out && out.__status) return new Response(JSON.stringify(out.body ?? {}), { status: out.__status });
      return new Response(JSON.stringify(out), { status: 200 });
    }
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop() ?? "";
      if (method === "sendMessage" && opts.telegramParseFailOnce && !parseFailed) {
        const b = init?.body ? JSON.parse(init.body) : {};
        if (b.parse_mode) {
          parseFailed = true;
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag \"b\"" }), { status: 400 });
        }
      }
      return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 1 } : true }), { status: 200 });
    }
    if (u.includes("api.twilio.com")) {
      return new Response(JSON.stringify({ sid: "SMfixture" }), { status: 201 });
    }
    return new Response("{}", { status: 200 });
  };
  return { fn: fn as any, calls };
}

// CHANNEL-DOC-1 additions: the channel_artifacts table (owner-scoped
// document bytes behind the reply contract's artifacts[] refs), keyed by
// row id, served by the same FakeQuery shapes as the approvals table.
export class FakeAdminArtifacts extends FakeAdminApprovals {
  artifacts = new Map<string, any>(); // id -> channel_artifacts row
  override from(table: string) {
    if (table === "channel_artifacts") {
      return new FakeQuery(() => this.artifacts, (row: any) => row.id);
    }
    return super.from(table);
  }
}

export function envOf(map: Record<string, string>) {
  return (k: string) => map[k];
}

export const TEST_USER = "2e8cb31d-59ab-4b2c-99bb-d4c5de8613a3"; // gauntlet test user
export const SUPABASE_URL = "https://fixture.supabase.co";
export const SERVICE_KEY = "fixture-service-key";
