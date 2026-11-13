// Review of PR #775 (2026-11-13): the one way a posting reader requests a page. Every address, and every redirect hop, is held
// to the same rule before it is requested:
//   * https only, no userinfo, no port, a named public host: never an IP literal, a single-label name, or a reserved or
//     private suffix (.local, .localdomain, .internal, .intranet, .lan, .home, .corp, .svc, .test, .example, .invalid, .localhost);
//   * never a site Trainee does not open (career_people_sites.ts neverOpen: the owner's never-automate list);
//   * when the caller reads job boards only (boardHost), the hop must be one of those boards' hosts too;
//   * any other host is looked up first (A and AAAA) WHERE THE RUNTIME HAS A RESOLVER: if the name does not exist, gives
//     nothing, or gives ANY private, loopback, link-local, CGNAT, unique-local, multicast, unspecified or IPv4-mapped
//     address, the address is not requested. Where the resolver is missing or not permitted (Deno.resolveDns is not verified
//     on the Supabase edge runtime), the request goes ahead as it did before this check existed and the result carries
//     dns_checked false: names that lead to a private address are closed ONLY where the resolver exists. The name-based
//     refusals above always apply. The job boards' own hosts (a fixed list of public services) are not looked up.
//     NOT closed by this: DNS rebinding. The lookup and the request are two resolutions; a name that answers a public address
//     to the check and a private one to the request passes. Closing it needs the request pinned to the checked address.
// Redirects are never followed by fetch itself (redirect "manual"): at most MAX_HOPS hops, each checked, GET only. A refused
// hop throws NotRead, which callers report as "not read", never as a posting. A body is read to MAX_BODY_BYTES and stopped.
// A time limit (limited) is raced against the work, so it holds when a fetch does not honour its abort signal.
import { neverOpen } from "./career_people_sites.ts";
import { isPrivateIp } from "./contact_sources/web_gate.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
// The addresses a name leads to; null when no lookup could be made here (no resolver, or not permitted); a throw when the
// name does not resolve.
export type Resolve = (host: string) => Promise<string[] | null>;
export const MAX_HOPS = 3;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
// A board name or a posting id as it sits in a path: letters, digits, "_" and "-", single dots inside. Never "..", "%", "/" or "?".
export const BOARD_SLUG = /^(?=.{1,64}$)[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;
export const POSTING_UUID = /^[0-9a-f][0-9a-f-]{7,63}$/i;
export class NotRead extends Error {
  constructor(public reason: string) { super(`not read: ${reason}`); this.name = "NotRead"; }
}
const RESERVED = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|svc|test|example|invalid|onion|arpa)$/;
// Why an address is never requested, or null when it may be.
export function refusedAddress(href: string): string | null {
  let u: URL;
  try { u = new URL(String(href ?? "").trim()); } catch { return "that is not a link"; }
  if (u.protocol !== "https:") return "the address is not https";
  if (u.username || u.password) return "the address carries a sign-in";
  if (u.port) return "the address names a port";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.includes(":") || /^[\d.]+$/.test(host) || /^0x/i.test(host) || !host.includes(".") || RESERVED.test(host)) return "the address is not a named public site";
  if (neverOpen(host)) return "it is a site Trainee never opens";
  return null;
}
// The job boards' own hosts: the posting APIs and pages the readers ask (link_check.ts, posting_requirements.ts, workday_posting.ts).
const BOARD_HOSTS = /^(?:boards-api\.greenhouse\.io|(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io|api(?:\.eu)?\.lever\.co|jobs(?:\.eu)?\.lever\.co|jobs\.ashbyhq\.com|api\.ashbyhq\.com|api\.smartrecruiters\.com|jobs\.smartrecruiters\.com|[a-z0-9][a-z0-9-]{0,62}\.wd\d{1,3}\.myworkdayjobs\.com|wd\d{1,3}\.myworkdaysite\.com)$/;
export const boardHost = (href: string): boolean => { try { return BOARD_HOSTS.test(new URL(href).hostname.toLowerCase()); } catch { return false; } };
// The system's resolver (Deno.resolveDns). A family with no records is empty. No resolver, or one the runtime does not
// support or permit: null (not checked). A name that does not exist: a throw.
export const systemResolve: Resolve = async (host) => {
  const dns = (globalThis as any).Deno?.resolveDns;
  if (typeof dns !== "function") return null;
  const got = await Promise.allSettled([dns(host, "A"), dns(host, "AAAA")]);
  const out = got.flatMap((g) => g.status === "fulfilled" && Array.isArray(g.value) ? g.value.map(String) : []);
  if (out.length) return out;
  if (got.some((g) => g.status === "rejected" && /^(NotSupported|PermissionDenied|NotCapable)$/.test(String(g.reason?.name)))) return null;
  if (got.every((g) => g.status === "rejected")) throw new Error("no answer");
  return out;
};
// True when the address was looked up (or needs no lookup); false when no lookup could be made here.
const check = async (href: string, o: { allow?: (href: string) => boolean; resolve?: Resolve | null }): Promise<boolean> => {
  const why = refusedAddress(href);
  if (why) throw new NotRead(why);
  if (o.allow && !o.allow(href)) throw new NotRead("the address is not on a site this read may open");
  if (boardHost(href) || o.resolve === null) return true; // null: the caller built the address from its own provider list
  let ips: string[] | null;
  try { ips = await (o.resolve ?? systemResolve)(new URL(href).hostname.toLowerCase().replace(/\.$/, "")); } catch { throw new NotRead("the site's address could not be looked up"); }
  if (ips === null) return false;
  if (!Array.isArray(ips) || !ips.length || ips.some((ip) => isPrivateIp(String(ip)))) throw new NotRead("the site's name does not lead to a public address");
  return true;
};
// One request, its redirects walked by hand. `url` in the result is the address that answered.
export async function guardedFetch(f: Fetch, href: string, init: RequestInit = {}, o: { allow?: (href: string) => boolean; resolve?: Resolve | null; maxHops?: number } = {}): Promise<{ res: Response; url: string; dns_checked: boolean }> {
  let url = href, dns_checked = true;
  const max = o.maxHops ?? MAX_HOPS;
  for (let hop = 0; ; hop++) {
    dns_checked = (await check(url, o)) && dns_checked;
    const res = await f(url, { ...init, redirect: "manual" });
    // A fetch that followed a redirect anyway names where it ended: that address is held to the same rule.
    if (res.url && res.url !== url) {
      try { dns_checked = (await check(res.url, o)) && dns_checked; } catch (e) { await res.body?.cancel().catch(() => {}); throw e; }
      url = res.url;
    }
    if (res.status < 300 || res.status >= 400 || res.status === 304) return { res, url, dns_checked };
    const loc = res.headers.get("location");
    await res.body?.cancel().catch(() => {});
    if (!loc) return { res, url, dns_checked };
    if ((init.method ?? "GET").toUpperCase() !== "GET") throw new NotRead("the request was redirected");
    if (hop >= max) throw new NotRead(`the address redirected more than ${max} times`);
    try { url = new URL(loc, url).href; } catch { throw new NotRead("it redirected to something that is not a link"); }
  }
}
// The body as text, read in pieces and stopped at the cap: a body that states or reaches a larger size is not read.
export async function cappedText(res: Response, max = MAX_BODY_BYTES, signal?: AbortSignal): Promise<string> {
  const tooBig = () => new NotRead(`the page is larger than ${Math.round(max / 1048576)} MB`);
  if (Number(res.headers.get("content-length")) > max) { await res.body?.cancel().catch(() => {}); throw tooBig(); }
  if (!res.body) return "";
  const reader = res.body.getReader(), dec = new TextDecoder();
  let n = 0, out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (signal?.aborted) { reader.cancel().catch(() => {}); throw new DOMException("timeout", "TimeoutError"); }
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel().catch(() => {}); throw tooBig(); }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}
export const cappedJson = async (res: Response, max = MAX_BODY_BYTES, signal?: AbortSignal): Promise<any> => parseJson(await cappedText(res, max, signal));
export const parseJson = (text: string): any => { try { return JSON.parse(text); } catch { return null; } };
// `work` under one time limit, request and body together. The timer is raced against the work, so the call returns at the
// limit even when the fetch ignores the signal; the signal is still given, so an honest fetch stops too.
export async function limited<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, rej) => { timer = setTimeout(() => { rej(new DOMException("timeout", "TimeoutError")); ctl.abort(); }, Math.max(0, ms)); });
  const run = work(ctl.signal);
  run.catch(() => {}); // a late failure after the limit is not an unhandled rejection
  try { return await Promise.race([run, late]); } finally { clearTimeout(timer); }
}
// One guarded GET (or the given method) with its body as text, all inside one time limit.
export async function guardedText(f: Fetch, href: string, init: RequestInit, o: { allow?: (href: string) => boolean; resolve?: Resolve; timeoutMs: number; max?: number; body?: boolean }): Promise<{ status: number; ok: boolean; url: string; text: string; headers: Headers; dns_checked: boolean }> {
  return await limited(o.timeoutMs, async (signal) => {
    const { res, url, dns_checked } = await guardedFetch(f, href, { ...init, signal }, o);
    const text = o.body === false ? (await res.body?.cancel().catch(() => {}), "") : await cappedText(res, o.max ?? MAX_BODY_BYTES, signal);
    return { status: res.status, ok: res.ok, url, text, headers: res.headers, dns_checked };
  });
}
// What stopped a read, in fixed words only: an error's own message can quote the page (a JSON parse error does), so it is never used.
export const stopWords = (e: unknown): string => e instanceof NotRead ? e.message : (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError" ? "timeout" : "the request failed";
// Characters that are never part of a posting's visible text: controls, zero-width and bidirectional marks.
export const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁯﻿￹-￻]/g;
