// A copied page is not a session (scenarios-file-session-binding-battery.ts): 3,000 seeded scenarios over memory stores through
// the real handler, and the page script's half of the Mini App rule. The Postgres sample: flow-scenarios-file-session-binding.test.ts.
import { memoryRun, eq } from "./scenarios-file-session-binding-battery.ts";
import { FEED_SCRIPT } from "../../supabase/functions/_shared/file_page.ts";

Deno.test({ name: "file page session binding at scale: 3,000 seeded saved/copied/replayed-page scenarios, every invariant after every request", sanitizeOps: false, sanitizeResources: false, fn: () => memoryRun(1, 1) });

Deno.test("file page script: in the Mini App every post (in place, plain, or the fallback) carries Telegram's initData; it is never written into the page itself", () => {
  // the in-place post adds it to the body it sends; a plain form (Sign out) and the fallback submit get it as a field at submit time
  eq(FEED_SCRIPT.includes(`q=new URLSearchParams(new FormData(f));if(w&&w.initData)q.set("init",w.initData)`), true);
  eq(FEED_SCRIPT.includes(`body:q.toString()`), true);
  eq(FEED_SCRIPT.includes(`if(f.tagName==="FORM")ii(f);return}`), true);
  eq(FEED_SCRIPT.includes(`function(){ii(f);f.submit();return null}`), true);
  // only Telegram's own value, only when there is one (a phone session's page outside Telegram sends nothing extra)
  eq([...FEED_SCRIPT.matchAll(/\.initData/g)].length, 4);
});
