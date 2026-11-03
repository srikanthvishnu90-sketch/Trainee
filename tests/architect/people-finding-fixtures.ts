// Shared by the people-finding tests: a ZIP built byte by byte (stored or deflated, with lying sizes or flags when asked),
// and synthetic Handshake and Indeed alert bodies (neither site documents its format; these are made up for the tests).
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
async function deflate(b: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw"); const w = cs.writable.getWriter(); w.write(new Uint8Array(b)); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
export async function zipOf(files: { name: string; data: Uint8Array; method?: 0 | 8; flags?: number; claim?: number }[]): Promise<Uint8Array> {
  const enc = new TextEncoder(), chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), method = f.method ?? 8, body = method === 8 ? await deflate(f.data) : f.data, crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, f.flags ?? 0, true); lh.setUint16(8, method, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, f.claim ?? f.data.length, true); lh.setUint16(26, name.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, f.flags ?? 0, true); ch.setUint16(10, method, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, f.claim ?? f.data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    chunks.push(new Uint8Array(lh.buffer), name, body); central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  const all = [...chunks, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0; for (const c of all) { out.set(c, o); o += c.length; }
  return out;
}

export const INDEED_HTML = `<html><body><p>New jobs for "data analyst"</p>
<a href="https://www.indeed.com/rc/clk?jk=0123456789abcdef&amp;from=ja">Data Analyst</a><br>Ramp - New York, NY<br>
<a href="https://www.indeed.com/viewjob?jk=fedcba9876543210">Business Analyst &amp; Ops</a><div>Acme Corp</div><div>Remote</div>
<a href="https://indeed.com.evil.io/rc/clk?jk=1234567890abcdef">Fake Job</a>
<a href="http://www.indeed.com/viewjob?jk=aaaaaaaaaaaaaaaa">Insecure Link</a>
<a href="https://www.indeed.com/viewjob?jk=bbbbbbbbbbbbbbbb">View job</a>
<a href="https://www.indeed.com/jobs?q=x"><img src="x"></a>
<a href="https://www.indeed.com/legal">Our privacy center</a><a href="https://www.indeed.com/unsubscribe?x=1">Unsubscribe</a></body></html>`;
export const HANDSHAKE_HTML = `<table><tr><td><a href="https://app.joinhandshake.com/jobs/1234567?ref=email">Analytics Intern<script>steal()</script></a></td></tr>
<tr><td>Stripe · Chicago, IL</td></tr><tr><td><a href="https://app.joinhandshake.com/notifications">See all</a></td></tr></table>`;


// ------------------------------------------------------------------------------------------------ pages, pinned
// A page reader's transport over fixtures, by full URL; every request's URL and the address it was pinned to recorded.
import type { Conn, Net, PageGet } from "../../supabase/functions/_shared/career_people_page.ts";
export function pageGetOf(routes: Record<string, () => Response>, calls: { url: string; ip: string }[] = [], fallback: () => Response = () => new Response("nf", { status: 404 })): PageGet {
  return async (url, ip) => { calls.push({ url: url.toString(), ip }); return (routes[url.toString()] ?? fallback)(); };
}
// A fake network for the real pinned client (pinnedGet): each connect and TLS start is recorded, and each connection
// answers the request written on it with serve()'s raw HTTP bytes, delivered in small reads.
export interface NetLog { connect: string[]; sni: string[]; requests: string[] }
export function fakeNet(serve: (r: { ip: string; sni: string; request: string }) => string | Uint8Array, log: NetLog = { connect: [], sni: [], requests: [] }): Net & { log: NetLog } {
  const conn = (ip: string): Conn & { sni: string } => {
    let sent = "", out: Uint8Array | null = null, at = 0;
    const c = {
      sni: "",
      async write(p: Uint8Array) { sent += new TextDecoder().decode(p); return p.length; },
      async read(p: Uint8Array) {
        if (!out) {
          if (!sent.includes("\r\n\r\n")) return null;
          log.requests.push(sent);
          const r = serve({ ip, sni: c.sni, request: sent });
          out = typeof r === "string" ? new TextEncoder().encode(r) : r;
        }
        if (at >= out.length) return null;
        const n = Math.min(p.length, 7000, out.length - at);
        p.set(out.subarray(at, at + n)); at += n;
        return n;
      },
      close() {},
    };
    return c;
  };
  return {
    log,
    async connect(o) { log.connect.push(o.hostname); return conn(o.hostname); },
    async startTls(c, o) { log.sni.push(o.hostname); (c as any).sni = o.hostname; return c; },
  };
}
export const http = (status: number, headers: Record<string, string>, body: string) =>
  `HTTP/1.1 ${status} X\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n${body}`;
