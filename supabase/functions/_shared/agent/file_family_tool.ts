// D-072 (files reachable): open_record_file, the chat's path to the record-backed File families (file_family_make.ts). The model
// names the family only; code reads the person's records, makes the File only when they hold something, and mints its link, which
// rides ctx.turn.fileLinks to the channel like create_file's (the model never sees or writes it). The result's `holds` is what the
// page shows, from the same view the File server draws, so the reply says what the File holds and nothing else. A File with nothing
// on record is not made: the reply says what is missing (never a hollow File, D-024; D-066 P6).
import type { ToolSpec } from "./loop.ts";
import { FAMILY_NAMES, type FamilyMakeDeps, makeFamilyFile } from "../file_family_make.ts";
import { MAX_FILES_PER_TURN } from "./file_tool.ts";

export const FAMILY_FILE_TOOL = "open_record_file";
export function familyFileTool(d: FamilyMakeDeps, ttlHours = 168): ToolSpec {
  return {
    name: FAMILY_FILE_TOOL, effect: "write_own",
    description: "Make the person's own File page from their records, when they ask to see, open or get one of these: career_brief (their aim, constraints and open questions), "
      + "profile_facts (what they confirmed and what is unknown), path_comparison, search_plan (their saved search plan, to approve on the page), materials (their tailored resume or letter versions), "
      + "answer_library (answers they gave employers), message_review (their newest outreach draft, to approve on the page), interview_hub (their next interview), weekly_brief (this week), "
      + "negotiation_plan (from the offer they told you), offer_comparison (the offers they told you). Give only the family: everything on the page comes from their records, never from you. "
      + "The result's holds lists what the page shows: say in a sentence or two what it holds, using only those lines. If it was not made (nothing on record), say what is missing plainly and do not say a File was made. "
      + "The link is added to your reply by the system: write no URL. Nothing on the page is approved or sent until they approve the exact item there.",
    input_schema: { type: "object", properties: { family: { type: "string", enum: [...FAMILY_NAMES], description: "Which File" } }, required: ["family"] },
    run: async (i, c) => {
      const links = c.turn?.fileLinks;
      if (links && links.length >= MAX_FILES_PER_TURN) throw new Error(`not made: at most ${MAX_FILES_PER_TURN} files in one reply`);
      const r = await makeFamilyFile(d, c.userId, String(i?.family ?? ""));
      if (!r.ok) throw new Error(r.error);
      if (c.turn) (c.turn.fileLinks ??= []).push(r.url);
      return { created: true, family: r.family, title: r.title, holds: r.holds, expires_in_hours: ttlHours, note: "The link is added after your reply. Do not write a URL. Say only what holds lists." };
    },
  };
}
