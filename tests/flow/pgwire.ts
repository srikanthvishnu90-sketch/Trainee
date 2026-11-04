// A minimal Postgres client (frontend/backend protocol 3.0, simple query, text results, trust auth over the unix socket)
// for tests that need many concurrent, long-lived sessions against the throwaway Postgres of tests/flow/pg.ts: one psql
// process per call (pg.sql) cannot hold 20 sessions racing each other, and the npm registry is not reachable everywhere
// these tests run. Test-only; it never reaches the live project.

export class PgError extends Error {}
// The runtime's own Deno.connect, taken when this module loads: a test that stands a fake network in for Deno.connect
// (flow-people-finding.test.ts) must not take the database's socket with it, as it never took psql's.
const realConnect = Deno.connect.bind(Deno);

export class PgConn {
  private buf = new Uint8Array(0);
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(private conn: Deno.Conn) {}

  static async connect(o: { host: string; port: number; user?: string; database?: string }): Promise<PgConn> {
    const conn = await realConnect({ transport: "unix", path: `${o.host}/.s.PGSQL.${o.port}` });
    const c = new PgConn(conn);
    const enc = new TextEncoder();
    const params = enc.encode(`user\0${o.user ?? "postgres"}\0database\0${o.database ?? "postgres"}\0client_encoding\0UTF8\0\0`);
    const msg = new Uint8Array(8 + params.length);
    const dv = new DataView(msg.buffer);
    dv.setInt32(0, msg.length);
    dv.setInt32(4, 196608);
    msg.set(params, 8);
    await c.write(msg);
    for (;;) {
      const [t, body] = await c.read();
      if (t === "R") {
        if (new DataView(body.buffer, body.byteOffset).getInt32(0) !== 0) throw new PgError("only trust authentication is supported");
      } else if (t === "E") throw new PgError(errorText(body));
      else if (t === "Z") return c;
    }
  }

  private async write(b: Uint8Array) {
    let off = 0;
    while (off < b.length) off += await this.conn.write(b.subarray(off));
  }

  private async fill(n: number) {
    while (this.buf.length < n) {
      const chunk = new Uint8Array(65536);
      const got = await this.conn.read(chunk);
      if (got === null) throw new PgError("connection closed");
      const next = new Uint8Array(this.buf.length + got);
      next.set(this.buf);
      next.set(chunk.subarray(0, got), this.buf.length);
      this.buf = next;
    }
  }

  private async read(): Promise<[string, Uint8Array]> {
    await this.fill(5);
    const t = String.fromCharCode(this.buf[0]);
    const len = new DataView(this.buf.buffer, this.buf.byteOffset).getInt32(1);
    await this.fill(1 + len);
    const body = this.buf.slice(5, 1 + len);
    this.buf = this.buf.slice(1 + len);
    return [t, body];
  }

  // One simple query (may hold several statements). Rows of the last statement that returned rows, as text (null kept).
  // Calls on one session run one after another (the protocol is strictly request, response).
  query(sql: string): Promise<(string | null)[][]> {
    const run = this.chain.then(() => this.queryNow(sql));
    this.chain = run.catch(() => {});
    return run;
  }

  private async queryNow(sql: string): Promise<(string | null)[][]> {
    const q = new TextEncoder().encode(sql + "\0");
    const msg = new Uint8Array(5 + q.length);
    msg[0] = 0x51; // 'Q'
    new DataView(msg.buffer).setInt32(1, 4 + q.length);
    msg.set(q, 5);
    await this.write(msg);
    let rows: (string | null)[][] = [], err: string | null = null;
    const dec = new TextDecoder();
    for (;;) {
      const [t, body] = await this.read();
      if (t === "T") rows = [];
      else if (t === "D") {
        const dv = new DataView(body.buffer, body.byteOffset);
        const n = dv.getInt16(0);
        let off = 2;
        const row: (string | null)[] = [];
        for (let i = 0; i < n; i++) {
          const len = dv.getInt32(off);
          off += 4;
          if (len < 0) row.push(null);
          else { row.push(dec.decode(body.subarray(off, off + len))); off += len; }
        }
        rows.push(row);
      } else if (t === "E") err = errorText(body);
      else if (t === "Z") {
        if (err) throw new PgError(err);
        return rows;
      }
    }
  }

  // One simple query, everything it answered: each result's rows (a statement that returns rows), the notices and the
  // error with all its fields (S severity, M message, D detail, H hint, W context, ...), and the transaction status
  // after it (I idle, T in a transaction, E in a failed one). Used by tests/flow/pg.ts's sql(), which sends one
  // statement at a time as psql does.
  exec(sql: string): Promise<{ results: (string | null)[][][]; notices: Record<string, string>[]; error: Record<string, string> | null; status: string }> {
    const run = this.chain.then(() => this.execNow(sql));
    this.chain = run.catch(() => {});
    return run;
  }

  private async execNow(sql: string) {
    const q = new TextEncoder().encode(sql + "\0");
    const msg = new Uint8Array(5 + q.length);
    msg[0] = 0x51; // 'Q'
    new DataView(msg.buffer).setInt32(1, 4 + q.length);
    msg.set(q, 5);
    await this.write(msg);
    const results: (string | null)[][][] = [], notices: Record<string, string>[] = [];
    let error: Record<string, string> | null = null;
    const dec = new TextDecoder();
    for (;;) {
      const [t, body] = await this.read();
      if (t === "T") results.push([]);
      else if (t === "D") {
        const dv = new DataView(body.buffer, body.byteOffset);
        const n = dv.getInt16(0);
        let off = 2;
        const row: (string | null)[] = [];
        for (let i = 0; i < n; i++) {
          const len = dv.getInt32(off);
          off += 4;
          if (len < 0) row.push(null);
          else { row.push(dec.decode(body.subarray(off, off + len))); off += len; }
        }
        results[results.length - 1].push(row);
      } else if (t === "E") error = errorFields(body);
      else if (t === "N") notices.push(errorFields(body));
      else if (t === "Z") return { results, notices, error, status: String.fromCharCode(body[0]) };
    }
  }

  async one(sql: string): Promise<string | null> {
    const r = await this.query(sql);
    return r.length ? r[0][0] : null;
  }

  close() {
    try {
      const x = new Uint8Array([0x58, 0, 0, 0, 4]); // 'X'
      this.conn.write(x).catch(() => {}).finally(() => { try { this.conn.close(); } catch { /* closed */ } });
    } catch { /* closed */ }
  }
}

function errorFields(body: Uint8Array): Record<string, string> {
  const dec = new TextDecoder(), out: Record<string, string> = {};
  let off = 0;
  while (off < body.length && body[off] !== 0) {
    const end = body.indexOf(0, off + 1);
    out[String.fromCharCode(body[off])] = dec.decode(body.subarray(off + 1, end));
    off = end + 1;
  }
  return out;
}

function errorText(body: Uint8Array): string {
  const dec = new TextDecoder();
  let off = 0, msg = "", detail = "";
  while (off < body.length && body[off] !== 0) {
    const code = String.fromCharCode(body[off]);
    const end = body.indexOf(0, off + 1);
    const v = dec.decode(body.subarray(off + 1, end));
    if (code === "M") msg = v;
    if (code === "D") detail = v;
    off = end + 1;
  }
  return detail ? `${msg} (${detail})` : msg;
}

// supabase-js's admin.rpc(name, args) over one session, as the service role, for functions taking one jsonb `p` and
// returning jsonb, text, int or nothing (the send rail's shape).
export function serviceRpc(conn: PgConn) {
  let ready: Promise<unknown> | null = null;
  const tag = () => "j" + crypto.randomUUID().replace(/-/g, "");
  return {
    async rpc(name: string, args: { p: unknown }): Promise<{ data: any; error: { message: string } | null }> {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) return { data: null, error: { message: `bad function ${name}` } };
      ready ??= conn.query("set role service_role");
      await ready;
      const t = tag();
      try {
        const v = await conn.one(`select to_jsonb(public.${name}($${t}$${JSON.stringify(args.p)}$${t}$::jsonb))::text`);
        return { data: v === null ? null : JSON.parse(v), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
  };
}
