// D-062: the database side of the capability tools (agent/capability_tools.ts).
//   grant     the person's career Google grant: connected (and allowed to read mail) or not, and the mailbox it reads. One
//             Google account per person (provider google_career, one row): Trainee does not read several accounts.
//   snapshot  the application record last shown (career_watch_kv, key career:application_record), so the next record names what
//             changed (G9). An erase deletes it with every other key of the person's (career_watch_kv, 20261020120100).
import type { Snapshot } from "./career_application_record.ts";

const READ = "https://www.googleapis.com/auth/gmail.readonly";
export const SNAPSHOT_KEY = "career:application_record";

// deno-lint-ignore no-explicit-any
export function supabaseCapabilityStores(admin: any) {
  return {
    async grant(userId: string): Promise<{ status: "ok" | "not_connected" | "not_allowed"; mailbox: string | null }> {
      const { data, error } = await admin.from("user_oauth_connections").select("email,scopes").eq("user_id", userId).eq("provider", "google_career").maybeSingle();
      if (error) throw new Error(`read the career grant: ${error.message}`);
      if (!data) return { status: "not_connected", mailbox: null };
      const mailbox = String(data.email ?? "").trim().toLowerCase() || null;
      return { status: String(data.scopes ?? "").split(/[\s,]+/).includes(READ) ? "ok" : "not_allowed", mailbox };
    },
    snapshot: {
      async get(userId: string): Promise<Snapshot | null> {
        const { data, error } = await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", SNAPSHOT_KEY).maybeSingle();
        if (error) throw new Error(`read the last record shown: ${error.message}`);
        return data?.value && Array.isArray(data.value.items) ? data.value as Snapshot : null;
      },
      async set(userId: string, s: Snapshot): Promise<void> {
        const { error } = await admin.from("career_watch_kv").upsert({ user_id: userId, key: SNAPSHOT_KEY, value: s }, { onConflict: "user_id,key" });
        if (error) throw new Error(`keep the record shown: ${error.message}`);
      },
    },
  };
}
