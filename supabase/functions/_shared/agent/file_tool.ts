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
// D-071 (live-8 C1: create_file refused "sections: must be a list" twice, and no File was made): the model sends the right content
// in another shape: the data or a list as JSON text, one item where a list goes, or a list keyed by heading. The shape is put
// right before validation; nothing is added or reworded, and every fact still needs its own source, so a fact without one is still
// refused, with the exact shape the kind takes.
const LISTS = new Set(["sections", "items", "options", "rows", "cells", "why", "summary", "answers", "problems", "conditions", "risks", "business", "developments", "competitors", "sources", "steps", "points"]);
const parsed = (v: unknown) => { if (typeof v !== "string" || !/^\s*[[{]/.test(v)) return v; try { return JSON.parse(v); } catch { return v; } };
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
export function coerceShape(data: unknown, key = ""): unknown {
  const v = parsed(data);
  if (LISTS.has(key)) {
    if (Array.isArray(v)) return v.map((x) => coerceShape(x));
    if (isObj(v)) {
      // One item where a list goes ({heading, items} or {label, value, source}).
      if (["heading", "label", "name", "text", "value", "question"].some((k) => k in v)) return [coerceShape(v)];
      // A list keyed by its headings: {"This week": [...], "Next week": [...]} -> [{heading, items}].
      if (key === "sections" && Object.values(v).every((x) => Array.isArray(parsed(x)) || isObj(parsed(x)))) return Object.entries(v).map(([heading, items]) => ({ heading, items: coerceShape(items, "items") }));
    }
    return v;
  }
  if (isObj(v)) return longLabel(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, coerceShape(x, k)])));
  return v;
}
// D-073 (live-9 C1: create_file refused "sections[0].items[0].label: is over 80 characters", and no File was made): a fact's label over
// 80 characters keeps its first words (at most 80 characters, cut at a word, marked with "…") and the whole label goes into the
// fact's own text, before its value. Nothing is added or reworded: every word the model wrote is still on the page, and the fact
// guard still reads all of it.
export const LABEL_MAX = 80;
function longLabel(x: Record<string, any>): Record<string, any> {
  const label = typeof x.label === "string" ? x.label.replace(/\s+/g, " ").trim() : null;
  const key = typeof x.value === "string" ? "value" : typeof x.text === "string" ? "text" : null;
  if (!label || label.length <= LABEL_MAX || !key) return x;
  const cut = label.slice(0, LABEL_MAX - 1), at = cut.lastIndexOf(" ");
  const head = `${(at >= 20 ? cut.slice(0, at) : cut).replace(/[\s,;:.\-–—]+$/, "")}…`;
  const body = String(x[key]).trim();
  return { ...x, label: head, [key]: body && !body.includes(label) ? `${label.replace(/[.:;]+$/, "")}: ${body}` : body || label };
}
// The exact data each kind takes, said in the refusal so a second call can be right.
export const KIND_SHAPE: Record<string, string> = {
  plan_review: '{"title": "...", "variant": "pipeline" or "interview_prep", "period": "...", "sections": [{"heading": "...", "items": [{"label": "...", "value": "...", "source": "From the posting" | "From your resume" | "From you" | "Reported, not verified"}]}]}',
  comparison: '{"title": "...", "options": [{"name": "..."}, {"name": "..."}], "rows": [{"label": "...", "cells": [{"value": "...", "source": "..."}, null]}]}',
};
export const MAX_FILES_PER_TURN = 3;
export function createFileTool(files: FileService): ToolSpec {
  return {
    name: FILE_TOOL, effect: "write_own",
    description: `Make a page for the person to open (a link), for detail that does not fit in a short text. Kinds: ${MODEL_KINDS.join(", ")}. `
      + "introduction: who, exactly 3 relevance bullets, and the exact outreach message (the person taps Pass or Introduce; nothing sends without it). "
      + "application_proof: give only {application_id} (the job id of an application on record); the company, role, status, dates, confirmation, answers and anything failed come from the application record, never from you. "
      + "application_review is not yours to make: Trainee builds it from a prepared application and links it on the card. "
      + "tracker is not yours to make either: export_tracker builds it from the person's records and Gmail confirmations. "
      + `plan_review: a weekly pipeline summary (variant pipeline) or an interview prep brief (variant interview_prep), data exactly ${KIND_SHAPE.plan_review}. ` + "comparison: offers or roles side by side, 2 to 4 options. draft: an email, cover letter or message the person can edit and copy. research_brief: company or role research with its sources. "
      + "Every fact needs a source: 'From the posting', 'From your resume', 'From you', or 'Reported, not verified' (never \"From Trainee's records\": only the system attaches that, from a real record). A fact without a source is refused. Leave out what you do not know; never write unknown or n/a. Facts about the person only from their confirmed profile or what they said. "
      + "The link is added to your reply by the system after you answer: do not write a URL or link yourself. Say in a few words what the page holds, and only once this call has succeeded.",
    input_schema: { type: "object", properties: { kind: { type: "string", enum: [...MODEL_KINDS], description: "The kind of file" }, data: { type: "object", description: "The kind's data (title plus the kind's fields); each fact is {label, value, source}" } }, required: ["kind", "data"] },
    run: async (i, c) => {
      const links = c.turn?.fileLinks;
      if (links && links.length >= MAX_FILES_PER_TURN) throw new Error(`not created: at most ${MAX_FILES_PER_TURN} files in one reply`);
      const data = coerceShape(i?.data);
      const v = validateKind(String(i?.kind ?? ""), data);
      if (!v.ok) throw new Error(`not created: ${v.errors.join("; ")}${KIND_SHAPE[String(i?.kind ?? "")] ? `. The data for ${String(i?.kind)} is exactly: ${KIND_SHAPE[String(i?.kind)]}` : ""}`);
      // The same guard as attach_document: facts about the person and money must trace to the person or a tool result this turn.
      // Fail closed: with no fact guard available nothing is created.
      if (typeof c.turn?.guard !== "function") throw new Error("not created: the fact check is unavailable, so no file was made");
      const bad = c.turn.guard(leaves(data).join("\n"));
      if (bad?.length) throw new Error(`not created: the file states things no tool returned this turn and the person did not say: ${[...new Set(bad)].slice(0, 8).join(", ")}. Remove them or label them "Reported, not verified", then create it again.`);
      const r = await files.create(c.userId, String(i?.kind ?? ""), data);
      if (!r.ok) throw new Error(r.error);
      if (r.url && c.turn) (c.turn.fileLinks ??= []).push(r.url);
      else if (!r.url) throw new Error("not created: the link could not be made");
      // Ruling 2026-11-14 (live-10 C1): the File's text, every leaf of which just passed the fact guard above (it traces to a tool
      // result this turn or to the person), is a source the reply may restate.
      if (c.turn) ((c.turn as any).fileTexts ??= []).push(...leaves(data).map((x: string) => String(x).replace(/\s+/g, " ").trim()).filter((x: string) => x.length > 2));
      return { created: true, kind: r.kind, title: r.title, expires_in_hours: files.ttlHours(), note: "The link is added after your reply. Do not write a URL." };
    },
  };
}
