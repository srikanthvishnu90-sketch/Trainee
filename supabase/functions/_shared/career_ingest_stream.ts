// Bounded reads for career-ingest (2026-10-30 production fix: "Memory limit exceeded" / "CPU Time exceeded" on ~20% of
// lane runs). A board's whole body used to be held as text, then as parsed JSON, then as normalized postings, all at once,
// 8 boards at a time: one Lever board answers 4,600 postings (~70 MB of JSON with every description twice), which no edge
// worker survives. Here:
//   readBody            reads a response up to `wholeMax` characters as one text (the common case: hashed, parsed whole);
//                       past that it hands back the text read so far and the rest of the stream, never the whole body
//   jsonArrayElements   splits a JSON body's job array (at the root, or under one key of the root object) into one
//                       element's text at a time while the body streams in: only the element being read is held, the
//                       elements before `skip` are counted and never parsed, the root object's short string fields
//                       (Workable's company name) are kept
//   idChunks            groups ids so a PostgREST `in.(...)` filter keeps its request URL under a byte limit (Workday ids
//                       run to 150+ characters; 100 of them made URLs of ~20 KB: "error sending request")
// Nothing here reads the network or a database by itself.

export interface BodyRead { text: string | null; head: string[]; rest: AsyncIterable<string> | null; chars: number }
// The most characters any one reader held at once, for the bounded-memory tests (reset by the test).
export const streamProbe = { maxHeldChars: 0, elementsParsed: 0, elementsSkipped: 0 };
const unescape = (raw: string) => { try { return String(JSON.parse(`"${raw}"`)); } catch { return raw; } };
const note = (n: number) => { if (n > streamProbe.maxHeldChars) streamProbe.maxHeldChars = n; };

async function* decoded(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      if (s) yield s;
    }
    const tail = dec.decode();
    if (tail) yield tail;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

// Reads at most `wholeMax` characters before deciding: a body that ends inside it comes back as `text`; a longer one comes
// back as `head` (what was read) and `rest` (the remaining decoded chunks), so the caller streams it.
export async function readBody(res: Response, wholeMax: number): Promise<BodyRead> {
  if (!res.body) return { text: await res.text(), head: [], rest: null, chars: 0 };
  const it = decoded(res.body.getReader());
  const head: string[] = [];
  let chars = 0;
  for (;;) {
    const r = await it.next();
    if (r.done) { const text = head.join(""); note(text.length); return { text, head: [], rest: null, chars }; }
    head.push(r.value);
    chars += r.value.length;
    note(chars);
    if (chars > wholeMax) return { text: null, head, rest: { [Symbol.asyncIterator]: () => it }, chars };
  }
}

// Every chunk of a streamed body, the part already read first (released as it is consumed).
export async function* chunksOf(b: BodyRead): AsyncGenerator<string> {
  while (b.head.length) yield b.head.shift()!;
  if (b.rest) for await (const c of b.rest) yield c;
}

// The elements of one JSON array in a streamed body, as text, one at a time. `key` null: the root is the array; else the
// array is the value of `key` in the root object. Elements that are not objects are not counted (the readers drop them).
// `skip`: object elements counted and passed over without being kept or parsed. `found` reports whether the array was
// there at all (false: not this provider's body shape); `root` the root object's string fields (each up to 1,000 chars).
export interface ArrayScan { found: boolean; done: boolean; root: Record<string, string>; counted: number; invalid?: boolean } // invalid: not one JSON value (round 2)
export async function* jsonArrayElements(chunks: AsyncIterable<string>, key: string | null, skip = 0, scan: ArrayScan = { found: false, done: false, root: {}, counted: 0 }): AsyncGenerator<string> {
  let depth = 0, inStr = false, esc = false, rootKind = 0; // rootKind: 1 object, 2 array
  let arrayDepth = -1; // the depth inside the target array (elements start at this depth)
  let strBuf: string[] | null = null, strLen = 0, pendingStr: string | null = null, curKey: string | null = null, expectKey = false;
  let elem: string[] | null = null, elemStart = -1, elemSkip = false, heldChars = 0;
  for await (const chunk of chunks) {
    let strFrom = inStr && strBuf ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inStr) {
        if (esc) { esc = false; continue; }
        if (c === 92) { esc = true; continue; } // backslash
        if (c === 34) { // closing quote
          inStr = false;
          if (strBuf) { if (strFrom >= 0) strBuf.push(chunk.slice(strFrom, i)); pendingStr = strBuf.join(""); strBuf = null; strFrom = -1; }
        }
        continue;
      }
      // 2026-10-30 (round 2): outside the root nothing but white space. Leading bytes that are not JSON (a body still gzip
      // encoded, an HTML page) used to be skipped until a "[" turned up, and the garbage read as an empty board.
      if (depth === 0 && c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 0xfeff && (rootKind !== 0 || (c !== 123 && c !== 91))) {
        scan.found = false; scan.invalid = true; return;
      }
      if (c === 34) { // opening quote
        inStr = true;
        // A string directly in the root object (a key or a short value) is kept; nothing else is.
        if (rootKind === 1 && depth === 1) { strBuf = []; strLen = 0; strFrom = i + 1; }
        continue;
      }
      if (c === 123 || c === 91) { // { [
        if (depth === 0) { rootKind = c === 123 ? 1 : 2; if (rootKind === 2 && key === null) { arrayDepth = 1; scan.found = true; } expectKey = rootKind === 1; }
        else if (rootKind === 1 && depth === 1 && c === 91 && curKey === key && key !== null && arrayDepth < 0 && !scan.done) { arrayDepth = 2; scan.found = true; }
        else if (depth === arrayDepth && c === 123) {
          elemSkip = scan.counted < skip;
          scan.counted++;
          if (elemSkip) streamProbe.elementsSkipped++;
          else { elem = []; elemStart = i; heldChars = 0; }
        }
        depth++;
        continue;
      }
      if (c === 125 || c === 93) { // } ]
        depth--;
        if (depth === arrayDepth && c === 125 && (elem || elemSkip)) {
          if (elem) {
            elem.push(chunk.slice(elemStart, i + 1));
            const text = elem.join("");
            note(text.length);
            elem = null; elemStart = -1;
            streamProbe.elementsParsed++;
            yield text;
          }
          elemSkip = false;
        } else if (depth === arrayDepth - 1 && c === 93 && arrayDepth > 0) { arrayDepth = -1; scan.done = true; }
        if (depth === 1 && rootKind === 1) expectKey = false;
        continue;
      }
      if (rootKind === 1 && depth === 1) {
        if (c === 58) { curKey = pendingStr; pendingStr = null; expectKey = false; } // ':'
        else if (c === 44) { // ',': a string value of the root object
          if (pendingStr !== null && curKey !== null && !expectKey) scan.root[curKey] = unescape(pendingStr).slice(0, 1000);
          pendingStr = null; curKey = null; expectKey = true;
        }
      }
    }
    // Carry what is open across the chunk boundary.
    if (inStr && strBuf && strFrom >= 0) { strLen += chunk.length - strFrom; if (strLen <= 4000) strBuf.push(chunk.slice(strFrom)); else strBuf = null; }
    if (elem) { elem.push(chunk.slice(elemStart < 0 ? 0 : elemStart)); heldChars += chunk.length - (elemStart < 0 ? 0 : elemStart); note(heldChars); elemStart = 0; }
  }
  if (pendingStr !== null && curKey !== null) scan.root[curKey] = unescape(pendingStr).slice(0, 1000);
}

// Ids grouped so `<base>?<column>=in.(<ids>)` stays under maxUrl characters once URL-encoded (and at most maxIds each).
export function idChunks(ids: string[], o: { maxUrl?: number; base?: number; maxIds?: number } = {}): string[][] {
  const maxUrl = o.maxUrl ?? 6000, base = o.base ?? 400, maxIds = o.maxIds ?? 100;
  const out: string[][] = [];
  let cur: string[] = [], len = base;
  for (const id of ids) {
    // PostgREST quotes a value with reserved characters; encodeURIComponent is the encoded size (plus quotes and a comma).
    const n = encodeURIComponent(`"${id}"`).length + 3;
    if (cur.length && (len + n > maxUrl || cur.length >= maxIds)) { out.push(cur); cur = []; len = base; }
    cur.push(id);
    len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// The kind of storage error worth retrying in smaller pieces and, if it persists, failing only the board (not the lane):
// a statement timeout, a lock timeout, a request that never reached the database, a gateway or connection error.
export function transientStorageError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /statement timeout|canceling statement|lock timeout|error sending request|fetch failed|connection (reset|refused|closed)|network|timed? ?out|ECONNRESET|HTTP 5\d\d|\b50[234]\b|upstream|deadlock/i.test(m);
}

// 2026-10-30 (ingest round 2): one posting's text that Postgres refuses fails the write it is in. Postgres text holds no
// NUL character, and JSON with a lone UTF-16 surrogate (an emoji cut in half by a length limit, or a broken one in the
// board's own JSON) is refused as invalid input; either used to fail the whole lane run on every tick, since the board
// was handed back and taken first again. `storable` drops NUL and the other control characters but tab and line breaks,
// and puts U+FFFD in place of a lone surrogate; `cut` is a length limit that never ends inside a surrogate pair.
export function storable(v: unknown): string {
  return String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}
export function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? s.slice(0, n - 1) : s.slice(0, n);
}
// A write refused for what one row holds (a value Postgres will not take, a row outside a table check): that board's
// read fails with the reason and the lane goes on (never the whole run, which would fail the same way every tick).
export function rowContentError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /invalid input syntax|unsupported Unicode escape|Unicode low surrogate|invalid byte sequence|untranslatable character|violates check constraint|value too long|null value in column|out of range/i.test(m);
}
