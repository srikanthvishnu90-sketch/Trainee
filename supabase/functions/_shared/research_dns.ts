// Review of #589 (2026-11-08, split out of #615 on 2026-11-09): the research reader checks the RESOLVED addresses of every hop
// (research_sources.ts fetchSources `resolver`) before each fetch and again right after it, so a public name that answers a private
// address at either lookup is refused or discarded. It does not pin the connection: fetch() resolves the name itself, so a name
// that flips for that one lookup only can still be reached once (research_sources.ts says what remains). This module is the
// production side of the check: the system resolver (3 s at most), the startup probe, and the reader the chat uses (25 s at most).
// deno-lint-ignore-file no-explicit-any
import { fetchSources, type FetchedSources, normalizeUrl, type Resolver } from "./research_sources.ts";
import { declaredFetch } from "./research_search.ts";

// The production resolver: A and AAAA now, through Deno.resolveDns (looked up at call time). No answer throws: unreachable.
export const RESOLVE_TIMEOUT_MS = 3000, RESEARCH_BUDGET_MS = 25_000;
export const systemResolver: Resolver = async (host) => {
  const D: any = (globalThis as any).Deno;
  if (!D?.resolveDns) throw new Error("no DNS resolver");
  const ips: string[] = [];
  // A and AAAA together, within 3 s: a lookup that does not answer in time counts as no answer (unreachable).
  const one = async (t: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([D.resolveDns(host, t), new Promise((_, no) => { timer = setTimeout(() => no(new Error("DNS timeout")), RESOLVE_TIMEOUT_MS); })]); }
    finally { clearTimeout(timer); }
  };
  for (const r of await Promise.allSettled(["A", "AAAA"].map(one))) if (r.status === "fulfilled" && Array.isArray(r.value)) ips.push(...r.value.map(String));
  if (!ips.length) throw new Error("no address");
  return ips;
};

// The startup probe (architect, 2026-11-08): can this runtime look a name up at all? Deno.resolveDns missing, or answering
// "not supported", "not implemented" or a permission error, means it cannot, and the reader then FAILS CLOSED (it reads nothing;
// every page is unreachable) rather than fetch without the address check. A name with no answer (NotFound), a timeout or any other
// error is DNS working, so the probe passes. Logged once as one JSON line: research_dns_probe.
export type DnsProbe = { ok: boolean; why: string };
let probed: Promise<DnsProbe> | null = null;
export function dnsProbe(o: { resolve?: ((host: string, type: string) => Promise<unknown>) | null; log?: (line: string) => void; fresh?: boolean } = {}): Promise<DnsProbe> {
  if (probed && !o.fresh) return probed;
  const p = (async (): Promise<DnsProbe> => {
    const D: any = (globalThis as any).Deno, r = o.resolve !== undefined ? o.resolve : D?.resolveDns?.bind(D);
    let out: DnsProbe;
    if (typeof r !== "function") out = { ok: false, why: "Deno.resolveDns is not available in this runtime" };
    else {
      try { await r("www.bls.gov", "A"); out = { ok: true, why: "resolved" }; }
      catch (e) {
        const msg = `${(e as any)?.name ?? ""} ${(e as any)?.message ?? e}`;
        out = e instanceof TypeError || /not\s+(?:supported|implemented)|unsupported|NotSupported|PermissionDenied|NotCapable|requires\s+net/i.test(msg)
          ? { ok: false, why: `Deno.resolveDns cannot be used here: ${msg.trim().slice(0, 160)}` } : { ok: true, why: `DNS answered: ${msg.trim().slice(0, 80)}` };
      }
    }
    (o.log ?? ((l: string) => console.log(l)))(JSON.stringify({ evt: "research_dns_probe", ok: out.ok, why: out.why }));
    return out;
  })();
  if (!o.fresh) probed = p;
  return p;
}

// The reader the chat's research turn uses: the declared User-Agent, at most 8 pages, every hop resolved. With the system
// resolver (no resolver given) the startup probe must have passed; if it failed, nothing is read (every page is unreachable).
export function resolvedReader(o: { fetch: typeof fetch; userAgent?: string | null; resolver?: Resolver; now?: () => number; probe?: () => Promise<DnsProbe>; max?: number; budgetMs?: number; clock?: () => number }) {
  const f = declaredFetch(o.fetch, o.userAgent), resolver = o.resolver ?? systemResolver;
  return async (urls: string[]): Promise<FetchedSources> => {
    if (!o.resolver && !(await (o.probe ?? dnsProbe)()).ok) return { verified: [], rejected: [...new Set(urls.map(normalizeUrl))].map((url) => ({ url, why: "unreachable" as const })) };
    const clock = o.clock ?? Date.now;
    return fetchSources(urls, { fetch: f, resolver, now: o.now, max: o.max ?? 8, clock, deadline: clock() + (o.budgetMs ?? RESEARCH_BUDGET_MS) });
  };
}
