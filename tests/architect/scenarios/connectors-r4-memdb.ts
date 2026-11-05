// Connectors round 4: round 3's in-memory project (connectors-r3-memdb.ts) with what round 4 changed in the database,
// written again here so the battery runs without Postgres (flow-scenarios-connectors-r4.test.ts runs the real migration):
//   - career_outbox, once per (person, key) as its unique constraint has it (a second insert is Postgres's 23505);
//   - the Google disconnect (and a switch to another address) deletes every undelivered text made from that mailbox, the
//     offers of the drafts it deletes and the pending "which application?" asks (20261105130000's google_career_disconnect_erase);
//   - career_mail_text_enqueue queues a text made from mail only while the career Google row is there;
//   - oauth_connect_commit stamps the grant it stores, and oauth_vault_refresh writes only over the same grant (and, as
//     round 2 has it, only while the row is there and for the row's own address);
//   - an account deleted: its rows cascade, its connection rows' Vault entries go with them (20261012060000).
// R4_PREFIX=1: the project as it was before round 4 (the disconnect deletes only the deadline reminder, no guarded queue,
// no grant stamp), so the battery can be shown to fail without the fix.
// deno-lint-ignore-file no-explicit-any
import { MemDb } from "./connectors-r3-memdb.ts";

export const PREFIX = Deno.env.get("R4_PREFIX") === "1";
const MAIL_TEXT = /^(status:([0-9a-f]{64}|deadline:[0-9a-f]{64}|confirmed:[^:]+|which:[0-9a-f]{64})|brief:[0-9a-f]{64}:[^:]+)$/;
const OFFER = /^followup:(followup|thank_you):/;

export class MemDb4 extends MemDb {
  seq = 0;
  constructor() {
    super();
    if (PREFIX) this.missing.add("career_mail_text_enqueue");
    const r3 = this.rpcs;
    this.rpcs = {
      ...r3,
      oauth_connect_commit: (a) => {
        const was = this.rows("user_oauth_connections").find((r) => r.user_id === a.p_user && r.provider === a.p_provider);
        let secret = a.p_secret;
        if (!PREFIX) { try { const j = JSON.parse(a.p_secret); if (j && typeof j === "object" && !Array.isArray(j)) secret = JSON.stringify({ ...j, grant: crypto.randomUUID() }); } catch { /* as given */ } }
        const out = r3.oauth_connect_commit({ ...a, p_secret: secret });
        if (out === "connected" && was && norm(was.email) !== norm(a.p_email)) this.mailboxGone(a.p_user, a.p_provider);
        return out;
      },
      oauth_vault_refresh: (a) => {
        const conn = this.rows("user_oauth_connections").find((r) => r.vault_name === a.p_name && a.p_name === `oauth_${r.provider}_${r.user_id}`);
        if (!conn) return false;
        let tok: any = null;
        try { tok = JSON.parse(a.p_secret); } catch { tok = null; }
        const tokEmail = norm(tok?.email);
        if (tokEmail && tokEmail !== norm(conn.email)) return false;
        if (!PREFIX) {
          let held: any = null;
          try { held = JSON.parse(this.vault.get(a.p_name) ?? ""); } catch { held = null; }
          if (held?.grant && tok?.grant !== held.grant) return false;
        }
        this.vault.set(a.p_name, a.p_secret);
        return true;
      },
      career_mail_text_enqueue: (a) => {
        if (!a.p_user || !MAIL_TEXT.test(String(a.p_key ?? "")) || !a.p_at) return "invalid";
        if (!this.rows("user_oauth_connections").some((r) => r.user_id === a.p_user && r.provider === "google_career") || !this.mailboxIs(a.p_user, a.p_mailbox)) return "gone";
        return this.outboxInsert({ user_id: a.p_user, key: a.p_key, kind: a.p_kind, text: a.p_text, deliver_at: a.p_at }) ? "queued" : "duplicate";
      },
      // Round 3's writes; with p_mailbox (round 4's overloads), refused for another address than the one the run read.
      career_mail_record_events: (a) => !PREFIX && a.p_mailbox !== undefined && !this.mailboxIs(a.p_user, a.p_mailbox) ? { ok: false } : r3.career_mail_record_events(a),
      career_mail_save_draft: (a) => !PREFIX && a.p_mailbox !== undefined && !this.mailboxIs(a.p_user, a.p_mailbox) ? "gone" : r3.career_mail_save_draft(a),
      career_outlook_store_messages: (a) => !PREFIX && a.p_mailbox !== undefined && !this.mailboxIs(a.p_user, a.p_mailbox, "microsoft") ? -1 : r3.career_outlook_store_messages(a),
      career_mail_save_cursor: (a) => !PREFIX && a.p_mailbox !== undefined && !this.mailboxIs(a.p_user, a.p_mailbox) ? false : r3.career_mail_save_cursor(a),
    };
  }
  mailboxIs(uid: string, mailbox: string | null | undefined, provider = "google_career") {
    if (mailbox === null || mailbox === undefined) return true;
    return this.rows("user_oauth_connections").some((r) => r.user_id === uid && r.provider === provider && norm(r.email) === norm(mailbox));
  }
  // ------------------------------------------------------------------------------------------ the outbox
  outbox() { return this.rows("career_outbox"); }
  outboxInsert(p: any): boolean {
    if (!this.users.has(p.user_id)) throw new Error("insert or update on table career_outbox violates foreign key constraint");
    if (this.outbox().some((r) => r.user_id === p.user_id && r.key === p.key)) return false;
    this.outbox().push({ id: String(++this.seq), status: "queued", delivered_at: null, attempts: 0, ...p });
    return true;
  }
  from(table: string) {
    const q: any = super.from(table);
    if (table !== "career_outbox") return q;
    q.insert = (p: any) => ({
      then: (ok: any, no?: any) => Promise.resolve().then(() => {
        this.calls.push("insert:career_outbox");
        try {
          for (const x of Array.isArray(p) ? p : [p]) if (!this.outboxInsert(x)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "career_outbox_once"' } };
          return { data: null, error: null };
        } catch (e) { return { data: null, error: { code: "23503", message: String((e as Error).message) } }; }
      }).then(ok, no),
    });
    return q;
  }
  // ------------------------------------------------------------------------------------------ what the triggers do
  // What a Google mailbox leaving the account deletes from the outbox and the asks (round 4; before it, the deadline only).
  mailboxGone(uid: string, provider: string) {
    if (provider === "microsoft") { for (const x of ["career_outlook_messages", "career_outlook_state"]) this.t[x] = this.rows(x).filter((r) => r.user_id !== uid); return; }
    if (provider !== "google_career") return;
    const tables = ["career_mail_events", "career_mail_drafts", "career_mail_cursors"];
    for (const x of tables) this.t[x] = this.rows(x).filter((r) => r.user_id !== uid);
    this.t.career_outbox = this.outbox().filter((r) => !(r.user_id === uid && r.delivered_at === null &&
      (PREFIX ? /^status:deadline:/.test(r.key) : MAIL_TEXT.test(r.key) || OFFER.test(r.key))));
    if (!PREFIX) this.t.career_watch_kv = this.rows("career_watch_kv").filter((r) => !(r.user_id === uid && /^career:confirm-ask:/.test(r.key) && r.value?.state === "pending"));
  }
  disconnect(uid: string, provider: "google_career" | "microsoft") {
    const had = this.rows("user_oauth_connections").some((r) => r.user_id === uid && r.provider === provider);
    super.disconnect(uid, provider);
    if (had) this.mailboxGone(uid, provider);
  }
  // The auth user deleted: every row of theirs cascades, and the Vault entries of their connection rows with them.
  deleteUser(uid: string) {
    this.users.delete(uid);
    for (const r of this.rows("user_oauth_connections").filter((x) => x.user_id === uid)) this.vault.delete(r.vault_name);
    for (const x of Object.keys(this.t)) this.t[x] = this.rows(x).filter((r) => r.user_id !== uid);
  }
}
const norm = (e: unknown) => String(e ?? "").trim().toLowerCase();
