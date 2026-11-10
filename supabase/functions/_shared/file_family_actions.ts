// Item 6, S5 (task f-s5): the File server's side of the record-backed families (F-01 F-02 F-03 F-08 F-13 F-14 F-14n F-15) (file_family_records.ts), in the shared S0 hook's
// shape (file_family_serve.ts FamilyRecords, one per family in FileDeps.familyRecords).
//   load(userId, rec)  the family's view, read from the person's records now (never a stored copy). With nothing on record, a C.24
//     state ({ state }) that says what is missing and opens the chat. Unreadable records: null (the hook draws the error state).
//   post  the one state change these pages make: pausing or resuming the weekly brief (F-14, briefpause / briefresume), after the
//     File server's cookie, page-token and same-site checks. It changes only the person's own career_digest_prefs row, keeps every
//     record, and sends nothing. Every other decision on these pages needs the person's own words: it opens the chat with the
//     question filled in (file_family_serve.ts) and changes nothing here.
import type { FamilyPostResult, FamilyRecords } from "./file_family_serve.ts";
import { type LiveFamily, LIVE_FAMILIES, type Records, viewOf } from "./file_family_records.ts";

// The actions SERVED_POSTS lists for these families (file_family_serve.ts); the drawn form's token is replaced by the page's own.
export const LIVE_POSTS: Partial<Record<LiveFamily, ReadonlySet<string>>> = { "F-14": new Set(["briefpause", "briefresume"]) };
export const DRAWN_TOKEN = "page"; // a placeholder: servedAct puts this page's token on every served post
export interface DigestWriter { setEnabled(userId: string, enabled: boolean): Promise<void> }
export interface RecordsDeps {
  read: (userId: string, family: LiveFamily, x: { now: number; tz: string | null }) => Promise<Records>;
  digest: DigestWriter; now: () => number; timeZone?: (userId: string) => Promise<string | null>;
}

async function brief(d: RecordsDeps, userId: string, on: boolean): Promise<FamilyPostResult> {
  try { await d.digest.setEnabled(userId, on); }
  catch (e) {
    console.error("file family F-14: weekly brief setting not saved:", (e as Error)?.message ?? e);
    return { ok: false, title: on ? "Not resumed" : "Not paused", lines: ["The setting could not be saved, so nothing changed. Try again in a minute."] };
  }
  return on ? { ok: true, title: "Weekly brief resumed", lines: ["Your next brief comes on its usual day. Nothing else changed."] }
    : { ok: true, title: "Weekly brief paused", lines: ["Every record is kept. No brief is sent to you until you resume it here or in the chat."] };
}

export function recordsFamily(family: LiveFamily, d: RecordsDeps): FamilyRecords {
  return {
    async load(userId) {
      try {
        const tz = d.timeZone ? await d.timeZone(userId).catch(() => null) : null;
        const v = viewOf(family, await d.read(userId, family, { now: d.now(), tz }), { token: DRAWN_TOKEN });
        return "view" in v ? { view: v.view, asOf: new Date(d.now()).toISOString() } : { state: v.state, asOf: new Date(d.now()).toISOString() };
      } catch (e) {
        console.error(`file family ${family}: records unreadable:`, (e as Error)?.message ?? e);
        return null;
      }
    },
    ...(family === "F-14" ? { post: { briefpause: (u: string) => brief(d, u, false), briefresume: (u: string) => brief(d, u, true) } } : {}),
  };
}
// The lines for FileDeps.familyRecords.
export const recordsFamilies = (d: RecordsDeps): Record<LiveFamily, FamilyRecords> =>
  Object.fromEntries(LIVE_FAMILIES.map((f) => [f, recordsFamily(f, d)])) as Record<LiveFamily, FamilyRecords>;

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
