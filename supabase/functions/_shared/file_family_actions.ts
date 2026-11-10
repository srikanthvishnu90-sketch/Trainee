// Item 6, S5 (task f-s5): the File server's side of the seven record-backed families (file_family_records.ts).
//   view(userId, family)  the family's view, read from the person's records now (never a stored copy).
//   act(userId, family, action, fields)  the one state change these pages make: pausing or resuming the weekly brief (F-14),
//     a POST that carries the page token (the handler checks it before calling). It changes only the person's own
//     career_digest_prefs row, keeps every record, and sends nothing. Every other decision on these pages needs the person's own
//     words, so it opens the chat with the question filled in (file_family_serve.ts) and changes nothing here.
import type { FamilyView, LiveFamily, Records } from "./file_family_records.ts";
import { viewOf } from "./file_family_records.ts";

export const LIVE_POSTS: Partial<Record<LiveFamily, Set<string>>> = { "F-14": new Set(["briefpause", "briefresume"]) };
export interface ActResult { ok: boolean; title: string; lines: string[] }
export interface DigestWriter { setEnabled(userId: string, enabled: boolean): Promise<void> }
export interface FamilySource {
  view(userId: string, family: LiveFamily, o: { now: number; tz: string | null; token: string | null }): Promise<FamilyView>;
  act(userId: string, family: LiveFamily, action: string, fields: URLSearchParams): Promise<ActResult>;
}

export function familySource(o: { read: (userId: string, family: LiveFamily, x: { now: number; tz: string | null }) => Promise<Records>; digest: DigestWriter }): FamilySource {
  return {
    async view(userId, family, x) {
      try { return viewOf(family, await o.read(userId, family, x), { token: x.token }); }
      catch (e) {
        console.error(`file family ${family}: records unreadable:`, (e as Error)?.message ?? e);
        // Unreadable is said; nothing on this page changed anything, so it can say so.
        return { state: { state: "error", family, title: "Could not read your records", nothingSent: true, recover: { label: "Reload", effect: "navigate", href: "?" } } };
      }
    },
    async act(userId, family, action) {
      if (!LIVE_POSTS[family]?.has(action)) return { ok: false, title: "Not done", lines: ["That is not something this page can do. Nothing was changed or sent."] };
      const on = action === "briefresume";
      try { await o.digest.setEnabled(userId, on); }
      catch (e) {
        console.error("file family F-14: weekly brief setting not saved:", (e as Error)?.message ?? e);
        return { ok: false, title: on ? "Not resumed" : "Not paused", lines: ["The setting could not be saved, so nothing changed. Try again in a minute."] };
      }
      return on ? { ok: true, title: "Weekly brief resumed", lines: ["Your next brief comes on its usual day. Nothing else changed."] }
        : { ok: true, title: "Weekly brief paused", lines: ["Every record is kept. No brief is sent to you until you resume it here or in the chat."] };
    },
  };
}

// The writer over Supabase: the person's own row only (service role, keyed by the signed-in user).
// deno-lint-ignore no-explicit-any
export function supabaseDigestWriter(admin: any): DigestWriter {
  return {
    async setEnabled(userId, enabled) {
      const r = await admin.from("career_digest_prefs").upsert({ user_id: userId, enabled, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (r.error) throw new Error(r.error.message);
    },
  };
}
