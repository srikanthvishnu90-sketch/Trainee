// R10 WO-F, spec E.7 items 56 and 59 (owner order "fix everything in instinct's files"), on the phone sign-in of /file.
//   E-59: a number that is on no account gets exactly the answer a known number gets: same status, same body (inputs aside), and
//         the same timing class under the deployed pacing (file_session.ts phonePace); a code that could not be sent is never
//         called sent.
//   E-56: the expired-link, phone and code states at 390x844 in Chromium: heading and action inside the first screen, nothing
//         sideways, and the action really drawn (the screenshot's pixels at the action are the plum).
// Memory fakes (no SMS, no network). The clock is an input.
import assertNode from "node:assert/strict";
import { createRequire } from "node:module";
import { mintFileToken } from "../../supabase/functions/_shared/file_link.ts";
import { phonePace } from "../../supabase/functions/_shared/file_session.ts";
import { renderLinkState, renderPhoneLogin } from "../../supabase/functions/_shared/file_page.ts";
import { PLUM } from "../../supabase/functions/_shared/brand.ts";
import { handleFile, type FileDeps, type FileStore } from "../../supabase/functions/trainee-file/handler.ts";
import { fakePhone, memSessions } from "./file-session-fakes.ts";

const assert = (v: unknown, m?: string) => assertNode.ok(v, m);
const eq = (a: unknown, b: unknown, m?: string) => assertNode.deepStrictEqual(a, b, m);
const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const CI = Deno.env.get("CI") === "true";
const U = "8c0f8f8e-6a43-4a49-9d2c-0000000f5e01", V = "8c0f8f8e-6a43-4a49-9d2c-0000000f5e02";
const U_PHONE = "+15125550170", V_PHONE = "+15125550171", NOBODY = "+14155550199";
const SECRET = "r10-e59-link-secret-0123456789-abcdef", LIST = "0e0e0e0e0e", NOW = Date.parse("2026-11-09T15:00:00Z");
const plain = (h: string) => h.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const FLOOR = 250; // the deployed floor is file_session.ts PHONE_STEP_FLOOR_MS; a shorter one keeps the test quick, same function

function world(o: { textingOn?: boolean; sendFails?: boolean; slowLookupMs?: number } = {}) {
  const s = memSessions();
  const P = fakePhone({ [U]: U_PHONE, [V]: V_PHONE }, { configured: o.textingOn !== false });
  const auth = { ...P.auth };
  // The account lookup takes longer for a known number (as a real lookup can); the pacing must hide that.
  if (o.slowLookupMs) auth.accountPhone = async (u: string) => { await new Promise((r) => setTimeout(r, o.slowLookupMs)); return P.auth.accountPhone(u); };
  if (o.sendFails) auth.send = async () => ({ ok: false, why: "refused" } as never);
  const d: FileDeps = { store: {} as FileStore, sessions: s.store, phone: auth, now: () => NOW, pace: phonePace(FLOOR), background: () => {},
    env: { get: (k) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_BOT_URL: "https://t.me/TraineeTestBot" } as Record<string, string>)[k] }, cards: {} as never, tap: {} as never };
  return { d, P };
}
const req = (d: FileDeps, o: { get?: string; form?: Record<string, string>; cookie?: string }) => handleFile(new Request(`https://trainee.example/file${o.get ?? ""}`, o.form
  ? { method: "POST", headers: { cookie: o.cookie ?? "", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o.form).toString() }
  : { headers: { cookie: o.cookie ?? "" } }), d);
// A fresh link for U opened in a browser, then a number typed: the answer, its body and how long it took.
async function ask(w: ReturnType<typeof world>, phone: string) {
  const link = (await mintFileToken({ secret: SECRET, userId: U, list: LIST, now: NOW, kind: "l" }))!;
  const open = await req(w.d, { get: `?t=${encodeURIComponent(link)}` });
  const cookie = (open.headers.get("set-cookie") ?? "").split(";")[0];
  const t0 = performance.now();
  const r = await req(w.d, { form: { action: "phone_start", phone }, cookie });
  const body = await r.text();
  return { status: r.status, body, ms: performance.now() - t0, csp: r.headers.get("content-security-policy") };
}

Deno.test("E-59: a number on no account gets exactly the known number's answer (status, body, timing class); another account's number too", async () => {
  const w = world({ slowLookupMs: 60 });
  const known = await ask(w, U_PHONE), unknown = await ask(w, NOBODY), other = await ask(w, V_PHONE);
  eq(w.P.texts.map((t) => t.phone), [U_PHONE], "only the link's own account's number is texted");
  for (const [name, x] of [["unknown", unknown], ["another account's", other]] as const) {
    eq(x.status, known.status, `${name}: same status`);
    eq(x.body, known.body, `${name}: byte-for-byte the same page`);
    eq(x.csp, known.csp, `${name}: same headers`);
  }
  assert(/<h1>Check your phone<\/h1>/.test(known.body) && /If that is the number on your Trainee account, we texted it a code/.test(plain(known.body)), "the conditional words, for every number");
  // timing class: every answer is held to the floor, so none answers faster than it, and none is a lookup slower than another
  for (const [name, x] of [["known", known], ["unknown", unknown], ["another account's", other]] as const) assert(x.ms >= FLOOR - 5 && x.ms < FLOOR + 120, `${name}: ${x.ms.toFixed(0)} ms is in the paced class (${FLOOR} ms floor)`);
  assert(Math.abs(known.ms - unknown.ms) < 60, `known ${known.ms.toFixed(0)} ms vs unknown ${unknown.ms.toFixed(0)} ms`);
});

// Architect ruling 2026-11-09 (WO-F caveat 2): for a matched number whose background send fails, the page keeps the conditional
// "If that is the number on your Trainee account, we texted it a code": not revealing who has an account wins, and that sentence
// makes no unconditional claim that a code was sent. "We could not send the code" is said only when texting is off for everyone.
Deno.test("E-59 (architect ruling 2026-11-09): a code that could not be sent is never called sent; texting off says 'We could not send the code'; a refused text for a matched number keeps the conditional words and answers exactly as a number on no account", async () => {
  // texting switched off: said plainly, before the number is compared, so the answer is the same for any number
  const off = world({ textingOn: false });
  const a = await ask(off, U_PHONE), b = await ask(off, NOBODY);
  eq(a.status, 503); eq(a.body, b.body, "texting off: the same answer for any number");
  assert(/<h1>We could not send the code<\/h1>/.test(a.body) && /no code was sent/.test(plain(a.body)), "says it was not sent");
  assert(!/we texted|code has been sent|code was sent to/i.test(plain(a.body)), "never says a code was sent");
  // the provider refuses the text for the account's own number: the page must not reveal that the number was the account's,
  // so it gives the conditional words every number gets (no claim that a code went), and no code exists to sign in with
  const refused = world({ sendFails: true });
  const k = await ask(refused, U_PHONE), n = await ask(refused, NOBODY);
  eq(k.body, n.body, "a refused text looks like a number on no account");
  assert(!/code has been sent|we sent you a code|a code is on its way/i.test(plain(k.body)), "no unconditional claim that a code was sent");
  eq(refused.P.texts.length, 0, "nothing was texted");
});

// ---------------------------------------------------------------- E-56 in Chromium
function playwright(): any {
  const req = createRequire(import.meta.url);
  for (const p of [Deno.env.get("UPMORE_PLAYWRIGHT_PATH"), `${ROOT}/tools/node_modules/playwright`]) { if (!p) continue; try { return req(p); } catch { /* next */ } }
  return null;
}
async function pngPixel(png: Uint8Array, x: number, y: number): Promise<[number, number, number]> {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8, w = 0, type = 0; const idat: Uint8Array[] = [];
  while (off < png.length) {
    const len = dv.getUint32(off), kind = String.fromCharCode(...png.subarray(off + 4, off + 8));
    if (kind === "IHDR") { w = dv.getUint32(off + 8); type = png[off + 17]; }
    if (kind === "IDAT") idat.push(png.subarray(off + 8, off + 8 + len));
    if (kind === "IEND") break;
    off += 12 + len;
  }
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const bpp = type === 6 ? 4 : 3, stride = w * bpp + 1;
  const rows: Uint8Array[] = [];
  for (let r = 0; r <= y; r++) {
    const f = raw[r * stride], line = raw.slice(r * stride + 1, (r + 1) * stride), prev = rows[r - 1] ?? new Uint8Array(w * bpp);
    for (let i = 0; i < line.length; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      line[i] = (line[i] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 255;
    }
    rows.push(line);
  }
  const i = x * bpp; return [rows[y][i], rows[y][i + 1], rows[y][i + 2]];
}

Deno.test({ name: "E-56: the expired-link, phone, code and wrong-code states at 390x844: heading and action in the first screen, nothing sideways, the action visibly drawn", sanitizeResources: false, sanitizeOps: false, async fn() {
  const pw = playwright();
  if (!pw) { if (CI) throw new Error("Playwright is missing in CI"); console.log("NOT_RUN locally: no Playwright"); return; }
  if (Deno.uid?.() === 0 && !CI) { console.log("NOT_RUN locally as root: run it as an unprivileged user (Chromium's sandbox)"); return; }
  const bot = "https://t.me/TraineeTestBot";
  const pages: [string, string, string, RegExp][] = [
    ["expired link", renderLinkState("This link has expired", ["Links last a day so a forwarded one stops working. Ask Trainee in Telegram for your jobs again and open the new link."], bot), "p.recovery a.apply", /expired/],
    ["phone entry", renderPhoneLogin({ step: "phone", botUrl: bot }), "form.login button.apply", /^Sign in$/],
    ["code sent", renderPhoneLogin({ step: "code", botUrl: bot }), "#codeform button.apply", /^Check your phone$/],
    ["wrong code", renderPhoneLogin({ step: "wrong_code", note: "Check the latest code or request a new one.", botUrl: bot }), "#codeform button.apply", /^That code did not work$/],
  ];
  const browser = await pw.chromium.launch({ args: ["--no-proxy-server"] });
  const problems: string[] = [];
  try {
    for (const [name, html, action, title] of pages) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, colorScheme: "light" });
      await ctx.route("**/*", (r: any) => r.abort());
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const m = await page.evaluate((sel: string) => {
        const h = document.querySelector("h1")!, a = document.querySelector(sel) as HTMLElement, mark = document.querySelector("svg.mark")!;
        const r = a.getBoundingClientRect();
        return { h1: h.textContent, h1Bottom: h.getBoundingClientRect().bottom, top: r.top, bottom: r.bottom, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
          mark: mark.getBoundingClientRect().height, sideways: document.documentElement.scrollWidth > innerWidth + 1 };
      }, action);
      if (!title.test(m.h1 ?? "")) problems.push(`${name}: heading "${m.h1}"`);
      if (m.h1Bottom > 844 || m.bottom > 844) problems.push(`${name}: heading ends at ${m.h1Bottom}, action at ${m.bottom} (first screen is 844)`);
      if (m.mark > 32) problems.push(`${name}: the mark is ${m.mark} px`);
      if (m.sideways) problems.push(`${name}: scrolls sideways`);
      const px = await pngPixel(new Uint8Array(await page.screenshot()), m.cx, Math.round(m.top) + 4);
      const plum = [1, 3, 5].map((i) => parseInt(PLUM.slice(i, i + 2), 16));
      if (px.some((v, i) => Math.abs(v - plum[i]) > 24)) problems.push(`${name}: the action is not drawn as the plum button (pixel ${px.join(",")})`);
      await ctx.close();
    }
  } finally { await browser.close(); }
  assert(!problems.length, problems.join("\n"));
} });
