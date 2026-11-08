// A PostgREST + GoTrue double over the flow harness's real Postgres (tests/flow/pg.ts), as a fetch function, so the
// production agent-chat handler runs unchanged with the real supabase-js client: the only seam is the HTTP hop to the
// Supabase project. Each request runs as the role its bearer token names (the service key: service_role; a person's
// token: authenticated, with their JWT claims), in its own transaction, so RLS, grants, triggers and every RPC are the
// database's own. Only the request shapes supabase-js sends for the calls the product makes are understood; anything
// else is answered 400 with "postgrest double: unsupported ...", so an unsupported call fails loudly, never quietly.
//
// Storage (/storage/v1, the shapes storage-js and _shared/account_delete.ts send): an in-memory object store, service
// role only, as the product only ever reaches it with the service key (the private career-resumes bucket): upload
// (POST, x-upsert; PUT update), sign (POST object/sign -> {signedURL}), download (GET object/<bucket>/<path>, and GET of a
// signed link with its token, no key needed), list (POST object/list/<bucket>) and remove (DELETE object/<bucket>
// {prefixes}). The double answers its host over https and http alike, so a handler given the https project URL (as in
// production, where a signed link must be https) and a test that hard-codes the http URL reach the same double.
import type { Pg } from "./pg.ts";

export interface Double {
  fetch: (input: Request | URL | string, init?: RequestInit) => Promise<Response>;
  // Every request the handler made, in order (method, path, role), for a test to read.
  log: { method: string; path: string; role: string; status?: number; error?: string }[];
  // The Storage objects, keyed "<bucket>/<path>", for a test to read.
  storage: Map<string, StoredObject>;
}
export interface StoredObject { bytes: Uint8Array; contentType: string; id: string; created_at: string; updated_at: string }

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Unsupported(`identifier ${s}`);
  return s;
};
class Unsupported extends Error {}
const tag = () => "d" + crypto.randomUUID().replace(/-/g, "");
const q = (v: unknown) => {
  const t = tag();
  return `$${t}$${typeof v === "string" ? v : JSON.stringify(v)}$${t}$`;
};
// A column, or a JSON path (state->career->stores, prefs->>on).
function path(expr: string): string {
  const parts = expr.split(/(->>|->)/);
  let out = ident(parts[0]);
  for (let i = 1; i < parts.length; i += 2) out = `(${out}${parts[i]}'${parts[i + 1].replace(/'/g, "")}')`;
  return out;
}
// "a:b->c, d" -> "(b->'c') as a, d"; PostgREST names a path by its last key.
function selectList(sel: string): string {
  if (!sel || sel === "*") return "*";
  return splitTop(sel).map((item) => {
    const s = item.trim();
    if (/\(/.test(s)) throw new Unsupported(`embedded select ${s}`);
    const m = /^([a-z_][a-z0-9_]*):(.+)$/.exec(s);
    const expr = m ? m[2] : s, alias = m ? m[1] : (expr.split(/->>|->/).at(-1) ?? expr);
    return expr.includes("->") ? `${path(expr)} as ${ident(alias)}` : (m ? `${ident(expr)} as ${ident(alias)}` : ident(expr));
  }).join(", ");
}
// Split on commas outside parentheses, braces and double quotes.
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quoted = false, cur = "";
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === "(" || ch === "{")) depth++;
    if (!quoted && (ch === ")" || ch === "}")) depth--;
    if (ch === "," && depth === 0 && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur !== "") out.push(cur);
  return out;
}
const unquote = (v: string) => (/^".*"$/.test(v) ? v.slice(1, -1).replace(/\\"/g, '"') : v);
// One condition "op.value" (or "not.op.value") on a column expression.
function cond(col: string, opv: string): string {
  let neg = false;
  if (opv.startsWith("not.")) { neg = true; opv = opv.slice(4); }
  const dot = opv.indexOf(".");
  const op = dot < 0 ? opv : opv.slice(0, dot), val = dot < 0 ? "" : opv.slice(dot + 1);
  const c = path(col);
  let sql: string;
  // Full-text search, as PostgREST maps it: fts(config).query -> to_tsquery, plfts -> plainto_tsquery,
  // phfts -> phraseto_tsquery, wfts -> websearch_to_tsquery (career_postings.search, the postings reader).
  const fts = /^(fts|plfts|phfts|wfts)(?:\(([^)]+)\))?$/.exec(op);
  if (fts) {
    const fn = ({ fts: "to_tsquery", plfts: "plainto_tsquery", phfts: "phraseto_tsquery", wfts: "websearch_to_tsquery" } as Record<string, string>)[fts[1]];
    sql = `${c} @@ ${fn}(${fts[2] ? `${q(fts[2])}::regconfig, ` : ""}${q(unquote(val))})`;
    return neg ? `not (${sql})` : sql;
  }
  switch (op) {
    case "eq": sql = `${c} = ${q(unquote(val))}`; break;
    case "neq": sql = `${c} <> ${q(unquote(val))}`; break;
    case "gt": sql = `${c} > ${q(unquote(val))}`; break;
    case "gte": sql = `${c} >= ${q(unquote(val))}`; break;
    case "lt": sql = `${c} < ${q(unquote(val))}`; break;
    case "lte": sql = `${c} <= ${q(unquote(val))}`; break;
    case "like": sql = `${c} like ${q(unquote(val).replace(/\*/g, "%"))}`; break;
    case "ilike": sql = `${c} ilike ${q(unquote(val).replace(/\*/g, "%"))}`; break;
    case "is":
      if (!/^(null|true|false)$/.test(val)) throw new Unsupported(`is.${val}`);
      sql = `${c} is ${val}`; break;
    case "in": {
      const items = splitTop(val.replace(/^\(|\)$/g, "")).map((x) => q(unquote(x.trim())));
      sql = items.length ? `${c} in (${items.join(", ")})` : "false"; break;
    }
    case "ov": sql = `${c} && ${q(val)}`; break;
    case "cs": sql = `${c} @> ${q(val)}`; break;
    case "cd": sql = `${c} <@ ${q(val)}`; break;
    default: throw new Unsupported(`operator ${op}`);
  }
  return neg ? `not (${sql})` : sql;
}
// or=(a.eq.1,b.in.(x,y),and(c.eq.2,d.eq.3))
function logic(kind: "or" | "and", body: string): string {
  const items = splitTop(body.replace(/^\(|\)$/g, "")).map((raw) => {
    const s = raw.trim();
    const nested = /^(not\.)?(and|or)\((.*)\)$/.exec(s);
    if (nested) { const x = logic(nested[2] as "or" | "and", `(${nested[3]})`); return nested[1] ? `not ${x}` : x; }
    const m = /^([a-z_][a-z0-9_>-]*?)\.(.+)$/.exec(s);
    if (!m) throw new Unsupported(`logic item ${s}`);
    return cond(m[1], m[2]);
  });
  return `(${items.join(` ${kind} `)})`;
}
const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);
function where(params: URLSearchParams): string {
  const parts: string[] = [];
  for (const [k, v] of params) {
    if (RESERVED.has(k)) continue;
    if (k === "or" || k === "and") parts.push(logic(k, v));
    else if (k === "not.or" || k === "not.and") parts.push(`not ${logic(k.slice(4) as "or" | "and", v)}`);
    else parts.push(cond(k, v));
  }
  return parts.length ? ` where ${parts.join(" and ")}` : "";
}
function orderBy(o: string | null): string {
  if (!o) return "";
  return " order by " + o.split(",").map((t) => {
    const [col, ...mods] = t.split(".");
    return `${path(col)}${mods.includes("desc") ? " desc" : " asc"}${mods.includes("nullsfirst") ? " nulls first" : mods.includes("nullslast") ? " nulls last" : ""}`;
  }).join(", ");
}

// The file part of a multipart upload. storage-js names it "" (form.append("", blob)), which Deno's own form parser
// drops, so the body is split by its boundary here.
function filePart(contentType: string, body: Uint8Array): { bytes: Uint8Array; contentType: string } | null {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return null;
  // A single-byte decoding, so a character index is a byte index; the bytes themselves are sliced from the body.
  const text = new TextDecoder("latin1").decode(body), sep = `--${boundary}`;
  for (let at = text.indexOf(sep); at >= 0;) {
    const start = at + sep.length;
    if (text.startsWith("--", start)) break;
    const next = text.indexOf(`\r\n${sep}`, start);
    if (next < 0) break;
    const head = text.indexOf("\r\n\r\n", start);
    if (head >= 0 && head < next && /filename=/i.test(text.slice(start, head))) {
      const type = /content-type:\s*([^\r\n]+)/i.exec(text.slice(start, head))?.[1].trim();
      return { bytes: body.slice(head + 4, next), contentType: type || "application/octet-stream" };
    }
    at = next + 2;
  }
  return null;
}

export function postgrestDouble(pg: Pg, o: { url: string; serviceKey: string; users: Record<string, { id: string; email?: string }> }): Double {
  const log: Double["log"] = [];
  const real = globalThis.fetch.bind(globalThis);
  const roleOf = (h: Headers): { role: "service_role" | "authenticated" | "anon"; uid: string | null } => {
    const tok = (h.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (tok === o.serviceKey) return { role: "service_role", uid: null };
    const u = o.users[tok];
    return u ? { role: "authenticated", uid: u.id } : { role: "anon", uid: null };
  };
  const run = async (who: { role: string; uid: string | null }, body: string) => {
    const claims = JSON.stringify(who.uid ? { sub: who.uid, role: who.role } : { role: who.role });
    const out = await pg.sql(`begin;
set local role ${who.role};
select set_config('request.jwt.claim.sub', '${who.uid ?? ""}', true), set_config('request.jwt.claims', ${q(claims)}, true) \\g /dev/null
${body};
commit;`);
    return JSON.parse(out.split("\n").filter(Boolean).at(-1) ?? "null");
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const pgError = (e: unknown) => {
    const message = String((e as Error)?.message ?? e).replace(/^psql:[^E]*ERROR:\s*/, "").split("\n")[0];
    const code = /duplicate key/.test(message) ? "23505" : /permission denied/.test(message) ? "42501" : /violates check/.test(message) ? "23514" : "P0001";
    return json(e instanceof Unsupported ? 400 : 400, { message: e instanceof Unsupported ? `postgrest double: unsupported ${message}` : message, code, details: null, hint: null });
  };

  const storage = new Map<string, StoredObject>();
  const signed = new Map<string, { key: string; exp: number }>();
  // As Storage answers (statusCode is a string in the body).
  const storageError = (status: number, error: string, message: string) => json(status, { statusCode: String(status), error, message });
  const objectPath = (rest: string) => {
    const parts = rest.split("/").map((x) => decodeURIComponent(x));
    if (parts.length < 2 || parts.some((x) => !x || x === "." || x === "..")) return null;
    return { bucket: parts[0], path: parts.slice(1).join("/"), key: parts.join("/") };
  };
  async function handleStorage(req: Request, url: URL, who: { role: string }): Promise<Response> {
    const route = url.pathname.slice("/storage/v1/object/".length);
    // A signed link: the token is the authority, no key.
    if (req.method === "GET" && route.startsWith("sign/")) {
      const at = objectPath(route.slice(5)), s = signed.get(url.searchParams.get("token") ?? "");
      if (!at || !s || s.key !== at.key) return storageError(400, "InvalidSignature", "The signature is invalid");
      if (Date.now() > s.exp) return storageError(400, "InvalidJWT", "\"exp\" claim timestamp check failed");
      const obj = storage.get(at.key);
      if (!obj) return storageError(404, "not_found", "Object not found");
      return new Response(obj.bytes.slice(), { status: 200, headers: { "content-type": obj.contentType, "content-length": String(obj.bytes.length) } });
    }
    if (route.startsWith("public/")) return storageError(400, "not_found", "the bucket is not public");
    if (who.role !== "service_role") return storageError(403, "Unauthorized", "storage double: service role only");
    if (req.method === "POST" && route.startsWith("sign/")) {
      const at = objectPath(route.slice(5));
      const body = await req.json().catch(() => ({}));
      const seconds = Number(body?.expiresIn);
      if (!at) return storageError(400, "InvalidKey", "bad object path");
      if (!Number.isFinite(seconds) || seconds <= 0) return storageError(400, "InvalidRequest", "expiresIn must be a positive number");
      if (!storage.has(at.key)) return storageError(404, "not_found", "Object not found");
      const token = tag();
      signed.set(token, { key: at.key, exp: Date.now() + seconds * 1000 });
      return json(200, { signedURL: `/object/sign/${at.key}?token=${token}` });
    }
    if (req.method === "POST" && route.startsWith("list/")) {
      const bucket = decodeURIComponent(route.slice(5));
      if (!bucket || bucket.includes("/")) return storageError(400, "InvalidKey", "bad bucket");
      const body = await req.json().catch(() => ({}));
      const prefix = String(body?.prefix ?? "").replace(/^\/+|\/+$/g, ""), search = String(body?.search ?? "");
      const limit = Number(body?.limit ?? 100), offset = Number(body?.offset ?? 0);
      const base = `${bucket}/${prefix ? `${prefix}/` : ""}`;
      const files = new Map<string, StoredObject | null>();
      for (const [k, v] of storage) {
        if (!k.startsWith(base)) continue;
        const rest = k.slice(base.length), slash = rest.indexOf("/");
        if (slash < 0) files.set(rest, v);
        else if (!files.has(rest.slice(0, slash))) files.set(rest.slice(0, slash), null);
      }
      const rows = [...files].filter(([n]) => n.startsWith(search)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).slice(offset, offset + limit)
        .map(([name, v]) => v
          ? { name, id: v.id, updated_at: v.updated_at, created_at: v.created_at, last_accessed_at: v.updated_at, metadata: { size: v.bytes.length, mimetype: v.contentType } }
          : { name, id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null });
      return json(200, rows);
    }
    if (req.method === "DELETE") {
      const bucket = decodeURIComponent(route);
      if (!bucket || bucket.includes("/")) return storageError(400, "InvalidKey", "bad bucket");
      const body = await req.json().catch(() => ({}));
      if (!Array.isArray(body?.prefixes)) return storageError(400, "InvalidRequest", "prefixes is required");
      const gone: unknown[] = [];
      for (const p of body.prefixes) {
        const key = `${bucket}/${String(p)}`, v = storage.get(key);
        if (!v) continue;
        storage.delete(key);
        gone.push({ name: String(p), bucket_id: bucket, id: v.id, updated_at: v.updated_at, created_at: v.created_at, metadata: { size: v.bytes.length, mimetype: v.contentType } });
      }
      return json(200, gone);
    }
    const at = objectPath(route.replace(/^authenticated\//, ""));
    if (!at) return storageError(400, "InvalidKey", "bad object path");
    if (req.method === "GET") {
      const obj = storage.get(at.key);
      if (!obj) return storageError(404, "not_found", "Object not found");
      return new Response(obj.bytes.slice(), { status: 200, headers: { "content-type": obj.contentType, "content-length": String(obj.bytes.length) } });
    }
    if (req.method === "POST" || req.method === "PUT") {
      const had = storage.get(at.key);
      if (req.method === "PUT" && !had) return storageError(404, "not_found", "Object not found");
      if (req.method === "POST" && had && req.headers.get("x-upsert") !== "true") return storageError(409, "Duplicate", "The resource already exists");
      let bytes: Uint8Array, contentType = req.headers.get("content-type") ?? "application/octet-stream";
      if (/^multipart\/form-data/i.test(contentType)) {
        const file = filePart(contentType, new Uint8Array(await req.arrayBuffer()));
        if (!file) return storageError(400, "InvalidRequest", "no file in the form");
        ({ bytes, contentType } = file);
      } else bytes = new Uint8Array(await req.arrayBuffer());
      const now = new Date().toISOString(), id = had?.id ?? crypto.randomUUID();
      storage.set(at.key, { bytes, contentType, id, created_at: had?.created_at ?? now, updated_at: now });
      return json(200, { Key: at.key, Id: id });
    }
    return storageError(400, "InvalidRequest", `storage double: unsupported ${req.method} ${url.pathname}`);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url), who = roleOf(req.headers);
    log.push({ method: req.method, path: url.pathname + url.search, role: who.role });
    if (url.pathname.startsWith("/storage/v1/object/")) return await handleStorage(req, url, who);
    if (url.pathname === "/auth/v1/user") {
      const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const u = o.users[tok];
      return u ? json(200, { id: u.id, email: u.email ?? null, aud: "authenticated", role: "authenticated" }) : json(401, { message: "invalid token" });
    }
    // GoTrue's admin create (supabase-js auth.admin.createUser), service role only: the account a texting channel's
    // first message signs up (trainee-inbound/store.ts createPerson). The stub's auth.users keeps the id and the email.
    if (url.pathname === "/auth/v1/admin/users" && req.method === "POST") {
      if (who.role !== "service_role") return json(403, { message: "not the service role" });
      const body = await req.json().catch(() => ({}));
      const email = typeof body?.email === "string" ? body.email : null;
      // As Auth does (the 2026-10-26 launch audit): a user with neither an email nor a phone is refused.
      if (!email && !(typeof body?.phone === "string" && body.phone)) return json(422, { code: 422, error_code: "validation_failed", msg: "an email or a phone is required" });
      // As Auth does: an address already registered is refused.
      if (email && (await pg.sql(`select count(*) from auth.users where lower(email) = lower(${q(email)})`)) !== "0") {
        return json(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
      }
      const id = await pg.sql(`insert into auth.users (email) values (${email === null ? "null" : q(email)}) returning id`);
      return json(200, { id: (/[0-9a-f-]{36}/.exec(id) ?? [""])[0], aud: "authenticated", role: "authenticated", email, phone: body?.phone ?? null,
        user_metadata: body?.user_metadata ?? {}, app_metadata: {}, created_at: new Date().toISOString() });
    }
    const rpc = /^\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)$/.exec(url.pathname);
    if (rpc) {
      const args = req.method === "GET" ? Object.fromEntries(url.searchParams) : await req.json().catch(() => ({}));
      const client = who.role === "service_role" ? pg.asService() : who.uid ? pg.asPerson(who.uid) : null;
      if (!client) return json(401, { message: "no role for this token", code: "42501" });
      const r = await client.rpc(rpc[1], args);
      if (r.error) return json(400, { message: r.error.message, code: /permission denied/.test(r.error.message) ? "42501" : "P0001", details: null, hint: null });
      return json(200, r.data);
    }
    const tbl = /^\/rest\/v1\/([a-z_][a-z0-9_]*)$/.exec(url.pathname);
    if (!tbl) return json(404, { message: `postgrest double: no route ${url.pathname}` });
    try {
      const t = `public.${ident(tbl[1])}`, p = url.searchParams, prefer = req.headers.get("prefer") ?? "";
      const wantObject = /vnd\.pgrst\.object/.test(req.headers.get("accept") ?? "");
      const returning = /return=representation/.test(prefer);
      const counting = /count=(exact|planned|estimated)/.test(prefer);
      const shape = (rows: any[], status: number) => {
        const headers: Record<string, string> = {};
        if (counting) headers["content-range"] = `${rows.length ? `0-${rows.length - 1}` : "*"}/${rows.length}`;
        if (wantObject) {
          if (rows.length !== 1) return json(406, { code: "PGRST116", details: `The result contains ${rows.length} rows`, hint: null, message: "JSON object requested, multiple (or no) rows returned" });
          return json(status, rows[0], headers);
        }
        return json(status, rows, headers);
      };
      if (req.method === "GET" || req.method === "HEAD") {
        const sel = selectList(p.get("select") ?? "*");
        const lim = p.get("limit") ? ` limit ${Number(p.get("limit"))}` : "", off = p.get("offset") ? ` offset ${Number(p.get("offset"))}` : "";
        const inner = `select ${sel} from ${t}${where(p)}${orderBy(p.get("order"))}${lim}${off}`;
        if (req.method === "HEAD") {
          const n = await run(who, `select to_jsonb(count(*)) from (${inner}) x`);
          return new Response(null, { status: 200, headers: { "content-range": `*/${n}` } });
        }
        const rows = await run(who, `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (${inner}) x`);
        return shape(rows, 200);
      }
      const ret = (dml: string) => `with w as (${dml} returning *) select coalesce(jsonb_agg(to_jsonb(w)), '[]'::jsonb) from w`;
      if (req.method === "POST") {
        const body = await req.json();
        const rowsIn = Array.isArray(body) ? body : [body];
        const keys = [...new Set(rowsIn.flatMap((r) => Object.keys(r)))].map(ident);
        let dml = `insert into ${t} (${keys.join(", ")}) select ${keys.join(", ")} from jsonb_populate_recordset(null::${t}, ${q(rowsIn)}::jsonb)`;
        if (/resolution=(merge|ignore)-duplicates/.test(prefer)) {
          const target = p.get("on_conflict");
          if (!target) throw new Unsupported("upsert without on_conflict");
          const cols = target.split(",").map((c) => ident(c.trim()));
          dml += /ignore-duplicates/.test(prefer) ? ` on conflict (${cols.join(", ")}) do nothing`
            : ` on conflict (${cols.join(", ")}) do update set ${keys.filter((k) => !cols.includes(k)).map((k) => `${k} = excluded.${k}`).join(", ") || `${cols[0]} = excluded.${cols[0]}`}`;
        }
        const rows = await run(who, ret(dml));
        return returning ? shape(rows, 201) : new Response(null, { status: 201 });
      }
      if (req.method === "PATCH") {
        const body = await req.json();
        const keys = Object.keys(body).map(ident);
        const rows = await run(who, ret(`update ${t} set ${keys.map((k) => `${k} = (jsonb_populate_record(null::${t}, ${q(body)}::jsonb)).${k}`).join(", ")}${where(p)}`));
        return returning ? shape(rows, 200) : new Response(null, { status: 204 });
      }
      if (req.method === "DELETE") {
        const rows = await run(who, ret(`delete from ${t}${where(p)}`));
        return returning ? shape(rows, 200) : new Response(null, { status: 204 });
      }
      throw new Unsupported(`method ${req.method}`);
    } catch (e) {
      return pgError(e);
    }
  }
  // The project's host, over https or http (see the header).
  const home = new URL(o.url), ours = (u: URL) => u.host === home.host && (u.protocol === "https:" || u.protocol === "http:");
  return {
    log,
    storage,
    fetch: async (input, init) => {
      const req = input instanceof Request && !init ? input : new Request(input as any, init);
      if (!ours(new URL(req.url))) return await real(req);
      const res = await handle(req), entry = log.at(-1)!;
      entry.status = res.status;
      if (res.status >= 400) entry.error = (await res.clone().text()).slice(0, 300);
      return res;
    },
  };
}
