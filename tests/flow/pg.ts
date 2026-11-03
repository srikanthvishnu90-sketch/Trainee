// Connected-flow harness (backend gap map G1): a throwaway Postgres with the career schema (tests/flow/provision-pg.sh,
// the same migration order as CI's tests/db/run.sh, never the draft card-cloud bridge), and an RPC client that calls the
// database's own functions exactly as PostgREST does for a signed-in person: in one transaction, as the `authenticated`
// role, with that person's JWT subject. No call runs as a superuser on the person's behalf; setup that is not the person
// acting (creating their account rows) goes through `asService`, the edge functions' role, and is named as setup.
// Nothing here reaches the live project.

import { PgConn } from "./pgwire.ts";
import { splitPsql } from "./psql-split.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

export function pgBinDir(): string | null {
  const env = Deno.env.get("PGBIN");
  for (const dir of [env, "/usr/lib/postgresql/16/bin"]) {
    if (!dir) continue;
    try {
      Deno.statSync(`${dir}/initdb`);
      return dir;
    } catch { /* next */ }
  }
  return null;
}

export interface Pg {
  host: string;
  port: number;
  stop: () => Promise<void>;
  sql: (text: string) => Promise<string>;
  asPerson: (userId: string) => RpcClient;
  asService: () => RpcClient;
}
export interface RpcClient {
  rpc: (name: string, args?: unknown) => Promise<{ data: any; error: { message: string } | null }>;
}

async function run(cmd: string, args: string[], stdin?: string, env?: Record<string, string>) {
  const child = new Deno.Command(cmd, { args, stdin: stdin === undefined ? "null" : "piped", stdout: "piped", stderr: "piped", env }).spawn();
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const out = await child.output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) };
}

// `includeBridge`: also the draft card-cloud bridge, at its filename position (tests/architect/bridge-ledger-order.test.ts).
// `migrationBudget`: leave the global model budget as the migration made it (the one window 2026-10-29 America/Chicago). By default the
// harness opens a test budget around NOW, so a test that makes a (fake) model call does not depend on the date it runs on; the budget's
// own tests (tests/architect/global-daily-budget.test.ts) pass migrationBudget to test the real window.
//
// Provisioned once per process (2026-10-30, for CI time): initdb and the ~160 migrations took ~8 s on every startPg, ~80 of
// them in a full architect run. The first startPg of each kind (with or without the bridge) provisions a template exactly as
// before (tests/flow/provision-pg.sh) and stops it cleanly; every startPg then starts its own copy of that data directory
// (under 1 s) on its own port and socket directory. Each cluster is still its own: nothing written in one is seen by
// another. The only difference from a fresh provision is the time the migrations ran (model_budget_* and storage.buckets
// timestamps; the budget window is re-set below as before). FLOW_PG_FRESH=1 provisions every cluster from scratch.
const templates = new Map<string, Promise<string>>();
const asPostgres = (bin: string, tool: string): [string, string[]] => Deno.uid?.() === 0 ? ["runuser", ["-u", "postgres", "--", `${bin}/${tool}`]] : [`${bin}/${tool}`, []];
const provision = async (bin: string, work: string, port: number, includeBridge: boolean) => {
  const prov = await run("bash", [`${ROOT}/tests/flow/provision-pg.sh`, work, String(port)], undefined, {
    ...Deno.env.toObject(), PGBIN: bin, INCLUDE_BRIDGE: includeBridge ? "1" : "",
  });
  if (prov.code !== 0) throw Error(`provision failed: ${prov.stderr.slice(-800)}`);
};
function template(bin: string, includeBridge: boolean): Promise<string> {
  const key = `${bin}|${includeBridge}`;
  if (!templates.has(key)) {
    templates.set(key, (async () => {
      const dir = await Deno.makeTempDir({ prefix: "trainee-flow-pg-template-" });
      await provision(bin, dir, 55000 + Math.floor(Math.random() * 4000), includeBridge);
      const [cmd, pre] = asPostgres(bin, "pg_ctl");
      const st = await run(cmd, [...pre, "-D", `${dir}/data`, "-m", "fast", "-w", "stop"]);
      if (st.code !== 0) throw Error(`template stop failed: ${st.stderr.slice(-400)}`);
      globalThis.addEventListener("unload", () => { try { Deno.removeSync(dir, { recursive: true }); } catch { /* gone */ } });
      return dir;
    })());
    templates.get(key)!.catch(() => templates.delete(key));
  }
  return templates.get(key)!;
}

export async function startPg(opts: { includeBridge?: boolean; migrationBudget?: boolean } = {}): Promise<Pg> {
  const bin = pgBinDir();
  if (!bin) throw Error("NO_POSTGRES");
  const work = await Deno.makeTempDir({ prefix: "trainee-flow-pg-" });
  const port = 55000 + Math.floor(Math.random() * 4000);
  if (Deno.env.get("FLOW_PG_FRESH") === "1") await provision(bin, work, port, !!opts.includeBridge);
  else {
    const tpl = await template(bin, !!opts.includeBridge);
    const cp = await run("cp", ["-a", `${tpl}/data`, `${work}/data`]);
    if (cp.code !== 0) throw Error(`copy of the template failed: ${cp.stderr.slice(-400)}`);
    if (Deno.uid?.() === 0) await run("chown", ["postgres", work]);
    const [cmd, pre] = asPostgres(bin, "pg_ctl");
    const st = await run(cmd, [...pre, "-D", `${work}/data`, "-o", `-p ${port} -k ${work} -c listen_addresses='' -c max_connections=${Deno.env.get("PG_MAX_CONNECTIONS") || 100}`,
      "-l", `${work}/log`, "-w", "start"]);
    if (st.code !== 0) throw Error(`start failed: ${st.stderr.slice(-400)} ${await Deno.readTextFile(`${work}/log`).catch(() => "")}`);
  }
  const pg = attachPg(work, port, bin);
  if (!opts.migrationBudget) {
    // One row for every Chicago day the open window touches (now ±12 h). Opening only the day 12 hours ago left the
    // calendar day the reservation actually uses (model_budget_day(now())) without a row after midnight Chicago time, so
    // every fake model call was refused as over budget from midnight to noon Chicago time (CI run 41005821719).
    await pg.sql(`insert into public.model_budget_days(day, limit_micros) select distinct public.model_budget_day(now() + d), 20000000
        from unnest(array[interval '-12 hours', interval '0', interval '12 hours']) d on conflict (day) do nothing;
      update public.model_budget_settings set value = to_char((now() - interval '12 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') where key = 'window_start';
      update public.model_budget_settings set value = to_char((now() + interval '12 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') where key = 'window_end';`);
  }
  return pg;
}

// The same clients over an already running throwaway cluster (a test's child process reaches the parent's database by
// its socket directory and port). `stop` stops and removes that cluster.
export function attachPg(work: string, port: number, bin: string): Pg {
  const base = ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-h", work, "-p", String(port), "-U", "postgres", "-d", "postgres"];
  const viaPsql = async (text: string) => {
    const r = await run(`${bin}/psql`, base, text); // the binary itself: the Debian psql is a Perl wrapper, slow to start
    if (r.code !== 0) throw Error(r.stderr.trim());
    return r.stdout.trim();
  };
  // The same answer as `psql -X -q -t -A -v ON_ERROR_STOP=1` (viaPsql), without a new psql process and a new database
  // session per call (2026-10-30: a fresh backend per call also re-reads the catalogs and recompiles every PL/pgSQL
  // function it runs, which was most of a flow test's time). The script is split as psql splits it (psql-split.ts) and
  // each statement sent on its own over a kept connection (pgwire.ts), as psql sends them: autocommit between
  // statements, the first error stops the script, every row of every statement printed as psql -t -A prints it, the
  // error as psql prints it. A connection goes back to the pool only when nothing it ran can outlive psql's session (no
  // session-level SET, temp table, advisory lock, open or failed transaction, error); otherwise it is closed, as psql's
  // was. Concurrent calls each get their own connection (never queued behind another), as concurrent psql processes
  // did. A script this does not model goes to psql unchanged. FLOW_PG_PSQL=1 sends every call to psql.
  const idle: PgConn[] = [], open = new Set<PgConn>();
  const say = (f: Record<string, string>) => {
    const lines = [`${f.S ?? f.V ?? "ERROR"}:  ${f.M ?? ""}`];
    if (f.D) lines.push(`DETAIL:  ${f.D}`);
    if (f.H) lines.push(`HINT:  ${f.H}`);
    if (f.W) lines.push(`CONTEXT:  ${f.W}`);
    return lines.join("\n");
  };
  const sql = async (text: string) => {
    const plan = Deno.env.get("FLOW_PG_PSQL") === "1" ? null : splitPsql(text);
    if (!plan) return await viaPsql(text);
    let kept = idle.pop();
    let c = kept ?? await PgConn.connect({ host: work, port });
    open.add(c);
    let reuse = plan.every((s) => s.poolSafe), status = "I";
    const rows: string[] = [], said: string[] = [];
    try {
      for (const [k, st] of plan.entries()) {
        let r;
        try {
          r = await c.exec(st.sql);
        } catch (e) {
          // A kept connection whose session is gone (a test ended backends, or restarted the cluster) before this call
          // sent anything: psql would have opened a new session, so does this, once.
          if (k !== 0 || !kept) throw e;
          open.delete(c); c.close(); kept = undefined;
          c = await PgConn.connect({ host: work, port });
          open.add(c);
          r = await c.exec(st.sql);
        }
        for (const nt of r.notices) said.push(say(nt));
        status = r.status;
        if (r.error) {
          reuse = false;
          throw Error([...said, say(r.error)].join("\n"));
        }
        if (!st.devnull) for (const set of r.results) for (const row of set) rows.push(row.map((v) => v ?? "").join("|"));
      }
      return rows.join("\n").trim();
    } catch (e) {
      reuse = false;
      throw e;
    } finally {
      // At most 8 kept idle (a burst of parallel calls opens more; they close after it, as psql processes did), so a
      // test that also starts its own sessions never meets max_connections because of connections kept here.
      if (reuse && status === "I" && idle.length < 8) idle.push(c);
      else { open.delete(c); c.close(); }
    }
  };
  // Argument names and types, and whether the function returns a set, read from the catalog (what PostgREST does).
  const sig = new Map<string, { names: string[]; types: string[]; set: boolean }[]>();
  const signatures = async (name: string) => {
    if (!sig.has(name)) {
      const rows = await sql(`select coalesce(array_to_json(proargnames)::text, '[]') || '|' || coalesce(array_to_json(proargtypes::regtype[]::text[])::text, '[]') || '|' || proretset
        from pg_proc where proname = '${name.replace(/[^a-z0-9_]/g, "")}' and pronamespace = 'public'::regnamespace`);
      sig.set(name, rows.split("\n").filter(Boolean).map((l) => {
        const [n, t, s] = l.split("|");
        return { names: JSON.parse(n), types: JSON.parse(t), set: s === "true" || s === "t" };
      }));
    }
    return sig.get(name)!;
  };
  const tag = () => "q" + crypto.randomUUID().replace(/-/g, "");
  const lit = (v: unknown, type: string) => {
    if (v === null || v === undefined) return `null::${type}`;
    const t = tag();
    if (type.endsWith("[]")) return `$${t}$${JSON.stringify(v)}$${t}$::jsonb`; // replaced below by a typed array read
    const text = typeof v === "string" && type !== "jsonb" ? v : JSON.stringify(v);
    return `$${t}$${text}$${t}$::${type}`;
  };
  const arrayLit = (v: unknown[], type: string) => {
    const base = type.slice(0, -2), t = tag();
    return `array(select jsonb_array_elements_text($${t}$${JSON.stringify(v)}$${t}$::jsonb)::${base})::${type}`;
  };
  const client = (role: "authenticated" | "service_role", userId: string | null): RpcClient => ({
    async rpc(name, args = {}) {
      try {
        const keys = Object.keys(args as Record<string, unknown>);
        const cand = (await signatures(name)).find((s) => keys.every((k) => s.names.includes(k)) && s.names.length >= keys.length);
        if (!cand) return { data: null, error: { message: `no function ${name}(${keys.join(", ")})` } };
        const params = keys.map((k) => {
          const type = cand.types[cand.names.indexOf(k)];
          const v = (args as any)[k];
          return `${k} => ${type.endsWith("[]") && Array.isArray(v) ? arrayLit(v, type) : lit(v, type)}`;
        }).join(", ");
        const call = `public.${name}(${params})`;
        const select = cand.set ? `select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from ${call} x` : `select to_jsonb(${call})`;
        const claims = userId ? JSON.stringify({ sub: userId, role }) : JSON.stringify({ role });
        const out = await sql(`begin;
set local role ${role};
select set_config('request.jwt.claim.sub', '${userId ?? ""}', true), set_config('request.jwt.claims', $c$${claims}$c$, true) \\g /dev/null
${select};
commit;`);
        return { data: out === "" ? null : JSON.parse(out.split("\n").at(-1)!), error: null };
      } catch (e) {
        return { data: null, error: { message: String((e as Error).message).replace(/^psql:[^E]*ERROR:\s*/, "").split("\n")[0] } };
      }
    },
  });
  const stop = async () => {
    for (const c of open) c.close();
    open.clear();
    idle.length = 0;
    const as = Deno.uid?.() === 0 ? ["runuser", ["-u", "postgres", "--", `${bin}/pg_ctl`]] as const : [`${bin}/pg_ctl`, []] as const;
    await run(as[0], [...as[1], "-D", `${work}/data`, "-m", "immediate", "stop"]);
    await Deno.remove(work, { recursive: true }).catch(() => {});
  };
  return { host: work, port, stop, sql, asPerson: (u) => client("authenticated", u), asService: () => client("service_role", null) };
}
