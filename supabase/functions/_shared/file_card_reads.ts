// SPEC C.2 / D-049: the reads the File card's resolver makes in the delivery run, and nothing else. trainee-deliver imports this
// instead of file_service.ts, whose import graph carries the router bundle (a 3 MB file) and some 60 other modules a delivery run
// never uses. The read here is the same query, with the same rules, as the one it mirrors; the parity test in
// tests/architect/file-card.test.ts runs both over the same rows.
//   files.get          file_service.ts createFileService().get over supabaseFileKindStore (career_watch_kv "tf:file:<id>")
// Read only: nothing here writes, and a read that errors throws (the resolver then sends the link as before).
import type { CardRecord } from "./file_card.ts";

// deno-lint-ignore no-explicit-any
export function fileCardReads(admin: any, now: () => number): { files: { get(userId: string, id: string): Promise<{ state: string; rec?: CardRecord }> } } {
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  return {
    files: {
      async get(u, id) {
        if (!u || !/^[0-9a-f]{10}$/.test(id)) return { state: "missing" };
        const rows = must(await admin.from("career_watch_kv").select("value").eq("user_id", u).eq("key", `tf:file:${id}`).limit(1), "read the file");
        const rec = rows?.[0]?.value;
        if (!rec || rec.userId !== u || rec.id !== id || (rec.kind === "application_proof" && rec.data?.from_record !== true) || (rec.kind === "application_review" && rec.data?.from_prepared !== true)) return { state: "missing" };
        if (rec.revoked_at !== null) return { state: "revoked", rec };
        return now() >= rec.expires_at ? { state: "expired", rec } : { state: "ok", rec };
      },
    },
  };
}
