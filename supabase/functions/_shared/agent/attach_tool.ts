// REPLY SHAPE: the attachment tool. Research, comparisons, a full posting list, a batch of drafts or a tailored resume summary
// that does not fit in one short paragraph is staged here as a named file; the channel sends it as a document after the
// answer (channel_shape.ts). The loop checks the content against this turn's facts before it is kept (loop.ts). The file is
// a draft the person reads: nothing in it is sent anywhere, so it needs no approval, and it makes no claim of its own.
import type { ToolSpec } from "./loop.ts";
import { fileParts, MAX_FILES } from "../channel_shape.ts";

export const ATTACH_TOOL = "attach_document";
// DEFAULT OFF (owner, 2026-10-29: nobody should have to download anything). Long detail goes to a hosted page link (create_file:
// research_brief, comparison, draft, the list page). This tool exists in a turn only when the person asked for a file in so many
// words ("send me a file", "attach it as a .md", "give me a PDF/doc").
export const attachAsked = (message: string): boolean =>
  /\b(?:send|give|attach|email|export|save)\b[^.?!\n]{0,40}\b(?:file|document|doc|pdf|md|txt|attachment|download)\b|\b(?:as|in) an? (?:file|document|pdf|\.?md|\.?txt)\b|\bdownload(?:able)?\b/i.test(String(message ?? ""));
export function attachTool(): ToolSpec {
  return {
    name: ATTACH_TOOL, effect: "read",
    description: "Attach a text file to this reply, for detail that does not fit in one short paragraph (research on a company, a comparison, the full list of postings, a batch of drafted emails, a tailored resume summary). Give a descriptive file name ending in .md or .txt (for example company-research.md) and the content, about 4 KB at most per file. The content follows the same rules as your reply: only facts from the person, their confirmed profile and tool results this turn; mark anything you could not verify as 'not verified'. Say in your reply, in a few words, what the file holds, and only once this call has succeeded.",
    input_schema: { type: "object", properties: { filename: { type: "string", description: "Descriptive name, e.g. company-research.md" }, content: { type: "string", description: "The file's text (markdown or plain)" } }, required: ["filename", "content"] },
    run: async (i, c) => {
      const parts = fileParts(i.filename, i.content);
      if (!parts.length) throw new Error("not attached: the file has no content");
      // The cap is on the files the person receives: each staged document expands into numbered parts when it is over the size limit.
      const staged = (c.turn?.attachments ?? []).reduce((n, a) => n + fileParts(a.filename, a.content).length, 0);
      if (staged + parts.length > MAX_FILES) throw new Error(`not attached: at most ${MAX_FILES} files in one reply (${staged} already staged, this one would send as ${parts.length})`);
      return { attachment: { filename: String(i.filename), content: String(i.content) }, will_send_as: parts.map((p) => ({ filename: p.filename, bytes: p.bytes })) };
    },
  };
}
