// The approval code for a results page (owner, 2026-11-01): Approve on a hosted page needs the person's identity bound to the
// link. The link only says WHICH list; the session it opens is bound to one account (file_session.ts); and Approve also needs a
// one-time code that Trainee sends into that account's own chat (their texting thread: iMessage, SMS, WhatsApp or Telegram,
// through the outbox the channels already deliver from). Never a password, and the code is never asked for IN chat.
//
// A code is bound to one session (its id's SHA-256) and one account: it cannot be used from another session, by another
// account, for any selection but the one it was sent for, after its expiry, twice, or while the person has had MAX_TRIES wrong codes in
// the last 10 minutes (across codes and sessions). Only its SHA-256 is stored.
export const CODE_TTL_MS = 10 * 60_000;
export const MAX_TRIES = 5; // wrong codes per person per LOCK_WINDOW_MS, across codes and sessions
export const LOCK_WINDOW_MS = 10 * 60_000;
export const MAX_SENDS = 3; // per session

// What a code approves: the exact selection (each row's ref and the payload tag shown for it). The code's row and hash carry it,
// and an approve for any other selection (another posting, more or fewer rows, a changed payload) is refused.
export interface Scope { items: { ref: string; tag: string; label: string }[] }
export type CodeCheck = "ok" | "wrong" | "expired" | "locked" | "none" | "used" | "scope";
export interface CodeRow { user_id: string; session: string; scope: string; hash: string; expires_at: number; sends: number; used_at: number | null }
export interface CodeStore {
  get(userId: string, session: string): Promise<CodeRow | null>;
  put(row: CodeRow): Promise<void>;
  // Once only: true for the first caller for this (account, code row), the way an insert on a unique key is.
  use(userId: string, session: string, hash: string, at: number): Promise<boolean>;
  // Wrong codes for the person, counted atomically: each wrong try is its own row (never a read-then-write counter, which parallel
  // requests overwrite), and the count is of the rows in the window. addFail returns the count including the one it just added.
  addFail(userId: string, at: number): Promise<number>;
  failCount(userId: string, since: number): Promise<number>;
}
// Into the person's own chat thread. false: it could not be queued.
export type ChatSend = (userId: string, o: { key: string; text: string; at: number }) => Promise<boolean>;

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const newCode = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
const scopeHash = async (s: Scope) => await sha(`scope1|${s.items.map((i) => `${i.ref}:${i.tag}`).sort().join(",")}`);
const oneLine = (x: string) => x.replace(/\s+/g, " ").trim().slice(0, 80);
// "Apply to Acme Web — Frontend Engineering Intern; Globex — Frontend Intern and 2 more"
export const scopeWords = (s: Scope) => {
  const names = s.items.map((i) => oneLine(i.label));
  return `Apply to ${names.slice(0, 3).join("; ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
};
export const codeText = (code: string, s: Scope) => `Trainee approval code for: ${scopeWords(s)}. Your code is ${code}. Type it on the page to approve exactly that. It works once, for 10 minutes. If you didn't ask for it, ignore this: nothing is sent without it.`;

export interface ApprovalCodes {
  send(userId: string, session: string, now: number, scope: Scope): Promise<{ ok: true } | { ok: false; why: "too_many" | "not_sent" | "locked" }>;
  check(userId: string, session: string, typed: unknown, now: number, scope: Scope): Promise<CodeCheck>;
}
export function approvalCodes(store: CodeStore, chat: ChatSend, o: { code?: () => string } = {}): ApprovalCodes {
  const make = o.code ?? newCode;
  const lockedNow = async (userId: string, now: number) => (await store.failCount(userId, now - LOCK_WINDOW_MS)) >= MAX_TRIES;
  const fail = async (userId: string, now: number): Promise<CodeCheck> => (await store.addFail(userId, now)) >= MAX_TRIES ? "locked" : "wrong";
  return {
    async send(userId, session, now, scope) {
      if (!scope.items.length) return { ok: false, why: "not_sent" };
      if (await lockedNow(userId, now)) return { ok: false, why: "locked" };
      const cur = await store.get(userId, session);
      const sends = cur && !cur.used_at && now < cur.expires_at ? cur.sends : 0;
      if (sends >= MAX_SENDS) return { ok: false, why: "too_many" };
      const code = make(), sc = await scopeHash(scope);
      await store.put({ user_id: userId, session, scope: sc, hash: await sha(`${userId}|${session}|${sc}|${code}`), expires_at: now + CODE_TTL_MS, sends: sends + 1, used_at: null });
      const key = `status:approve-code:${(await sha(`${session}|${now}|${sends}`)).slice(0, 24)}`;
      return (await chat(userId, { key, text: codeText(code, scope), at: now }).catch(() => false)) ? { ok: true } : { ok: false, why: "not_sent" };
    },
    async check(userId, session, typed, now, scope) {
      const code = String(typed ?? "").replace(/[\s-]/g, "");
      if (await lockedNow(userId, now)) return "locked";
      const row = await store.get(userId, session);
      if (!row || row.user_id !== userId || row.session !== session) return "none";
      if (row.used_at) return "used";
      if (now >= row.expires_at) return "expired";
      // The code is judged against the selection it was sent for; then that selection must be the one being approved.
      if (!/^\d{6}$/.test(code) || await sha(`${userId}|${session}|${row.scope}|${code}`) !== row.hash) return await fail(userId, now);
      if (row.scope !== await scopeHash(scope)) return "scope";
      if (!(await store.use(userId, session, row.hash, now))) return "used";
      await store.put({ ...row, used_at: now });
      return "ok";
    },
  };
}

export function memoryCodeStore(): CodeStore & { rows(): CodeRow[] } {
  const m = new Map<string, CodeRow>(), used = new Set<string>(), fails: { u: string; at: number }[] = [];
  // No await between the push and the count: each call sees every earlier wrong try, as the database's insert-then-count does.
  const count = (u: string, since: number) => fails.filter((f) => f.u === u && f.at >= since).length;
  return {
    async addFail(u, at) { fails.push({ u, at }); return count(u, at - LOCK_WINDOW_MS); },
    async failCount(u, since) { return count(u, since); },
    rows: () => [...m.values()].map((r) => ({ ...r })),
    async get(u, s) { const r = m.get(`${u}|${s}`); return r ? { ...r } : null; },
    async put(r) { m.set(`${r.user_id}|${r.session}`, { ...r }); },
    async use(u, s, h) { const k = `${u}|${s}|${h}`; if (used.has(k)) return false; used.add(k); return true; },
  };
}

// Supabase: the code row in career_watch_kv (per person, key tf:approve:<session hash>); "used" is an insert on the table's
// unique (user_id, key), so exactly one approval wins; the chat message is a career_outbox row the channels deliver.
// deno-lint-ignore no-explicit-any
export function supabaseCodeStore(admin: any): CodeStore {
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  const key = (s: string) => `tf:approve:${s.slice(0, 64)}`;
  return {
    async get(u, s) {
      const v = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", key(s)).maybeSingle(), "read the approval code")?.value;
      return v && v.user_id === u && v.session === s ? v as CodeRow : null;
    },
    async put(r) { must(await admin.from("career_watch_kv").upsert({ user_id: r.user_id, key: key(r.session), value: r, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" }), "save the approval code"); },
    // One row per wrong try (a unique key each), then a count of the person's rows in the window: concurrent wrong codes each
    // insert their own row, so none is lost, and each count includes every insert committed before it.
    async addFail(u, at) {
      must(await admin.from("career_watch_kv").insert({ user_id: u, key: `tf:approve-fail:${at}:${crypto.randomUUID()}`, value: { at }, updated_at: new Date(at).toISOString() }), "count the wrong code");
      return await this.failCount(u, at - LOCK_WINDOW_MS);
    },
    async failCount(u, since) {
      const rows = must(await admin.from("career_watch_kv").select("key").eq("user_id", u).like("key", "tf:approve-fail:%").gte("updated_at", new Date(since).toISOString()).limit(1000), "read the wrong-code count");
      return Array.isArray(rows) ? rows.length : 0;
    },
    async use(u, _s, h, at) {
      const r = await admin.from("career_watch_kv").insert({ user_id: u, key: `tf:approve-used:${h.slice(0, 64)}`, value: { at: new Date(at).toISOString() }, updated_at: new Date(at).toISOString() });
      if (!r.error) return true;
      if (r.error.code === "23505" || /duplicate key/i.test(r.error.message)) return false;
      throw new Error(`use the approval code: ${r.error.message}`);
    },
  };
}
// deno-lint-ignore no-explicit-any
export const supabaseChatSend = (admin: any): ChatSend => async (userId, m) => {
  const r = await admin.from("career_outbox").insert({ user_id: userId, key: m.key, kind: "status", text: m.text, deliver_at: new Date(m.at).toISOString() });
  if (r.error) { console.error(`approval code: not queued (${r.error.message})`); return false; }
  return true;
};
