// Connectors round 3: an in-memory project for the pure battery (tests/architect/scenarios-connectors-r3.test.ts). A
// supabase-js-shaped service client (from(t).select/eq/in/order/limit/maybeSingle, insert/upsert/update/delete, rpc) over
// plain arrays, with the RPCs round 3 added answering as 20261031060000_connectors_r3.sql does (the same rules, written
// again here so the battery runs without Postgres; flow-scenarios-connectors-r3.test.ts runs the real ones), and the
// disconnect and erase triggers' effects on the rows these tests read. Anything else throws, so an unsupported call fails
// loudly.
// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

export class MemDb {
  t: Record<string, Row[]> = {};
  vault = new Map<string, string>();
  users = new Set<string>();
  spent = new Set<string>();
  calls: string[] = [];
  // RPCs answered as "function does not exist" (a project without the migration). R3_PREFIX=1: every round-3 function
  // missing, so the product falls back to the writes it made before the fix (how the battery is shown to fail without it).
  missing = new Set<string>(Deno.env.get("R3_PREFIX") === "1" ? ["oauth_state_use", "oauth_connect_commit", "career_outlook_store_messages", "career_mail_record_events", "career_mail_save_draft", "career_mail_save_cursor"] : []);
  rows(t: string) { return (this.t[t] ??= []); }

  // ------------------------------------------------------------------------------------------ what the triggers do
  disconnect(uid: string, provider: "google_career" | "microsoft") {
    this.t.user_oauth_connections = this.rows("user_oauth_connections").filter((r) => !(r.user_id === uid && r.provider === provider));
    this.vault.delete(`oauth_${provider}_${uid}`);
    const tables = provider === "google_career" ? ["career_mail_events", "career_mail_drafts", "career_mail_cursors"] : ["career_outlook_messages", "career_outlook_state"];
    for (const x of tables) this.t[x] = this.rows(x).filter((r) => r.user_id !== uid);
  }
  // "forget everything": the epoch raised and paused; every career_ row erased except the account row and the cursor.
  erase(uid: string) {
    const acct = this.rows("career_watch_kv").find((r) => r.user_id === uid && r.key === "career:account");
    const epoch = Number(acct?.value?.epoch ?? 0) + 1;
    if (acct) acct.value = { ...acct.value, epoch, paused: true };
    else this.rows("career_watch_kv").push({ user_id: uid, key: "career:account", value: { epoch, paused: true } });
    for (const x of Object.keys(this.t)) if (x.startsWith("career_") && x !== "career_watch_kv" && x !== "career_mail_cursors") this.t[x] = this.rows(x).filter((r) => r.user_id !== uid);
  }
  epoch(uid: string) { return Number(this.rows("career_watch_kv").find((r) => r.user_id === uid && r.key === "career:account")?.value?.epoch ?? 0); }
  live(uid: string, provider: string, epoch: number | null | undefined) {
    if (!this.rows("user_oauth_connections").some((r) => r.user_id === uid && r.provider === provider)) return false;
    return epoch === null || epoch === undefined || this.epoch(uid) <= epoch;
  }

  // ------------------------------------------------------------------------------------------ the RPCs
  rpcs: Record<string, (a: any) => any> = {
    oauth_state_use: (a) => { if (!a.p_state || a.p_state.length < 16) return false; if (this.spent.has(a.p_state)) return false; this.spent.add(a.p_state); return true; },
    oauth_connect_commit: (a) => {
      if (!a.p_user || !a.p_secret || !["google_career", "gmail", "microsoft"].includes(a.p_provider)) return "invalid";
      const addr = String(a.p_email ?? "").trim().toLowerCase() || null;
      const fam = a.p_provider === "microsoft" ? ["microsoft"] : ["google_career", "gmail"];
      if (addr && this.rows("user_oauth_connections").some((r) => fam.includes(r.provider) && r.user_id !== a.p_user && String(r.email ?? "").trim().toLowerCase() === addr)) return "taken";
      if (!this.users.has(a.p_user)) return "gone";
      const name = `oauth_${a.p_provider}_${a.p_user}`;
      this.vault.set(name, a.p_secret);
      const rows = this.rows("user_oauth_connections");
      const i = rows.findIndex((r) => r.user_id === a.p_user && r.provider === a.p_provider);
      const row = { user_id: a.p_user, provider: a.p_provider, vault_name: name, email: a.p_email, scopes: a.p_scopes, connected_at: a.p_now };
      if (i >= 0) rows[i] = row; else rows.push(row);
      return "connected";
    },
    oauth_vault_read: (a) => this.vault.get(a.p_name) ?? null,
    oauth_vault_refresh: (a) => { if (!this.rows("user_oauth_connections").some((r) => r.vault_name === a.p_name)) return false; this.vault.set(a.p_name, a.p_secret); return true; },
    career_outlook_store_messages: (a) => {
      if (!this.live(a.p_user, "microsoft", a.p_epoch)) return -1;
      const rows = this.rows("career_outlook_messages");
      for (const m of a.p_rows) { const i = rows.findIndex((r) => r.user_id === a.p_user && r.message_hash === m.message_hash); const row = { user_id: a.p_user, ...m }; if (i >= 0) rows[i] = row; else rows.push(row); }
      return a.p_rows.length;
    },
    career_mail_record_events: (a) => {
      if (!this.live(a.p_user, "google_career", a.p_epoch)) return { ok: false };
      const rows = this.rows("career_mail_events"), stored: string[] = [];
      for (const e of a.p_rows) if (!rows.some((r) => r.user_id === a.p_user && r.message_hash === e.message_hash)) { rows.push({ user_id: a.p_user, ...e }); stored.push(e.message_hash); }
      return { ok: true, stored };
    },
    career_mail_save_draft: (a) => {
      if (!this.live(a.p_user, "google_career", a.p_epoch)) return "gone";
      const rows = this.rows("career_mail_drafts");
      if (rows.some((r) => r.user_id === a.p_user && r.draft_key === a.p_row.draft_key)) return "duplicate";
      rows.push({ user_id: a.p_user, ...a.p_row });
      return "saved";
    },
    career_mail_save_cursor: (a) => {
      if (!this.live(a.p_user, "google_career", null)) return false;
      const rows = this.rows("career_mail_cursors"), i = rows.findIndex((r) => r.user_id === a.p_user);
      const row = { user_id: a.p_user, read_through: a.p_read_through };
      if (i >= 0) rows[i] = row; else rows.push(row);
      return true;
    },
  };
  rpcsOld: Record<string, (a: any) => any> = {
    oauth_vault_store: (a) => { this.vault.set(a.p_name, a.p_secret); return null; },
  };
  async rpc(name: string, a: any) {
    this.calls.push(`rpc:${name}`);
    if (this.missing.has(name)) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache` } };
    const f = this.rpcs[name] ?? this.rpcsOld[name];
    if (!f) throw new Error(`MemDb: rpc ${name} is not here`);
    try { return { data: f(a), error: null }; } catch (e) { return { data: null, error: { message: String((e as Error).message) } }; }
  }
  from(table: string) { return new MemQ(this, table); }
}

class MemQ {
  filters: ((r: Row) => boolean)[] = [];
  op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  payload: any = null; conflict: string[] = []; single = false; lim = Infinity; ignoreDup = false;
  constructor(public db: MemDb, public table: string) {}
  returning = false;
  select(_c?: string) { if (this.op !== "select") this.returning = true; return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  order() { return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.single = true; return this; }
  insert(p: any) { this.op = "insert"; this.payload = p; return this; }
  upsert(p: any, o?: { onConflict?: string; ignoreDuplicates?: boolean }) { this.op = "upsert"; this.payload = p; this.conflict = (o?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean); this.ignoreDup = !!o?.ignoreDuplicates; return this; }
  update(p: any) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  then(ok: (v: any) => any, no?: (e: any) => any) { return Promise.resolve().then(() => this.run()).then(ok, no); }
  run() {
    this.db.calls.push(`${this.op}:${this.table}`);
    const rows = this.db.rows(this.table);
    const hit = (r: Row) => this.filters.every((f) => f(r));
    if (this.op === "select") {
      const got = rows.filter(hit).slice(0, this.lim).map((r) => structuredClone(r));
      return { data: this.single ? (got[0] ?? null) : got, error: null };
    }
    if (this.op === "insert" || this.op === "upsert") {
      const out: Row[] = [];
      for (const p of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        const i = this.conflict.length ? rows.findIndex((r) => this.conflict.every((c) => r[c] === p[c])) : -1;
        if (i >= 0) { if (!this.ignoreDup) { rows[i] = { ...rows[i], ...p }; out.push(rows[i]); } } else { rows.push({ ...p }); out.push(p); }
      }
      return { data: this.returning ? out.map((r) => structuredClone(r)) : null, error: null };
    }
    if (this.op === "update") { for (const r of rows) if (hit(r)) Object.assign(r, this.payload); return { data: null, error: null }; }
    this.db.t[this.table] = rows.filter((r) => !hit(r));
    return { data: null, error: null };
  }
}
