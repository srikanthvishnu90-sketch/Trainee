// SPEC C.2 / D-049: the reads the File card's resolver makes in the delivery run, and nothing else. trainee-deliver imports this
// instead of file_service.ts and telegram_jobs.ts, whose import graphs carry the router bundle (a 3 MB file) and some 60 other
// modules a delivery run never uses. Every read here is the same query, with the same rules, as the module it mirrors; the parity
// test in tests/architect/file-card.test.ts runs both over the same rows.
//   files.get          file_service.ts createFileService().get over supabaseFileKindStore (career_watch_kv "tf:file:<id>")
//   recall, recallList, recallListMeta, prepared, applied   telegram_jobs.ts supabaseJobStore
// Read only: nothing here writes, and a read that errors throws (the resolver then sends the link as before).
import type { CardRecord, RolesReads } from "./file_card.ts";

// deno-lint-ignore no-explicit-any
export function fileCardReads(admin: any, now: () => number): { files: { get(userId: string, id: string): Promise<{ state: string; rec?: CardRecord }> }; jobs: RolesReads } {
  // deno-lint-ignore no-explicit-any
  const must = (r: any, what: string) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  const kv = async (userId: string, key: string) => (must(await admin.from("career_watch_kv").select("value").eq("user_id", userId).eq("key", key).maybeSingle(), "read"))?.value ?? null;
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
    jobs: {
      async recall(userId, ref) { const v = await kv(userId, `tg:job:${ref}`); return v?.job ? { job: v.job } : null; },
      async recallList(userId, listId) { const v = await kv(userId, `tg:list:${listId}`); return Array.isArray(v) ? v.map(String) : null; },
      async recallListMeta(userId, listId) { const v = await kv(userId, `tg:listmeta:${listId}`); return v && v.kind === "results" ? v : null; },
      async prepared(userId, jobId) {
        const rows = must(await admin.from("career_apply_prepared").select("id,job_id,company,url,payload,payload_hash,card_lines,state").eq("user_id", userId).eq("job_id", jobId)
          .in("state", ["ready", "shown"]).order("created_at", { ascending: false }).limit(1), "read the prepared application");
        return rows?.[0] ?? null;
      },
      async applied(userId, jobId) {
        const rows = must(await admin.from("career_apply_jobs").select("job_id").eq("user_id", userId).eq("job_id", jobId).limit(1), "read the queue");
        return !!rows?.length;
      },
    },
  };
}
