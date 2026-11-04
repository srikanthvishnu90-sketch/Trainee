// create_file: the model hands over a kind and its data; code validates it against the kind's schema, stores it for this person, and
// puts the signed link in the reply. The tool never shows the model the link, so the model cannot write or alter it (the link rides
// ctx.turn.fileLinks to the channel). A file sends nothing: its actions are the person's own taps on the page.
// Extends attach_document's shape (a staged output the channel delivers after the answer); it does not duplicate it.
import type { ToolSpec } from "./loop.ts";
import { MODEL_KINDS, validateKind } from "../file_kinds.ts";
import type { FileService } from "../file_service.ts";

// Every text value in the data, one per line (the guard reads sentences, not JSON).
const leaves = (x: unknown, out: string[] = []): string[] => { if (Array.isArray(x)) x.forEach((v) => leaves(v, out)); else if (x && typeof x === "object") Object.values(x).forEach((v) => leaves(v, out)); else if (typeof x === "string") out.push(x); return out; };
export const FILE_TOOL = "create_file";
export const MAX_FILES_PER_TURN = 3;
export function createFileTool(files: FileService): ToolSpec {
  return {
    name: FILE_TOOL, effect: "write_own",
    description: `Make a page for the person to open (a link), for detail that does not fit in a short text. Kinds: ${MODEL_KINDS.join(", ")}. `
      + "introduction: who, exactly 3 relevance bullets, and the exact outreach message (the person taps Pass or Introduce; nothing sends without it). "
      + "application_proof: give only {application_id} (the job id of an application on record); the company, role, status, dates, confirmation, answers and anything failed come from the application record, never from you. "
      + "plan_review: a weekly pipeline summary (variant pipeline) or an interview prep brief (variant interview_prep). comparison: offers or roles side by side, 2 to 4 options. draft: an email, cover letter or message the person can edit and copy. research_brief: company or role research with its sources. "
      + "Every fact needs a source: 'From the posting', 'From your resume', 'From you', or 'Reported, not verified' (never \"From Trainee's records\": only the system attaches that, from a real record). A fact without a source is refused. Leave out what you do not know; never write unknown or n/a. Facts about the person only from their confirmed profile or what they said. "
      + "The link is added to your reply by the system after you answer: do not write a URL or link yourself. Say in a few words what the page holds, and only once this call has succeeded.",
    input_schema: { type: "object", properties: { kind: { type: "string", enum: [...MODEL_KINDS], description: "The kind of file" }, data: { type: "object", description: "The kind's data (title plus the kind's fields); each fact is {label, value, source}" } }, required: ["kind", "data"] },
    run: async (i, c) => {
      const links = c.turn?.fileLinks;
      if (links && links.length >= MAX_FILES_PER_TURN) throw new Error(`not created: at most ${MAX_FILES_PER_TURN} files in one reply`);
      const v = validateKind(String(i?.kind ?? ""), i?.data);
      if (!v.ok) throw new Error(`not created: ${v.errors.join("; ")}`);
      // The same guard as attach_document: facts about the person and money must trace to the person or a tool result this turn.
      // Fail closed: with no fact guard available nothing is created.
      if (typeof c.turn?.guard !== "function") throw new Error("not created: the fact check is unavailable, so no file was made");
      const bad = c.turn.guard(leaves(i?.data).join("\n"));
      if (bad?.length) throw new Error(`not created: the file states things no tool returned this turn and the person did not say: ${[...new Set(bad)].slice(0, 8).join(", ")}. Remove them or label them "Reported, not verified", then create it again.`);
      const r = await files.create(c.userId, String(i?.kind ?? ""), i?.data);
      if (!r.ok) throw new Error(r.error);
      if (r.url && c.turn) (c.turn.fileLinks ??= []).push(r.url);
      else if (!r.url) throw new Error("not created: the link could not be made");
      return { created: true, kind: r.kind, title: r.title, expires_in_hours: files.ttlHours(), note: "The link is added after your reply. Do not write a URL." };
    },
  };
}
