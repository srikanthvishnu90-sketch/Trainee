// M4 test fixture: a supabase-js-shaped service client over the flow harness's real Postgres (tests/flow/pg.ts), with the
// calls the Outlook code makes (select/eq/in/limit/order/maybeSingle, insert, upsert, update, delete, rpc), each in one
// transaction as service_role, and Microsoft (login.microsoftonline.com and graph.microsoft.com) faked at the HTTP boundary.
// Anything else throws, so an unsupported call fails loudly. Nothing here reaches a network.
// deno-lint-ignore-file no-explicit-any
import type { Pg } from "../flow/pg.ts";

const ident = (s: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Error(`unsupported identifier ${s}`); return s; };
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") return `$j$${JSON.stringify(v)}$j$::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
export function admin(pg: Pg) {
  const run = (sql: string) => pg.sql(`begin;\nset local role service_role;\n${sql};\ncommit;`);
  class Q {
    cols = "*"; where: string[] = []; ord = ""; lim = ""; single = false; op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    row: Record<string, unknown> | null = null; conflict = "";
    constructor(public table: string) { ident(table); }
    select(c = "*") { if (this.op === "select") this.cols = c.split(",").map((x) => ident(x.trim())).join(", "); return this; }
    eq(c: string, v: unknown) { this.where.push(`${ident(c)} = ${lit(v)}`); return this; }
    in(c: string, vs: unknown[]) { this.where.push(vs.length ? `${ident(c)} in (${vs.map(lit).join(", ")})` : "false"); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.ord = ` order by ${ident(c)} ${o?.ascending === false ? "desc" : "asc"}`; return this; }
    limit(n: number) { this.lim = ` limit ${Math.floor(n)}`; return this; }
    maybeSingle() { this.single = true; return this; }
    insert(r: Record<string, unknown>) { this.op = "insert"; this.row = r; return this; }
    upsert(r: Record<string, unknown>, o?: { onConflict?: string }) { this.op = "upsert"; this.row = r; this.conflict = (o?.onConflict ?? "").split(",").map((c) => ident(c.trim())).join(", "); return this; }
    update(r: Record<string, unknown>) { this.op = "update"; this.row = r; return this; }
    delete() { this.op = "delete"; return this; }
    async exec() {
      try {
        const w = this.where.length ? ` where ${this.where.join(" and ")}` : "";
        if (this.op === "insert" || this.op === "upsert") {
          const keys = Object.keys(this.row!).map(ident);
          await run(`insert into public.${this.table} (${keys.join(", ")}) values (${keys.map((k) => lit((this.row as any)[k])).join(", ")})` +
            (this.op === "upsert" && this.conflict ? ` on conflict (${this.conflict}) do update set ${keys.map((k) => `${k} = excluded.${k}`).join(", ")}` : ""));
          return { data: null, error: null };
        }
        if (this.op === "update") {
          await run(`update public.${this.table} set ${Object.entries(this.row!).map(([k, v]) => `${ident(k)} = ${lit(v)}`).join(", ")}${w}`);
          return { data: null, error: null };
        }
        if (this.op === "delete") { await run(`delete from public.${this.table}${w}`); return { data: null, error: null }; }
        const out = await run(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select ${this.cols} from public.${this.table}${w}${this.ord}${this.lim}) t`);
        const rows = JSON.parse(out.split("\n").at(-1)!);
        return { data: this.single ? rows[0] ?? null : rows, error: null };
      } catch (e) { return { data: null, error: { message: String((e as Error).message) } }; }
    }
    then<T>(ok: (r: any) => T, bad?: (e: unknown) => T) { return this.exec().then(ok, bad); }
  }
  return { from: (t: string) => new Q(t), rpc: (name: string, args: Record<string, unknown>) => pg.asService().rpc(name, args) };
}

// ------------------------------------------------------------------------------------------------ fake Microsoft
export interface Call { method: string; url: string; headers: Record<string, string>; body: string }
export type Route = (c: Call) => Response | Promise<Response> | null;
export function microsoft() {
  const calls: Call[] = [];
  const routes: Route[] = [];
  const f = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => { headers[k] = v; });
    const body = init?.body == null ? "" : typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
    const c = { method: (init?.method ?? "GET").toUpperCase(), url, headers, body };
    if (!/^https:\/\/(login\.microsoftonline\.com|graph\.microsoft\.com)\//.test(url)) throw new Error(`a call left the fake Microsoft: ${url}`);
    calls.push(c);
    for (const r of routes) { const res = await r(c); if (res) return res; }
    return new Response(JSON.stringify({ error: { code: "NotFakedHere" } }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls, on: (r: Route) => { routes.unshift(r); }, reset: () => { routes.length = 0; calls.length = 0; } };
}
export const json = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...h } });
export const fakeIdToken = (email: string) => `fakeheader.${btoa(JSON.stringify({ email, test: "fake" })).replace(/=+$/, "")}.fakesig`;
