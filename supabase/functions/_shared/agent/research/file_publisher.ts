// Publisher for PR #280's real file kind: the brief becomes a `research_brief` file (file_kinds.ts) through the file service,
// which validates it, stores it for this one person and mints the link in code. Retrieved facts and general knowledge are both
// filed as "Reported, not verified": they are claims from outside, and the file says so. A brief with no retrieved source has no
// file (the kind needs at least one source), so the reply carries no link rather than a false one.
import type { FileService } from "../../file_service.ts";
import type { BriefFile, Publisher } from "./index.ts";

const MAX = 580;
const plain = (s: string) => s.replace(/\*\*/g, "").replace(/^>\s?/gm, "").replace(/\[(S\d+[^\]]*)\]/g, "($1)").replace(/\[([^\]]{1,60})\]/g, "($1)").replace(/<([^>\n]{1,40})>/g, "$1").replace(/^[-*]\s+/gm, "• ").replace(/\byour[_ ](name|company|title|role)\b/gi, "the $1").replace(/\binsert\b/gi, "add").replace(/[ \t]+/g, " ").trim();
function chunks(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of plain(body).split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (cur && cur.length + line.length + 1 > MAX) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${line}` : line.slice(0, MAX);
  }
  if (cur) out.push(cur);
  return out;
}
export function researchBriefData(f: BriefFile): { title: string; subject: string; findings: { label: string; value: string; source: string }[]; sources: { title: string; url: string }[] } {
  const parts = f.markdown.split(/^## /m), head = parts.shift() ?? "";
  const title = (/^# (.+)$/m.exec(head)?.[1] ?? f.subject).slice(0, 80);
  const intro = plain(head.replace(/^# .+$/m, "")).split("\n").filter(Boolean).join(" ");
  const secs = parts.map((p) => { const [h, ...rest] = p.split("\n"); return { label: h.trim().slice(0, 80), chunks: chunks(rest.join("\n")) }; }).filter((s) => s.label !== "Sources" && s.chunks.length);
  if (intro) secs.unshift({ label: "Who this is written for", chunks: chunks(intro) });
  // at most 12 findings: one chunk per section first, then the rest in order
  const picks: { label: string; value: string }[] = [];
  for (let round = 0; picks.length < 12; round++) {
    let added = false;
    for (const s of secs) if (s.chunks[round] && picks.length < 12) { picks.push({ label: round ? `${s.label} (continued)`.slice(0, 80) : s.label, value: s.chunks[round] }); added = true; }
    if (!added) break;
  }
  const sources = [...f.markdown.matchAll(/^\d+\. (S\d+): (https:\/\/\S+) \(([^,)]+)/gm)].slice(0, 10).map((m) => ({ title: `${m[1]}, ${m[3]}`.slice(0, 120), url: m[2] }));
  return { title, subject: f.subject.slice(0, 120), findings: picks.map((p) => ({ ...p, source: "Reported, not verified" })), sources };
}
export function fileKindPublisher(files: FileService, userId: string): Publisher {
  return async (f) => {
    const r = await files.create(userId, "research_brief", researchBriefData(f));
    if (!r.ok) throw new Error(r.error);
    const url = r.url ?? r.webApp;
    if (!url) throw new Error("no link was minted");
    return { url };
  };
}
