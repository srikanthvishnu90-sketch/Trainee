// Item 6, S0 (coordinator rulings 2026-11-10 on VERIFICATION-15 item 6): a File family served from a stored File record. The record
// holds the family's own view data (the input of its builder in file_family_plan.ts / file_family_apply.ts), built by code. Serving
// draws that family through the one visual system (file_family.ts familyPage) and turns every control into one the File server
// answers, or into a control shown off with its reason. Nothing here changes state; a GET never does (ruling 1).
//
// What each control becomes (rulings 1-3):
//   Back, "Close this File"         the chat (TRAINEE_BOT_URL). There is no File index yet (ruling 3).
//   an export or download           ?format=json: this File's own data, as shown, from the File server.
//   a decision in the person's words the chat, with the exact question filled in and the File item named (ruling 2). Nothing changes on
//                                   the server until the person's own words come in.
//   an employer or source page      unchanged (an https link).
//   anything else                   shown off, with the reason: a state change or approval this File cannot do yet (S1-S6 serve them
//                                   as POST forms with the page token; approvals bind the payload hash, D-MS-1, D-MN-2).
import { type Act, type Block, FAMILIES, type FamilyFile, type FamilyId, type Part } from "./file_family.ts";
import { answerLibraryFile, careerBriefFile, materialsFile, pathComparisonFile, profileFactsFile, roleWorkspaceFile, searchPlanFile } from "./file_family_plan.ts";
import { applicationReviewFile, batchFile, interviewHubFile, messageReviewFile, negotiationFile, offerComparisonFile, pipelineFile, weeklyBriefFile } from "./file_family_apply.ts";

export type ServedFamily = Exclude<FamilyId, "F-05"> | "F-14n"; // F-05 is served by the results page (file_family_live.ts)
// deno-lint-ignore no-explicit-any
const BUILD: Record<ServedFamily, (v: any) => FamilyFile> = {
  "F-01": careerBriefFile, "F-02": profileFactsFile, "F-03": pathComparisonFile, "F-04": searchPlanFile, "F-06": roleWorkspaceFile, "F-07": materialsFile,
  "F-08": answerLibraryFile, "F-09": applicationReviewFile, "F-10": batchFile, "F-11": pipelineFile, "F-12": messageReviewFile, "F-13": interviewHubFile,
  "F-14": weeklyBriefFile, "F-14n": negotiationFile, "F-15": offerComparisonFile,
};
export const SERVED_FAMILIES = Object.keys(BUILD) as ServedFamily[];
export const isServedFamily = (x: unknown): x is ServedFamily => typeof x === "string" && x in BUILD;

// The decisions that need the person's own words (ruling 2): the query keys the family builders use for them.
export const ASK_KEYS = new Set(["answer", "edit", "correct", "propose", "decide", "followup", "prefer", "priorities", "recipient", "questions", "negotiate", "decision",
  "plan", "add", "tighten", "adjacent", "widen", "find", "practice", "start"]);
// The posts each family serves (S1-S6). One line per family, so each builder adds only its own line: a post listed here is drawn as
// a form carrying this page's token (the handler checks the cookie, the token and the site, then hands it to that family's
// FamilySource.act). Every other post stays shown off with NOT_YET. Approvals bind the payload hash shown (D-MS-1, D-MN-2).
export const SERVED_POSTS: Record<ServedFamily, ReadonlySet<string>> = {
  "F-01": new Set(),
  "F-02": new Set(),
  "F-03": new Set(),
  "F-04": new Set(),
  "F-06": new Set(),
  "F-07": new Set(),
  "F-08": new Set(),
  "F-09": new Set(),
  "F-10": new Set(),
  "F-11": new Set(),
  "F-12": new Set(),
  "F-13": new Set(),
  "F-14": new Set(),
  "F-14n": new Set(),
  "F-15": new Set(),
};
// THE shared S0 hook (one for every family builder, S1-S6): where a family File reads its records and does its posts.
// FileDeps.familyRecords holds one FamilyRecords per family (each builder wires only its own key in deps.ts).
//   load: the family's builder input, read now from the real records the File names (rec.data.ref), for a File made with
//         createFamily(..., { ref }). null when it cannot be read: the page then shows the C.24 error state, never a stored or stale view.
//   post: one handler per action. The handler dispatches a post only when the action is in SERVED_POSTS[family] AND has a handler
//         here, after the File server's own cookie, page-token and same-site checks. ok false (a stale hash, a changed payload) is a
//         409 whose lines say what was not done and why. An approval approves only the exact payload hash shown (D-MS-1, D-MN-2).
export interface FamilyRec { id: string; data: { family: ServedFamily; title?: string; ref?: Record<string, string> | null } }
export interface FamilyPostResult { ok: boolean; title: string; lines: string[] }
export interface FamilyRecords {
  load(userId: string, rec: FamilyRec): Promise<{ view: unknown; asOf: string | null } | null>;
  post?: Record<string, (userId: string, rec: FamilyRec, fields: URLSearchParams, now: number) => Promise<FamilyPostResult>>;
}
export type FamilyRecordsByFamily = Partial<Record<ServedFamily, FamilyRecords>>;
export const NOT_YET = "Not available on this page yet. Ask Trainee in the chat.";
export const NO_CHAT = "Not available: the chat link isn't set up.";

// The chat link with the question filled in: Telegram (t.me) and WhatsApp (wa.me) both open a chat with ?text= as the draft.
export function chatAsk(bot: string | null, text: string): string | null {
  if (!bot) return null;
  try {
    const u = new URL(bot);
    if (u.protocol !== "https:" || !/^(t\.me|wa\.me)$/.test(u.hostname)) return null;
    u.search = ""; u.searchParams.set("text", text.slice(0, 900));
    return u.toString();
  } catch { return null; }
}
// The exact words the chat opens with: the File, the item it is about, and the decision (ruling 2).
export const askText = (fileTitle: string, item: string | null, label: string) => `About my ${fileTitle}${item ? `, "${item}"` : ""}: ${label}. `;

export interface ServeCtx { bot: string | null; title: string; family?: ServedFamily; token?: string | null; answers?: (action: string) => boolean }
// One control, as served. item: the File item it sits on (its title), when it has one.
export function servedAct(a: Act, c: ServeCtx, item: string | null): Act {
  if (a.off) return a;
  const href = a.href ?? "";
  // A post this family serves keeps its form, with this page's token; any other is shown off (S1-S6 serve each one).
  // It is drawn as a form only when it is listed AND this page's records answer it (o.answers): a listed post on a page with no source
  // behind it (a stored view) would post and fail, so it is shown off instead.
  if (a.post) return c.token && c.family && SERVED_POSTS[c.family].has(a.post.action) && c.answers?.(a.post.action) ? { ...a, post: { ...a.post, token: c.token } } : { ...a, post: undefined, href: null, off: NOT_YET };
  if (/^https:\/\//i.test(href)) return a;
  if (a.effect === "download" || /^\/files\//.test(href)) return { ...a, effect: "download", href: "?format=json" };
  if (href === "/f" || a.label === "Close this File") { const h = c.bot; return h ? { ...a, effect: "open", href: h, label: "Back to chat" } : { ...a, href: null, off: NO_CHAT }; }
  const key = href.startsWith("?") ? [...new URLSearchParams(href.slice(1)).keys()][0] ?? "" : "";
  if (ASK_KEYS.has(key)) { const h = chatAsk(c.bot, askText(c.title, item, a.label)); return h ? { ...a, effect: "open", href: h, aria: `${a.label}: opens the chat with the question filled in` } : { ...a, href: null, off: NO_CHAT }; }
  return { ...a, href: null, off: NOT_YET };
}
function servedPart(p: Part, c: ServeCtx): Part {
  if (p.p === "item") return { ...p, ...(p.act ? { act: servedAct(p.act, c, p.title) } : {}), ...(p.menu ? { menu: p.menu.map((m) => servedAct(m, c, p.title)) } : {}) };
  if (p.p === "tile" && p.act) return { ...p, act: servedAct(p.act, c, p.title) };
  return p;
}
function servedBlock(b: Block, c: ServeCtx): Block {
  if (b.b === "card") return { ...b, parts: b.parts.map((p) => servedPart(p, c)) };
  if (b.b === "note" && b.act) return { ...b, act: servedAct(b.act, c, b.label.replace(/[.:]\s*$/, "")) };
  return b;
}
// The family File as served: built from the record's view data, every control made servable or shown off.
// o.token: this page's token (the handler's); o.answers: whether this page's records answer a post. A post in SERVED_POSTS is drawn as a
// form only with both; otherwise every post is shown off.
export function servedFamilyFile(family: ServedFamily, view: unknown, o: { bot: string | null; token?: string | null; answers?: (action: string) => boolean }): FamilyFile {
  const f = BUILD[family](view);
  const c: ServeCtx = { bot: o.bot, title: f.header ?? (FAMILIES[family as FamilyId] ?? FAMILIES["F-14"]).header, family, token: o.token ?? null, answers: o.answers };
  const menu: Act[] = [{ label: "Export", effect: "download", href: "?format=json" }, ...(o.bot ? [{ label: "Back to chat", effect: "open" as const, href: o.bot }] : [])];
  return {
    ...f, back: o.bot, menu: f.pause ? undefined : menu, pause: f.pause ? servedAct(f.pause, c, null) : f.pause,
    segments: f.segments?.map((s) => ({ ...s, href: null })), blocks: f.blocks.map((b) => servedBlock(b, c)),
    actions: f.actions && { ...f.actions, primary: f.actions.primary ? servedAct(f.actions.primary, c, null) : f.actions.primary, secondary: f.actions.secondary?.map((s) => servedAct(s, c, null)) },
  };
}
