// R10 WO-E: no dead buttons. A File page only offers a live control for an action trainee-file/handler.ts answers; anything else
// (approveplan, approvedoc, approveapp, approvesend, checkstatus, ...) is drawn disabled with its one-line reason. The route table
// (file_routes.ts) is held equal to the handler's own POST guard, read from its source, so the two cannot drift apart.
import assert from "node:assert/strict";
import { FAMILIES, familyStatePage, NOT_CONNECTED, type FamilyId } from "../../supabase/functions/_shared/file_family.ts";
import { liveShortlistPage } from "../../supabase/functions/_shared/file_family_live.ts";
import { FILE_FAMILIES } from "../../supabase/functions/_shared/file_family_specimens.ts";
import { FILE_ROUTES } from "../../supabase/functions/_shared/file_routes.ts";
import { CTX } from "./r10-files-fixtures.ts";
import { feed } from "./r10-files-fixtures-live.ts";

const ROUTED = { ...CTX, routes: FILE_ROUTES };
const postedActions = (html: string) => [...html.matchAll(/<form method="post"[^>]*>([\s\S]*?)<\/form>/g)].map((m) => /name="action" value="([^"]+)"/.exec(m[1])?.[1] ?? "(none)");

Deno.test("no dead buttons: the route table is exactly the actions trainee-file's handler answers on a File page", async () => {
  const src = await Deno.readTextFile(new URL("../../supabase/functions/trainee-file/handler.ts", import.meta.url));
  const m = /if \(!\[([^\]]+)\]\.includes\(action\)\) return o\.state\("Not done"/.exec(src);
  assert.ok(m, "the handler's File-page action guard");
  const handled = new Set([...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]));
  assert.deepEqual([...FILE_ROUTES].sort(), [...handled].sort());
});

Deno.test("no dead buttons: every family page, its states and the live roles page post only routed actions; the rest are off with a reason", () => {
  const pages: [string, string][] = FILE_FAMILIES.map((f) => [f.id, f.page(ROUTED)]);
  for (const id of Object.keys(FAMILIES) as FamilyId[]) for (const state of ["loading", "empty", "needs_input", "prepared", "uncertain", "error", "expired"] as const) {
    pages.push([`${id} ${state}`, familyStatePage({ state, family: id, next: { label: "Check status", effect: "decide", post: { token: "t", action: "checkstatus" } }, recover: { label: "Try again", effect: "decide", href: "?" } }, ROUTED)]);
  }
  pages.push(["F-05 live", liveShortlistPage(feed(), ROUTED)], ["F-05 live paused", liveShortlistPage(feed({ paused: true }), ROUTED)]);
  for (const [id, html] of pages) for (const a of postedActions(html)) assert.ok(FILE_ROUTES.has(a), `${id}: a live control posts "${a}", which the server does not answer`);
  // The specimens' unrouted controls are still there, disabled, saying why - never silently dropped and never live.
  const byId = Object.fromEntries(pages);
  for (const [id, label] of [["F-07", "Approve v3 for R-07"], ["F-09", "Approve submission"], ["F-12", "Approve send"], ["F-10", "Check status"]]) {
    assert.match(byId[id], new RegExp(`disabled[^>]*>${label}</button><span class="ff-off">${NOT_CONNECTED.replace(/'/g, "&#39;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `${id}: ${label}`);
  }
  // A routed action stays live.
  assert.match(byId["F-05"], /name="action" value="apply"><input type="hidden" name="ref" value="ref\d+"><input type="hidden" name="tag" value="none"><button type="submit"/);
});
