// D-072 (files reachable): the deployed wiring of the File family maker (file_family_make.ts) in agent-chat.
import type { FileService } from "./file_service.ts";
import type { FamilyMakeDeps } from "./file_family_make.ts";
import { recordsFamilies, supabaseDigestWriter } from "./file_family_actions.ts";
import { supabaseRecords } from "./file_family_records.ts";
import { planMaterialRecords, supabasePlanMaterialStore } from "./file_family_records_materials.ts";
import { messageRecords, outreachDrafts } from "./file_family_message.ts";

// The same record readers the File server serves these pages from (trainee-file/deps.ts), over the service role, keyed by the person.
// Only `load` is used here: no post runs from the chat.
// deno-lint-ignore no-explicit-any
export function supabaseFamilyMaker(admin: any, files: Pick<FileService, "createFamily">, now: () => number = Date.now): FamilyMakeDeps {
  // deno-lint-ignore no-explicit-any
  const first = async (q: any, what: string): Promise<string | null> => { const r = await q; if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data?.[0] ? String(Object.values(r.data[0])[0]) : null; };
  return {
    files,
    records: {
      ...recordsFamilies({ read: supabaseRecords(admin), digest: supabaseDigestWriter(admin), now }),
      ...planMaterialRecords(supabasePlanMaterialStore(admin), now),
      "F-12": messageRecords({ store: outreachDrafts(admin), rail: null }),
    },
    refs: {
      latestDoc: (u) => first(admin.from("career_material_versions").select("doc_key").eq("user_id", u).order("created_at", { ascending: false }).limit(1), "read the document versions"),
      // The newest draft waiting for the person's decision, else the newest draft.
      latestDraft: async (u) => await first(admin.from("career_outreach_drafts").select("id").eq("user_id", u).eq("status", "shown").order("created_at", { ascending: false }).limit(1), "read the drafts")
        ?? await first(admin.from("career_outreach_drafts").select("id").eq("user_id", u).order("created_at", { ascending: false }).limit(1), "read the drafts"),
    },
  };
}
