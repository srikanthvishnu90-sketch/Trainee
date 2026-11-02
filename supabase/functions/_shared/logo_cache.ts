// Company logos for Files from the employer's OWN domain, fetched by the server and served from the File's own origin (audit R16;
// owner brief P6.3): the reader's browser never contacts a third-party logo service or the employer, so no tracker sees who opened
// the File. Turned on with TRAINEE_LOGO_URL=self (the trainee-file handler then serves `?logo=<domain>` and allows img-src 'self').
//
// Rules: the domain is only one the caller allowlisted (a posting on the signed-in person's own list, logoDomain); only https on
// that exact host (no redirects followed, so a redirect to another host is never fetched); only a real image by its first bytes
// (PNG, ICO, JPEG, GIF, WebP; never SVG, which can carry script), at most 64 KB; a short timeout. Results are cached in memory (a
// found logo 7 days, a miss 1 day), at most MAX_ENTRIES, oldest first out. No logo: the page draws the lettermark.
export interface Logo { type: string; bytes: Uint8Array }
type Entry = { logo: Logo | null; until: number };
export interface LogoCache { get(domain: string): Entry | undefined; set(domain: string, e: Entry): void }
export const MAX_BYTES = 64 * 1024, MAX_ENTRIES = 500, HIT_MS = 7 * 86_400_000, MISS_MS = 86_400_000;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const validDomain = (d: string) => DOMAIN.test(d) && !/^\d+(\.\d+)+$/.test(d) && !/(^|\.)(localhost|local|internal|home|lan|corp)$/.test(d);

export function memoryLogoCache(max = MAX_ENTRIES): LogoCache {
  const m = new Map<string, Entry>();
  return {
    get: (d) => m.get(d),
    set: (d, e) => { m.delete(d); m.set(d, e); while (m.size > max) m.delete(m.keys().next().value!); },
  };
}

// The image type from its first bytes, or null.
export function sniff(b: Uint8Array): string | null {
  const at = (i: number, xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (b.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (b.length >= 4 && at(0, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon";
  if (b.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 6 && (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return "image/gif";
  if (b.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  if (!res.body) return null;
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > cap) { await res.body.cancel().catch(() => {}); return null; }
  const reader = res.body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export async function fetchLogo(domain: string, o: { fetch: typeof fetch; cache: LogoCache; now: number; timeoutMs?: number }): Promise<Logo | null> {
  const d = String(domain ?? "").trim().toLowerCase();
  if (!validDomain(d)) return null;
  const hit = o.cache.get(d);
  if (hit && hit.until > o.now) return hit.logo;
  let logo: Logo | null = null;
  for (const path of ["/apple-touch-icon.png", "/favicon.ico"]) {
    try {
      const res = await o.fetch(`https://${d}${path}`, { redirect: "manual", headers: { accept: "image/png,image/x-icon,image/jpeg,image/gif,image/webp" }, signal: AbortSignal.timeout(o.timeoutMs ?? 3000) });
      if (res.status !== 200) { await res.body?.cancel().catch(() => {}); continue; }
      const bytes = await readCapped(res, MAX_BYTES);
      const type = bytes && bytes.length ? sniff(bytes) : null;
      if (bytes && type) { logo = { type, bytes }; break; }
    } catch { /* the next path; a miss is cached below */ }
  }
  o.cache.set(d, { logo, until: o.now + (logo ? HIT_MS : MISS_MS) });
  return logo;
}
