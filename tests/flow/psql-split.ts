// psql's own split of a script into statements (tests/flow/pg.ts sends them one at a time over a kept connection, as
// psql sends them one at a time over its own): a semicolon ends a statement unless it is inside a string ('...', E'...'
// with backslash escapes), a quoted name ("..."), a dollar-quoted body ($tag$...$tag$), a comment (-- or nested /* */)
// or parentheses. The one psql meta-command the harness uses, `\g /dev/null` (send, print nothing), ends a statement
// whose rows are dropped. Anything else this does not model (another meta-command, BEGIN ATOMIC bodies, psql variables)
// returns null, and pg.ts then runs the script through psql itself, unchanged.
export interface Stmt { sql: string; line: number; devnull: boolean; poolSafe: boolean }

const IDENT = /[A-Za-z0-9_$\u0080-￿]/;
const TAG_START = /[A-Za-z_\u0080-￿]/;
const TAG_CHAR = /[A-Za-z0-9_\u0080-￿]/;

// A statement that leaves state on the session (beyond its transaction) makes the connection not reusable: psql's
// session would have ended with it.
function poolSafe(sql: string): boolean {
  const s = sql.replace(/--[^\n]*/g, " ").toLowerCase();
  if (/^\s*set\s+(?!local\b|transaction\b|constraints\b)/.test(s)) return false;
  if (/^\s*(reset|discard|listen|unlisten|prepare|declare|load|close|deallocate)\b/.test(s)) return false;
  if (/\b(temp|temporary)\s+(table|view|sequence)\b/.test(s)) return false;
  if (/pg_(try_)?advisory_lock(_shared)?\s*\(/.test(s)) return false;
  if (/set_config\s*\(/.test(s) && /\bfalse\b/.test(s)) return false;
  if (/\bset\s+(session\s+authorization|role)\b/.test(s) && !/\bset\s+local\s+(session\s+authorization|role)\b/.test(s)) return false;
  return true;
}

export function splitPsql(text: string): Stmt[] | null {
  if (/\bbegin\s+atomic\b/i.test(text)) return null; // a SQL-standard body: psql parses it, this does not
  const out: Stmt[] = [];
  let start = 0, i = 0, depth = 0, line = 1;
  const n = text.length;
  const push = (end: number, devnull: boolean) => {
    const sql = text.slice(start, end);
    const bare = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/;\s*$/, "").trim();
    if (bare) out.push({ sql, line, devnull, poolSafe: poolSafe(sql) });
    else if (devnull) return false;
    return true;
  };
  while (i < n) {
    const c = text[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === "-" && text[i + 1] === "-") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") {
      let d = 1;
      i += 2;
      while (i < n && d > 0) {
        if (text[i] === "\n") line++;
        if (text[i] === "/" && text[i + 1] === "*") { d++; i += 2; } else if (text[i] === "*" && text[i + 1] === "/") { d--; i += 2; } else i++;
      }
      if (d > 0) return null;
      continue;
    }
    if (c === "'") {
      const escaped = (text[i - 1] === "E" || text[i - 1] === "e") && !IDENT.test(text[i - 2] ?? "");
      i++;
      for (;;) {
        if (i >= n) return null;
        const d = text[i];
        if (d === "\n") line++;
        if (escaped && d === "\\") { i += 2; continue; }
        if (d === "'") { if (text[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= n) return null;
        if (text[i] === "\n") line++;
        if (text[i] === '"') { if (text[i + 1] === '"') { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === "$" && !IDENT.test(text[i - 1] ?? "")) {
      let j = i + 1;
      if (j < n && TAG_START.test(text[j])) { j++; while (j < n && TAG_CHAR.test(text[j])) j++; }
      if (text[j] === "$") {
        const tag = text.slice(i, j + 1);
        const close = text.indexOf(tag, j + 1);
        if (close < 0) return null;
        for (let k = i; k < close + tag.length; k++) if (text[k] === "\n") line++;
        i = close + tag.length;
        continue;
      }
      i++;
      continue;
    }
    // A psql variable (:NAME, :'NAME', :"NAME"): psql substitutes the ones it defines (all upper case: ON_ERROR_STOP,
    // DBNAME, USER, ...); not modeled.
    if (c === ":" && text[i - 1] !== ":" && /^:['"]?[A-Z][A-Z_]{2,}\b/.test(text.slice(i, i + 40))) return null;
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (c === ";" && depth === 0) { push(i + 1, false); i++; start = i; continue; }
    if (c === "\\") {
      const eol = text.indexOf("\n", i);
      const cmd = text.slice(i, eol < 0 ? n : eol).trim();
      if (cmd !== "\\g /dev/null" || depth !== 0) return null;
      if (!push(i, true)) return null;
      i = eol < 0 ? n : eol;
      start = i;
      continue;
    }
    i++;
  }
  if (depth !== 0) return null;
  push(n, false);
  // COPY speaks its own sub-protocol (psql streams the data): not modeled.
  if (out.some((s) => /^\s*(?:--[^\n]*\n\s*)*copy\b/i.test(s.sql))) return null;
  return out;
}
