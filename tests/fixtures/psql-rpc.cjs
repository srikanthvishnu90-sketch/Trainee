"use strict";
// A PostgREST-shaped rpc(name, args) over long-lived psql sessions on a throwaway Postgres (tests/flow/provision-pg.sh), each
// session running as a given database role (the apply VM tests use apply_vm_worker, which has no table rights). No driver
// download: the Postgres client the flow harness already uses. One query at a time per session; a pool spreads concurrent calls.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");

function session({ dir, port, role }) {
  const child = spawn("psql", ["-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=0", "-h", dir, "-p", String(port), "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = []; let errs = "", pending = "", wake = null;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => { pending += c; const parts = pending.split("\n"); pending = parts.pop(); lines.push(...parts); wake && wake(); });
  child.stderr.on("data", (c) => { errs += c; wake && wake(); });
  let chain = Promise.resolve(), ready = false;
  const q = (sql) => {
    const run = chain.then(async () => {
      const mark = "__END_" + crypto.randomUUID().replace(/-/g, "");
      errs = "";
      child.stdin.write(`${ready || !role ? "" : `set role ${role};\n`}${sql};\n\\echo ${mark}\n\\warn ${mark}\n`); ready = true;
      for (;;) {
        const i = lines.indexOf(mark);
        // stderr is a separate pipe: the error text is complete only once the same mark has come through it too
        if (i >= 0 && errs.includes(mark)) {
          const out = lines.splice(0, i + 1).slice(0, -1).filter((l) => l !== "");
          if (/ERROR:/.test(errs)) throw new Error(errs.split("\n").find((l) => /ERROR:/.test(l)).replace(/^.*ERROR:\s*/, ""));
          return out;
        }
        await new Promise((r) => { wake = r; setTimeout(r, 50); });
      }
    });
    chain = run.catch(() => {});
    return run;
  };
  return { q, close() { child.stdin.end(); } };
}

const lit = (v, type) => {
  if (v === null || v === undefined) return `null::${type}`;
  if (type.endsWith("[]")) return v.length ? `array[${v.map((x) => `'${String(x).replace(/'/g, "''")}'`).join(",")}]::${type}` : `'{}'::${type}`;
  if (type === "jsonb") return `$j$${JSON.stringify(v)}$j$::jsonb`;
  if (typeof v === "number") return `${v}::${type}`;
  return `'${String(v).replace(/'/g, "''")}'::${type}`;
};

function psqlRpc({ dir, port, role = "apply_vm_worker", size = 4 }) {
  const sessions = Array.from({ length: size }, () => session({ dir, port, role }));
  const admin = session({ dir, port, role: null });
  let next = 0; const sig = new Map();
  const rpc = async (name, args = {}) => {
    if (!sig.has(name)) {
      const [row] = await admin.q(`select pg_get_function_identity_arguments(oid) from pg_proc where proname='${name}' and pronamespace='public'::regnamespace limit 1`);
      sig.set(name, row ? row.split(", ").map((a) => { const m = /^(\w+) (.+)$/.exec(a); return [m[1], m[2]]; }) : []);
    }
    const list = sig.get(name).filter(([n]) => Object.prototype.hasOwnProperty.call(args, n));
    const call = `public.${name}(${list.map(([n, t]) => `${n} => ${lit(args[n], t)}`).join(", ")})`;
    const [out] = await sessions[next++ % size].q(`select ${call}::text`);
    return out === undefined || out === "" ? null : JSON.parse(out);
  };
  rpc.admin = admin; rpc.close = () => { sessions.forEach((s) => s.close()); admin.close(); };
  return rpc;
}
module.exports = { psqlRpc, session };
