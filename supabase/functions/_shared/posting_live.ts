// The live posting read (2026-11-15; found in a real-task comparison: "Open the live posting for Vista Equity Partners ... job id
// 3048": get_posting only read postings already on file, and a later attempt hit "redirected too many times" on the employer's
// careers site and gave up). One posting page, opened now, read as text:
//   * through posting_fetch.ts guardedFetch: https only, a named public host (looked up where the runtime can), never a site
//     Trainee does not open (LinkedIn, Indeed: career_people_sites.ts neverOpen), every redirect hop held to the same rule;
//   * at most LIVE_MAX_HOPS redirects, with a cookie jar that lives for this one read only (posting_fetch.ts cookieJar), so a
//     careers site that sets a session cookie on a redirect and loops until it sees it resolves;
//   * GET only, one time limit for the whole read, the body read to LIVE_MAX_BYTES and stopped;
//   * HTML to text with scripts, styles and tags removed.
// No sign-in, no form, no captcha: a page that asks for one is "not read", with why, never worked around. Whatever the page
// says is the page's text: callers pass it through posting_pay.ts postingTextForModel, and a read that fails returns no text.
import { cappedText, cookieJar, guardedFetch, limited, NotRead, type Resolve, stopWords } from "./posting_fetch.ts";
import { neverOpen } from "./career_people_sites.ts";
import { htmlToText } from "./workday_posting.ts";
import { decodeHtmlEntities } from "./posting_text.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
export const LIVE_MAX_HOPS = 8;
export const LIVE_TIMEOUT_MS = 10_000;
export const LIVE_MAX_BYTES = 1536 * 1024;
export const LIVE_MIN_TEXT = 200; // fewer characters of text than this is not a posting page (a script-only shell, an error page)
export type LiveRead =
  | { status: "read"; url: string; final_url: string; title: string; text: string; read_at: string }
  | { status: "not_read"; url: string; why: string };
export interface LiveDeps { fetch: Fetch; resolve?: Resolve; timeoutMs?: number; maxBytes?: number; maxHops?: number; userAgent?: string; now?: () => number }

const WALL = /\b(?:g-recaptcha|h-captcha|hcaptcha|cf-turnstile|cf-challenge|captcha)\b|verify (?:that )?you are (?:a )?human|are you a robot|just a moment\.\.\.|attention required! \| cloudflare/i;
// A wall is a page that is mostly the wall: a long posting whose apply form carries a captcha script is still the posting.
const WALL_TEXT_MAX = 1500;
const SIGN_IN = /\/(?:log-?in|sign-?in|signin|auth|sso|oauth2?)(?:[/?#]|$)/i;
const titleOf = (html: string): string => {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,300})["']/i.exec(html)?.[1];
  const t = og ?? /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1] ?? /<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i.exec(html)?.[1] ?? "";
  return decodeHtmlEntities(t.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200);
};
// The page's visible text: head, scripts, styles, templates, svg and comments are not text.
export const pageText = (html: string): string => htmlToText(String(html ?? "")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " "));

export async function readLivePosting(href: string, d: LiveDeps): Promise<LiveRead> {
  const url = String(href ?? "").trim();
  const no = (why: string): LiveRead => ({ status: "not_read", url, why });
  try { if (neverOpen(new URL(url).hostname)) return no("not read: it is a site Trainee never opens"); } catch { return no("not read: that is not a link"); }
  const max = d.maxBytes ?? LIVE_MAX_BYTES, now = d.now ?? Date.now;
  try {
    return await limited(d.timeoutMs ?? LIVE_TIMEOUT_MS, async (signal) => {
      const headers: Record<string, string> = { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" };
      if (d.userAgent) headers["user-agent"] = d.userAgent;
      const { res, url: final } = await guardedFetch(d.fetch, url, { method: "GET", headers, signal }, { resolve: d.resolve, maxHops: d.maxHops ?? LIVE_MAX_HOPS, cookies: cookieJar() });
      if (res.status >= 300 && res.status < 400) { await res.body?.cancel().catch(() => {}); return no("not read: the site redirected without saying where"); }
      if (!res.ok) { await res.body?.cancel().catch(() => {}); return no(`not read: the site answered HTTP ${res.status}`); }
      if (SIGN_IN.test(new URL(final).pathname)) { await res.body?.cancel().catch(() => {}); return no("not read: the page asks for a sign-in; Trainee never signs in for anyone"); }
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type && !/html|text\/plain|xml/.test(type)) { await res.body?.cancel().catch(() => {}); return no("not read: the link is not a web page"); }
      const html = await cappedText(res, max, signal);
      const text = pageText(html);
      if (text.length < WALL_TEXT_MAX && WALL.test(html.slice(0, 200_000))) return no("not read: the page shows a captcha or bot check; Trainee does not solve those");
      if (text.length < WALL_TEXT_MAX && /<input[^>]+type=["']?password/i.test(html)) return no("not read: the page asks for a sign-in; Trainee never signs in for anyone");
      if (text.length < LIVE_MIN_TEXT) return no("not read: the page held no posting text (it may need a browser to show it)");
      return { status: "read", url, final_url: final, title: titleOf(html), text, read_at: new Date(now()).toISOString() };
    });
  } catch (e) {
    const w = stopWords(e);
    return no(e instanceof NotRead ? w : w === "timeout" ? "not read: the site did not answer in time (timeout)" : `not read: ${w}`);
  }
}
