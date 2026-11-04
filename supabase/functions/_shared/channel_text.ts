// Text units every texting channel shares (CHANNEL DELIVERY SCENARIOS, 2026-10-29): where a link begins and ends in a
// line, where a message may be cut without breaking a character, and how long a string is in bytes. Pure; no I/O.
//
// A link is found the way a person reads it: it starts at http:// or https:// (not glued to a word before it) and runs to
// the first space, angle bracket, quote or backtick. What follows it in the sentence is not part of it: trailing
// punctuation (". , ; : ! ? …"), a closing bracket it did not open ("(https://x/1)" -> https://x/1, while
// "https://en.wikipedia.org/wiki/Foo_(bar)" keeps its own pair), and the markdown emphasis around it ("**https://x/1**").

const START = /https?:\/\//gi;
const STOP_CHAR = /[\s<>"'`“”‘’]/;
const TRAILING = /[.,;:!?…*~]$/;

function balanced(url: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of url) { if (ch === open) depth++; else if (ch === close) depth--; }
  return depth >= 0;
}

export interface UrlSpan { start: number; end: number; url: string }

// Every link in `text`, in order, as exact character spans (url === text.slice(start, end)).
export function findUrls(text: string): UrlSpan[] {
  const s = String(text ?? "");
  const out: UrlSpan[] = [];
  START.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = START.exec(s))) {
    const start = m.index;
    if (start > 0 && /[\p{L}\p{N}]/u.test(s[start - 1])) continue; // "xhttps://" is not a link
    if (out.length && start < out[out.length - 1].end) continue;
    let end = start;
    while (end < s.length && !STOP_CHAR.test(s[end])) end++;
    let url = s.slice(start, end);
    for (;;) {
      const before = url;
      if (TRAILING.test(url)) url = url.slice(0, -1);
      else if (url.endsWith(")") && !balanced(url, "(", ")")) url = url.slice(0, -1);
      else if (url.endsWith("]") && !balanced(url, "[", "]")) url = url.slice(0, -1);
      else if (url.endsWith("}") && !balanced(url, "{", "}")) url = url.slice(0, -1);
      else if (url.endsWith("_") && start > 0 && s[start - 1] === "_") url = url.slice(0, -1); // _https://x/1_ (italic)
      if (url === before) break;
    }
    if (!/^https?:\/\/[^/?#]/i.test(url)) { START.lastIndex = start + 1; continue; }
    out.push({ start, end: start + url.length, url });
    START.lastIndex = start + url.length;
  }
  return out;
}
export const urlsOf = (text: string): string[] => findUrls(text).map((u) => u.url);
export const isBareUrl = (s: string): boolean => {
  const t = String(s ?? "").trim();
  const u = findUrls(t);
  return u.length === 1 && u[0].start === 0 && u[0].end === t.length;
};

// The largest index <= n that does not fall between the two halves of a surrogate pair (an emoji, most CJK extensions):
// cutting there never leaves half a character on either side.
export function safeCut(s: string, n: number): number {
  if (n <= 0) return 0;
  if (n >= s.length) return s.length;
  const c = s.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? n - 1 : n;
}
// s.slice(0, n) that never ends in half a character.
export const safeSlice = (s: string, n: number): string => String(s ?? "").slice(0, safeCut(String(s ?? ""), n));

const enc = new TextEncoder();
export const utf8Bytes = (s: string): number => enc.encode(String(s ?? "")).length;
