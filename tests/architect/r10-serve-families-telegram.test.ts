// R10 WO-E, D-049: a served File family is a kind page in every way Telegram needs. It carries the same Content-Security-Policy and
// script hashes as the kind's page (the kind's script and telegram.org in script-src), and it opens as a Mini App: Telegram's initData
// signs the owner in, another linked account sees nothing, and an unlinked one gets 403. No network, no database, no model.
//   deno test -A --no-check --import-map=tests/flow/supabase-npm.json tests/architect/r10-serve-families-telegram.test.ts
import assert from "node:assert/strict";
import { handleFile, type FileDeps } from "../../supabase/functions/trainee-file/handler.ts";
import { fileAppFor } from "../../supabase/functions/_shared/file_link.ts";
import { createFileService, memoryFileStore } from "../../supabase/functions/_shared/file_service.ts";
import { memSessions, signedInit } from "./file-session-fakes.ts";

const SECRET = "file-link-secret-0123456789-abcdef", BASE = "https://trainee.example/file", BOT = "123456:TEST-BOT-TOKEN";
const U = "33333333-3333-4333-8333-333333333333", OTHER = "44444444-4444-4444-8444-444444444444";
const NOW = Date.parse("2026-11-09T15:45:00Z");
const INTRO = { title: "Intro to Dana", person: { name: "Dana Lee", role: "Analytics Manager", company: "Example Co", source: "Reported, not verified" },
  why: [{ text: "You built pricing dashboards in SQL.", source: "From your resume" }, { text: "Example Co is hiring a Data Analyst.", source: "From the posting" }, { text: "You want a growth-team role.", source: "From you" }],
  message: { channel: "email", to: "dana@example.com", subject: "A question about analytics", body: "Hi Dana, could I ask two questions about the team?" } };
const env = (families: string | undefined) => ({ get: (k: string) => ({ TRAINEE_FILE_LINK_SECRET: SECRET, TRAINEE_FILE_BASE_URL: BASE, TELEGRAM_BOT_TOKEN: BOT, TRAINEE_FILE_FAMILIES: families } as Record<string, string | undefined>)[k] });

async function world(families: string | undefined) {
  const files = createFileService({ store: memoryFileStore(), env: env(families), now: () => NOW });
  const made = await files.create(U, "introduction", structuredClone(INTRO)) as { ok: true; url: string; webApp: string };
  assert.ok(made.ok && made.url && made.webApp, JSON.stringify(made));
  const app = await fileAppFor(env(families), made.url, NOW);
  const list = new URL(app!).searchParams.get("list")!;
  const linked: Record<string, string> = { "777": U, "888": OTHER };
  const d = { env: env(families), now: () => NOW, sessions: memSessions().store, files, userOfTelegram: async (tg: string) => linked[tg] ?? null, phone: undefined } as unknown as FileDeps;
  const open = async (tg: string) => await handleFile(new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://trainee.example" },
    body: new URLSearchParams({ init: await signedInit(tg, NOW / 1000 - 30, BOT), list }).toString() }), d);
  return { open };
}
const scriptSrc = (r: Response) => /script-src ([^;]+)/.exec(r.headers.get("content-security-policy") ?? "")?.[1] ?? "";

Deno.test("D-049: a served family page signs in through Telegram's initData and carries the kind page's CSP and script hashes", async () => {
  const on = await world("on"), off = await world(undefined);
  const fam = await on.open("777"), famHtml = await fam.text();
  assert.equal(fam.status, 200, famHtml.slice(0, 300));
  assert.match(famHtml, /data-family="F-12"/, "the owner, signed in by Telegram, gets the family page");
  assert.match(famHtml, /Hi Dana, could I ask two questions about the team\?/);
  assert.match(famHtml, /<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js/, "the Telegram WebApp script");
  const kind = await off.open("777");
  assert.equal(kind.status, 200); assert.doesNotMatch(await kind.text(), /data-family=/);
  // The same script-src as the kind's page: the same hashes, and telegram.org.
  assert.match(scriptSrc(fam), /'sha256-[^']+' 'sha256-[^']+' 'sha256-[^']+' https:\/\/telegram\.org/, scriptSrc(fam));
  assert.equal(scriptSrc(fam), scriptSrc(kind), "the family page's script-src is the kind page's");
  // Another linked Telegram account sees nothing of it; one linked to no one opens nothing.
  const theirs = await on.open("888");
  assert.doesNotMatch(await theirs.text(), /Hi Dana|data-family=/);
  const stranger = await on.open("999");
  assert.equal(stranger.status, 403); assert.doesNotMatch(await stranger.text(), /Hi Dana/);
});
