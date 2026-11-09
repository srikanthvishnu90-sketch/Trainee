// R10 WO-E: the live roles page drawn as F-05 (file_family_live.ts), open and paused, passes the visual checker at 390 and 1280 px:
// no horizontal overflow, phone text >= 14px, AA contrast, every action labelled, every sourced claim linked and dated.
import { liveShortlistPage } from "../../supabase/functions/_shared/file_family_live.ts";
import { checkPages } from "./r10-files-check.ts";
import { CTX } from "./r10-files-fixtures.ts";
import { feed } from "./r10-files-fixtures-live.ts";

const PAGES: Record<string, () => string> = {
  "F-05-live-roles-page": () => liveShortlistPage(feed(), CTX),
  "F-05-live-roles-page-paused": () => liveShortlistPage(feed({ paused: true, top: undefined, notes: {} }), CTX),
};
Deno.test({ name: "R10 WO-E live: F-05 drawing the live roles feed passes the visual checker at 390 and 1280 px", sanitizeResources: false, sanitizeOps: false,
  async fn(t) { await checkPages(t, PAGES); } });
