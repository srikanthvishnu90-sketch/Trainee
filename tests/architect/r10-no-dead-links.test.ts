// R10 WO-E: no dead links. A same-page GET link ("?key=...") is a button too: a key trainee-file's GET does not read would only reload
// the page. Every such link a File family draws uses only keys the handler reads (file_routes.ts FILE_LINKS, held against the
// handler's source); any other is drawn disabled with its reason.
import assert from "node:assert/strict";
import { deadQuery, FAMILIES, familyStatePage, NOT_CONNECTED, type FamilyId } from "../../supabase/functions/_shared/file_family.ts";
import { liveShortlistPage } from "../../supabase/functions/_shared/file_family_live.ts";
import { FILE_FAMILIES } from "../../supabase/functions/_shared/file_family_specimens.ts";
import { FILE_LINKS, FILE_ROUTES } from "../../supabase/functions/_shared/file_routes.ts";
import { CTX } from "./r10-files-fixtures.ts";
import { feed } from "./r10-files-fixtures-live.ts";

const SERVED = { ...CTX, routes: FILE_ROUTES, links: FILE_LINKS };
const unesc = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

Deno.test("no dead links: every query key a File link may use is one trainee-file's handler reads", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/trainee-file/handler.ts", import.meta.url));
  for (const k of FILE_LINKS) assert.ok(new RegExp(`(searchParams|fields)\\.get\\("${k}"\\)`).test(src), `the handler never reads "${k}"`);
});

Deno.test("no dead links: no family page, state page or live roles page draws a live link to a query the server ignores", () => {
  const pages: [string, string][] = FILE_FAMILIES.map((f) => [f.id, f.page(SERVED)]);
  for (const id of Object.keys(FAMILIES) as FamilyId[]) pages.push([`${id} empty`, familyStatePage({ state: "empty", family: id, next: { label: "Widen the search", effect: "decide", href: "?widen=adjacent" } }, SERVED)]);
  pages.push(["F-05 live", liveShortlistPage(feed(), SERVED)]);
  for (const [id, html] of pages) for (const m of html.matchAll(/<a [^>]*href="(\?[^"]*)"/g)) assert.ok(!deadQuery(unesc(m[1]), FILE_LINKS), `${id}: a live link to ${m[1]}`);
  const byId = Object.fromEntries(pages), off = NOT_CONNECTED.replace(/'/g, "&#39;");
  assert.ok(byId["F-01"].includes(`disabled data-effect="decide">Answer</button><span class="ff-off">${off}`), "F-01 Answer is off, with its reason");
  assert.ok(byId["F-05 empty"].includes(`>Widen the search</button><span class="ff-off">${off}`));
  assert.match(byId["F-05 live"], /<a href="\?things=ref4">Answer them now<\/a>/, "a link the server answers stays live");
  assert.match(byId["F-05 live"], /href="\?pay=meets|name="pay"/);
});
