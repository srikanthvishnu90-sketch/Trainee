// D-069 (real set item 10, finding 7): a large JSON answer read as a stream, keeping only the fields asked for. Palantir's Lever
// board is 5.9 MB, Notion's and Ramp's Ashby boards about 2.9 MB each, mostly job descriptions; the research probe stopped at
// 2 MB and the reader at 1.5 MB, so those boards were "not found" or "not text". pruneJson reads the body a chunk at a time,
// never holds the whole body or its parse, and builds only the paths in `keep` (each kept string capped at maxString). Every
// other value is read and dropped as it streams past; `onString` sees each string value (capped at scanString) so a caller can
// look for a word in it (the board's own link to the company's site) without keeping it. The body is still capped (maxBytes,
// counted as read); past the cap the read stops and the answer is too_large. A body that is not one well-formed JSON value is
// invalid. Memory is bounded by what is kept, not by the body.
//
// Paths: "$" is the root, ".key" an object member, "[]" every element of an array: "$.jobs[].title", "$[].categories.location".

export interface PruneOpts {
  keep: Iterable<string>;
  maxBytes: number;
  maxString?: number; // a kept string longer than this is cut (default 2,000)
  maxItems?: number; // elements kept per array (default 20,000); the rest are read and dropped
  scanString?: number; // how much of each string onString sees (default 20,000)
  onString?: (s: string, path: string) => void;
}
export type Pruned = { ok: true; value: unknown; bytes: number } | { ok: false; why: "too_large" | "invalid"; bytes: number };

type Frame = { kind: "o" | "a"; path: string; val: any; key: string | null; count: number };
const WS = new Set([" ", "\t", "\n", "\r"]);

export async function pruneJson(body: ReadableStream<Uint8Array> | null | undefined, o: PruneOpts): Promise<Pruned> {
  const keep = new Set(o.keep), containers = new Set<string>();
  for (const k of keep) {
    // Every prefix of a kept path that ends where a container starts ("$", "$.jobs", "$.jobs[]", "$.jobs[].location").
    for (let i = 1; i <= k.length; i++) if (i === k.length || k[i] === "." || k[i] === "[") containers.add(k.slice(0, i));
    containers.delete(k);
  }
  containers.add("$");
  const maxString = o.maxString ?? 2000, maxItems = o.maxItems ?? 20000, scan = o.scanString ?? 20000;
  const stack: Frame[] = [];
  let mode: "value" | "key" | "colon" | "after" | "string" | "literal" | "done" = "value";
  let root: unknown = undefined, bytes = 0;
  // string state
  let strKey = false, strKeep = false, strScan = false, strPath = "", parts: string[] = [], strLen = 0, esc = 0, hex = "";
  let lit = "";
  const top = () => stack[stack.length - 1];
  const childPath = (f: Frame | undefined) => !f ? "$" : f.kind === "o" ? `${f.path}.${f.key}` : `${f.path}[]`;
  const fail = (): never => { throw new SyntaxError("invalid JSON"); };
  const deliver = (v: unknown, container: boolean) => {
    const f = top();
    if (!f) { root = v; mode = "done"; return; }
    const path = childPath(f);
    if (f.val !== null && (container ? v !== null : keep.has(path))) {
      if (f.kind === "o") f.val[f.key!] = v; else if (f.val.length < maxItems) f.val.push(v);
    }
    f.count++;
    mode = "after";
  };
  const open = (kind: "o" | "a") => {
    const path = childPath(top());
    stack.push({ kind, path, val: containers.has(path) ? (kind === "o" ? {} : []) : null, key: null, count: 0 });
    mode = kind === "o" ? "key" : "value";
  };
  const close = (kind: "o" | "a") => {
    const f = stack.pop();
    if (!f || f.kind !== kind) fail();
    deliver(f!.val, true);
  };
  const add = (s: string) => {
    if (strKey) { if (strLen < 1000) parts.push(s); strLen += s.length; return; }
    const cap = strKeep ? Math.max(maxString, strScan ? scan : 0) : scan;
    if (strLen < cap) parts.push(strLen + s.length > cap ? s.slice(0, cap - strLen) : s);
    strLen += s.length;
  };
  const endString = () => {
    const s = parts.join(""); parts = []; strLen = 0;
    if (strKey) { top()!.key = s.slice(0, 1000); mode = "colon"; return; }
    if (strScan) o.onString!(s.slice(0, scan), strPath);
    deliver(strKeep ? s.slice(0, maxString) : null, false);
  };
  const endLiteral = () => {
    const t = lit; lit = "";
    let v: unknown;
    if (t === "true") v = true; else if (t === "false") v = false; else if (t === "null") v = null;
    else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) v = Number(t); else fail();
    deliver(v, false);
  };
  const feed = (chunk: string) => {
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      if (mode === "string") {
        if (esc === 1) {
          const c = chunk[i++];
          const m: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (c === "u") { esc = 2; hex = ""; continue; }
          if (!(c in m)) fail();
          add(m[c]); esc = 0; continue;
        }
        if (esc === 2) {
          const c = chunk[i++];
          if (!/[0-9a-fA-F]/.test(c)) fail();
          hex += c;
          if (hex.length === 4) { add(String.fromCharCode(parseInt(hex, 16))); esc = 0; }
          continue;
        }
        // Fast path: up to the next quote or backslash in this chunk.
        let j = i;
        while (j < n) { const c = chunk.charCodeAt(j); if (c === 34 || c === 92) break; if (c < 32) fail(); j++; }
        if (j > i) add(chunk.slice(i, j));
        if (j >= n) { i = n; break; }
        if (chunk.charCodeAt(j) === 92) { esc = 1; i = j + 1; continue; }
        i = j + 1; mode = "after"; endString(); continue;
      }
      const c = chunk[i];
      if (mode === "literal") {
        if (/[0-9a-zA-Z+\-.]/.test(c)) { lit += c; if (lit.length > 64) fail(); i++; continue; }
        endLiteral(); continue; // the char is read again in the mode the literal left
      }
      if (WS.has(c)) { i++; continue; }
      i++;
      switch (mode) {
        case "done": fail(); break;
        case "value":
          if (c === "{") open("o");
          else if (c === "[") open("a");
          else if (c === "]" && top()?.kind === "a" && top()!.count === 0) close("a");
          else if (c === '"') { strKey = false; strPath = childPath(top()); strKeep = keep.has(strPath); strScan = !!o.onString; mode = "string"; }
          else if (/[-0-9tfn]/.test(c)) { lit = c; mode = "literal"; }
          else fail();
          break;
        case "key":
          if (c === '"') { strKey = true; strKeep = false; strScan = false; mode = "string"; }
          else if (c === "}" && top()?.count === 0) close("o");
          else fail();
          break;
        case "colon": if (c !== ":") fail(); mode = "value"; break;
        case "after": {
          const f = top();
          if (!f) fail();
          if (c === ",") mode = f!.kind === "o" ? "key" : "value";
          else if (c === "}") close("o");
          else if (c === "]") close("a");
          else fail();
          break;
        }
      }
    }
  };
  if (!body) return { ok: false, why: "invalid", bytes: 0 };
  const reader = body.getReader(), dec = new TextDecoder("utf-8", { fatal: false });
  let done = false;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (bytes > o.maxBytes) { await reader.cancel().catch(() => {}); done = true; return { ok: false, why: "too_large", bytes }; }
      feed(dec.decode(r.value, { stream: true }));
    }
    done = true;
    feed(dec.decode());
    if ((mode as string) === "literal" && stack.length === 0) endLiteral();
    if ((mode as string) !== "done") return { ok: false, why: "invalid", bytes };
    return { ok: true, value: root, bytes };
  } catch {
    if (!done) await reader.cancel().catch(() => {});
    return { ok: false, why: "invalid", bytes };
  } finally {
    try { reader.releaseLock(); } catch { /* released or cancelled */ }
  }
}

// The fields research keeps from each public job board's list (what research_free_sources.ts convertFree and the provider read).
export const BOARD_KEEP: Record<"Greenhouse" | "Lever" | "Ashby" | "SmartRecruiters", string[]> = {
  Greenhouse: ["$.jobs[].id", "$.jobs[].title", "$.jobs[].location.name", "$.jobs[].company_name", "$.jobs[].absolute_url", "$.meta.total"],
  Lever: ["$[].id", "$[].text", "$[].categories.location", "$[].hostedUrl"],
  Ashby: ["$.jobs[].id", "$.jobs[].title", "$.jobs[].location", "$.jobs[].isListed", "$.jobs[].jobUrl"],
  SmartRecruiters: ["$.content[].id", "$.content[].name", "$.content[].location.city", "$.content[].location.region", "$.content[].location.country", "$.content[].company.name", "$.totalFound"],
};
// Big enough for the largest public boards seen (Palantir's Lever board, 5.9 MB, 2026-11-12) with room; never unbounded.
export const BOARD_MAX_BYTES = 16_000_000;
// The content types a JSON API answers with: application/json and its +json kinds, text/json, and (for the documented board
// APIs only) a JSON body sent as text/plain or with no type at all.
export function jsonType(type: string | null | undefined, documented = false): boolean {
  const t = String(type ?? "").toLowerCase().split(";")[0].trim();
  return /^(?:application|text)\/(?:[\w.+-]+\+)?json$/.test(t) || t === "application/x-javascript-json" || (documented && (t === "" || t === "text/plain" || t === "application/octet-stream"));
}
